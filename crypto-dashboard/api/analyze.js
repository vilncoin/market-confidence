// Multi-timeframe synthesis report.
// Server fetches 15m, 1h, 4h itself, runs the rule engine on each (fixed verdicts),
// blends them (4h weighted highest), then Claude writes ONE flowing English report.
// Claude never changes the numbers — it only synthesizes and explains.

import { fetchMarket, computeBias } from "./engine.js";

const FRAMES = [
  { period: "15m", weight: 1, label: "15m" },
  { period: "1h", weight: 2, label: "1h" },
  { period: "4h", weight: 3, label: "4h" },
];

function biasScore(bias) {
  // Signed contribution: bullish positive, bearish negative, scaled by confidence.
  const sign = bias.bias === "Bullish" ? 1 : bias.bias === "Bearish" ? -1 : 0;
  return sign * (bias.conf / 100);
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try {
    const symbol = ((req.body && req.body.symbol) || "BTCUSDT").toUpperCase();

    // Fetch + evaluate all three timeframes in parallel.
    const results = await Promise.all(
      FRAMES.map(async (f) => {
        const data = await fetchMarket(symbol, f.period);
        const bias = computeBias(data);
        return { ...f, data, bias };
      })
    );

    // Weighted blended verdict. 4h dominates the trend.
    let weighted = 0, weightSum = 0;
    for (const r of results) {
      weighted += biasScore(r.bias) * r.weight;
      weightSum += r.weight;
    }
    const net = weighted / weightSum; // -1..1
    let mtfBias = net > 0.12 ? "Bullish" : net < -0.12 ? "Bearish" : "Neutral";
    let mtfConf = Math.round(Math.abs(net) * 100);
    if (mtfBias === "Neutral") mtfConf = Math.min(mtfConf, 20);
    else mtfConf = Math.max(mtfConf, 35);

    // Alignment: do all three agree?
    const dirs = results.map((r) => r.bias.bias);
    const allSame = dirs.every((d) => d === dirs[0]) && dirs[0] !== "Neutral";
    const alignment = allSame
      ? "aligned"
      : dirs.filter((d) => d === "Bullish").length && dirs.filter((d) => d === "Bearish").length
      ? "conflicting"
      : "mixed";

    // Build compact per-frame context for the model.
    const frameLines = results.map((r) => {
      const d = r.data, b = r.bias, fl = d.flow || {}, lv = d.levels || {}, bk = d.book || {}, sq = d.squeeze || {};
      const active = b.signals.filter((s) => s.ok).map((s) => s.label).join("; ") || "none";
      return (
        `[${r.label}] verdict: ${b.bias} ${b.conf}% | ` +
        `price ${d.price}, OIΔ ${d.oiChangePct.toFixed(2)}%, funding ${(d.funding * 100).toFixed(3)}%, ` +
        `taker ${d.takerRatio}, L/S ${d.longShort ?? "n/a"}, book ${bk.label ?? "n/a"}, ` +
        `CVD ${fl.cvdTrend ?? "n/a"}, divergence ${fl.divergence ?? "none"}/${fl.swing ?? "none"}, ` +
        `squeeze ${sq.type ?? "none"}, support ${lv.support ?? "n/a"}, resistance ${lv.resistance ?? "n/a"} | ` +
        `signals: ${active}`
      );
    });

    const sys =
      "You are a professional crypto futures analyst writing ONE concise multi-timeframe market report in English. " +
      "You are given FIXED per-timeframe verdicts (15m, 1h, 4h) and a FIXED blended verdict from a deterministic rule engine, " +
      "plus real price levels and order-flow data for each timeframe. " +
      "STRICT RULES: " +
      "(1) Do NOT change or recompute any verdict or confidence — treat them as settled and write with conviction. " +
      "(2) Do NOT invent numbers — use only the values provided; omit anything missing. " +
      "(3) Treat the 4h as the dominant trend, 1h as the intermediate structure, 15m as the short-term/timing read. " +
      "(4) Squeeze/liquidation info is an ESTIMATE from OI and CVD, not a real feed — phrase it as an estimate if used. " +
      "(5) Market analysis, not financial advice; do not tell the reader to buy or sell. " +
      "FORMAT: Return ONLY valid JSON, no markdown, no backticks: {\"report\": string}. " +
      "The report is 2-3 short paragraphs of flowing prose, NO headings, NO bullet points. " +
      "Open with the blended verdict and whether the timeframes are aligned or conflicting. " +
      "Then explain how 4h, 1h and 15m relate (trend vs pullback vs timing). " +
      "Close with the key levels that would confirm continuation or flip the read. " +
      "Write decisively, like a desk analyst briefing a trader.";

    const user =
      `Ticker: ${symbol}\n` +
      `BLENDED VERDICT: ${mtfBias} at ${mtfConf}% confidence\n` +
      `Timeframe alignment: ${alignment}\n\n` +
      `Per-timeframe (4h is dominant):\n` +
      frameLines.join("\n");

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1000,
        system: sys,
        messages: [{ role: "user", content: user }],
      }),
    });

    const out = await r.json();
    if (!r.ok) return res.status(500).json({ error: out.error?.message || "Claude error" });

    let text = (out.content || []).map((b) => b.text || "").join("").trim();
    text = text.replace(/```json|```/g, "").trim();
    let parsed;
    try { parsed = JSON.parse(text); }
    catch { parsed = { report: text }; }

    // Return the blended verdict too, so the UI can show it above the report.
    res.status(200).json({
      report: parsed.report || "",
      mtf: { bias: mtfBias, conf: mtfConf, alignment, frames: dirs },
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
}
