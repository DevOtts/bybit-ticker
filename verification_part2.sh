#!/bin/bash

BASE_URL="http://localhost:8080/api/trade"
SECRET="my-secret-token"

echo "=============================================="
echo "      Bybit Trading API Part 2 Verification   "
echo "=============================================="

# 1. Validation Logic
echo "\n[1] Testing Validation Endpoint (BTCUSDT - Valid)"
curl -s -X GET "$BASE_URL/validate/BTCUSDT" \
  -H "Authorization: Bearer $SECRET" | json_pp

echo "\n[1b] Testing Validation Endpoint (XXXXXX - Invalid)"
curl -s -X GET "$BASE_URL/validate/XXXXXX" \
  -H "Authorization: Bearer $SECRET" | json_pp

# 2. Market Data
echo "\n[2] Testing Market Data (BTCUSDT)"
curl -s -X GET "$BASE_URL/market/BTCUSDT" \
  -H "Authorization: Bearer $SECRET" | json_pp

# 2b. Balance Safety Check (Epic 10)
echo "\n[2b] Testing Insufficient Balance Logic (Safety Check)"
curl -s -X POST "$BASE_URL/open" \
  -H "Authorization: Bearer $SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "symbol": "BTCUSDT",
    "direction": "LONG",
    "margin": 1000000
  }' | json_pp

# 3. Open Position (Enhanced Flow)
echo "\n[3] Testing Open Position (BTCUSDT, LONG, Margin=11)"
# Note: Using min margin to ensure it works
curl -s -X POST "$BASE_URL/open" \
  -H "Authorization: Bearer $SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "symbol": "BTCUSDT",
    "direction": "LONG",
    "margin": 11,
    "leverage": 20
  }' | json_pp

# Wait a bit for orders to settle (though openPosition waits for fill)
sleep 2

# 4. Get Position (Enhanced Monitoring)
echo "\n[4] Testing Get Position (BTCUSDT)"
curl -s -X GET "$BASE_URL/position/BTCUSDT" \
  -H "Authorization: Bearer $SECRET" | json_pp

# 5. Close Position (Enhanced Summary)
echo "\n[5] Testing Close Position (BTCUSDT)"
curl -s -X POST "$BASE_URL/close" \
  -H "Authorization: Bearer $SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "symbol": "BTCUSDT"
  }' | json_pp

echo "\n=============================================="
echo "Verification Complete"
