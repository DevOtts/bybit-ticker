// File: api/bybit.js
export default async function handler(req, res) {
    const { symbol, category = "spot" } = req.query;
  
    if (!symbol) {
      return res.status(400).json({
        error: "Missing 'symbol' query param (example: ?symbol=BTCUSDT)"
      });
    }
  
    try {
      const bybitUrl =
        `https://api.bybit.com/v5/market/tickers?category=${category}&symbol=${symbol}`;
  
      const upstream = await fetch(bybitUrl, {
        method: "GET",
        headers: {
          Accept: "application/json"
        }
      });
  
      const contentType = upstream.headers.get("content-type") || "";
      const text = await upstream.text();
  
      // If Bybit sends HTML (CloudFront 403 page), don't try to parse JSON
      if (!contentType.includes("application/json")) {
        console.error("Bybit non-JSON response:", upstream.status, text.slice(0, 200));
  
        return res.status(upstream.status).json({
          error: "Upstream returned non-JSON (likely CloudFront error)",
          status: upstream.status,
          bodyPreview: text.slice(0, 400)
        });
      }
  
      let data;
      try {
        data = JSON.parse(text);
      } catch (e) {
        console.error("JSON parse error:", e, text.slice(0, 200));
        return res.status(500).json({
          error: "JSON parse failed",
          details: e.message
        });
      }
  
      return res.status(upstream.status).json(data);
    } catch (err) {
      console.error("Handler error:", err);
      return res.status(500).json({
        error: "Internal error",
        details: err.message
      });
    }
  }
  