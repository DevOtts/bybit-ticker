# Bybit Ticker API

A lightweight Express.js API server that provides endpoints for fetching Bybit cryptocurrency market data and performing stop-loss simulations.

## Features

- 📊 Real-time ticker data across multiple categories (spot, linear, inverse)
- 📈 Historical candlestick (kline) data with flexible intervals
- 🎯 Stop-loss simulation with customizable percentages
- 🔍 Automatic symbol category detection
- 📅 Time-based data fetching with automatic limit calculation

## Installation

```bash
npm install
```

## Running the Server

```bash
node server.mjs
```

The server will start on port `8080` by default (or the port specified in the `PORT` environment variable).

## API Endpoints

### 1. Health Check

Check if the server is running.

**Endpoint:** `GET /health`

**Example Request:**
```bash
curl http://localhost:8080/health
```

**Example Response:**
```json
{
  "status": "ok"
}
```

---

### 2. Get Ticker Data

Fetch current ticker information for a symbol. Automatically searches across spot, linear, and inverse categories.

**Endpoint:** `GET /api/bybit`

**Query Parameters:**
- `symbol` (required) - Trading pair symbol (e.g., `BTCUSDT`, `ETHUSDT`)

**Example Request:**
```bash
curl "http://localhost:8080/api/bybit?symbol=BTCUSDT"
```

**Example Response:**
```json
{
  "retCode": 0,
  "retMsg": "OK",
  "result": {
    "category": "linear",
    "list": [
      {
        "symbol": "BTCUSDT",
        "lastPrice": "43250.50",
        "bid1Price": "43250.00",
        "ask1Price": "43250.50",
        "volume24h": "28450.123",
        "turnover24h": "1230456789.50"
      }
    ]
  },
  "time": 1732095123456
}
```

---

### 3. Get Candlestick Data

Fetch historical candlestick (kline) data with parsed OHLCV format.

**Endpoint:** `GET /api/bybit/candles`

**Query Parameters:**
- `symbol` (required) - Trading pair symbol
- `category` (optional, default: `linear`) - Market category (`spot`, `linear`, `inverse`)
- `interval` (optional, default: `1`) - Time interval in minutes (`1`, `5`, `15`, `60`, `D`, `W`, `M`)
- `limit` (optional, default: `10`) - Number of candles to fetch (max: 200)
- `start` (optional) - Start timestamp in milliseconds
- `end` (optional) - End timestamp in milliseconds

**Example Request:**
```bash
curl "http://localhost:8080/api/bybit/candles?symbol=BTCUSDT&interval=60&limit=5"
```

**Example Response:**
```json
{
  "meta": {
    "symbol": "BTCUSDT",
    "category": "linear",
    "interval": "60",
    "limit": "5"
  },
  "retCode": 0,
  "retMsg": "OK",
  "candles": [
    {
      "startTime": 1732093200000,
      "startTimeISO": "2024-11-20T10:00:00.000Z",
      "open": 43200.50,
      "high": 43350.75,
      "low": 43150.25,
      "close": 43250.00,
      "volume": 125.45,
      "turnover": 5428750.50
    }
  ],
  "time": 1732095123456
}
```

---

### 4. Stop-Loss Simulation

Simulate stop-loss hits based on historical price data. Automatically calculates the number of candles needed from your entry date to now.

**Endpoint:** `GET /api/bybit/stop-sim`

**Query Parameters:**
- `symbol` (required) - Trading pair symbol
- `entryPrice` (required) - Your entry price (e.g., `0.1257`)
- `entryDate` (required) - Entry date in ISO format (e.g., `2025-11-10T14:52:00Z`)
- `direction` (optional, default: `LONG`) - Position direction (`LONG` or `SHORT`)
- `category` (optional, default: `linear`) - Market category
- `interval` (optional, default: `1`) - Candlestick interval in minutes
- `stopPercents` (optional, default: `10,15,20`) - Stop-loss percentages (comma-separated)
- `includeCandles` (optional, default: `false`) - Include full candle data in response

**How it works:**
1. Calculates time difference between entry date and now
2. Determines how many candles are needed based on the interval
3. Fetches historical data starting from entry date
4. Simulates whether each stop-loss percentage would have been hit
5. Returns hit status and timestamps for each stop level

**Example Request (LONG position):**
```bash
curl "http://localhost:8080/api/bybit/stop-sim?symbol=BTCUSDT&direction=LONG&entryPrice=43000&entryDate=2024-11-19T10:00:00Z&interval=60&stopPercents=5,10,15"
```

**Example Response:**
```json
{
  "meta": {
    "symbol": "BTCUSDT",
    "category": "linear",
    "interval": "60",
    "entryDate": "2024-11-19T10:00:00Z",
    "entryTimestamp": 1732010400000,
    "direction": "LONG",
    "entryPrice": 43000,
    "stopPercents": [5, 10, 15],
    "computedLimit": 24,
    "cappedLimit": 24,
    "actualCandlesReceived": 24
  },
  "retCode": 0,
  "retMsg": "OK",
  "minLowSinceEntry": 40850.25,
  "maxHighSinceEntry": 44250.75,
  "stops": {
    "5": {
      "percent": 5,
      "price": 40850,
      "hit": true,
      "firstHitTime": 1732015800000,
      "firstHitTimeISO": "2024-11-19T11:30:00.000Z"
    },
    "10": {
      "percent": 10,
      "price": 38700,
      "hit": false,
      "firstHitTime": null,
      "firstHitTimeISO": null
    },
    "15": {
      "percent": 15,
      "price": 36550,
      "hit": false,
      "firstHitTime": null,
      "firstHitTimeISO": null
    }
  },
  "time": 1732095123456
}
```

**Example Request (SHORT position):**
```bash
curl "http://localhost:8080/api/bybit/stop-sim?symbol=CROSSUSDT&direction=SHORT&entryPrice=0.1257&entryDate=2024-11-10T14:52:00Z&interval=1&stopPercents=10,15,20"
```

**SHORT Position Explanation:**
- For SHORT positions, stop-losses trigger when price goes **UP**
- Stop-loss price = `entryPrice * (1 + percent/100)`
- Example: Entry at $0.1257, 10% stop = $0.13827 (0.1257 × 1.10)

**Understanding the Response:**

- **`computedLimit`**: Raw calculated number of candles between entry date and now
- **`cappedLimit`**: Actual limit used (Bybit max is 200)
- **`actualCandlesReceived`**: How many candles Bybit returned
- **`minLowSinceEntry`**: Lowest price reached since entry
- **`maxHighSinceEntry`**: Highest price reached since entry
- **`stops`**: Object containing each stop-loss level:
  - `percent`: The percentage level
  - `price`: Calculated stop-loss price
  - `hit`: Whether this stop was triggered
  - `firstHitTime`: Timestamp when stop was first hit (null if not hit)
  - `firstHitTimeISO`: ISO string of hit time

**Important Notes:**

1. **Bybit Limit**: The API can only fetch a maximum of 200 candles per request. If your entry date requires more candles (e.g., 40 days ago with 1-minute intervals), you'll only get the first 200 candles from your entry date.

2. **Date Format**: Use ISO 8601 format for `entryDate`: `YYYY-MM-DDTHH:mm:ss.sssZ`

3. **Future Dates**: Entry dates in the future will return an error.

4. **Time Calculation**: The endpoint automatically calculates how many candles are needed:
   - Time difference = Now - Entry Date
   - Candles needed = Time difference / Interval duration
   - Capped at 200 maximum

---

## Interval Options

Available intervals for candlestick data:

| Interval | Description |
|----------|-------------|
| `1`, `3`, `5`, `15`, `30` | Minutes |
| `60`, `120`, `240`, `360`, `720` | Minutes (1h, 2h, 4h, 6h, 12h) |
| `D` | Daily |
| `W` | Weekly |
| `M` | Monthly |

---

## Error Responses

All endpoints return appropriate HTTP status codes and error messages:

**400 Bad Request:**
```json
{
  "error": "Missing 'symbol' query param"
}
```

**500 Internal Server Error:**
```json
{
  "error": "Internal error",
  "details": "Connection timeout"
}
```

---

## Use Cases

### Trading Strategy Backtesting
Use the stop-loss simulation to backtest your stop-loss strategies:
```bash
# Test if a 10% stop on BTC would have been hit in the last hour
curl "http://localhost:8080/api/bybit/stop-sim?symbol=BTCUSDT&entryPrice=43000&entryDate=2024-11-20T09:00:00Z&interval=1&stopPercents=10"
```

### Risk Management Analysis
Analyze historical volatility to set appropriate stop-losses:
```bash
# Get 1-hour candles to analyze price swings
curl "http://localhost:8080/api/bybit/candles?symbol=ETHUSDT&interval=60&limit=24"
```

### Real-Time Monitoring
Monitor current market prices:
```bash
# Get latest ticker for quick price checks
curl "http://localhost:8080/api/bybit?symbol=BTCUSDT"
```

---

## Technical Details

- Built with Express.js and ES modules
- Fetches data from Bybit V5 API
- No authentication required for market data endpoints
- Supports spot, linear (USDT perpetual), and inverse (coin-margined) markets
- Automatic retry across different market categories

---

## Deployment

The project includes configuration for deployment on Fly.io:

```bash
fly deploy
```

---

## License

ISC

---

## Support

For issues or questions, please open an issue on the repository.

