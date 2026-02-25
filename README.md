# Bybit Ticker API

A lightweight Express.js API server that provides endpoints for fetching Bybit cryptocurrency market data, simulating stop-losses, and **executing automated trades** (SP20 Strategy).

## Table of Contents
- [Features](#features)
- [Installation & Running Locally](#installation--running-locally)
- [Deployment & Configuration](#deployment--configuration)
- [API Endpoints](#api-endpoints)
    - [1. Health Check](#1-health-check)
    - [2. Public Data Endpoints](#2-public-data-endpoints)
    - [3. Trading Endpoints (Authenticated)](#3-trading-endpoints-authenticated)
        - [Risk Analyze](#risk-analyze)
        - [Validate Symbol](#validate-symbol)
        - [Get Market Data](#get-market-data)
        - [Open Position (SP20)](#open-position-sp20)
        - [Get Position](#get-position)
        - [Close Position](#close-position)
- [Analysis & Tools](#analysis--tools)

---

## Features

- 🔐 **Secure Trading**: Authenticated execution of trades using Bybit V5 API.
- 🤖 **SP20 Strategy**: Automated position entry with pre-calculated invalidation (SL) and structured take-profits (TP).
- 🛡️ **Safety Guardrails**: Pre-flight balance checks and symbol validation.
- 📊 **Real-time Data**: Ticker, Funding Rates, and 24h stats.
- 📈 **Historical Data**: Klines and stop-loss simulation tools.
- 🧠 **Risk Analyzer V3**: ATR/SL volatility filter with 14 pattern checks to gate trade execution. Prevents entries where the stop-loss is within normal price noise.

---

## Installation & Running Locally

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure Environment
Create a `.env` file in the root directory (see [Deployment & Configuration](#deployment--configuration)).

### 3. Start the Server
```bash
node server.mjs
```
The server will start on port `8080` (default).

---

## Deployment & Configuration

This service requires Bybit API Credentials to execute trades.

### Environment Variables
Create a `.env` file or configuring your cloud provider secrets:

```bash
# Bybit API Keys (Unified Trading Account Recommended)
BYBIT_API_KEY=your_api_key_here
BYBIT_API_SECRET=your_api_secret_here
BYBIT_USE_TESTNET=false # Set 'true' for Testnet

# Application Security
PORT=8080
TRADING_API_SECRET=your_secret_access_token # Bearer token for accessing trading endpoints
```

### Deploying to Fly.io

First, make sure you have it installed
`brew install flyctl`



```bash
# auth
fly auth login

# Set secrets via CLI
fly secrets set BYBIT_API_KEY=x BYBIT_API_SECRET=y TRADING_API_SECRET=z  -a bybit-ticker-fly

# Deploy
fly deploy -a bybit-ticker-fly
```

---

## API Endpoints

### 📖 Swagger UI
**Interactive Documentation**: `http://localhost:8080/api-docs`

### 1. Health Check
`GET /health`
```json
{ "status": "ok" }
```

### 2. Public Data Endpoints
*See original documentation for detailed Public API usage (Ticker/Candles/Stop-Sim).*

- **Get Ticker**: `GET /api/bybit?symbol=BTCUSDT`
- **Get Candles**: `GET /api/bybit/candles?symbol=BTCUSDT`
- **Simulate Stops**: `GET /api/bybit/stop-sim`

---

### 3. Trading Endpoints (Authenticated)
**Authentication Required**: All trading endpoints require the header:
`Authorization: Bearer <TRADING_API_SECRET>`

#### Risk Analyze
Analyzes trade risk before execution using ATR/SL volatility filtering and 14 technical patterns. Returns a go/no-go decision. Call this **before** opening a position.

`POST /api/trade/risk-analyze`
```bash
curl -X POST "http://localhost:8080/api/trade/risk-analyze" \
     -H "Authorization: Bearer <TOKEN>" \
     -H "Content-Type: application/json" \
     -d '{
           "symbol": "BTCUSDT",
           "direction": "LONG",
           "entryPrice": 95000
         }'
```

| Parameter    | Type   | Required | Description                                |
|-------------|--------|----------|--------------------------------------------|
| `symbol`    | string | Yes      | Trading pair (e.g. `BTCUSDT`)              |
| `direction` | string | Yes      | `LONG` or `SHORT`                          |
| `entryPrice`| number | No       | Entry price (defaults to last close price)  |

**Response**:
```json
{
  "symbol": "BTCUSDT",
  "direction": "LONG",
  "entryPrice": 95000,
  "riskScore": 2,
  "internalScore": 20,
  "riskLevel": "LOW",
  "shouldAvoid": false,
  "atrSlRatio": 1.69,
  "isBlacklisted": false,
  "detectedPatterns": [],
  "technicalSummary": {
    "trend": "BEARISH",
    "sma9": 95800.5,
    "sma20": 96500.2,
    "sma50": 97100.8,
    "rsi14": 48.5,
    "atr14": 1607.5,
    "bollingerUpper": 99200.1,
    "bollingerLower": 93800.3,
    "macdHistogram": -120.5,
    "distanceFromSMA20Percent": 1.56,
    "avgVolume20": 12500,
    "currentVolume": 9800,
    "volumeRatio": 0.78,
    "consecutiveCandles": 1,
    "lastClose": 95000,
    "lastHigh": 95800,
    "lastLow": 94200
  },
  "recommendation": "✅ PROCEED. Risk score: 2/10. Conditions are favorable for this trade.",
  "analyzedAt": "2026-02-25T15:30:00.000Z",
  "candlesAnalyzed": 100
}
```

**Key response fields:**
- `shouldAvoid` — **boolean**, the primary decision flag. `true` = skip the trade.
- `riskScore` — **0-10**, normalized risk score. >= 7 means avoid.
- `atrSlRatio` — **float**, ATR(14) / stop-loss distance. >= 2.5x means the stop is noise.
- `recommendation` — **string**, human-readable summary for Slack alerts.

#### Validate Symbol
Checks if a symbol is valid for Linear Perpetual trading and supports 20x leverage.

`GET /api/trade/validate/:symbol`
```bash
curl -H "Authorization: Bearer <TOKEN>" \
     "http://localhost:8080/api/trade/validate/BTCUSDT"
```
**Response**:
```json
{
  "success": true,
  "canTrade": true,
  "orderSizing": { "minOrderQty": "0.001", "qtyStep": "0.001" }
}
```

#### Get Market Data
Fetches Last Price, Mark Price, and Funding Rate.

`GET /api/trade/market/:symbol`
```bash
curl -H "Authorization: Bearer <TOKEN>" \
     "http://localhost:8080/api/trade/market/BTCUSDT"
```

#### Open Position (SP20)
Executes the SP20 Strategy:
1.  **Safety Check**: Verifies Wallet Balance > Margin * 1.01.
2.  **Execution**: Market Buy/Sell at 20x Leverage.
3.  **Protection**: Sets Stop Loss (Default 1% distance or custom `slPercentage`) and 4 Take Profits.

`POST /api/trade/open`
```bash
curl -X POST "http://localhost:8080/api/trade/open" \
     -H "Authorization: Bearer <TOKEN>" \
     -H "Content-Type: application/json" \
     -d '{
           "symbol": "BTCUSDT",
           "direction": "LONG",
           "margin": 100,
           "slPercentage": 0.01
         }'
```
**Response**:
```json
{
  "success": true,
  "execution": {
    "entryPrice": 90000,
    "quantity": "0.022",
    "orders": {
      "market": { "status": "Filled" },
      "stopLoss": { "price": "89100", "status": "Active" },
      "takeProfits": [...]
    }
  }
}
```

#### Get Position
Get active position details including real-time PnL and Risk metrics.

`GET /api/trade/position/:symbol`
```bash
curl -H "Authorization: Bearer <TOKEN>" \
     "http://localhost:8080/api/trade/position/BTCUSDT"
```

#### Close Position
Liquidates the position at Market price and cancels all open orders (TP/SL).

`POST /api/trade/close`
```bash
curl -X POST "http://localhost:8080/api/trade/close" \
     -H "Authorization: Bearer <TOKEN>" \
     -H "Content-Type: application/json" \
     -d '{ "symbol": "BTCUSDT" }'
```

---

## Analysis & Tools

### Stop-Loss Simulation
`GET /api/bybit/stop-sim`
Simulates historical stop-loss hits. Useful for backtesting risk parameters.
(See legacy docs for full params).

---

## Testing

No test framework is required — tests are standalone Node.js scripts that call the live Bybit public API.

### Risk Analyzer V3
Validates the ATR/SL volatility filter against live market data. Tests 5 scenarios: BTC LONG (safe), BTC SHORT (schema check), ETH LONG (safe), DASH SHORT (should avoid + blacklisted), and an invalid symbol (fail-safe).

```bash
node testRiskAnalyzerV3.mjs
```

**Expected output:**
```
=== Risk Analyzer V3 Tests ===

Test 1: BTCUSDT LONG
  ✅ shouldAvoid is false
  ✅ riskScore <= 4
  ✅ atrSlRatio < 2.5
  ...

=== Results ===
  Passed: 20
  Failed: 0
  Total:  20
```

> **Note:** Tests hit the live Bybit API, so ATR/SL ratios will vary with market conditions. The core assertions (BTC = safe, DASH = avoid) should remain stable due to the wide gap between their volatility profiles.

---

## About

This API Bundle was created by **Devotts** with the intention to help Devotts with his own trades automations.

Feel free to contribute and reach out with questions or suggestions at [github.com/devotts](https://github.com/devotts).
