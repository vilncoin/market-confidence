// Multi-timeframe synthesis report.
// Server fetches 15m, 1h, 4h itself, runs the rule engine on each (fixed verdicts),
// blends them (4h weighted highest), then Claude writes ONE flowing English report.
// Claude never changes the numbers — it only synthesizes and explains.

import { fetchMarket, computeBias } from "./engine.js";
import { checkGate, MIN_VILN } from "./gate.js";

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

    // --- VILN token gate: verify wallet ownership + balance before analyzing ---
    const auth = (req.body && req.body.auth) || {};
    const gate = await checkGate(auth);
    if (!gate.ok) {
      return res.status(403).json({
        error: "gated",
        reason: gate.reason,
        balance: gate.balance ?? null,
        required: MIN_VILN,
      });
    }

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

    // Human-friendly bias label: soften low-confidence calls.
    let biasLabel;
    if (mtfConf < 30) biasLabel = "Neutral";
    else if (mtfConf < 45) biasLabel = mtfBias === "Bullish" ? "Weak Bullish" : mtfBias === "Bearish" ? "Weak Bearish" : "Neutral";
    else biasLabel = mtfBias;

    // Alignment: do all three agree?
    const dirs = results.map((r) => r.bias.bias);
    const allSame = dirs.every((d) => d === dirs[0]) && dirs[0] !== "Neutral";
    const alignment = allSame
      ? "aligned"
      : dirs.filter((d) => d === "Bullish").length && dirs.filter((d) => d === "Bearish").length
      ? "conflicting"
      : "mixed";

    // Key levels from the 4h (dominant structure).
    const dom = results.find((r) => r.label === "4h") || results[results.length - 1];
    const domLv = dom.data.levels || {};
    const support = domLv.support ?? null;
    const resistance = domLv.resistance ?? null;

    // Invalidation = the level that, if broken, kills the current read.
    // Set it just BEYOND the relevant boundary (small buffer) so it never equals support/resistance.
    // Bullish: break below support invalidates -> a touch under support (or recent low, whichever lower).
    // Bearish: break above resistance invalidates -> a touch over resistance (or recent high, whichever higher).
    // Neutral: use the downside break (support) as the reference risk level.
    const BUF = 0.003; // 0.3% buffer beyond the level
    function roundLvl(n) {
      if (n == null) return null;
      if (n >= 1000) return Math.round(n);
      if (n >= 1) return Math.round(n * 100) / 100;
      return Math.round(n * 10000) / 10000;
    }
    let invalidation = null;
    if (mtfBias === "Bullish") {
      const base = Math.min(support ?? Infinity, domLv.recentLow ?? Infinity);
      invalidation = isFinite(base) ? roundLvl(base * (1 - BUF)) : null;
    } else if (mtfBias === "Bearish") {
      const base = Math.max(resistance ?? -Infinity, domLv.recentHigh ?? -Infinity);
      invalidation = isFinite(base) ? roundLvl(base * (1 + BUF)) : null;
    } else {
      // Neutral: downside invalidation just below support.
      invalidation = support != null ? roundLvl(support * (1 - BUF)) : null;
    }

    // Detect high-risk conditions across timeframes: active squeeze or extreme crowding.
    const anySqueeze = results.some((r) => {
      const t = (r.data.squeeze || {}).type;
      return t === "long_squeeze" || t === "short_squeeze";
    });
    const extremeCrowd = results.some((r) => {
      const ls = r.data.longShort;
      return ls != null && (ls > 2.5 || ls < 0.5);
    });
    const danger = anySqueeze || extremeCrowd;
    const highRisk = danger && mtfConf >= 40;

    // Verdict priority:
    // 1) HIGH RISK — danger with real conviction.
    // 2) WAIT — conflicting, low conviction, OR any danger that isn't strong enough for HIGH RISK
    //    (never recommend BUY/SELL while a squeeze/crowd is present).
    // 3) BUY / SELL — clean aligned direction with no danger.
    let verdict, verdictColor;
    if (highRisk) {
      verdict = "HIGH RISK"; verdictColor = "orange";
    } else if (danger || alignment === "conflicting" || mtfConf < 30) {
      verdict = "WAIT"; verdictColor = "yellow";
    } else if (mtfBias === "Bullish") {
      verdict = "BUY"; verdictColor = "green";
    } else if (mtfBias === "Bearish") {
      verdict = "SELL"; verdictColor = "red";
    } else {
      verdict = "WAIT"; verdictColor = "yellow";
    }

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
      "You are a professional crypto futures analyst. A deterministic rule engine has ALREADY decided the verdict, " +
      "bias, timeframe alignment, and key levels. Your job is to write the 'why' bullets, a brief summary, and a detailed report. " +
      "STRICT RULES: " +
      "(1) Do NOT change the verdict, bias, confidence, or levels. Do NOT restate the numbers you're given except where natural. " +
      "(2) Do NOT invent numbers. " +
      "(3) Squeeze/liquidation info is an ESTIMATE from OI and CVD — phrase as estimate if used. " +
      "(4) Analysis, not financial advice. " +
      "FORMAT: Return ONLY valid JSON, no markdown, no backticks: {\"why\": string[], \"summary\": string, \"detailed\": string}. " +
      "why: 3-4 very short bullet strings (max ~10 words each), each naming ONE concrete driver, ideally tied to a timeframe " +
      "(e.g. '4H squeeze setup building', '1H bearish CVD divergence', '15m lacks confirmation'). " +
      "summary: 2-3 sentences, plain and decisive, on why this is the right stance right now. No headings, no bullets in the summary. " +
      "detailed: a thorough multi-paragraph report (4-6 short paragraphs) for readers who want depth. " +
      "Walk through each timeframe (4h dominant trend, 1h intermediate structure, 15m timing) and how they interact, " +
      "then interpret the order flow (OI, CVD/delta, funding, long/short, order book) and any squeeze estimate, " +
      "and finally discuss the key levels and what price action would confirm or invalidate the read. " +
      "Use \\n\\n between paragraphs. No markdown headings, no bullet symbols — flowing prose only. Decisive desk-analyst tone.";

    const user =
      `Ticker: ${symbol}\n` +
      `Verdict: ${verdict}\nBias: ${biasLabel} (${mtfConf}%)\nAlignment: ${alignment}\n` +
      `Support: ${support ?? "n/a"}  Resistance: ${resistance ?? "n/a"}  Invalidation: ${invalidation ?? "n/a"}\n\n` +
      `Per-timeframe (4h dominant):\n` +
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
        max_tokens: 1600,
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
    catch { parsed = { why: [], summary: text, detailed: "" }; }

    res.status(200).json({
      verdict, verdictColor,
      biasLabel, conf: mtfConf, alignment,
      frames: results.map((r) => ({ tf: r.label, dir: r.bias.bias })),
      levels: { support, resistance, invalidation },
      why: Array.isArray(parsed.why) ? parsed.why : [],
      summary: parsed.summary || "",
      detailed: parsed.detailed || "",
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
}
