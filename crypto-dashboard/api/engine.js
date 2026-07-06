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
  const [ticker, oiHist, taker, fundingArr, klines, lsRatio, depth] = await Promise.all([
    j(`${FAPI}/fapi/v1/ticker/24hr?symbol=${symbol}`),
    j(`${FAPI}/futures/data/openInterestHist?symbol=${symbol}&period=${period}&limit=2`),
    j(`${FAPI}/futures/data/takerlongshortRatio?symbol=${symbol}&period=${period}&limit=1`),
    j(`${FAPI}/fapi/v1/fundingRate?symbol=${symbol}&limit=1`),
    j(`${FAPI}/fapi/v1/klines?symbol=${symbol}&interval=${period}&limit=50`),
    j(`${FAPI}/futures/data/globalLongShortAccountRatio?symbol=${symbol}&period=${period}&limit=1`),
    j(`${FAPI}/fapi/v1/depth?symbol=${symbol}&limit=100`),
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

  // Support/resistance from real candles. kline[2]=high, kline[3]=low.
  const levels = computeLevels(klines, price);

  // Delta / CVD from candle taker-buy vs total volume.
  const flow = computeDelta(klines);

  // Long/Short account ratio. >1 means more accounts long.
  const longShort =
    Array.isArray(lsRatio) && lsRatio.length ? parseFloat(lsRatio[0].longShortRatio) : null;

  // Order book imbalance: bid depth vs ask depth near the top of book.
  const book = computeBookImbalance(depth);

  // Squeeze estimate from OI + price + CVD (no real liquidation feed on free REST).
  const squeeze = estimateSqueeze(oiChangePct, priceChangePct, flow);

  return {
    symbol, period, price, priceChangePct, oiChangePct, takerRatio, funding,
    levels, flow, longShort, book, squeeze,
  };
}

// Bid/ask depth imbalance. Returns ratio (>1 = more bids/buy support) and a label.
function computeBookImbalance(depth) {
  if (!depth || !Array.isArray(depth.bids) || !Array.isArray(depth.asks)) {
    return { ratio: null, label: "n/a" };
  }
  const sum = (rows) => rows.reduce((a, r) => a + (parseFloat(r[1]) || 0), 0);
  const bidVol = sum(depth.bids);
  const askVol = sum(depth.asks);
  if (askVol === 0) return { ratio: null, label: "n/a" };
  const ratio = bidVol / askVol;
  let label = "balanced";
  if (ratio > 1.3) label = "bid-heavy";       // buy support stacked
  else if (ratio < 0.77) label = "ask-heavy"; // sell pressure stacked
  return { ratio: Math.round(ratio * 100) / 100, label };
}

// Infer likely squeeze from OI change + price move + CVD direction.
// No real liquidation data on free REST, so this is an estimate, labeled as such.
function estimateSqueeze(oiChangePct, priceChangePct, flow) {
  const cvdDown = flow && flow.cvdTrend === "down";
  const cvdUp = flow && flow.cvdTrend === "up";
  // OI falling = positions being closed/forced out.
  if (oiChangePct < -1.5 && priceChangePct < -0.5 && cvdDown) {
    return { type: "long_squeeze", note: "OI dropping into a falling market — likely long liquidations" };
  }
  if (oiChangePct < -1.5 && priceChangePct > 0.5 && cvdUp) {
    return { type: "short_squeeze", note: "OI dropping into a rising market — likely short liquidations" };
  }
  // OI rising while price flat = leverage building, squeeze risk both ways.
  if (oiChangePct > 2 && Math.abs(priceChangePct) < 0.8) {
    return { type: "leverage_building", note: "OI rising without price move — leverage building, volatility risk" };
  }
  return { type: "none", note: "" };
}

// Delta = taker buy - taker sell per candle. CVD = running sum of delta.
// kline[5] = total base volume, kline[9] = taker buy base volume.
function computeDelta(klines) {
  if (!Array.isArray(klines) || !klines.length) {
    return { lastDelta: 0, cvd: 0, cvdTrend: "flat", priceTrend: "flat", divergence: "none", swing: "none" };
  }
  let cvd = 0;
  const cvdSeries = [];
  const closes = [];
  for (const k of klines) {
    const vol = parseFloat(k[5]) || 0;
    const takerBuy = parseFloat(k[9]) || 0;
    const takerSell = vol - takerBuy;
    const delta = takerBuy - takerSell; // >0 buyers dominant, <0 sellers dominant
    cvd += delta;
    cvdSeries.push(cvd);
    closes.push(parseFloat(k[4]) || 0);
  }
  const n = klines.length;
  const lastDelta = (() => {
    const k = klines[n - 1];
    const vol = parseFloat(k[5]) || 0;
    const takerBuy = parseFloat(k[9]) || 0;
    return takerBuy - (vol - takerBuy);
  })();

  // Compare recent window (last ~10 candles) start vs end for trend direction.
  const w = Math.min(10, n);
  const cvdStart = cvdSeries[n - w];
  const cvdEnd = cvdSeries[n - 1];
  const priceStart = closes[n - w];
  const priceEnd = closes[n - 1];

  const cvdTrend = cvdEnd > cvdStart ? "up" : cvdEnd < cvdStart ? "down" : "flat";
  const priceTrend = priceEnd > priceStart ? "up" : priceEnd < priceStart ? "down" : "flat";

  // Divergence: price and CVD disagree.
  let divergence = "none";
  if (priceTrend === "up" && cvdTrend === "down") divergence = "bearish";   // price up, buyers not backing it
  else if (priceTrend === "down" && cvdTrend === "up") divergence = "bullish"; // price down, buyers accumulating

  // Swing divergence at extremes: compare the two most recent halves' price low/high vs CVD low/high.
  // Bullish: price makes a lower low but CVD makes a higher low (selling pressure fading at the bottom).
  // Bearish: price makes a higher high but CVD makes a lower high (buying pressure fading at the top).
  const swing = computeSwingDivergence(closes, cvdSeries);

  return {
    lastDelta: Math.round(lastDelta),
    cvd: Math.round(cvdEnd),
    cvdTrend,
    priceTrend,
    divergence,
    swing,
  };
}

// Split the recent window into two halves; compare price extreme vs CVD extreme.
function computeSwingDivergence(closes, cvdSeries) {
  const n = closes.length;
  const win = Math.min(20, n);
  if (win < 8) return "none";
  const seg = win >> 1; // half window
  const p1 = closes.slice(n - win, n - seg);
  const p2 = closes.slice(n - seg, n);
  const c1 = cvdSeries.slice(n - win, n - seg);
  const c2 = cvdSeries.slice(n - seg, n);

  const pLow1 = Math.min(...p1), pLow2 = Math.min(...p2);
  const pHigh1 = Math.max(...p1), pHigh2 = Math.max(...p2);
  const cLow1 = Math.min(...c1), cLow2 = Math.min(...c2);
  const cHigh1 = Math.max(...c1), cHigh2 = Math.max(...c2);

  // Bullish: recent price low is lower, but recent CVD low is higher (not confirming the new low).
  if (pLow2 < pLow1 && cLow2 > cLow1) return "bullish";
  // Bearish: recent price high is higher, but recent CVD high is lower (not confirming the new high).
  if (pHigh2 > pHigh1 && cHigh2 < cHigh1) return "bearish";
  return "none";
}

// Real support/resistance from recent candle highs/lows. No guessing.
// Nearest resistance = lowest recent high above price. Nearest support = highest recent low below price.
function computeLevels(klines, price) {
  if (!Array.isArray(klines) || !klines.length) return { support: null, resistance: null, recentHigh: null, recentLow: null };
  const highs = klines.map((k) => parseFloat(k[2])).filter((n) => !isNaN(n));
  const lows = klines.map((k) => parseFloat(k[3])).filter((n) => !isNaN(n));
  const recentHigh = Math.max(...highs);
  const recentLow = Math.min(...lows);
  const highsAbove = highs.filter((h) => h > price).sort((a, b) => a - b);
  const lowsBelow = lows.filter((l) => l < price).sort((a, b) => b - a);
  const resistance = highsAbove.length ? highsAbove[0] : recentHigh;
  const support = lowsBelow.length ? lowsBelow[0] : recentLow;
  return {
    support: round(support),
    resistance: round(resistance),
    recentHigh: round(recentHigh),
    recentLow: round(recentLow),
  };
}

function round(n) {
  if (n == null) return null;
  if (n >= 1000) return Math.round(n);
  if (n >= 1) return Math.round(n * 100) / 100;
  return Math.round(n * 10000) / 10000;
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

  // CVD divergence: strong signal. Only added when a divergence actually exists.
  const flow = d.flow || {};
  if (flow.divergence === "bearish") {
    add("Bearish CVD divergence (buyers not confirming)", false, true, 3);
  } else if (flow.divergence === "bullish") {
    add("Bullish CVD divergence (accumulation on dips)", true, true, 3);
  }

  // Swing divergence at support/resistance: strongest reversal cue. Only added when present.
  if (flow.swing === "bearish") {
    add("Bearish divergence at highs (lower CVD high)", false, true, 3);
  } else if (flow.swing === "bullish") {
    add("Bullish divergence at lows (higher CVD low)", true, true, 3);
  }

  // Order book imbalance.
  const book = d.book || {};
  if (book.label === "ask-heavy") {
    add("Order book ask-heavy (sell walls stacked)", false, true, 2);
  } else if (book.label === "bid-heavy") {
    add("Order book bid-heavy (buy support stacked)", true, true, 2);
  }

  // Long/short crowding: extreme long crowding is a contrarian bearish risk (squeeze fuel).
  if (d.longShort != null) {
    if (d.longShort > 2.0) {
      add("Crowded longs (squeeze risk)", false, true, 2);
    } else if (d.longShort < 0.6) {
      add("Crowded shorts (squeeze risk)", true, true, 2);
    }
  }

  // Squeeze estimate from OI/price/CVD.
  const sq = d.squeeze || {};
  if (sq.type === "long_squeeze") {
    add("Long squeeze in progress (est.)", false, true, 3);
  } else if (sq.type === "short_squeeze") {
    add("Short squeeze in progress (est.)", true, true, 3);
  } else if (sq.type === "leverage_building") {
    add("Leverage building — volatility ahead (est.)", false, true, 1);
  }

  const net = score;
  let bias = net < 0 ? "Bearish" : net > 0 ? "Bullish" : "Neutral";
  let conf = Math.round((Math.abs(net) / weightSum) * 100);
  if (conf < 15) bias = "Neutral";
  if (bias !== "Neutral") conf = Math.max(conf, 35);
  else conf = Math.min(conf, 20);

  return { bias, conf, signals, freshness: d.period };
}
