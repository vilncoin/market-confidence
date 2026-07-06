// Calls Claude to write the explanation + X post.
// The bias/confidence/signals are FIXED by the rule engine and passed in.
// Claude is instructed never to change them — only to explain and phrase.

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try {
    const { data, bias } = req.body || {};
    if (!data || !bias) return res.status(400).json({ error: "Missing data/bias" });

    const active = bias.signals.filter((s) => s.ok).map((s) => s.label);
    const inactive = bias.signals.filter((s) => !s.ok).map((s) => s.label);

    const sys =
      "You are a crypto market analyst writing for a trading dashboard. " +
      "You are given a FIXED bias, confidence score, and list of satisfied/unsatisfied signals, " +
      "computed by a deterministic rule engine. You MUST NOT change, recompute, or contradict the bias " +
      "or confidence number. Only explain the reasoning in natural language and write a short X (Twitter) post. " +
      "Return ONLY valid JSON, no markdown, no backticks, in the form " +
      '{"explanation": string, "x_post": string}. ' +
      "explanation: 2-3 sentences, plain and non-hype. x_post: under 280 characters, no financial advice, " +
      "include the ticker with a $ prefix and 1-2 hashtags.";

    const user =
      `Ticker: ${data.symbol}\nTimeframe: ${data.period}\n` +
      `Price: ${data.price}\n24h change: ${data.priceChangePct}%\n` +
      `OI change: ${data.oiChangePct.toFixed(2)}%\nTaker buy ratio: ${data.takerRatio}\n` +
      `Funding: ${(data.funding * 100).toFixed(3)}%\n\n` +
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
        model: "claude-haiku-4-5-20251001", // cheap + fast; swap to a larger model if you want richer prose
        max_tokens: 500,
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
    catch { parsed = { explanation: text, x_post: "" }; }

    res.status(200).json(parsed);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
}
