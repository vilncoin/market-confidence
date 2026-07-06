import { fetchMarket, computeBias } from "./engine.js";

export default async function handler(req, res) {
  try {
    const symbol = (req.query.symbol || "BTCUSDT").toUpperCase();
    const period = req.query.period || "1h";
    const data = await fetchMarket(symbol, period);
    const bias = computeBias(data);
    res.status(200).json({ data, bias });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
}
