// server.mjs
import express from "express";
import { getCandles, simulateStops } from "./priceService.mjs";

const app = express();
const PORT = process.env.PORT || 8080;

/**
 * Ticker helper – tenta em várias categorias (spot, linear, inverse)
 * até encontrar o símbolo.
 */
async function fetchTicker(symbol) {
    const categories = ["spot", "linear", "inverse"];

    for (const category of categories) {
        const bybitUrl =
            `https://api.bybit.com/v5/market/tickers` +
            `?category=${category}&symbol=${encodeURIComponent(symbol)}`;

        try {
            const resp = await fetch(bybitUrl, {
                method: "GET",
                headers: { Accept: "application/json" },
            });

            const contentType = resp.headers.get("content-type") || "";
            const text = await resp.text();

            if (!contentType.includes("application/json")) {
                console.warn(
                    `Bybit Ticker non-JSON symbol=${symbol} category=${category} status=${resp.status}`,
                );
                continue;
            }

            const data = JSON.parse(text);

            if (
                data.retCode === 0 &&
                data.result &&
                Array.isArray(data.result.list) &&
                data.result.list.length > 0
            ) {
                // Guarda a categoria encontrada pra debug / downstream
                data.result.category = category;
                return data;
            }

            if (data.retCode === 10001) {
                // Not supported symbols nessa categoria – tenta próxima
                continue;
            }

            console.warn(
                `Bybit Ticker retCode=${data.retCode} symbol=${symbol} category=${category}`,
            );
            continue;
        } catch (err) {
            console.error(
                `Error fetching Bybit ticker symbol=${symbol} category=${category}`,
                err,
            );
            continue;
        }
    }

    return {
        retCode: 10001,
        retMsg: "Not supported symbols in any category",
        result: {},
    };
}

/**
 * Kline helper – pega candles crus da Bybit.
 * Você escolhe categoria, intervalo, start/end/limit via query params.
 */
async function fetchKlines({ symbol, category = "linear", interval = "1", start, end, limit }) {
    const params = new URLSearchParams();

    // category é opcional mas vamos ser explícitos
    if (category) params.set("category", category);
    params.set("symbol", symbol);
    params.set("interval", String(interval));

    if (start) params.set("start", String(start));
    if (end) params.set("end", String(end));
    if (limit) params.set("limit", String(limit));

    const url = `https://api.bybit.com/v5/market/kline?${params.toString()}`;

    const resp = await fetch(url, {
        method: "GET",
        headers: { Accept: "application/json" },
    });

    const contentType = resp.headers.get("content-type") || "";
    const text = await resp.text();

    if (!contentType.includes("application/json")) {
        throw new Error(
            `Bybit Kline non-JSON. status=${resp.status}, body=${text.slice(0, 200)}`,
        );
    }

    const data = JSON.parse(text);
    return data;
}

// Healthcheck simples
app.get("/health", (req, res) => {
    res.json({ status: "ok" });
});

// === 1) Endpoint Ticker atual ===
app.get("/api/bybit", async (req, res) => {
    const { symbol } = req.query;

    if (!symbol) {
        return res.status(400).json({
            error: "Missing 'symbol' query param (example: ?symbol=BTCUSDT)",
        });
    }

    try {
        const data = await fetchTicker(symbol.toUpperCase().trim());
        return res.status(200).json(data);
    } catch (err) {
        console.error("Ticker handler error:", err);
        return res.status(500).json({
            error: "Internal error",
            details: err.message,
        });
    }
});

// === 2) Novo endpoint de candles (klines) — VERSÃO PARSEADA ===
app.get("/api/bybit/candles", async (req, res) => {
    const {
        symbol,
        category = "linear",
        interval = "1",
        start,
        end,
        limit = "10",
    } = req.query;

    if (!symbol) {
        return res.status(400).json({
            error: "Missing 'symbol' query param (example: ?symbol=CROSSUSDT)",
        });
    }

    try {
        const raw = await fetchKlines({
            symbol: symbol.toUpperCase().trim(),
            category,
            interval,
            start,
            end,
            limit,
        });

        const list = raw?.result?.list || [];

        // Transform array → object
        const parsed = list.map((c) => {
            const ts = Number(c[0]);

            return {
                startTime: ts,
                startTimeISO: new Date(ts).toISOString(),
                open: Number(c[1]),
                high: Number(c[2]),
                low: Number(c[3]),
                close: Number(c[4]),
                volume: Number(c[5]),
                turnover: Number(c[6]),
            };
        });

        return res.status(200).json({
            meta: {
                symbol: symbol.toUpperCase().trim(),
                category,
                interval,
                limit,
            },
            retCode: raw.retCode,
            retMsg: raw.retMsg,
            candles: parsed,
            time: raw.time,
        });
    } catch (err) {
        console.error("Candles handler error:", err);
        return res.status(500).json({
            error: "Internal error",
            details: err.message,
        });
    }
});

// === 3) Stop-loss simulation endpoint ===
// Example:
// /api/bybit/stop-sim?symbol=CROSSUSDT&direction=SHORT&entryPrice=0.1257&entryDate=2025-01-10T14:52:00Z&interval=1&stopPercents=10,15,20
app.get("/api/bybit/stop-sim", async (req, res) => {
    const {
        symbol,
        direction = "LONG",
        entryPrice,
        entryDate,
        category = "linear",
        interval = "1",
        stopPercents = "10,15,20",
        includeCandles = "false",
    } = req.query;

    // ---- Validations ----
    if (!symbol) {
        return res.status(400).json({ error: "Missing 'symbol' query param" });
    }

    const entry = Number(entryPrice);
    if (!entry || !Number.isFinite(entry)) {
        return res.status(400).json({ error: "Invalid or missing 'entryPrice'" });
    }

    if (!entryDate) {
        return res.status(400).json({ error: "Missing 'entryDate' query param" });
    }

    const entryTimestamp = Date.parse(entryDate);
    if (isNaN(entryTimestamp)) {
        return res.status(400).json({ error: "Invalid 'entryDate' format" });
    }

    const now = Date.now();
    const diffMs = now - entryTimestamp;

    if (diffMs <= 0) {
        return res.status(400).json({ error: "Entry date is in the future" });
    }

    let stopsArray = String(stopPercents)
        .split(",")
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n) && n > 0);

    if (stopsArray.length === 0) {
        stopsArray = [10, 15, 20];
    }

    // ---- Auto-calculate limit ----
    const intervalMinutes = Number(interval);
    const intervalMs = intervalMinutes * 60 * 1000;
    const computedLimit = Math.ceil(diffMs / intervalMs);

    // Cap at Bybit's max limit (200)
    const cappedLimit = Math.min(computedLimit, 200);

    // ---- Fetch candles starting from entry date ----
    try {
        const { raw, candles } = await getCandles({
            symbol: symbol.toUpperCase().trim(),
            category,
            interval,
            start: String(entryTimestamp),
            limit: String(cappedLimit),
        });

        const sim = simulateStops({
            entryPrice: entry,
            direction,
            candles,
            stopPercents: stopsArray,
        });

        return res.status(200).json({
            meta: {
                symbol: symbol.toUpperCase().trim(),
                category,
                interval,
                entryDate,
                entryTimestamp,
                direction: direction.toUpperCase(),
                entryPrice: entry,
                stopPercents: stopsArray,
                computedLimit,
                cappedLimit,
                actualCandlesReceived: candles.length,
            },
            retCode: raw.retCode,
            retMsg: raw.retMsg,
            ...sim,
            time: raw.time,
            candles: includeCandles === "true" ? candles : undefined,
        });
    } catch (err) {
        console.error("Stop-sim handler error:", err);
        return res.status(500).json({
            error: "Internal error",
            details: err.message,
        });
    }
});

app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
