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
```bash
# Set secrets via CLI
fly secrets set BYBIT_API_KEY=x BYBIT_API_SECRET=y TRADING_API_SECRET=z

# Deploy
fly deploy
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

## About

This API Bundle was created by **Devotts** with the intention to help Devotts with his own trades automations.

Feel free to contribute and reach out with questions or suggestions at [github.com/devotts](https://github.com/devotts).
