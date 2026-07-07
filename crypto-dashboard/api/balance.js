// Read-only VILN balance lookup for display purposes.
// No signature required — balance is public on-chain info. The real gate
// (signature + balance) still runs server-side in analyze.js before any analysis.

import { getVilnBalance, MIN_VILN } from "./gate.js";

export default async function handler(req, res) {
  try {
    const address = (req.query && req.query.address) || (req.body && req.body.address);
    if (!address) return res.status(400).json({ error: "missing address" });
    const balance = await getVilnBalance(address);
    res.status(200).json({ balance, required: MIN_VILN, eligible: balance >= MIN_VILN });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
}
