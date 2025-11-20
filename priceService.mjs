// priceService.mjs

// Fetch raw klines from Bybit and return parsed candles
export async function getCandles({
    symbol,
    category = "linear",
    interval = "1",
    start,
    end,
    limit = "200",
  }) {
    const params = new URLSearchParams();
    params.set("category", category);
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
  
    const list = data?.result?.list || [];
  
    const candles = list.map((c) => {
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
  
    return {
      raw: data,
      candles,
    };
  }
  
  /**
   * Simulate stop-loss hits for a list of candles.
   *
   * direction: "LONG" or "SHORT"
   * stopPercents: e.g. [10,15,20] => 10%, 15%, 20%
   */
  export function simulateStops({
    entryPrice,
    direction = "LONG",
    candles,
    stopPercents = [10, 15, 20],
  }) {
    if (!entryPrice || !Number.isFinite(entryPrice)) {
      throw new Error("simulateStops: invalid entryPrice");
    }
  
    const dir = direction.toUpperCase();
    if (dir !== "LONG" && dir !== "SHORT") {
      throw new Error("simulateStops: direction must be LONG or SHORT");
    }
  
    let minLowSinceEntry = Infinity;
    let maxHighSinceEntry = -Infinity;
  
    const stops = {};
    for (const p of stopPercents) {
      const pct = Number(p);
      const factor = pct / 100;
  
      const price =
        dir === "LONG"
          ? entryPrice * (1 - factor)
          : entryPrice * (1 + factor);
  
      stops[String(pct)] = {
        percent: pct,
        price,
        hit: false,
        firstHitTime: null,
        firstHitTimeISO: null,
      };
    }
  
    for (const c of candles) {
      if (c.low < minLowSinceEntry) minLowSinceEntry = c.low;
      if (c.high > maxHighSinceEntry) maxHighSinceEntry = c.high;
  
      for (const key of Object.keys(stops)) {
        const s = stops[key];
        if (s.hit) continue;
  
        if (dir === "LONG") {
          if (c.low <= s.price) {
            s.hit = true;
            s.firstHitTime = c.startTime;
            s.firstHitTimeISO = c.startTimeISO;
          }
        } else {
          // SHORT
          if (c.high >= s.price) {
            s.hit = true;
            s.firstHitTime = c.startTime;
            s.firstHitTimeISO = c.startTimeISO;
          }
        }
      }
    }
  
    if (minLowSinceEntry === Infinity) minLowSinceEntry = null;
    if (maxHighSinceEntry === -Infinity) maxHighSinceEntry = null;
  
    return {
      minLowSinceEntry,
      maxHighSinceEntry,
      stops,
    };
  }
  