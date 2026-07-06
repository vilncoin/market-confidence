// Calls Claude for a detailed analysis. No X post.
// Bias/confidence/signals are FIXED by the rule engine. Support/resistance
// levels are computed from REAL candle data and passed in — Claude must not invent numbers.

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try {
    const { data, bias } = req.body || {};
    if (!data || !bias) return res.status(400).json({ error: "Missing data/bias" });

    const active = bias.signals.filter((s) => s.ok).map((s) => s.label);
    const inactive = bias.signals.filter((s) => !s.ok).map((s) => s.label);
    const lv = data.levels || {};
    const fl = data.flow || {};

    const sys =
      "You are a crypto futures analyst writing for a trading dashboard. " +
      "You are given a FIXED bias, confidence score, satisfied/unsatisfied signals (from a deterministic rule engine), " +
      "and REAL support/resistance levels computed from candle data. " +
      "STRICT RULES: (1) Never change or recompute the bias or confidence. " +
      "(2) Never invent price levels — use ONLY the support/resistance numbers provided. " +
      "If a level is null, say it is not clearly defined rather than making one up. " +
      "(3) This is analysis, not financial advice; do not tell the user to buy or sell. " +
      "Return ONLY valid JSON, no markdown, no backticks, in this exact shape: " +
      '{"summary": string, "bull_case": string, "bear_case": string, "watch": string}. ' +
      "summary: 2-3 sentences on the current read, mentioning order flow (delta/CVD) when it is meaningful. " +
      "bull_case: 1-2 sentences — what would confirm upside, referencing the resistance level. " +
      "bear_case: 1-2 sentences — what would confirm downside, referencing the support level. " +
      "watch: 1-2 sentences on the key thing to monitor next.";

    const user =
      `Ticker: ${data.symbol}\nTimeframe: ${data.period}\n` +
      `Price: ${data.price}\n24h change: ${data.priceChangePct}%\n` +
      `OI change: ${data.oiChangePct.toFixed(2)}%\nTaker buy ratio: ${data.takerRatio}\n` +
      `Funding: ${(data.funding * 100).toFixed(3)}%\n` +
      `Nearest support: ${lv.support ?? "not defined"}\n` +
      `Nearest resistance: ${lv.resistance ?? "not defined"}\n` +
      `Recent range low: ${lv.recentLow ?? "n/a"}  high: ${lv.recentHigh ?? "n/a"}\n` +
      `Last-candle delta: ${fl.lastDelta ?? "n/a"} (positive = buyers dominant)\n` +
      `CVD trend: ${fl.cvdTrend ?? "n/a"}; price trend: ${fl.priceTrend ?? "n/a"}; ` +
      `divergence: ${fl.divergence ?? "none"}\n` +
      `swing divergence at extreme: ${fl.swing ?? "none"}\n\n` +
      `FIXED bias: ${bias.bias}\nFIXED confidence: ${bias.conf}%\n` +
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
        max_tokens: 800,
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
    catch { parsed = { summary: text, bull_case: "", bear_case: "", watch: "" }; }

    res.status(200).json(parsed);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
}
