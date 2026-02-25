// riskAnalyzerService.mjs — Risk Analyzer V3: ATR/SL Volatility Filter
import { getCandles } from './priceService.mjs';
import { fetchBlacklist } from './airtableService.mjs';

// ─── Constants ───────────────────────────────────────────────────────────────
const SL_DISTANCE_PERCENT = 0.01; // 1% stop-loss (Ottimus SP20 strategy)
const ATR_PERIOD = 14;
const RSI_PERIOD = 14;
const BB_PERIOD = 20;
const BB_STDDEV = 2;
const MACD_FAST = 12;
const MACD_SLOW = 26;
const MACD_SIGNAL = 9;
const CANDLE_LIMIT = '100';
const CANDLE_INTERVAL = '240'; // 4H

// ─── Technical Indicator Functions ───────────────────────────────────────────

/** ATR with Wilder's smoothing */
function calculateATR(candles, period = ATR_PERIOD) {
  if (candles.length < period + 1) return null;

  const trs = [candles[0].high - candles[0].low];
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].high;
    const l = candles[i].low;
    const pc = candles[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }

  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
  }

  return atr;
}

/** RSI with Wilder's smoothing */
function calculateRSI(closes, period = RSI_PERIOD) {
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

  for (let i = period; i < deltas.length; i++) {
    avgGain = (avgGain * (period - 1) + Math.max(deltas[i], 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.abs(Math.min(deltas[i], 0))) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

/** Simple Moving Average (last `period` values) */
function calculateSMA(values, period) {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

/** EMA series — returns array of all EMA values */
function calculateEMASeries(values, period) {
  if (values.length < period) return [];
  const k = 2 / (period + 1);
  const sma = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const result = [sma];
  for (let i = period; i < values.length; i++) {
    result.push(values[i] * k + result[result.length - 1] * (1 - k));
  }
  return result;
}

/** EMA — returns final value only */
function calculateEMA(values, period) {
  const series = calculateEMASeries(values, period);
  return series.length > 0 ? series[series.length - 1] : null;
}

/** Bollinger Bands: SMA20 ± 2σ */
function calculateBollingerBands(closes, period = BB_PERIOD, multiplier = BB_STDDEV) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const middle = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((sum, v) => sum + (v - middle) ** 2, 0) / period;
  const stddev = Math.sqrt(variance);
  return {
    middle,
    upper: middle + multiplier * stddev,
    lower: middle - multiplier * stddev,
  };
}

/** MACD: line, signal, histogram */
function calculateMACD(closes, fast = MACD_FAST, slow = MACD_SLOW, signal = MACD_SIGNAL) {
  if (closes.length < slow + signal) return null;
  const emaFastSeries = calculateEMASeries(closes, fast);
  const emaSlowSeries = calculateEMASeries(closes, slow);

  // Align series: emaFast starts at index (fast-1), emaSlow starts at index (slow-1)
  // Take the tail of emaFast to match emaSlowSeries length
  const offset = slow - fast;
  const alignedFast = emaFastSeries.slice(offset);
  const macdLine = alignedFast.map((f, i) => f - emaSlowSeries[i]);

  if (macdLine.length < signal) return null;
  const signalSeries = calculateEMASeries(macdLine, signal);
  const signalOffset = macdLine.length - signalSeries.length;
  const lastMacd = macdLine[macdLine.length - 1];
  const lastSignal = signalSeries[signalSeries.length - 1];

  return {
    macdLine: lastMacd,
    signalLine: lastSignal,
    histogram: lastMacd - lastSignal,
  };
}

// ─── Utility Functions ───────────────────────────────────────────────────────

function determineTrend(sma9, sma20, sma50) {
  if (sma9 == null || sma20 == null || sma50 == null) return 'NEUTRAL';
  if (sma9 > sma20 && sma20 > sma50) return 'BULLISH';
  if (sma9 < sma20 && sma20 < sma50) return 'BEARISH';
  return 'NEUTRAL';
}

function getRiskLevel(riskScore) {
  if (riskScore >= 7) return 'HIGH';
  if (riskScore >= 5) return 'MEDIUM';
  return 'LOW';
}

function buildRecommendation(shouldAvoid, riskScore, atrSlRatio, detectedPatterns) {
  const ratioStr = atrSlRatio != null ? atrSlRatio.toFixed(1) : '?';
  if (shouldAvoid) {
    return `⛔ AVOID this trade. Risk score: ${riskScore}/10. ATR/SL ratio ${ratioStr}x — the 1% stop will be hit by normal price noise.`;
  }
  if (riskScore >= 5) {
    return `⚠️ CAUTION. Risk score: ${riskScore}/10. Enter with reduced size or tighter risk management.`;
  }
  return `✅ PROCEED. Risk score: ${riskScore}/10. Conditions are favorable for this trade.`;
}

// ─── Pattern Detection Functions ─────────────────────────────────────────────
// Each returns { detected, score, confidence, details }

/** P0: ATR/SL Ratio Critical — PRIMARY FILTER (+40) */
function checkP0_AtrSlRatio(ctx) {
  const { atrSlRatio } = ctx;
  if (atrSlRatio == null) return { detected: false, score: 0, confidence: 0, details: 'ATR unavailable' };
  if (atrSlRatio >= 2.5) {
    return {
      detected: true,
      score: 40,
      confidence: Math.min(1.0, atrSlRatio / 5.0),
      details: `ATR/SL ratio ${atrSlRatio.toFixed(1)}x exceeds 2.5x threshold — stop is noise`,
    };
  }
  return { detected: false, score: 0, confidence: 0, details: `ATR/SL ratio ${atrSlRatio.toFixed(1)}x within safe range` };
}

/** P1: Double-Tap Exhaustion (+30) */
function checkP1_DoubleTap(ctx) {
  const { candles, entryPrice, direction } = ctx;
  const lookback = candles.slice(-20);
  let touches = 0;
  const threshold = entryPrice * 0.003; // 0.3% proximity

  for (const c of lookback) {
    if (direction === 'LONG' && Math.abs(c.high - entryPrice) <= threshold) touches++;
    if (direction === 'SHORT' && Math.abs(c.low - entryPrice) <= threshold) touches++;
  }

  if (touches >= 2) {
    return {
      detected: true,
      score: 30,
      confidence: Math.min(1.0, touches / 4),
      details: `Price tested ${entryPrice} level ${touches} times — exhaustion zone`,
    };
  }
  return { detected: false, score: 0, confidence: 0, details: `${touches} touches near entry` };
}

/** P2: Extended Move Exhaustion (+25) */
function checkP2_ExtendedMove(ctx) {
  const { candles, direction, distanceFromSMA20Percent } = ctx;
  let consecutive = 0;
  for (let i = candles.length - 1; i >= 0; i--) {
    const c = candles[i];
    const isUp = c.close > c.open;
    if ((direction === 'LONG' && isUp) || (direction === 'SHORT' && !isUp)) {
      consecutive++;
    } else {
      break;
    }
  }

  if (consecutive >= 3 && distanceFromSMA20Percent > 3) {
    return {
      detected: true,
      score: 25,
      confidence: Math.min(1.0, consecutive / 5),
      details: `${consecutive} consecutive ${direction} candles, ${distanceFromSMA20Percent.toFixed(1)}% from SMA20 — extended move`,
    };
  }
  return { detected: false, score: 0, confidence: 0, details: `${consecutive} consecutive candles, ${distanceFromSMA20Percent.toFixed(1)}% from SMA20` };
}

/** P3: Low Volume Breakout (+20) */
function checkP3_LowVolumeBreakout(ctx) {
  const { candles, direction, volumeRatio } = ctx;
  if (candles.length < 11) return { detected: false, score: 0, confidence: 0, details: 'Insufficient candles' };

  const lastCandle = candles[candles.length - 1];
  const prior = candles.slice(-11, -1);

  const highestHigh = Math.max(...prior.map(c => c.high));
  const lowestLow = Math.min(...prior.map(c => c.low));

  const isBreakout =
    (direction === 'LONG' && lastCandle.high > highestHigh) ||
    (direction === 'SHORT' && lastCandle.low < lowestLow);

  if (isBreakout && volumeRatio < 0.8) {
    return {
      detected: true,
      score: 20,
      confidence: Math.min(1.0, 1.0 - volumeRatio),
      details: `Breakout on ${Math.round(volumeRatio * 100)}% of average volume — weak conviction`,
    };
  }
  return { detected: false, score: 0, confidence: 0, details: `Volume ratio: ${volumeRatio.toFixed(2)}, breakout: ${isBreakout}` };
}

/** P4: Wick Rejection Zone (+15) */
function checkP4_WickRejection(ctx) {
  const { candles, entryPrice, direction } = ctx;
  const lookback = candles.slice(-10);
  let rejectionWicks = 0;
  const priceThreshold = entryPrice * 0.01; // 1% proximity

  for (const c of lookback) {
    const range = c.high - c.low;
    if (range === 0) continue;

    if (direction === 'LONG' && Math.abs(c.high - entryPrice) <= priceThreshold) {
      const upperWick = c.high - Math.max(c.open, c.close);
      if (upperWick / range > 0.6) rejectionWicks++;
    }
    if (direction === 'SHORT' && Math.abs(c.low - entryPrice) <= priceThreshold) {
      const lowerWick = Math.min(c.open, c.close) - c.low;
      if (lowerWick / range > 0.6) rejectionWicks++;
    }
  }

  if (rejectionWicks >= 2) {
    return {
      detected: true,
      score: 15,
      confidence: Math.min(1.0, rejectionWicks / 4),
      details: `${rejectionWicks} rejection wicks near entry — supply/demand zone`,
    };
  }
  return { detected: false, score: 0, confidence: 0, details: `${rejectionWicks} rejection wicks` };
}

/** P5: Ranging/Choppy Market (+10) */
function checkP5_ChoppyMarket(ctx) {
  const { candles } = ctx;
  const lookback = candles.slice(-10);
  let directionChanges = 0;

  for (let i = 1; i < lookback.length; i++) {
    const prevUp = lookback[i - 1].close > lookback[i - 1].open;
    const currUp = lookback[i].close > lookback[i].open;
    if (prevUp !== currUp) directionChanges++;
  }

  if (directionChanges >= 5) {
    return {
      detected: true,
      score: 10,
      confidence: Math.min(1.0, directionChanges / 8),
      details: `${directionChanges} direction changes in 10 candles — choppy market`,
    };
  }
  return { detected: false, score: 0, confidence: 0, details: `${directionChanges} direction changes` };
}

/** P6: Against Major Trend (+10) */
function checkP6_AgainstTrend(ctx) {
  const { direction, sma20, sma50 } = ctx;
  if (sma20 == null || sma50 == null) return { detected: false, score: 0, confidence: 0, details: 'SMA unavailable' };

  const against =
    (direction === 'LONG' && sma20 < sma50) ||
    (direction === 'SHORT' && sma20 > sma50);

  if (against) {
    const gapPercent = Math.abs(sma20 - sma50) / sma50 * 100;
    return {
      detected: true,
      score: 10,
      confidence: Math.min(1.0, gapPercent / 5),
      details: `${direction} opposes major trend (SMA20 ${sma20 < sma50 ? '<' : '>'} SMA50, gap ${gapPercent.toFixed(1)}%)`,
    };
  }
  return { detected: false, score: 0, confidence: 0, details: `${direction} aligns with trend` };
}

/** P7: RSI Extreme (+20) */
function checkP7_RsiExtreme(ctx) {
  const { direction, rsi14 } = ctx;
  if (rsi14 == null) return { detected: false, score: 0, confidence: 0, details: 'RSI unavailable' };

  if (direction === 'LONG' && rsi14 > 70) {
    return {
      detected: true,
      score: 20,
      confidence: Math.min(1.0, (rsi14 - 70) / 20),
      details: `RSI ${rsi14.toFixed(1)} — overbought extreme`,
    };
  }
  if (direction === 'SHORT' && rsi14 < 30) {
    return {
      detected: true,
      score: 20,
      confidence: Math.min(1.0, (30 - rsi14) / 20),
      details: `RSI ${rsi14.toFixed(1)} — oversold extreme`,
    };
  }
  return { detected: false, score: 0, confidence: 0, details: `RSI ${rsi14.toFixed(1)} in normal range` };
}

/** P8: Bollinger Overextension (+15) */
function checkP8_BollingerOverextension(ctx) {
  const { direction, entryPrice, bollinger } = ctx;
  if (!bollinger) return { detected: false, score: 0, confidence: 0, details: 'Bollinger unavailable' };

  if (direction === 'LONG' && entryPrice >= bollinger.upper) {
    const bandWidth = bollinger.upper - bollinger.middle;
    const overshoot = bandWidth > 0 ? (entryPrice - bollinger.upper) / bandWidth : 0;
    return {
      detected: true,
      score: 15,
      confidence: Math.min(1.0, overshoot + 0.5),
      details: `Price at/beyond Bollinger upper band (${bollinger.upper.toFixed(2)})`,
    };
  }
  if (direction === 'SHORT' && entryPrice <= bollinger.lower) {
    const bandWidth = bollinger.middle - bollinger.lower;
    const overshoot = bandWidth > 0 ? (bollinger.lower - entryPrice) / bandWidth : 0;
    return {
      detected: true,
      score: 15,
      confidence: Math.min(1.0, overshoot + 0.5),
      details: `Price at/beyond Bollinger lower band (${bollinger.lower.toFixed(2)})`,
    };
  }
  return { detected: false, score: 0, confidence: 0, details: 'Price within Bollinger Bands' };
}

/** P9: Volume-Price Divergence (+15) */
function checkP9_VolumePriceDivergence(ctx) {
  const { candles, direction, volumes } = ctx;
  if (volumes.length < 15) return { detected: false, score: 0, confidence: 0, details: 'Insufficient data' };

  const recentVol = volumes.slice(-5);
  const priorVol = volumes.slice(-15, -5);
  const avgRecent = recentVol.reduce((a, b) => a + b, 0) / recentVol.length;
  const avgPrior = priorVol.reduce((a, b) => a + b, 0) / priorVol.length;

  if (avgPrior === 0) return { detected: false, score: 0, confidence: 0, details: 'Zero baseline volume' };

  const volumeDecline = (avgPrior - avgRecent) / avgPrior * 100;

  // Check if price is trending in entry direction
  const recentCandles = candles.slice(-5);
  const priceChange = recentCandles[recentCandles.length - 1].close - recentCandles[0].open;
  const isTrending =
    (direction === 'LONG' && priceChange > 0) ||
    (direction === 'SHORT' && priceChange < 0);

  if (isTrending && volumeDecline >= 20) {
    return {
      detected: true,
      score: 15,
      confidence: Math.min(1.0, volumeDecline / 40),
      details: `Volume declined ${volumeDecline.toFixed(0)}% while price trending ${direction} — divergence`,
    };
  }
  return { detected: false, score: 0, confidence: 0, details: `Volume change: ${(-volumeDecline).toFixed(0)}%, trending: ${isTrending}` };
}

/** P10: Extreme Volatility Legacy (+20) */
function checkP10_ExtremeVolatility(ctx) {
  const { candles } = ctx;
  if (candles.length < 20) return { detected: false, score: 0, confidence: 0, details: 'Insufficient candles' };

  const recent = candles.slice(-5);
  const baseline = candles.slice(-20, -5);

  const recentATR = calculateATR(recent, Math.min(4, recent.length - 1)) || 0;
  const baselineATR = calculateATR(baseline, Math.min(14, baseline.length - 1)) || 0;

  if (baselineATR === 0) return { detected: false, score: 0, confidence: 0, details: 'Zero baseline ATR' };

  const ratio = recentATR / baselineATR;
  if (ratio > 1.5) {
    return {
      detected: true,
      score: 20,
      confidence: Math.min(1.0, ratio - 1.0),
      details: `ATR spike ${ratio.toFixed(1)}x vs baseline — extreme volatility`,
    };
  }
  return { detected: false, score: 0, confidence: 0, details: `ATR ratio ${ratio.toFixed(1)}x vs baseline` };
}

/** P11: Reversal Candlestick (+15) */
function checkP11_ReversalCandlestick(ctx) {
  const { candles, direction } = ctx;
  if (candles.length < 3) return { detected: false, score: 0, confidence: 0, details: 'Insufficient candles' };

  const last3 = candles.slice(-3);

  for (const c of last3) {
    const body = Math.abs(c.close - c.open);
    const range = c.high - c.low;
    if (range === 0) continue;
    const upperWick = c.high - Math.max(c.open, c.close);
    const lowerWick = Math.min(c.open, c.close) - c.low;

    // Shooting star (bearish reversal) — dangerous for LONG entries
    if (direction === 'LONG' && upperWick > body * 2 && lowerWick < body * 0.5 && body > 0) {
      return {
        detected: true,
        score: 15,
        confidence: 0.8,
        details: `Shooting star reversal pattern detected against ${direction} entry`,
      };
    }

    // Hammer (bullish reversal) — dangerous for SHORT entries
    if (direction === 'SHORT' && lowerWick > body * 2 && upperWick < body * 0.5 && body > 0) {
      return {
        detected: true,
        score: 15,
        confidence: 0.8,
        details: `Hammer reversal pattern detected against ${direction} entry`,
      };
    }
  }

  // Engulfing pattern: last candle engulfs previous, opposite to entry direction
  if (last3.length >= 2) {
    const prev = last3[last3.length - 2];
    const curr = last3[last3.length - 1];
    const prevBody = Math.abs(prev.close - prev.open);
    const currBody = Math.abs(curr.close - curr.open);
    const prevBullish = prev.close > prev.open;
    const currBullish = curr.close > curr.open;

    // Bearish engulfing against LONG
    if (direction === 'LONG' && prevBullish && !currBullish && currBody > prevBody) {
      return {
        detected: true,
        score: 15,
        confidence: 0.8,
        details: `Bearish engulfing pattern detected against ${direction} entry`,
      };
    }
    // Bullish engulfing against SHORT
    if (direction === 'SHORT' && !prevBullish && currBullish && currBody > prevBody) {
      return {
        detected: true,
        score: 15,
        confidence: 0.8,
        details: `Bullish engulfing pattern detected against ${direction} entry`,
      };
    }
  }

  return { detected: false, score: 0, confidence: 0, details: 'No reversal pattern detected' };
}

/** P12: Huge S/R Nearby (+20) */
function checkP12_SupportResistanceNearby(ctx) {
  const { candles, entryPrice, direction } = ctx;
  if (candles.length < 20) return { detected: false, score: 0, confidence: 0, details: 'Insufficient candles' };

  // Cluster highs and lows into S/R levels (0.5% bins)
  const binSize = entryPrice * 0.005;
  const levels = {};

  for (const c of candles) {
    const highBin = Math.round(c.high / binSize) * binSize;
    const lowBin = Math.round(c.low / binSize) * binSize;
    levels[highBin] = (levels[highBin] || 0) + 1;
    levels[lowBin] = (levels[lowBin] || 0) + 1;
  }

  // Find significant levels (touched 3+ times)
  const significantLevels = Object.entries(levels)
    .filter(([, count]) => count >= 3)
    .map(([price, count]) => ({ price: parseFloat(price), count }));

  // Check if any S/R blocks the TP direction within 2% of entry
  const tpThreshold = entryPrice * 0.02;

  for (const level of significantLevels) {
    if (direction === 'LONG' && level.price > entryPrice && (level.price - entryPrice) <= tpThreshold) {
      const dist = ((level.price - entryPrice) / entryPrice * 100).toFixed(1);
      return {
        detected: true,
        score: 20,
        confidence: Math.min(1.0, level.count / 4),
        details: `Major resistance at ${level.price.toFixed(2)} — ${dist}% from entry, blocking TP`,
      };
    }
    if (direction === 'SHORT' && level.price < entryPrice && (entryPrice - level.price) <= tpThreshold) {
      const dist = ((entryPrice - level.price) / entryPrice * 100).toFixed(1);
      return {
        detected: true,
        score: 20,
        confidence: Math.min(1.0, level.count / 4),
        details: `Major support at ${level.price.toFixed(2)} — ${dist}% from entry, blocking TP`,
      };
    }
  }

  return { detected: false, score: 0, confidence: 0, details: 'No major S/R blocking TP' };
}

/** BL: Blacklist Token (+25) */
function checkBL_Blacklist(ctx) {
  const { symbol, blacklist } = ctx;
  const tokenBase = symbol.replace(/(USDT|PERP|USD)$/, '');
  const isBlacklisted = blacklist.some(b => b.toUpperCase() === tokenBase.toUpperCase());

  if (isBlacklisted) {
    return {
      detected: true,
      score: 25,
      confidence: 1.0,
      details: `${tokenBase} has historically elevated loss rate`,
    };
  }
  return { detected: false, score: 0, confidence: 0, details: `${tokenBase} not in blacklist` };
}

// ─── Main Export ──────────────────────────────────────────────────────────────

/**
 * Analyze trade risk before execution.
 * @param {string} symbol - e.g. "BTCUSDT"
 * @param {string} direction - "LONG" or "SHORT"
 * @param {number} [entryPrice] - Optional, defaults to last close
 * @returns {Promise<object>} Risk analysis result
 */
export async function analyzeTradeRisk(symbol, direction, entryPrice = null) {
  try {
    // Step 1: Fetch candles
    const result = await getCandles({
      symbol,
      category: 'linear',
      interval: CANDLE_INTERVAL,
      limit: CANDLE_LIMIT,
    });

    const candles = result?.candles;

    if (!candles || candles.length === 0) {
      return {
        symbol,
        direction,
        entryPrice: entryPrice || null,
        riskScore: 10,
        internalScore: 100,
        riskLevel: 'HIGH',
        shouldAvoid: true,
        atrSlRatio: null,
        isBlacklisted: false,
        detectedPatterns: [],
        technicalSummary: null,
        recommendation: `⛔ No candle data available for ${symbol}. Defaulting to AVOID.`,
        analyzedAt: new Date().toISOString(),
        candlesAnalyzed: 0,
        error: `No candle data available for ${symbol}`,
      };
    }

    // CRITICAL: Bybit returns newest-first, reverse to chronological (oldest-first)
    candles.reverse();

    if (candles.length < 20) {
      return {
        symbol,
        direction,
        entryPrice: entryPrice || candles[candles.length - 1].close,
        riskScore: 10,
        internalScore: 100,
        riskLevel: 'HIGH',
        shouldAvoid: true,
        atrSlRatio: 10,
        isBlacklisted: false,
        detectedPatterns: [],
        technicalSummary: null,
        recommendation: `⛔ Insufficient candle data (${candles.length} candles). New listings are too risky.`,
        analyzedAt: new Date().toISOString(),
        candlesAnalyzed: candles.length,
      };
    }

    // Step 2: Extract price arrays
    const closes = candles.map(c => c.close);
    const volumes = candles.map(c => c.volume);
    const finalEntryPrice = entryPrice || closes[closes.length - 1];

    // Step 3: Compute technical indicators
    const atr14 = calculateATR(candles, ATR_PERIOD);
    const rsi14 = calculateRSI(closes, RSI_PERIOD);
    const sma9 = calculateSMA(closes, 9);
    const sma20 = calculateSMA(closes, 20);
    const sma50 = calculateSMA(closes, 50);
    const bollinger = calculateBollingerBands(closes, BB_PERIOD, BB_STDDEV);
    const macd = calculateMACD(closes, MACD_FAST, MACD_SLOW, MACD_SIGNAL);

    // Step 4: Derived values
    const slDistance = finalEntryPrice * SL_DISTANCE_PERCENT;
    const atrSlRatio = atr14 != null ? atr14 / slDistance : null;
    const distanceFromSMA20Percent = sma20 != null ? Math.abs(finalEntryPrice - sma20) / sma20 * 100 : 0;
    const volSlice = volumes.slice(-20);
    const avgVolume20 = volSlice.length > 0 ? volSlice.reduce((a, b) => a + b, 0) / volSlice.length : 0;
    const currentVolume = volumes[volumes.length - 1];
    const volumeRatio = avgVolume20 > 0 ? currentVolume / avgVolume20 : 1;
    const trend = determineTrend(sma9, sma20, sma50);

    // Consecutive candles count
    let consecutiveCandles = 0;
    for (let i = candles.length - 1; i >= 0; i--) {
      const c = candles[i];
      const isUp = c.close > c.open;
      if ((direction === 'LONG' && isUp) || (direction === 'SHORT' && !isUp)) {
        consecutiveCandles++;
      } else {
        break;
      }
    }

    // Step 5: Fetch blacklist
    let blacklist;
    try {
      blacklist = await fetchBlacklist();
    } catch {
      blacklist = ["WHITEWHALE", "DASH", "RIVER", "GRIFFAIN", "SCR", "BREV", "MAGMA"];
    }

    // Step 6: Build context
    const ctx = {
      candles, closes, volumes, direction,
      entryPrice: finalEntryPrice,
      atr14, rsi14, sma9, sma20, sma50,
      bollinger, macd, slDistance, atrSlRatio,
      blacklist, symbol, distanceFromSMA20Percent,
      avgVolume20, currentVolume, volumeRatio,
    };

    // Step 7: Run all pattern checks
    const patterns = [
      { name: 'ATR/SL Ratio Critical', ...checkP0_AtrSlRatio(ctx) },
      { name: 'Double-Tap Exhaustion', ...checkP1_DoubleTap(ctx) },
      { name: 'Extended Move Exhaustion', ...checkP2_ExtendedMove(ctx) },
      { name: 'Low Volume Breakout', ...checkP3_LowVolumeBreakout(ctx) },
      { name: 'Wick Rejection Zone', ...checkP4_WickRejection(ctx) },
      { name: 'Ranging/Choppy Market', ...checkP5_ChoppyMarket(ctx) },
      { name: 'Against Major Trend', ...checkP6_AgainstTrend(ctx) },
      { name: 'RSI Extreme', ...checkP7_RsiExtreme(ctx) },
      { name: 'Bollinger Overextension', ...checkP8_BollingerOverextension(ctx) },
      { name: 'Volume-Price Divergence', ...checkP9_VolumePriceDivergence(ctx) },
      { name: 'Extreme Volatility', ...checkP10_ExtremeVolatility(ctx) },
      { name: 'Reversal Candlestick', ...checkP11_ReversalCandlestick(ctx) },
      { name: 'Huge S/R Nearby', ...checkP12_SupportResistanceNearby(ctx) },
      { name: 'Blacklist Token', ...checkBL_Blacklist(ctx) },
    ];

    // Step 8: Score aggregation
    const internalScore = patterns.reduce((sum, p) => sum + (p.detected ? p.score : 0), 0);
    const riskScore = Math.min(10, Math.round(internalScore / 10));
    const shouldAvoid = riskScore >= 7;
    const riskLevel = getRiskLevel(riskScore);
    const isBlacklisted = patterns.find(p => p.name === 'Blacklist Token')?.detected || false;
    const detectedPatterns = patterns.filter(p => p.detected);

    // Step 9: Build response
    const lastCandle = candles[candles.length - 1];

    return {
      symbol,
      direction,
      entryPrice: finalEntryPrice,
      riskScore,
      internalScore,
      riskLevel,
      shouldAvoid,
      atrSlRatio: atrSlRatio != null ? parseFloat(atrSlRatio.toFixed(2)) : null,
      isBlacklisted,
      detectedPatterns,
      technicalSummary: {
        trend,
        sma9: sma9 != null ? parseFloat(sma9.toFixed(6)) : null,
        sma20: sma20 != null ? parseFloat(sma20.toFixed(6)) : null,
        sma50: sma50 != null ? parseFloat(sma50.toFixed(6)) : null,
        rsi14: rsi14 != null ? parseFloat(rsi14.toFixed(1)) : null,
        atr14: atr14 != null ? parseFloat(atr14.toFixed(6)) : null,
        bollingerUpper: bollinger ? parseFloat(bollinger.upper.toFixed(6)) : null,
        bollingerLower: bollinger ? parseFloat(bollinger.lower.toFixed(6)) : null,
        macdHistogram: macd ? parseFloat(macd.histogram.toFixed(6)) : null,
        distanceFromSMA20Percent: parseFloat(distanceFromSMA20Percent.toFixed(2)),
        avgVolume20: parseFloat(avgVolume20.toFixed(0)),
        currentVolume,
        volumeRatio: parseFloat(volumeRatio.toFixed(2)),
        consecutiveCandles,
        lastClose: lastCandle.close,
        lastHigh: lastCandle.high,
        lastLow: lastCandle.low,
      },
      recommendation: buildRecommendation(shouldAvoid, riskScore, atrSlRatio, detectedPatterns),
      analyzedAt: new Date().toISOString(),
      candlesAnalyzed: candles.length,
    };
  } catch (error) {
    console.error(`[RiskAnalyzer] Error analyzing ${symbol}:`, error);
    return {
      symbol,
      direction,
      entryPrice: entryPrice || null,
      riskScore: 10,
      internalScore: 100,
      riskLevel: 'HIGH',
      shouldAvoid: true,
      atrSlRatio: null,
      isBlacklisted: false,
      detectedPatterns: [],
      technicalSummary: null,
      recommendation: `⛔ ERROR analyzing ${symbol}: ${error.message}. Defaulting to AVOID.`,
      analyzedAt: new Date().toISOString(),
      candlesAnalyzed: 0,
      error: error.message,
    };
  }
}
