# PRD: Bybit Trading API (Microservice)

## 1. Overview
This document defines the requirements for adding **Real Trading Capabilities** to the existing `bybit-ticker-fly` microservice.
The goal is to enable **Ottimus (n8n)** to execute trades on Bybit via a simple HTTP interface, bypassing Vercel/IP restrictions.

## 2. Architecture & Security

### 2.1 Authentication (Client -> Microservice)
Since this service is public, we must protect the trading endpoints.
- **Mechanism:** Simple Bearer Token.
- **Env Var:** `TRADING_API_SECRET`
- **Header:** `Authorization: Bearer <TRADING_API_SECRET>`
- **Behavior:** If the header does not match the env var, return `401 Unauthorized`.

### 2.2 Bybit Authentication (Microservice -> Bybit)
The service will hold the Bybit credentials.
- **Env Vars:**
    - `BYBIT_API_KEY`: The API Key with "Orders" and "Positions" permissions (Linear).
    - `BYBIT_API_SECRET`: The API Secret.
    - `BYBIT_TESTNET`: `true` or `false` (Default: `false`).

---

## 3. Endpoints

### 3.1 Open Position (Strategy Execution)
**POST** `/api/trade/open`

**Purpose:** Executes a "Market Open" with the specific **Ottimus SP20 Strategy** (20x Leverage, 20% Hard SL, 4 Split TPs).

**Request Body:**
```json
{
  "symbol": "BTCUSDT",        // Required
  "direction": "LONG",        // "LONG" or "SHORT"
  "leverage": 20,             // Default: 20
  "margin": 100,              // Margin to use in USDT (e.g., $100)
  "stop_loss_percent": 0.20   // Default: 0.20 (20%)
}
```

**Workflow Logic (Atomic Execution):**
The server must perform these steps in sequence:

1.  **Switch Position Mode:** Ensure the user is in **One-Way Mode** (or manage Hedge Mode explicitly, but One-Way is simpler for automated bots).
2.  **Set Leverage:** Call `set-leverage` to ensure the symbol is at `20x` (Ignore error if "already set").
3.  **Calculate Size:**
    *   `Price` = Get current Mark Price.
    *   `Qty` (in Coins) = `(Margin * Leverage) / Price`.
    *   *Round Qty to correct precision (lot size) for the symbol.*
4.  **Place Main Order:**
    *   **Type:** Market
    *   **Qty:** Calculated Qty
    *   **Stop Loss:** Trigger Price calculated based on Entry (Mark Price) and `stop_loss_percent`.
        *   LONG SL = `Price * (1 - 0.20/20)` note: 20% ROE at 20x is 1% price movement.
        *   *Correction:* User rule is "Stop Loss 20% ROE". With 20x leverage, that is a **1% Price Change**.
    *   **Tag:** Assign a unique `orderLinkId` if possible for tracking.
5.  **Place Take Profits (The "4 TPs" Strategy):**
    *   Immediately after the order fills (or concurrently if using `Order` with `stopLoss` param):
    *   Calculate TP Prices for **40%, 60%, 80%, 100% ROE**.
        *   TP1 (40% ROE) = +2% Price Move.
        *   TP2 (60% ROE) = +3% Price Move.
        *   TP3 (80% ROE) = +4% Price Move.
        *   TP4 (100% ROE) = +5% Price Move.
    *   Place **4 Limit Orders** (Reduce-Only):
        *   Qty: 25% of Total Position Size each.
        *   Price: The specific TP price.

**Response (200 OK):**
```json
{
  "status": "success",
  "trade_id": "12345678",        // Bybit Order ID
  "symbol": "BTCUSDT",
  "entry_price": 50000,
  "qty": 0.123,
  "tp_orders": ["id1", "id2", "id3", "id4"]
}
```

---

### 3.2 Close Position (Panic Button)
**POST** `/api/trade/close`

**Purpose:** Immediately closes the entire position for a symbol and cancels all pending orders (TPs).

**Request Body:**
```json
{
  "symbol": "BTCUSDT"
}
```

**Workflow Logic:**
1.  **Cancel All Orders:** Cancel all Active/Limit orders for `symbol`.
2.  **Market Close:** Place a Market Order to close the entire `size` of the current position.

**Response (200 OK):**
```json
{
  "status": "closed",
  "symbol": "BTCUSDT",
  "pnl": 15.50  // Realized PnL if available immediately, else null
}
```

---

### 3.3 Get Position Info
**GET** `/api/trade/position?symbol=BTCUSDT`

**Purpose:** Check health of a specific trade.

**Response (200 OK):**
```json
{
  "symbol": "BTCUSDT",
  "size": 1.5,           // Positive for Long, Negative/Abs for Short (depending on API)
  "side": "Buy",         // or "Sell"
  "entry_price": 50100,
  "mark_price": 50200,
  "unrealized_pnl": 30.00,
  "unrealized_roe": 0.60, // 60%
  "leverage": 20
}
```

## 4. Technical Stack Requirements
- **Library:** Use `bybit-api` (node-client) or raw `App.fetch` signed logic. *Recommendation: Use a lightweight wrapper or raw signed fetch to keep the repo simple as per "bybit-ticker" philosophy.*
- **Crypto:** Use `crypto` module to generate `HmacSHA256` signature for Bybit V5.

## 5. Error Handling
- **Insufficient Balance:** Return `400 Bad Request` with message "Insufficient Funds".
- **Invalid Symbol:** Return `400 Bad Request`.
- **API Error:** Return `502 Bad Gateway` if Bybit causes issues.
