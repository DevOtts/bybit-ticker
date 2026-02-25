import express from 'express';
import * as tradingService from './tradingService.mjs';
import { analyzeTradeRisk } from './riskAnalyzerService.mjs';

const router = express.Router();

// Removed top-level const TRADING_SECRET = process.env.TRADING_API_SECRET; to prevent hoisting issues
// We will access process.env.TRADING_API_SECRET dynamically inside the middleware.

/**
 * Middleware to validate Authorization header
 */
function validateAuth(req, res, next) {
    const TRADING_SECRET = process.env.TRADING_API_SECRET;

    const authHeader = req.headers.authorization;
    if (!authHeader) {
        console.warn('[Auth] Missing Authorization header');
        return res.status(401).json({ error: 'Missing Authorization header' });
    }

    // Robust parsing: split by space, handle multiple spaces, case-insensitive
    const parts = authHeader.trim().split(/\s+/);
    const type = parts[0];
    const token = parts.slice(1).join(' '); // Rejoin rest in case token has weird internal spaces (unlikely but safe)

    if (!type || type.toLowerCase() !== 'bearer') {
        const msg = `Invalid Authorization header format. Expected 'Bearer <token>'. Received type: '${type}'`;
        console.warn(`[Auth] ${msg}`);
        return res.status(401).json({ error: msg, receivedHeader: authHeader.substring(0, 20) + '...' });
    }

    if (!token) {
        return res.status(401).json({ error: 'Missing token in Authorization header' });
    }

    if (!TRADING_SECRET) {
        console.error('[Auth] Server Misconfiguration: TRADING_API_SECRET is not set');
        return res.status(500).json({ error: 'Server authentication (TRADING_API_SECRET) is NOT configured on the server.' });
    }

    if (token !== TRADING_SECRET) {
        // SECURITY WARNING: We are exposing debug info as requested.
        const msg = `Invalid Bearer token.`;
        console.warn(`[Auth] Token Mismatch. Received len=${token.length}, Expected len=${TRADING_SECRET.length}`);
        return res.status(401).json({
            error: msg,
            debug: {
                receivedLen: token.length,
                expectedLen: TRADING_SECRET.length,
                receivedStart: token.substring(0, 3) + '...',
                expectedStart: TRADING_SECRET.substring(0, 3) + '...'
            }
        });
    }

    next();
}

// Apply auth middleware to all routes in this router
router.use(validateAuth);

// GET /api/trade/validate/:symbol
router.get('/validate/:symbol', async (req, res) => {
    try {
        const result = await tradingService.validateSymbol(req.params.symbol);
        res.status(200).json(result);
    } catch (err) {
        console.error('Validate symbol error:', err);
        res.status(500).json({ error: err.message });
    }
});

// GET /api/trade/market/:symbol
router.get('/market/:symbol', async (req, res) => {
    try {
        const result = await tradingService.getMarketData(req.params.symbol);
        res.status(200).json(result);
    } catch (err) {
        console.error('Get market data error:', err);
        res.status(500).json({ error: err.message });
    }
});

// POST /api/trade/open
router.post('/open', async (req, res) => {
    try {
        // Support slDist (decimal) or slPercentage (decimal)
        const { symbol, direction, margin, leverage, slDist, slPercentage } = req.body;

        // Robust fallback: slDist -> slPercentage -> 0.01 (default in service)
        const finalSlDist = slDist || slPercentage;

        const result = await tradingService.openPosition({
            symbol,
            direction,
            margin,
            leverage,
            slDist: finalSlDist
        });
        res.status(200).json(result);
    } catch (err) {
        console.error('Open position error:', err);
        res.status(500).json({ error: err.message });
    }
});

// POST /api/trade/close
router.post('/close', async (req, res) => {
    try {
        const result = await tradingService.closePosition(req.body.symbol);
        res.status(200).json(result);
    } catch (err) {
        console.error('Close position error:', err);
        res.status(500).json({ error: err.message });
    }
});

// GET /api/trade/position/:symbol
router.get('/position/:symbol', async (req, res) => {
    try {
        const result = await tradingService.getPosition(req.params.symbol);
        res.status(200).json(result);
    } catch (err) {
        console.error('Get position error:', err);
        res.status(500).json({ error: err.message });
    }
});

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
    } catch (err) {
        console.error('Risk analysis error:', err);
        res.status(500).json({ error: 'Risk analysis failed', details: err.message });
    }
});

export default router;
