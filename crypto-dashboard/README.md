# Market Confidence Dashboard

Live Binance futures signals → deterministic bias/confidence engine → Claude-written
explanation + X post, generated only when you click "Analyze market".

## What costs money
Only the "Analyze market" button (Claude API). Everything else is free:
Binance public API, the rule engine, hosting on Vercel's free tier.

## Deploy (free)
1. Push this folder to a GitHub repo.
2. Import it at vercel.com (free Hobby plan).
3. In Vercel → Project → Settings → Environment Variables, add:
   ANTHROPIC_API_KEY = your key from console.anthropic.com
4. Deploy. Done.

## Run locally
```
npm i -g vercel
vercel dev            # then open the printed localhost URL
```
Set ANTHROPIC_API_KEY in your shell or a .env file first.

## Files
- api/engine.js   Binance fetch + rule engine (bias, confidence, signals)
- api/market.js   GET /api/market?symbol=BTCUSDT&period=1h
- api/analyze.js  POST /api/analyze  -> Claude explanation + X post
- public/index.html  the dashboard UI

## Tuning
Edit the weights in api/engine.js -> computeBias(). Each signal has a weight;
confidence = |net score| / total weight. Change thresholds or add signals there.
The AI never computes these numbers — it only phrases them.

## Cheaper / richer
api/analyze.js uses claude-haiku-4-5 (cheapest). Swap the model string for a
larger model if you want richer prose.
