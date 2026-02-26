import crypto from 'crypto';

const API_KEY = process.env.BYBIT_API_KEY;
const API_SECRET = process.env.BYBIT_API_SECRET;
const IS_TESTNET = process.env.BYBIT_TESTNET === 'true';

const BASE_URL = IS_TESTNET
    ? 'https://api-testnet.bybit.com'
    : 'https://api.bybit.com';

/**
 * Generates HMAC-SHA256 signature for Bybit V5
 * @param {object} params
 * @returns {string} signature
 */
function getSignature(timestamp, window, payload) {
    const raw = timestamp + API_KEY + window + payload;
    return crypto.createHmac('sha256', API_SECRET).update(raw).digest('hex');
}

/**
 * Sends a signed request to Bybit V5 API
 * @param {string} endpoint - e.g. "/v5/order/create"
 * @param {string} method - "GET" or "POST"
 * @param {object} params - Query params (GET) or Body (POST)
 */
export async function sendRequest(endpoint, method, params = {}) {
    if (!API_KEY || !API_SECRET) {
        throw new Error("Missing BYBIT_API_KEY or BYBIT_API_SECRET");
    }

    const timestamp = Date.now().toString();
    const recvWindow = '5000';
    let url = `${BASE_URL}${endpoint}`;
    let payload = '';

    if (method === 'GET') {
        const qs = new URLSearchParams(params).toString();
        if (qs) url += `?${qs}`;
        payload = qs; // For GET, payload in signature is query string
    } else {
        payload = JSON.stringify(params);
    }

    const signature = getSignature(timestamp, recvWindow, payload);

    const headers = {
        'X-BAPI-API-KEY': API_KEY,
        'X-BAPI-TIMESTAMP': timestamp,
        'X-BAPI-RECV-WINDOW': recvWindow,
        'X-BAPI-SIGN': signature,
        'Content-Type': 'application/json' // Always required
    };

    // For POST, we send body. For GET, body is null (params are in URL)
    const options = {
        method,
        headers,
        body: method === 'GET' ? undefined : payload
    };

    const response = await fetch(url, options);
    const text = await response.text();

    if (!response.ok) {
        throw new Error(`Bybit HTTP ${response.status}: ${text}`);
    }

    try {
        const data = JSON.parse(text);
        if (data.retCode !== 0) {
            throw new Error(`Bybit API Error ${data.retCode}: ${data.retMsg}`);
        }
        return data;
    } catch (e) {
        // If it's already an error we threw, rethrow it
        if (e.message.startsWith('Bybit API Error')) throw e;
        throw new Error(`Invalid JSON or API Error: ${text}`);
    }
}


const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Get order details
 */
export async function getOrder(symbol, orderId) {
    const data = await sendRequest('/v5/order/realtime', 'GET', {
        category: 'linear',
        symbol,
        orderId
    });
    return data.result.list[0];
}

/**
 * Poll order status until filled or timeout
 */
export async function waitForFill(orderId, symbol, timeoutMs = 5000) {
    const startTime = Date.now();
    const pollInterval = 200;

    while (Date.now() - startTime < timeoutMs) {
        const order = await getOrder(symbol, orderId);

        if (order.orderStatus === 'Filled') {
            return {
                success: true,
                orderId: orderId,
                status: 'Filled',
                avgPrice: order.avgPrice,
                executedQty: order.cumExecQty,
                fee: order.cumExecFee
            };
        }

        if (order.orderStatus === 'Rejected' || order.orderStatus === 'Cancelled') {
            throw new Error(`Order ${orderId} failed: ${order.orderStatus}`);
        }

        await sleep(pollInterval);
    }

    throw new Error(`Order ${orderId} fill timeout after ${timeoutMs}ms`);
}

/**
 * Set Trading Stop (Stop Loss / Take Profit)
 */
export async function setTradingStop(symbol, stopLoss, takeProfit, positionIdx = 0) {
    const params = {
        category: 'linear',
        symbol,
        positionIdx,
        tpslMode: 'Full', // Entire position
    };

    if (stopLoss) params.stopLoss = stopLoss;
    if (takeProfit) params.takeProfit = takeProfit;

    return await sendRequest('/v5/position/trading-stop', 'POST', params);
}

/**
 * Sets leverage for a symbol (Linear)
 */
export async function setLeverage(symbol, leverage) {
    try {
        await sendRequest('/v5/position/set-leverage', 'POST', {
            category: 'linear',
            symbol,
            buyLeverage: String(leverage),
            sellLeverage: String(leverage)
        });
    } catch (err) {
        // Ignore specific error codes if leverage is already modified/set
        // 110043: Leverage not modified
        // 10001: Symbol invalid (handled elsewhere?) but 110043 is the common "already set" one
        if (!err.message.includes('110043')) {
            console.warn(`Set Leverage warning: ${err.message}`);
        }
    }
}

/**
 * Gets ticker info for mark price
 */
export async function getTicker(symbol) {
    const data = await sendRequest('/v5/market/tickers', 'GET', {
        category: 'linear',
        symbol
    });
    return data.result.list[0];
}

/**
 * Detect category for a symbol
 * Returns: 'linear' | 'spot' | null
 */
async function detectCategory(symbol) {
    try {
        const linearData = await sendRequest('/v5/market/instruments-info', 'GET', { category: 'linear', symbol });
        if (linearData.retCode === 0 && linearData.result.list.length > 0 && linearData.result.list[0].status === 'Trading') {
            return { category: 'linear', data: linearData.result.list[0] };
        }
    } catch (e) { /* ignore */ }

    try {
        const spotData = await sendRequest('/v5/market/instruments-info', 'GET', { category: 'spot', symbol });
        if (spotData.retCode === 0 && spotData.result.list.length > 0 && spotData.result.list[0].status === 'Trading') {
            return { category: 'spot', data: spotData.result.list[0] };
        }
    } catch (e) { /* ignore */ }

    return { category: null, data: null };
}

/**
 * Validate if symbol can be traded with Ottimus SP20 strategy
 */
export async function validateSymbol(symbol) {
    const detection = await detectCategory(symbol);

    if (!detection.category) {
        return {
            success: false,
            canTrade: false,
            reason: `Symbol ${symbol} not found on Bybit`,
            error: { code: 'SYMBOL_NOT_FOUND' }
        };
    }

    if (detection.category === 'spot') {
        return {
            success: false,
            symbol: symbol,
            category: 'spot',
            canTrade: false,
            reason: `Symbol ${symbol} is only available for SPOT trading. LINEAR perpetual contract required for leverage trading.`,
            error: { code: 'SPOT_ONLY' }
        };
    }

    // Validate leverage
    const leverageFilter = detection.data.leverageFilter;
    const maxLeverage = parseFloat(leverageFilter.maxLeverage);
    // OPTION: Instead of failing, we verify and allow the caller to adapt
    // We just return the limits here

    // Get current ticker for market data
    const ticker = await getTicker(symbol);

    return {
        success: true,
        symbol: symbol,
        category: 'linear',
        canTrade: true,
        contractType: detection.data.contractType,
        status: detection.data.status,
        leverage: {
            min: parseFloat(leverageFilter.minLeverage),
            max: maxLeverage,
            step: parseFloat(leverageFilter.leverageStep),
            requested: 20, // Default reference
        },
        orderSizing: {
            tickSize: detection.data.priceFilter.tickSize,
            qtyStep: detection.data.lotSizeFilter.qtyStep,
            minOrderQty: detection.data.lotSizeFilter.minOrderQty,
            maxOrderQty: detection.data.lotSizeFilter.maxOrderQty
        },
        marketData: {
            lastPrice: ticker.lastPrice,
            bid: ticker.bid1Price,
            ask: ticker.ask1Price,
            change24h: ticker.price24hPcnt
        },
        features: {
            leverage: true,
            stopLoss: true,
            takeProfit: true,
            reduceOnly: true
        }
    };
}

/**
 * Get real-time market data
 */
export async function getMarketData(symbol) {
    const ticker = await getTicker(symbol);
    if (!ticker) {
        throw new Error(`Symbol ${symbol} not found`);
    }

    return {
        success: true,
        symbol: symbol,
        category: 'linear', // We assume linear for now
        timestamp: new Date().toISOString(),
        price: {
            last: ticker.lastPrice,
            bid: ticker.bid1Price,
            ask: ticker.ask1Price,
            spread: (Number(ticker.ask1Price) - Number(ticker.bid1Price)).toFixed(5), // Approximate
            markPrice: ticker.markPrice
        },
        change24h: {
            percent: ticker.price24hPcnt,
            high: ticker.highPrice24h,
            low: ticker.lowPrice24h,
            volume: ticker.volume24h,
            turnover: ticker.turnover24h
        },
        fundingRate: {
            current: ticker.fundingRate,
            nextFundingTime: new Date(Number(ticker.nextFundingTime)).toISOString()
        }
    };
}

/**
 * Opens a position with Ottimus SP20 Strategy
 * @param {object} params - { symbol, direction, leverage, margin, stop_loss_percent }
 */
/**
 * Round price to tick size
 */
function roundToTick(price, tickSize) {
    const tick = parseFloat(tickSize);
    return Math.floor(price / tick) * tick;
}

/**
 * Round quantity to step size
 */
function roundToStep(quantity, qtyStep) {
    const step = parseFloat(qtyStep);
    return Math.floor(quantity / step) * step;
}

/**
 * Opens a position with Enhanced Logic (8 Steps)
 * Default StopLoss= 20%
 * @param {object} params - { symbol, direction, leverage, margin }
 */
export async function openPosition({ symbol, direction, leverage = 20, margin, slDist = 0.2 }) {
    // STEP 0: Check Wallet Balance
    // We strictly use USDT for settlements in Linear perps.
    // We add a conservative 1% buffer for opening fees/market slippage.
    const balance = await getWalletBalance('USDT');
    const requiredMargin = margin * 1.01;

    if (balance.availableToOrder < requiredMargin) {
        // We throw 400-like error to be clearer (though here just Error)
        throw new Error(`Insufficient USDT Balance. Required: ${requiredMargin.toFixed(2)}, Available: ${balance.availableToOrder.toFixed(2)}`);
    }

    // STEP 1: Pre-flight validation
    const validation = await validateSymbol(symbol);
    if (!validation.canTrade) {
        throw new Error(validation.reason || "Symbol validation failed");
    }

    const dir = direction.toUpperCase();
    const entryPrice = parseFloat(validation.marketData.lastPrice);

    // ADAPTIVE LEVERAGE LOGIC
    let effectiveLeverage = leverage;
    if (validation.leverage.max < leverage) {
        console.warn(`[Auto-Adjust] Requested leverage ${leverage}x exceeds symbol max ${validation.leverage.max}x. Capping to ${validation.leverage.max}x.`);
        effectiveLeverage = validation.leverage.max;
    }

    // STEP 2: Calculate position size
    // Size = (Margin * Leverage) / Price
    const positionValue = margin * effectiveLeverage;
    const rawQty = positionValue / entryPrice;
    const qtyStep = validation.orderSizing.qtyStep;

    // Use floor to ensure we don't exceed margin due to rounding up
    const quantity = roundToStep(rawQty, qtyStep);

    // Validate min order qty
    const minQty = parseFloat(validation.orderSizing.minOrderQty);
    if (quantity < minQty) {
        throw new Error(`Calculated quantity ${quantity} is below minimum ${minQty} for ${symbol}`);
    }

    const qtyPrecision = getPrecision(qtyStep);
    const qtyStr = quantity.toFixed(qtyPrecision);

    // STEP 3: Set leverage (if different from current or just force set)
    // We use the effective leverage
    await setLeverage(symbol, effectiveLeverage);

    // STEP 4: Execute market order
    const side = dir === 'LONG' ? 'Buy' : 'Sell';
    const marketOrderRes = await sendRequest('/v5/order/create', 'POST', {
        category: 'linear',
        symbol,
        side,
        orderType: 'Market',
        qty: qtyStr,
        positionIdx: 0
    });
    const marketOrderId = marketOrderRes.result.orderId;

    // STEP 5: Wait for fill (poll order status)
    // We assume fill happens quickly for market orders
    const filledOrder = await waitForFill(marketOrderId, symbol, 5000);
    const actualEntryPrice = parseFloat(filledOrder.avgPrice);

    // STEP 6: Calculate and set stop loss (using provided slDist)
    // slDist should be a decimal (e.g., 0.01 for 1%)
    const slPriceRaw = dir === 'LONG'
        ? actualEntryPrice * (1 - slDist)
        : actualEntryPrice * (1 + slDist);

    const tickSize = validation.orderSizing.tickSize;
    const pricePrecision = getPrecision(tickSize);
    const slPrice = roundToTick(slPriceRaw, tickSize);
    const slPriceStr = slPrice.toFixed(pricePrecision);

    await setTradingStop(symbol, slPriceStr, null, 0);

    // STEP 7: Place TP limit orders
    // We aim for 4 split TPs (2%, 3%, 4%, 5%).
    // However, if qty/4 < minOrderQty, we must adjust to fewer orders or 1 order.

    const tpLevels = [0.02, 0.03, 0.04, 0.05];
    const rawTpDist = quantity / 4;
    // Determine workable TP size
    let tpChunk = roundToStep(rawTpDist, qtyStep);
    let validTpLevels = tpLevels;

    // If split size is too small, try splitting into 2, then 1
    if (tpChunk < minQty) {
        // Try split by 2
        if (roundToStep(quantity / 2, qtyStep) >= minQty) {
            tpChunk = roundToStep(quantity / 2, qtyStep);
            validTpLevels = [0.03, 0.05]; // Use 2 levels avg
        } else {
            // Fallback to 1 TP
            tpChunk = quantity;
            validTpLevels = [0.04]; // Single TP at avg
        }
    }

    const tpOrders = [];
    const tpSide = dir === 'LONG' ? 'Sell' : 'Buy';
    let placedQty = 0;

    for (let i = 0; i < validTpLevels.length; i++) {
        const level = validTpLevels[i];

        let thisQty = tpChunk;

        // Adjust last one to match remainder exactly to avoid "truncate to zero" or leftover
        if (i === validTpLevels.length - 1) {
            thisQty = quantity - placedQty;
            // Ensure remainder is valid (float weirdness)
            thisQty = roundToStep(thisQty, qtyStep);
        }

        if (thisQty < minQty) continue;

        const tpPriceRaw = dir === 'LONG'
            ? actualEntryPrice * (1 + level)
            : actualEntryPrice * (1 - level);

        const tpPrice = roundToTick(tpPriceRaw, tickSize);
        const tpPriceStr = tpPrice.toFixed(pricePrecision);
        const tpQtyStr = thisQty.toFixed(qtyPrecision);

        try {
            const tpOrderRes = await sendRequest('/v5/order/create', 'POST', {
                category: 'linear',
                symbol,
                side: tpSide,
                orderType: 'Limit',
                qty: tpQtyStr,
                price: tpPriceStr,
                reduceOnly: true,
                positionIdx: 0,
                timeInForce: 'GTC'
            });
            tpOrders.push({
                level: (level * 100) + '%',
                price: tpPriceStr,
                qty: tpQtyStr,
                orderId: tpOrderRes.result.orderId,
                status: 'Active'
            });
            placedQty += thisQty;
        } catch (e) {
            console.error(`Failed to place TP at ${tpPriceStr}`, e.message);
            tpOrders.push({
                level: (level * 100) + '%',
                price: tpPriceStr,
                status: `Failed: ${e.message}`
            });
        }
    }

    // STEP 8: Return execution summary
    return {
        success: true,
        execution: {
            symbol,
            direction: dir,
            leverage: effectiveLeverage,
            entryPrice: actualEntryPrice,
            quantity: qtyStr,
            positionValue: positionValue.toFixed(2),
            marginUsed: (actualEntryPrice * quantity / effectiveLeverage).toFixed(2),
            orders: {
                market: {
                    orderId: marketOrderId,
                    status: 'Filled',
                    avgPrice: actualEntryPrice,
                    fee: filledOrder.fee || "0"
                },
                stopLoss: {
                    price: slPriceStr,
                    status: 'Active',
                    distance: '1%'
                },
                takeProfits: tpOrders
            }
        }
    };
}

/**
 * Closes position for a symbol (Market Close + Cancel All)
 */
export async function closePosition(symbol) {
    if (!symbol) throw new Error("Missing symbol");

    // 1. Get Current Position Info (for PnL tracking)
    const pos = await getPosition(symbol); // We use our enhanced getPosition to get current state
    const size = parseFloat(pos.size || '0');

    if (size === 0) {
        // Cancel orders anyway just in case
        await sendRequest('/v5/order/cancel-all', 'POST', { category: 'linear', symbol });
        return {
            success: true,
            message: "No open position",
            result: { symbol, closedSize: "0", pnl: { gross: "0", percent: "0%" } }
        };
    }

    // 2. Cancel All Orders (TP/SL)
    let cancelledCount = 0;
    try {
        const cancelRes = await sendRequest('/v5/order/cancel-all', 'POST', {
            category: 'linear',
            symbol
        });
        // Bybit V5 cancel-all returns list of cancelled orders
        if (cancelRes.result && cancelRes.result.list) {
            cancelledCount = cancelRes.result.list.length;
        }
    } catch (e) {
        console.warn(`Cancel all warning: ${e.message}`);
    }

    // 3. Place Market Close Order
    const side = pos.side === 'Buy' ? 'Sell' : 'Buy';
    await sendRequest('/v5/order/create', 'POST', {
        category: 'linear',
        symbol,
        side,
        orderType: 'Market',
        qty: pos.size.toString(), // Ensure string
        reduceOnly: true,
        positionIdx: 0,
        timeInForce: "IOC" // Immediate or Cancel for market close
    });

    return {
        success: true,
        action: "Close Position",
        result: {
            symbol,
            closedSize: pos.size,
            pnl: {
                gross: pos.pnl.unrealized, // Using unrealized as close approximation
                percent: pos.pnl.roe
            },
            remainingOrdersCancelled: cancelledCount
        }
    };
}

/**
 * Gets current position info
 */
/**
 * Fetch wallet balance for a specific coin (default USDT)
 */
export async function getWalletBalance(coin = 'USDT') {
    const res = await sendRequest('/v5/account/wallet-balance', 'GET', {
        accountType: 'UNIFIED',
        coin
    });
    // console.log('Wallet Balance Raw:', JSON.stringify(res.result, null, 2));

    // Bybit returns a list. We expect one account.
    const account = res.result.list[0];
    if (!account) {
        throw new Error("No account balance found");
    }

    const coinData = account.coin.find(c => c.coin === coin);
    if (!coinData) {
        return {
            totalEquity: 0,
            availableToOrder: 0
        };
    }

    // For Unified Account (UTA), availableToWithdraw might be empty.
    // Use walletBalance (or equity) as the available funds for trading if unlocked.
    // robust parsing:
    const freeFunds = parseFloat(coinData.availableToWithdraw) || parseFloat(coinData.walletBalance) || 0;

    return {
        totalEquity: parseFloat(coinData.equity || 0),
        availableToOrder: freeFunds
    };
}

export async function getPosition(symbol) {
    if (!symbol) throw new Error("Missing symbol");

    // Parallel fetch: Position + Real-time Orders (for TP/SL visibility)
    const [posRes, ordersRes] = await Promise.all([
        sendRequest('/v5/position/list', 'GET', { category: 'linear', symbol }),
        sendRequest('/v5/order/realtime', 'GET', { category: 'linear', symbol, openOnly: 0, limit: 20 }) // Fetch recent/active orders
    ]);

    const pos = posRes.result.list[0];
    if (!pos) return { symbol, size: "0", side: "None" };

    const activeOrders = ordersRes.result.list.filter(o => o.orderStatus === 'New' || o.orderStatus === 'PartiallyFilled');

    // Categorize TP/SL
    const tpOrders = activeOrders.filter(o => o.stopOrderType === 'TakeProfit' || (o.orderType === 'Limit' && o.reduceOnly));
    const slOrders = activeOrders.filter(o => o.stopOrderType === 'StopLoss' || (o.stopLoss && o.stopLoss !== "") || (o.orderType === 'Stop' && o.reduceOnly));

    // Look for explicit SL params on position if no order found
    const slPrice = pos.stopLoss && parseFloat(pos.stopLoss) > 0 ? pos.stopLoss : (slOrders[0]?.triggerPrice || slOrders[0]?.price);

    // Extract TP prices
    const tpPrices = tpOrders.map(o => o.price || o.triggerPrice);

    return {
        symbol: pos.symbol,
        side: pos.side,
        size: pos.size,
        value: pos.positionValue,
        entryPrice: pos.avgPrice,
        markPrice: pos.markPrice,
        pnl: {
            unrealized: pos.unrealisedPnl,
            roe: (parseFloat(pos.unrealisedPnl) / parseFloat(pos.positionIM) * 100).toFixed(2) + '%' // ROE based on Initial Margin
        },
        risk: {
            leverage: pos.leverage,
            liquidationPrice: pos.liqPrice,
            marginUsed: pos.positionIM
        },
        orders: {
            tp: tpPrices,
            sl: slPrice || "None"
        }
    };
}

/**
 * Gets full orders status for a symbol (ground truth for n8n workflow)
 * Queries active orders, order history, and position in parallel
 */
export async function getOrdersStatus(symbol) {
    if (!symbol) throw new Error("Missing symbol");

    // Parallel fetch: active orders, order history, position
    const [activeRes, historyRes, posRes] = await Promise.all([
        sendRequest('/v5/order/realtime', 'GET', { category: 'linear', symbol, limit: 50 }),
        sendRequest('/v5/order/history', 'GET', { category: 'linear', symbol, limit: 50 }),
        sendRequest('/v5/position/list', 'GET', { category: 'linear', symbol })
    ]);

    // Parse position
    const rawPos = posRes.result.list[0];
    const posSize = parseFloat(rawPos?.size || '0');
    const positionExists = rawPos && posSize > 0;

    const position = positionExists ? {
        exists: true,
        side: rawPos.side,
        size: rawPos.size,
        entryPrice: rawPos.avgPrice,
        markPrice: rawPos.markPrice,
        unrealisedPnl: rawPos.unrealisedPnl,
        leverage: rawPos.leverage,
        liquidationPrice: rawPos.liqPrice,
        positionStatus: rawPos.positionStatus || 'Normal'
    } : { exists: false };

    // Parse orders
    const activeOrders = (activeRes.result.list || []);
    const historyOrders = (historyRes.result.list || []);

    // Categorize history orders
    const filledOrders = historyOrders.filter(o => o.orderStatus === 'Filled');
    const cancelledOrders = historyOrders.filter(o =>
        o.orderStatus === 'Cancelled' || o.orderStatus === 'Deactivated'
    );

    // Format order for response
    const formatOrder = (o) => ({
        orderId: o.orderId,
        type: o.orderType,
        side: o.side,
        price: o.price,
        qty: o.qty,
        ...(o.avgPrice ? { avgPrice: o.avgPrice } : {}),
        ...(o.cumExecQty ? { cumExecQty: o.cumExecQty } : {}),
        ...(o.cumExecFee ? { cumExecFee: o.cumExecFee } : {}),
        status: o.orderStatus,
        reduceOnly: o.reduceOnly,
        createdTime: new Date(parseInt(o.createdTime)).toISOString(),
        ...(o.updatedTime ? { updatedTime: new Date(parseInt(o.updatedTime)).toISOString() } : {}),
        ...(o.stopOrderType ? { stopOrderType: o.stopOrderType } : {}),
        ...(o.triggerPrice && o.triggerPrice !== '0' ? { triggerPrice: o.triggerPrice } : {})
    });

    // Merge all orders for classification
    const allOrders = [...activeOrders, ...historyOrders];

    // Determine entry price: from position if exists, otherwise from filled market order
    let entryPrice = positionExists ? parseFloat(rawPos.avgPrice) : null;
    if (!entryPrice) {
        const entryOrder = filledOrders.find(o => o.orderType === 'Market' && !o.reduceOnly);
        if (entryOrder) entryPrice = parseFloat(entryOrder.avgPrice);
    }

    // Classify TP/SL orders
    const classified = classifyTPSLOrders(allOrders, entryPrice, rawPos);

    // Add labels to formatted orders
    const labeledActive = activeOrders.map(o => {
        const fmt = formatOrder(o);
        const label = classified.orderLabels[o.orderId];
        if (label) fmt.label = label;
        return fmt;
    });

    const labeledFilled = filledOrders.map(o => {
        const fmt = formatOrder(o);
        const label = classified.orderLabels[o.orderId];
        if (label) fmt.label = label;
        return fmt;
    });

    const labeledCancelled = cancelledOrders.map(o => {
        const fmt = formatOrder(o);
        const label = classified.orderLabels[o.orderId];
        if (label) fmt.label = label;
        return fmt;
    });

    // Determine direction
    let direction = null;
    if (positionExists) {
        direction = rawPos.side === 'Buy' ? 'LONG' : 'SHORT';
    } else {
        const entryOrder = filledOrders.find(o => o.orderType === 'Market' && !o.reduceOnly);
        if (entryOrder) direction = entryOrder.side === 'Buy' ? 'LONG' : 'SHORT';
    }

    // Compute suggested status
    const suggestedStatus = determineSuggestedStatus(
        { exists: positionExists, size: posSize },
        filledOrders,
        activeOrders
    );

    // TP progress
    const filledTpCount = Object.values(classified.takeProfits).filter(tp => tp.status === 'Filled').length;
    const totalTpCount = Object.keys(classified.takeProfits).length;

    // Build summary
    const summary = {
        hasOpenPosition: positionExists,
        ...(direction ? { direction } : {}),
        totalOrders: activeOrders.length + filledOrders.length + cancelledOrders.length,
        activeOrders: activeOrders.length,
        filledOrders: filledOrders.length,
        cancelledOrders: cancelledOrders.length,
        stopLoss: classified.stopLoss
            ? {
                status: classified.stopLoss.status,
                ...(classified.stopLoss.triggerPrice ? { triggerPrice: classified.stopLoss.triggerPrice } : {}),
                ...(classified.stopLoss.price && classified.stopLoss.price !== '0' ? { price: classified.stopLoss.price } : {}),
                orderId: classified.stopLoss.orderId
            }
            : (rawPos?.stopLoss && parseFloat(rawPos.stopLoss) > 0
                ? { status: 'Active', triggerPrice: rawPos.stopLoss, source: 'position' }
                : null),
        takeProfits: classified.takeProfits,
        tpProgress: `${filledTpCount}/${totalTpCount}`,
        suggestedStatus
    };

    // PnL calculation from filled orders
    const entryOrder = filledOrders.find(o => o.orderType === 'Market' && !o.reduceOnly);
    if (entryOrder) {
        const entryPx = parseFloat(entryOrder.avgPrice);
        const entryQty = parseFloat(entryOrder.cumExecQty);
        const dir = entryOrder.side === 'Sell' ? 'SHORT' : 'LONG';

        let grossPnl = 0;
        const tpFills = filledOrders.filter(o => o.reduceOnly && o.orderType === 'Limit');
        for (const tp of tpFills) {
            const exitPrice = parseFloat(tp.avgPrice);
            const qty = parseFloat(tp.cumExecQty);
            grossPnl += dir === 'SHORT'
                ? (entryPx - exitPrice) * qty
                : (exitPrice - entryPx) * qty;
        }

        const slFill = filledOrders.find(o => o.stopOrderType === 'StopLoss' && o.orderStatus === 'Filled');
        if (slFill) {
            const slPrice = parseFloat(slFill.avgPrice);
            const slQty = parseFloat(slFill.cumExecQty);
            grossPnl += dir === 'SHORT'
                ? (entryPx - slPrice) * slQty
                : (slPrice - entryPx) * slQty;
        }

        const totalFees = filledOrders.reduce((sum, o) => sum + parseFloat(o.cumExecFee || 0), 0);
        const leverage = 20;
        const margin = (entryQty * entryPx) / leverage;

        summary.pnl = {
            gross: parseFloat(grossPnl.toFixed(4)),
            fees: parseFloat((-totalFees).toFixed(4)),
            net: parseFloat((grossPnl - totalFees).toFixed(4)),
            roe: parseFloat(((grossPnl - totalFees) / margin).toFixed(4)),
            margin: parseFloat(margin.toFixed(4)),
            currency: 'USDT'
        };
    }

    return {
        success: true,
        symbol,
        timestamp: new Date().toISOString(),
        position,
        orders: {
            active: labeledActive,
            filled: labeledFilled,
            cancelled: labeledCancelled
        },
        summary
    };
}

/**
 * Classify orders into TP/SL labels based on price distance from entry
 */
function classifyTPSLOrders(allOrders, entryPrice, rawPosition) {
    const orderLabels = {};
    let stopLoss = null;
    const takeProfits = {};

    // Find SL order
    const slOrder = allOrders.find(o =>
        o.stopOrderType === 'StopLoss' ||
        (o.orderType === 'Market' && o.triggerPrice && o.triggerPrice !== '0' && o.reduceOnly)
    );

    if (slOrder) {
        stopLoss = {
            status: slOrder.orderStatus,
            triggerPrice: slOrder.triggerPrice || slOrder.price,
            price: slOrder.price,
            orderId: slOrder.orderId
        };
        orderLabels[slOrder.orderId] = 'SL';
    }

    // Find TP orders: reduce-only limit orders
    const tpOrders = allOrders.filter(o =>
        o.reduceOnly === true && o.orderType === 'Limit'
    );

    if (entryPrice && tpOrders.length > 0) {
        // Sort by distance from entry (closest = TP1)
        const sorted = [...tpOrders].sort((a, b) => {
            const distA = Math.abs(parseFloat(a.price) - entryPrice);
            const distB = Math.abs(parseFloat(b.price) - entryPrice);
            return distA - distB;
        });

        // Deduplicate by orderId (order may appear in both active and history)
        const seen = new Set();
        sorted.forEach((o) => {
            if (seen.has(o.orderId)) return;
            seen.add(o.orderId);

            const idx = seen.size;
            const label = `TP${idx}`;
            orderLabels[o.orderId] = label;

            takeProfits[label] = {
                status: o.orderStatus,
                price: o.price,
                qty: o.orderStatus === 'Filled' ? (o.cumExecQty || o.qty) : o.qty,
                orderId: o.orderId,
                ...(o.orderStatus === 'Filled' && o.updatedTime
                    ? { filledAt: new Date(parseInt(o.updatedTime)).toISOString() }
                    : {})
            };
        });
    }

    return { stopLoss, takeProfits, orderLabels };
}

/**
 * Determine suggested trade status based on position and order state
 */
function determineSuggestedStatus(position, filledOrders, activeOrders) {
    // No position = fully resolved
    if (!position.exists || position.size === 0) {
        const slFilled = filledOrders.some(o =>
            o.stopOrderType === 'StopLoss' ||
            (o.orderType === 'Market' && o.triggerPrice && o.triggerPrice !== '0' && o.reduceOnly)
        );
        if (slFilled) return 'STOPPED';

        const tpsFilled = filledOrders.filter(o => o.reduceOnly && o.orderType === 'Limit');
        if (tpsFilled.length > 0) return 'CLOSED';

        return 'CLOSED';
    }

    // Position exists — check if any TPs filled
    const tpsFilled = filledOrders.filter(o => o.reduceOnly && o.orderType === 'Limit');
    if (tpsFilled.length > 0) return 'PARTIAL';

    // Position exists, nothing filled yet
    return 'OPEN';
}

/**
 * Helper to count decimals for toFixed
 */
function getPrecision(step) {
    if (!step) return 2;
    const str = step.toString();
    if (str.includes('e-')) {
        return parseInt(str.split('e-')[1], 10);
    }
    const split = str.split('.');
    return split.length > 1 ? split[1].length : 0;
}
