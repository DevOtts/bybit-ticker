# Task: Implement Risk Analyzer V3 — ATR/SL Volatility Filter

## Context

This is the `bybit-ticker` repo — a Node.js Express.js (ES Modules, `.mjs` files) microservice deployed on Fly.io that trades crypto perpetual futures on Bybit. It's part of the Ottimus automated trading system.

**The Problem:** The system trades 20x leveraged perpetual futures with a 1% price stop-loss (= 20% ROE loss). We analyzed 65 stopped trades from January 2026 and discovered that the #1 predictor of stop-loss hits is the **ATR/SL ratio** — when ATR(14) on 4H candles exceeds 2.5x the stop-loss distance, the stop is noise, not protection. Every single analyzed stopped trade had ATR/SL > 2.8x, while every winning trade had ATR/SL < 1.5x. There's zero overlap.

**The Goal:** Add a new endpoint `POST /api/trade/risk-analyze` that computes this ATR-based risk score and returns a go/no-go decision. This endpoint will be called by our n8n workflow BEFORE `POST /api/trade/open` to gate trade execution.

---

## Repo Structure (existing)

```
bybit-ticker/
├── server.mjs              # Express app, public endpoints (/health, /api/bybit/*)
├── tradingRoutes.mjs       # Authenticated route definitions (/api/trade/*)
├── tradingService.mjs      # Bybit V5 API integration, trade execution logic
├── priceService.mjs        # Candle fetching, stop-loss simulation
├── riskAnalyzerService.mjs # EXISTING risk analyzer (7 patterns, 26.7% detection rate)
├── airtableService.mjs     # Dynamic blacklist fetch from Airtable
├── package.json
├── Dockerfile
└── fly.toml
```

**Key patterns to follow:**
- All files use ES Modules (`.mjs`, `import/export`)
- Auth middleware is already in `tradingRoutes.mjs` via Bearer token check
- `priceService.mjs` already has `getCandles(symbol, category, interval, limit)` function
- The existing `riskAnalyzerService.mjs` exports `analyzeTradeRisk(symbol, direction)` — we're **replacing** this with v3

---

## What to Build

### 1. Rewrite `riskAnalyzerService.mjs` (v3)

Replace the current risk analyzer with a new version that has the ATR/SL ratio as the **primary filter** (highest-weight pattern), plus the existing secondary patterns enhanced with 5 new ones from our research.

#### Core Algorithm — ATR/SL Ratio Check (THE KEY FILTER)

```javascript
// Fetch 100 x 4H candles
const candles = await getCandles(symbol, 'linear', '240', 100);

// Calculate ATR(14) using Wilder's smoothing
const atr14 = calculateATR(candles, 14);

// Current price (last close)
const currentPrice = candles[candles.length - 1].close;

// Stop-loss distance = 1% of price (Ottimus SP20 strategy)
const slDistance = currentPrice * 0.01;

// THE CRITICAL RATIO
const atrSlRatio = atr14 / slDistance;

// Decision thresholds (validated against 21 tokens, zero false positives)
if (atrSlRatio >= 2.5) {
  // CRITICAL — stop is noise. 100% of analyzed stopped trades had ratio > 2.8x
  // 0% of winning trades had ratio > 1.5x
  internalScore += 40; // Essentially guarantees shouldAvoid = true
}
```

#### Pattern Scoring System (0-100 internal → 0-10 normalized)

| # | Pattern | Weight | Priority | Description |
|---|---------|--------|----------|-------------|
| P0 | **ATR/SL Ratio ≥ 2.5x** | **+40** | **CRITICAL** | Primary filter. Catches 100% of analyzed stopped trades. |
| P1 | Double-Tap Exhaustion | +30 | HIGH | Price tested level 2+ times, entry on 3rd+ touch |
| P2 | Extended Move Exhaustion | +25 | HIGH | 3+ consecutive candles same direction, far from SMA20 |
| P3 | Low Volume Breakout | +20 | MED-HIGH | Breaking range but volume below 20-period average |
| P4 | Wick Rejection Zone | +15 | MEDIUM | Multiple rejection wicks near entry |
| P5 | Ranging/Choppy Market | +10 | MEDIUM | 5+ direction changes in last 10 candles |
| P6 | Against Major Trend | +10 | MEDIUM | Entry opposes SMA20/SMA50 trend |
| P7 | RSI Extreme | +20 | HIGH | LONG with RSI>70 or SHORT with RSI<30 |
| P8 | Bollinger Overextension | +15 | MEDIUM | Price at/beyond Bollinger Band in entry direction |
| P9 | Volume-Price Divergence | +15 | MEDIUM | Price trending but volume declining 20%+ |
| P10 | Extreme Volatility (legacy) | +20 | HIGH | ATR spike vs baseline (supplements P0) |
| P11 | Reversal Candlestick | +15 | MEDIUM | Hammer/Star/Engulfing against entry in last 3 candles |
| P12 | Huge S/R Nearby | +20 | HIGH | Major S/R blocking TP1 distance (within 2% of entry) |
| BL | Blacklist Token | +25 | HIGH | Token in dynamic blacklist from Airtable |

**Normalization:** `riskScore = min(10, round(internalScore / 10))`

**Decision Rule:**
```
riskScore >= 7  → shouldAvoid = true  (SKIP the trade)
riskScore 5-6   → shouldAvoid = false (enter with caution)
riskScore <= 4  → shouldAvoid = false (proceed normally)
```

#### Technical Indicators to Calculate

All from 100 x 4H candles:

| Indicator | Period | Formula |
|-----------|--------|---------|
| SMA9 | 9 | Simple Moving Average |
| SMA20 | 20 | Primary trend filter |
| SMA50 | 50 | Major trend direction |
| RSI | 14 | Relative Strength Index (Wilder's smoothing) |
| ATR | 14 | Average True Range (Wilder's smoothing) |
| Bollinger Bands | 20, 2σ | Middle = SMA20, Upper/Lower = ±2 std dev |
| MACD | 12,26,9 | For histogram divergence |

#### Function Signature

```javascript
/**
 * Analyze trade risk before execution.
 * @param {string} symbol - e.g. "BTCUSDT"
 * @param {string} direction - "LONG" or "SHORT"
 * @param {number} [entryPrice] - Optional, defaults to last close
 * @returns {Promise<object>} Risk analysis result
 */
export async function analyzeTradeRisk(symbol, direction, entryPrice = null) {
  // ... returns the response object below
}
```

### 2. Add Route in `tradingRoutes.mjs`

Add the new endpoint to the existing authenticated router:

```javascript
// POST /api/trade/risk-analyze
router.post('/risk-analyze', async (req, res) => {
  try {
    const { symbol, direction, entryPrice } = req.body;
    
    if (!symbol || !direction) {
      return res.status(400).json({ error: 'symbol and direction are required' });
    }
    
    if (!['LONG', 'SHORT'].includes(direction.toUpperCase())) {
      return res.status(400).json({ error: 'direction must be LONG or SHORT' });
    }
    
    const result = await analyzeTradeRisk(
      symbol.toUpperCase().replace('/', ''),
      direction.toUpperCase(),
      entryPrice || null
    );
    
    res.json(result);
  } catch (error) {
    console.error('Risk analysis error:', error);
    res.status(500).json({ error: 'Risk analysis failed', details: error.message });
  }
});
```

### 3. Response Format

The endpoint must return this exact JSON structure (n8n workflow depends on it):

```json
{
  "symbol": "DASHUSDT",
  "direction": "SHORT",
  "entryPrice": 36.05,
  "riskScore": 8,
  "internalScore": 80,
  "riskLevel": "HIGH",
  "shouldAvoid": true,
  "atrSlRatio": 5.2,
  "isBlacklisted": true,
  "detectedPatterns": [
    {
      "name": "ATR/SL Ratio Critical",
      "detected": true,
      "score": 40,
      "confidence": 1.0,
      "details": "ATR/SL ratio 5.2x exceeds 2.5x threshold — stop is noise"
    },
    {
      "name": "Blacklist Token",
      "detected": true,
      "score": 25,
      "confidence": 1.0,
      "details": "DASH has historically elevated loss rate"
    }
  ],
  "technicalSummary": {
    "trend": "BEARISH",
    "sma9": 35.80,
    "sma20": 37.50,
    "sma50": 42.30,
    "rsi14": 38.5,
    "atr14": 1.88,
    "bollingerUpper": 42.10,
    "bollingerLower": 32.90,
    "macdHistogram": -0.45,
    "distanceFromSMA20Percent": 3.87,
    "avgVolume20": 1250000,
    "currentVolume": 980000,
    "volumeRatio": 0.78,
    "consecutiveCandles": 2,
    "lastClose": 36.05,
    "lastHigh": 36.80,
    "lastLow": 35.20
  },
  "recommendation": "⛔ AVOID this trade. Risk score: 8/10. ATR/SL ratio 5.2x — the 1% stop will be hit by normal price noise.",
  "analyzedAt": "2026-02-25T15:30:00.000Z",
  "candlesAnalyzed": 100
}
```

**Critical fields for n8n integration:**
- `shouldAvoid` (boolean) — the n8n IF node branches on this
- `riskScore` (0-10) — logged to Airtable
- `atrSlRatio` (float) — the primary metric, logged for monitoring
- `recommendation` (string) — sent to Slack when trade is skipped

---

## Implementation Details

### ATR Calculation (Wilder's Smoothing)

```javascript
function calculateATR(candles, period = 14) {
  if (candles.length < period + 1) return null;
  
  // True Range for each candle
  const trs = [candles[0].high - candles[0].low];
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].high;
    const l = candles[i].low;
    const pc = candles[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  
  // Wilder's smoothing (same as used in our statistical validation)
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
  }
  
  return atr;
}
```

### RSI Calculation

```javascript
function calculateRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  
  const deltas = [];
  for (let i = 1; i < closes.length; i++) {
    deltas.push(closes[i] - closes[i - 1]);
  }
  
  let avgGain = 0, avgLoss = 0;
  for (let i = 0; i < period; i++) {
    if (deltas[i] > 0) avgGain += deltas[i];
    else avgLoss += Math.abs(deltas[i]);
  }
  avgGain /= period;
  avgLoss /= period;
  
  // Continue with Wilder's smoothing for remaining
  for (let i = period; i < deltas.length; i++) {
    avgGain = (avgGain * (period - 1) + Math.max(deltas[i], 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.abs(Math.min(deltas[i], 0))) / period;
  }
  
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}
```

### SMA, Bollinger Bands, MACD

Use standard implementations. SMA is simple average. Bollinger = SMA20 ± 2*stddev. MACD = EMA12 - EMA26, signal = EMA9 of MACD.

### Blacklist Check

The existing `airtableService.mjs` has `fetchBlacklist()`. Use it. If Airtable is unreachable, fall back to this hardcoded list:

```javascript
const FALLBACK_BLACKLIST = [
  "WHITEWHALE", "DASH", "RIVER", "GRIFFAIN",
  "SCR", "BREV", "MAGMA"
];
```

### Candle Data Fetching

Use the existing `getCandles` from `priceService.mjs`:

```javascript
import { getCandles } from './priceService.mjs';

// Fetches from Bybit V5 API: /v5/market/kline
const candles = await getCandles(symbol, 'linear', '240', 100);
```

The candles come back as array of objects with: `{ startTime, open, high, low, close, volume, turnover }`.

**IMPORTANT:** `getCandles` returns candles in **reverse chronological order** (newest first) from the Bybit API. You must reverse them to chronological order before calculating indicators:

```javascript
const candles = await getCandles(symbol, 'linear', '240', 100);
candles.reverse(); // Now chronological: oldest first
```

Verify this by checking the existing code in `priceService.mjs` — if it already reverses, don't double-reverse.

---

## Testing

### Manual Test (after deploying)

```bash
# Should return shouldAvoid: false for BTC (ATR/SL ~0.7-1.1x)
curl -X POST https://bybit-ticker-fly.fly.dev/api/trade/risk-analyze \
  -H "Authorization: Bearer $TRADING_API_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"symbol": "BTCUSDT", "direction": "LONG"}'

# Should return shouldAvoid: true for high-vol tokens
curl -X POST https://bybit-ticker-fly.fly.dev/api/trade/risk-analyze \
  -H "Authorization: Bearer $TRADING_API_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"symbol": "DASHUSDT", "direction": "SHORT"}'
```

### Expected Results (from our statistical validation)

| Token | ATR/SL Ratio | Expected shouldAvoid |
|-------|-------------|---------------------|
| BTCUSDT | 0.7x | false |
| ETHUSDT | 1.1x | false |
| SOLUSDT | 1.1x | false |
| BNBUSDT | 0.7x | false |
| DOGEUSDT | 1.2x | false |
| XRPUSDT | 1.0x | false |
| SUIUSDT | 1.5x | false |
| ADAUSDT | 1.4x | false |
| DASHUSDT | 8.4x | true |
| RIVERUSDT | 11.6x | true |

### Unit Test File (optional but nice)

Create `testRiskAnalyzerV3.mjs` that:
1. Calls `analyzeTradeRisk('BTCUSDT', 'LONG')` — expects riskScore ≤ 4, shouldAvoid = false
2. Calls `analyzeTradeRisk('BTCUSDT', 'SHORT')` — check RSI/trend patterns
3. Validates response schema has all required fields

---

## Integration Point (n8n Workflow)

After this endpoint is deployed, the n8n workflow will be updated to:

```
"Is New Trade?" = true
  → Airtable: Create Trade
    → NEW: Risk Analyze (POST /api/trade/risk-analyze)
      → NEW: Should Trade? (IF: shouldAvoid === false)
        → TRUE path: Execute Trade (existing)
        → FALSE path: Log Skip to Airtable + Slack alert
```

The n8n HTTP Request node for risk-analyze will use:
```json
{
  "symbol": "{{ $('Parse Result').item.json.parsed.TickerPair.replace('/', '') }}",
  "direction": "{{ $('Parse Result').item.json.parsed.Direction }}"
}
```

---

## Constraints & Edge Cases

1. **Timeout:** The endpoint must respond within 10 seconds. Bybit kline API is fast (~200ms for 100 candles), so this is fine. Add a 15s timeout on the Bybit fetch.

2. **Symbol not found:** If `getCandles` returns empty/null (symbol doesn't exist as LINEAR perpetual), return:
   ```json
   { "error": "No candle data available for XYZUSDT", "shouldAvoid": true, "riskScore": 10 }
   ```
   **Default to shouldAvoid: true on errors** — fail safe, don't risk money.

3. **Insufficient candles:** If fewer than 20 candles returned (brand new listing), set ATR/SL ratio to 10x and shouldAvoid = true. New listings are inherently dangerous for our strategy.

4. **Float precision:** Prices can be very small (e.g., SHIBUSDT at 0.00001234). Use the price as-is, don't round intermediate calculations.

---

## Summary of Changes

| File | Action | Description |
|------|--------|-------------|
| `riskAnalyzerService.mjs` | **REWRITE** | Replace v2 with v3 (ATR/SL primary filter + 12 secondary patterns) |
| `tradingRoutes.mjs` | **ADD ROUTE** | Add `POST /api/trade/risk-analyze` endpoint |
| `testRiskAnalyzerV3.mjs` | **CREATE** | Test script for validation |

**Do NOT modify:** `server.mjs`, `tradingService.mjs`, `priceService.mjs`, `airtableService.mjs` — these are stable and working in production.