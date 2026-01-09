# Ottimus Integration Guide: Bybit Trading API

## 🤖 For AI Agents & Developers
This guide details how to integrate the **Bybit Trading Microservice** with **n8n** and **Airtable**. 
This API handles the complex execution logic (SP20 Strategy), allowing n8n to focus on orchestration and data persistence.

---

## 🔐 Authentication
All requests must include the **Service Token** in the header.
This should be stored as a credential in n8n.

- **Header**: `Authorization`
- **Value**: `Bearer <TRADING_API_SECRET>`

---

## 🔄 Trade Lifecycle Workflow

### Phase 1: Pre-Trade Checks (n8n)
*Goal: Ensure trade is safe and valid before creating an Airtable record.*

#### Step 1: Check Market Conditions
Call `GET /api/trade/market/:symbol` (e.g., `BTCUSDT`).
- **Use Response**: Check `fundingRate.current`. If highly negative/positive (depending on strategy), you might crave to abort.
- **Airtable**: Log `marketData.price.markPrice` as "Signal Price".

#### Step 2: Validate Symbol
Call `GET /api/trade/validate/:symbol`.
- **Logic**: If `success: false` or `canTrade: false`, **HALT** the workflow.
- **Error Handling**: Log `error.reason` to Airtable "Validation Logs".

---

### Phase 2: Execution (n8n)
*Goal: Execute the SP20 Strategy and persist Order IDs for tracking.*

#### Step 3: Open Position
Call `POST /api/trade/open`.
**Payload**:
```json
{
  "symbol": "BTCUSDT",
  "direction": "LONG",
  "margin": 100
}
```

**✅ Success Response (Persist to Airtable)**:
The API performs a "Balance Safety Check" automatically. If successful, you receive the full execution details.

**Map these fields to Airtable `Trades` Table:**
| API Field | Airtable Field | Description |
|-----------|----------------|-------------|
| `execution.entryPrice` | `Entry Price` | Actual fill price of Market Order |
| `execution.quantity` | `Position Size` | Size in base coin (e.g., 0.002 BTC) |
| `execution.orders.stopLoss.price` | `SL Price` | Initial Stop Loss Price |
| `execution.orders.stopLoss.status` | `SL Status` | Should be "Active" |
| `execution.orders.takeProfits` | `TP Details` | JSON Array of TP Orders (ID + Price) |

**❌ Failure Response (Handle Errors)**:
- `10001` (Insufficient Balance): Send Alert to Telegram. Do NOT Create Trade Record.
- `10005` (Permission Denied): Check API Keys.

---

### Phase 3: Monitoring (Dashboard / n8n Polling)
*Goal: Update PnL and Risk Metrics in real-time.*

#### Step 4: Get Position Details
Call `GET /api/trade/position/:symbol`.

**Map these fields to Airtable/Dashboard:**
| API Field | Airtable Field | Description |
|-----------|----------------|-------------|
| `pnl.unrealized` | `Unrealized PnL` | Current profit/loss in USDT |
| `pnl.roe` | `ROE %` | Return on Equity percentage |
| `risk.distToLiq` | `Liquidation Distance` | Distance to Liquidation Price |
| `orders.sl` | `Current SL` | Dynamic SL price (if trailing) |

---

### Phase 4: Exit Strategy (n8n / Dashboard)
*Goal: Close trade and record final outcome.*

#### Step 5: Close Position
Call `POST /api/trade/close`.
**Payload**: `{"symbol": "BTCUSDT"}`

**✅ Success Response (Update Airtable)**:
**Map these fields to Airtable `Trades` Table:**
| API Field | Airtable Field | Description |
|-----------|----------------|-------------|
| `result.closedSize` | `Closed Size` | Amount closed |
| `result.pnl.gross` | `Realized PnL` | Final PnL from the trade |
| `result.pnl.percent` | `Final ROE %` | Final percentage |
| `success` | `Status` | Update record to "CLOSED" |

---

## ⚠️ Common Error Codes
Handle these specifically in your n8n "Switch" nodes:

| Code | Meaning | Action |
|------|---------|--------|
| `10001` | **Insufficient Balance** | Abort Entry. Notify User. |
| `10005` | **Permission Denied** | Check Bybit API Key Permissions (needs "Unified Trading"). |
| `10014` | **Invalid Symbol** | Symbol does not exist or is not Linear Perp. |
| `110017` | **Order Qty Too Small** | Increase Margin. (API tries to auto-fix this, but if it fails, margin is too low). |
