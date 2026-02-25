// testRiskAnalyzerV3.mjs — Standalone test script for Risk Analyzer V3
import { analyzeTradeRisk } from './riskAnalyzerService.mjs';

let passed = 0;
let failed = 0;

function assert(label, condition) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ ${label}`);
    failed++;
  }
}

function assertSchema(label, result) {
  const requiredFields = [
    'symbol', 'direction', 'entryPrice', 'riskScore', 'internalScore',
    'riskLevel', 'shouldAvoid', 'atrSlRatio', 'isBlacklisted',
    'detectedPatterns', 'technicalSummary', 'recommendation',
    'analyzedAt', 'candlesAnalyzed'
  ];
  const missing = requiredFields.filter(f => !(f in result));
  assert(`${label} — all required fields present`, missing.length === 0);
  if (missing.length > 0) console.log(`    Missing: ${missing.join(', ')}`);

  if (result.technicalSummary) {
    const summaryFields = [
      'trend', 'sma9', 'sma20', 'sma50', 'rsi14', 'atr14',
      'bollingerUpper', 'bollingerLower', 'macdHistogram',
      'distanceFromSMA20Percent', 'avgVolume20', 'currentVolume',
      'volumeRatio', 'consecutiveCandles', 'lastClose', 'lastHigh', 'lastLow'
    ];
    const missingS = summaryFields.filter(f => !(f in result.technicalSummary));
    assert(`${label} — technicalSummary fields`, missingS.length === 0);
    if (missingS.length > 0) console.log(`    Missing summary: ${missingS.join(', ')}`);
  }
}

async function runTests() {
  console.log('=== Risk Analyzer V3 Tests ===\n');

  // Test 1: BTC LONG — should be safe (low ATR/SL)
  console.log('Test 1: BTCUSDT LONG');
  const btcLong = await analyzeTradeRisk('BTCUSDT', 'LONG');
  assert('shouldAvoid is false', btcLong.shouldAvoid === false);
  assert('riskScore <= 4', btcLong.riskScore <= 4);
  assert('atrSlRatio < 2.5', btcLong.atrSlRatio < 2.5);
  assertSchema('BTCUSDT LONG', btcLong);
  console.log(`  ℹ️  ATR/SL: ${btcLong.atrSlRatio}x | Score: ${btcLong.riskScore}/10 | RSI: ${btcLong.technicalSummary?.rsi14}`);
  console.log();

  // Test 2: BTC SHORT — validate schema, check trend patterns
  console.log('Test 2: BTCUSDT SHORT');
  const btcShort = await analyzeTradeRisk('BTCUSDT', 'SHORT');
  assertSchema('BTCUSDT SHORT', btcShort);
  assert('riskScore is 0-10', btcShort.riskScore >= 0 && btcShort.riskScore <= 10);
  assert('riskLevel is valid', ['LOW', 'MEDIUM', 'HIGH'].includes(btcShort.riskLevel));
  console.log(`  ℹ️  ATR/SL: ${btcShort.atrSlRatio}x | Score: ${btcShort.riskScore}/10 | Trend: ${btcShort.technicalSummary?.trend}`);
  console.log();

  // Test 3: ETH LONG — should be safe
  console.log('Test 3: ETHUSDT LONG');
  const ethLong = await analyzeTradeRisk('ETHUSDT', 'LONG');
  assert('shouldAvoid is false', ethLong.shouldAvoid === false);
  assert('atrSlRatio < 2.5', ethLong.atrSlRatio < 2.5);
  assertSchema('ETHUSDT LONG', ethLong);
  console.log(`  ℹ️  ATR/SL: ${ethLong.atrSlRatio}x | Score: ${ethLong.riskScore}/10`);
  console.log();

  // Test 4: DASH SHORT — should be avoided (high ATR/SL, blacklisted)
  console.log('Test 4: DASHUSDT SHORT');
  const dashShort = await analyzeTradeRisk('DASHUSDT', 'SHORT');
  assert('shouldAvoid is true', dashShort.shouldAvoid === true);
  assert('riskScore >= 7', dashShort.riskScore >= 7);
  assert('isBlacklisted is true', dashShort.isBlacklisted === true);
  assertSchema('DASHUSDT SHORT', dashShort);
  console.log(`  ℹ️  ATR/SL: ${dashShort.atrSlRatio}x | Score: ${dashShort.riskScore}/10 | Patterns: ${dashShort.detectedPatterns.map(p => p.name).join(', ')}`);
  console.log();

  // Test 5: Invalid symbol — should fail safe
  console.log('Test 5: INVALIDXYZ (non-existent)');
  const invalid = await analyzeTradeRisk('INVALIDXYZ', 'LONG');
  assert('shouldAvoid is true', invalid.shouldAvoid === true);
  assert('riskScore is 10', invalid.riskScore === 10);
  console.log(`  ℹ️  Recommendation: ${invalid.recommendation}`);
  console.log();

  // Summary
  console.log('=== Results ===');
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);
  console.log(`  Total:  ${passed + failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
