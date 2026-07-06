// Rule engine + Binance data fetch. No API key needed for these endpoints.
// Binance blocks fapi.binance.com in some regions (e.g. US). If your Vercel
// deployment region is blocked, set BINANCE_BASE to a data mirror you trust,
// or move the Vercel project region to an allowed one (Project > Settings > Functions).
const FAPI = process.env.BINANCE_BASE || "https://fapi.binance.com";

async function j(url) {
  let r;
  try {
    r = await fetch(url);
  } catch (e) {
    throw new Error("Network error reaching Binance. Region may be blocked. " + e.message);
  }
  if (r.status === 451 || r.status === 403) {
    throw new Error(
      "Binance returned " + r.status + " (region restricted). " +
      "Move your Vercel function region or set BINANCE_BASE to an allowed endpoint."
    );
  }
  if (!r.ok) throw new Error("Binance " + r.status + " on " + url);
  return r.json();
}

// Pull the raw market signals we need for one symbol/timeframe.
export async function fetchMarket(symbol, period) {
  // period must be one of Binance's: 5m,15m,30m,1h,2h,4h,6h,12h,1d
  const [ticker, oiHist, taker, fundingArr] = await Promise.all([
    j(`${FAPI}/fapi/v1/ticker/24hr?symbol=${symbol}`),
    j(`${FAPI}/futures/data/openInterestHist?symbol=${symbol}&period=${period}&limit=2`),
    j(`${FAPI}/futures/data/takerlongshortRatio?symbol=${symbol}&period=${period}&limit=1`),
    j(`${FAPI}/fapi/v1/fundingRate?symbol=${symbol}&limit=1`),
  ]);

  const price = parseFloat(ticker.lastPrice);
  const priceChangePct = parseFloat(ticker.priceChangePercent);

  // OI history: newest data is last in the array. Compare last vs previous.
  let oiChangePct = 0;
  if (Array.isArray(oiHist) && oiHist.length >= 2) {
    const prev = parseFloat(oiHist[oiHist.length - 2].sumOpenInterest);
    const now = parseFloat(oiHist[oiHist.length - 1].sumOpenInterest);
    if (prev > 0) oiChangePct = ((now - prev) / prev) * 100;
  }

  const takerRatio =
    Array.isArray(taker) && taker.length ? parseFloat(taker[0].buySellRatio) : 1;

  // fundingRate comes as a decimal (e.g. 0.0001 = 0.01%). Keep it as a decimal fraction.
  const funding =
    Array.isArray(fundingArr) && fundingArr.length ? parseFloat(fundingArr[0].fundingRate) : 0;

  return { symbol, period, price, priceChangePct, oiChangePct, takerRatio, funding };
}

// Deterministic rule engine. AI never touches these numbers.
export function computeBias(d) {
  const signals = [];
  let score = 0, weightSum = 0;
  const add = (label, bullish, ok, weight) => {
    weightSum += weight;
    if (ok) score += bullish ? weight : -weight;
    signals.push({ label, ok, dir: bullish ? "bull" : "bear", weight });
  };

  const oiRisingNoPrice = d.oiChangePct > 2 && Math.abs(d.priceChangePct) < 1;
  add("OI rising without price expansion", false, oiRisingNoPrice, 3);

  const takerWeak = d.takerRatio < 0.95;
  add("Taker buy volume weakening", false, takerWeak, 2);

  const askLiq = d.priceChangePct < 0 && d.oiChangePct > 0;
  add("Ask-side liquidity increasing", false, askLiq, 2);

  // funding is a decimal fraction: 0.0001 = 0.01%. Typical is 0.0001; >0.0005 (0.05%) is hot.
  const fundingOverheated = Math.abs(d.funding) > 0.0005;
  add("Funding not overheated", true, !fundingOverheated, 1);

  const net = score;
  let bias = net < 0 ? "Bearish" : net > 0 ? "Bullish" : "Neutral";
  let conf = Math.round((Math.abs(net) / weightSum) * 100);
  if (conf < 15) bias = "Neutral";
  if (bias !== "Neutral") conf = Math.max(conf, 35);
  else conf = Math.min(conf, 20);

  return { bias, conf, signals, freshness: d.period };
}
