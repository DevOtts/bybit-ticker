import express from 'express';
import * as tradingService from './tradingService.mjs';

const router = express.Router();

const TRADING_SECRET = process.env.TRADING_API_SECRET;

/**
 * Middleware to validate Authorization header
 */
function validateAuth(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
        return res.status(401).json({ error: 'Missing Authorization header' });
    }

    const [type, token] = authHeader.split(' ');
    if (type !== 'Bearer' || token !== TRADING_SECRET) {
        return res.status(401).json({ error: 'Invalid Bearer token' });
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
        const result = await tradingService.openPosition(req.body);
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

export default router;
