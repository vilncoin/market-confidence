// Calls Claude for a flowing analyst report (English, no section headers).
// Bias/confidence/signals are FIXED by the rule engine. Levels and squeeze are
// computed from real data and passed in — Claude must not invent numbers or change the verdict.

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try {
    const { data, bias } = req.body || {};
    if (!data || !bias) return res.status(400).json({ error: "Missing data/bias" });

    const active = bias.signals.filter((s) => s.ok).map((s) => s.label);
    const inactive = bias.signals.filter((s) => !s.ok).map((s) => s.label);
    const lv = data.levels || {};
    const fl = data.flow || {};
    const bk = data.book || {};
    const sq = data.squeeze || {};

    const sys =
      "You are a professional crypto futures analyst writing a concise market report in English. " +
      "You are given a FIXED verdict (bias + confidence) and a FIXED list of satisfied signals from a " +
      "deterministic rule engine, plus REAL price levels and order-flow data. " +
      "STRICT RULES: " +
      "(1) Do NOT change, soften, or recompute the bias or confidence — state them as settled facts and write with conviction. " +
      "(2) Do NOT invent any numbers — use ONLY the price levels, ratios, and values provided; if a value is missing, omit it. " +
      "(3) Liquidation/squeeze info is an ESTIMATE derived from OI and CVD, not a real liquidation feed — if you mention it, phrase it as an estimate. " +
      "(4) This is market analysis, not financial advice; do not instruct the reader to buy or sell. " +
      "FORMAT: Return ONLY valid JSON, no markdown, no backticks: {\"report\": string}. " +
      "The report is 2-3 short paragraphs of flowing prose, NO headings, NO bullet points. " +
      "Paragraph 1: the current read and why (bias, confidence, the key signals driving it). " +
      "Paragraph 2: positioning and order flow (OI, CVD/delta, funding, long/short, order book, squeeze estimate). " +
      "Paragraph 3: the levels that matter (support/resistance) and what would confirm continuation or reversal. " +
      "Write decisively and cleanly, like a desk analyst briefing a trader.";

    const user =
      `Ticker: ${data.symbol}\nTimeframe: ${data.period}\n` +
      `Price: ${data.price}\n24h change: ${data.priceChangePct}%\n` +
      `OI change: ${data.oiChangePct.toFixed(2)}%\nTaker buy ratio: ${data.takerRatio}\n` +
      `Funding: ${(data.funding * 100).toFixed(3)}%\n` +
      `Long/Short account ratio: ${data.longShort ?? "n/a"}\n` +
      `Order book: ${bk.label ?? "n/a"}${bk.ratio != null ? " (bid/ask " + bk.ratio + ")" : ""}\n` +
      `Last-candle delta: ${fl.lastDelta ?? "n/a"} (positive = buyers dominant)\n` +
      `CVD trend: ${fl.cvdTrend ?? "n/a"}; price trend: ${fl.priceTrend ?? "n/a"}; ` +
      `trend divergence: ${fl.divergence ?? "none"}; swing divergence: ${fl.swing ?? "none"}\n` +
      `Squeeze estimate: ${sq.type ?? "none"}${sq.note ? " — " + sq.note : ""}\n` +
      `Nearest support: ${lv.support ?? "not defined"}\n` +
      `Nearest resistance: ${lv.resistance ?? "not defined"}\n` +
      `Recent range low: ${lv.recentLow ?? "n/a"}  high: ${lv.recentHigh ?? "n/a"}\n\n` +
      `FIXED VERDICT: ${bias.bias} at ${bias.conf}% confidence\n` +
      `Satisfied signals: ${active.join("; ") || "none"}\n` +
      `Unsatisfied signals: ${inactive.join("; ") || "none"}`;

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 900,
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

    res.status(200).json(parsed);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
}
