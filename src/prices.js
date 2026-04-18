const fetch = require('node-fetch');

let cache = {
  RAIN: { price: null, change24h: null, ts: 0 },
  ENLV: { price: null, change24h: null, ts: 0 },
};

const RAIN_TTL_MS = 30 * 1000;
const ENLV_TTL_MS = 60 * 1000;

// RAIN on Arbitrum — top liquidity pool RAIN/WETH 0.01%
const RAIN_NETWORK = process.env.RAIN_NETWORK || 'arbitrum';
const RAIN_POOL = process.env.RAIN_POOL || '0xd13040d4fe917ee704158cfcb3338dcd2838b245';

async function fetchRain() {
  try {
    const url = `https://api.geckoterminal.com/api/v2/networks/${RAIN_NETWORK}/pools/${RAIN_POOL}`;
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`GeckoTerminal ${res.status}`);
    const j = await res.json();
    const attr = j.data && j.data.attributes;
    if (!attr) throw new Error('no attributes');
    const price = parseFloat(attr.base_token_price_usd);
    let change24h = null;
    if (attr.price_change_percentage && attr.price_change_percentage.h24 != null) {
      change24h = parseFloat(attr.price_change_percentage.h24);
    }
    cache.RAIN = { price, change24h, ts: Date.now() };
    return cache.RAIN;
  } catch (e) {
    console.error('[prices] RAIN fetch error:', e.message);
    return cache.RAIN;
  }
}

async function fetchEnlv() {
  try {
    const symbol = process.env.ENLV_SYMBOL || 'ENLV';
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=5d`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Stormfund/1.0)',
        Accept: 'application/json',
      },
    });
    if (!res.ok) throw new Error(`Yahoo ${res.status}`);
    const j = await res.json();
    const result = j.chart && j.chart.result && j.chart.result[0];
    if (!result) throw new Error('no result');
    const meta = result.meta || {};
    const price = meta.regularMarketPrice;
    const prev = meta.chartPreviousClose || meta.previousClose;
    let change24h = null;
    if (price != null && prev != null && prev !== 0) {
      change24h = ((price - prev) / prev) * 100;
    }
    cache.ENLV = { price, change24h, ts: Date.now() };
    return cache.ENLV;
  } catch (e) {
    console.error('[prices] ENLV fetch error:', e.message);
    return cache.ENLV;
  }
}

async function getPrices() {
  const now = Date.now();
  const tasks = [];
  if (now - cache.RAIN.ts > RAIN_TTL_MS) tasks.push(fetchRain());
  if (now - cache.ENLV.ts > ENLV_TTL_MS) tasks.push(fetchEnlv());
  if (tasks.length) await Promise.all(tasks);
  return {
    RAIN: cache.RAIN,
    ENLV: cache.ENLV,
    fetched_at: new Date().toISOString(),
  };
}

module.exports = { getPrices };
