import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

const config = JSON.parse(fs.readFileSync('./config.json', 'utf-8'));
const stateFile = './data/state.json';

const markets = {
  india: {
    name: 'India (NSE)',
    currency: 'INR',
    currencySymbol: '₹',
    locale: 'en-IN',
    timeZone: 'Asia/Kolkata',
    sessions: [[9 * 60 + 15, 15 * 60 + 30]],
    watchlist: config.watchlist
  },
  us: {
    name: 'United States (NYSE/Nasdaq)',
    currency: 'USD',
    currencySymbol: '$',
    locale: 'en-US',
    timeZone: 'America/New_York',
    sessions: [[9 * 60 + 30, 16 * 60]],
    watchlist: [
      { symbol: 'AAPL', name: 'Apple', sector: 'Technology' },
      { symbol: 'MSFT', name: 'Microsoft', sector: 'Technology' },
      { symbol: 'NVDA', name: 'NVIDIA', sector: 'Semiconductors' },
      { symbol: 'AMZN', name: 'Amazon', sector: 'Consumer' },
      { symbol: 'TSLA', name: 'Tesla', sector: 'Automotive' }
    ]
  },
  uk: {
    name: 'United Kingdom (LSE)',
    currency: 'GBP',
    currencySymbol: '£',
    locale: 'en-GB',
    timeZone: 'Europe/London',
    sessions: [[8 * 60, 16 * 60 + 30]],
    watchlist: [
      { symbol: 'SHEL.L', name: 'Shell', sector: 'Energy' },
      { symbol: 'AZN.L', name: 'AstraZeneca', sector: 'Healthcare' },
      { symbol: 'HSBA.L', name: 'HSBC', sector: 'Banking' },
      { symbol: 'ULVR.L', name: 'Unilever', sector: 'Consumer' },
      { symbol: 'VOD.L', name: 'Vodafone', sector: 'Telecom' }
    ]
  },
  japan: {
    name: 'Japan (TSE)',
    currency: 'JPY',
    currencySymbol: '¥',
    locale: 'ja-JP',
    timeZone: 'Asia/Tokyo',
    sessions: [[9 * 60, 11 * 60 + 30], [12 * 60 + 30, 15 * 60 + 30]],
    watchlist: [
      { symbol: '7203.T', name: 'Toyota', sector: 'Automotive' },
      { symbol: '6758.T', name: 'Sony', sector: 'Technology' },
      { symbol: '9984.T', name: 'SoftBank Group', sector: 'Telecom' },
      { symbol: '6861.T', name: 'Keyence', sector: 'Technology' },
      { symbol: '8306.T', name: 'Mitsubishi UFJ', sector: 'Banking' }
    ]
  },
  hongKong: {
    name: 'Hong Kong (HKEX)',
    currency: 'HKD',
    currencySymbol: 'HK$',
    locale: 'en-HK',
    timeZone: 'Asia/Hong_Kong',
    sessions: [[9 * 60 + 30, 12 * 60], [13 * 60, 16 * 60]],
    watchlist: [
      { symbol: '0700.HK', name: 'Tencent', sector: 'Technology' },
      { symbol: '9988.HK', name: 'Alibaba', sector: 'Consumer' },
      { symbol: '0005.HK', name: 'HSBC', sector: 'Banking' },
      { symbol: '0941.HK', name: 'China Mobile', sector: 'Telecom' },
      { symbol: '1299.HK', name: 'AIA Group', sector: 'Insurance' }
    ]
  }
};

const defaultMarket = config.defaultMarket && markets[config.defaultMarket]
  ? config.defaultMarket
  : 'india';

const defaultConfig = {
  cash: config.startingCapital,
  equity: config.startingCapital,
  selectedMarket: defaultMarket,
  positions: {},
  history: [],
  logs: []
};

// In-memory state store to avoid read/write collisions
let memoryState = null;

function loadState() {
  if (memoryState) return memoryState;

  if (!fs.existsSync('./data')) {
    fs.mkdirSync('./data', { recursive: true });
  }

  try {
    if (fs.existsSync(stateFile)) {
      const raw = fs.readFileSync(stateFile, 'utf-8').trim();
      if (raw.length > 0) {
        memoryState = JSON.parse(raw);
        if (!markets[memoryState.selectedMarket]) memoryState.selectedMarket = defaultMarket;
        return memoryState;
      }
    }
  } catch (err) {
    console.error("Corrupted state file detected. Re-initializing...", err.message);
  }

  // Fallback if file was empty, missing, or invalid JSON
  memoryState = { ...defaultConfig };
  saveState(memoryState);
  return memoryState;
}

function saveState(state) {
  memoryState = state;
  try {
    // Atomic-like write: write to temp file then rename
    const tempFile = `${stateFile}.tmp`;
    fs.writeFileSync(tempFile, JSON.stringify(state, null, 2), 'utf-8');
    fs.renameSync(tempFile, stateFile);
  } catch (err) {
    console.error("Failed to save state to disk:", err.message);
  }
}

// Initial state load on startup
loadState();

// 1. Market Hours Guard (IST)
function getSelectedMarket(state = loadState()) {
  return markets[state.selectedMarket] || markets[defaultMarket];
}

function isMarketOpen(market = getSelectedMarket()) {
  const now = new Date();
  const istFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: market.timeZone,
    hour12: false,
    weekday: 'short',
    hour: 'numeric',
    minute: 'numeric'
  });
  const parts = Object.fromEntries(istFormatter.formatToParts(now).map(p => [p.type, p.value]));
  if (parts.weekday === 'Sat' || parts.weekday === 'Sun') {
    return { open: false, reason: 'Weekend', timeZone: market.timeZone };
  }

  const mins = parseInt(parts.hour, 10) * 60 + parseInt(parts.minute, 10);
  const session = market.sessions.find(([start, end]) => mins >= start && mins < end);
  if (session) return { open: true, reason: 'Live Regular Session', timeZone: market.timeZone };
  if (mins < market.sessions[0][0]) return { open: false, reason: 'Pre-market', timeZone: market.timeZone };
  if (mins >= market.sessions[market.sessions.length - 1][1]) {
    return { open: false, reason: 'Market Closed', timeZone: market.timeZone };
  }
  return { open: false, reason: 'Trading Break', timeZone: market.timeZone };
}

// 2. Regulatory Charges Calculator
function calculateFriction(tradeValue, side = 'BUY') {
  const brokerage = Math.min(config.fees.brokerageFlat, tradeValue * 0.0003);
  const stt = side === 'SELL' ? tradeValue * config.fees.sttPct : 0;
  const exchange = tradeValue * config.fees.exchangeTurnoverPct;
  const sebi = tradeValue * config.fees.sebiTurnoverPct;
  const stamp = side === 'BUY' ? tradeValue * config.fees.stampDutyPct : 0;
  const gst = (brokerage + exchange + sebi) * config.fees.gstPct;
  const slippage = tradeValue * config.slippagePct;
  return brokerage + stt + exchange + sebi + stamp + gst + slippage;
}

// 3. Yahoo Finance Live Fetcher
async function fetchPrice(symbol) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1m&range=1d`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) return null;
    const data = await res.json();
    const meta = data?.chart?.result?.[0]?.meta;
    return meta?.regularMarketPrice || null;
  } catch {
    return null;
  }
}

// 4. Autonomous Trading Loop
async function runBotCycle() {
  const state = loadState();
  const selectedMarket = getSelectedMarket(state);
  const market = isMarketOpen(selectedMarket);
  const timestamp = new Date().toISOString();

  let totalPositionValue = 0;
  const prices = {};

  // Update quotes & monitor existing positions
  for (const item of selectedMarket.watchlist) {
    const price = await fetchPrice(item.symbol);
    if (!price) continue;
    prices[item.symbol] = price;

    if (state.positions[item.symbol]) {
      const pos = state.positions[item.symbol];
      const pnlPct = (price - pos.buyPrice) / pos.buyPrice;
      totalPositionValue += pos.shares * price;

      // Stop Loss / Take Profit Execution
      const hitSL = pnlPct <= -config.risk.stopLossPct;
      const hitTP = pnlPct >= config.risk.takeProfitPct;

      if (hitSL || hitTP) {
        const grossReturn = pos.shares * price;
        const friction = calculateFriction(grossReturn, 'SELL');
        const netCash = grossReturn - friction;
        state.cash += netCash;
        state.history.push({
          type: hitSL ? 'STOP_LOSS' : 'TAKE_PROFIT',
          symbol: item.symbol,
          shares: pos.shares,
          exitPrice: price,
          pnl: netCash - (pos.shares * pos.buyPrice),
          timestamp
        });
        delete state.positions[item.symbol];
        state.logs.unshift(`[${timestamp}] CLOSED ${item.symbol} at ₹${price} (${hitSL ? 'SL' : 'TP'})`);
      }
    }
  }

  // Look for new entries during open market hours
  if (market.open) {
    for (const item of selectedMarket.watchlist) {
      if (state.positions[item.symbol]) continue;
      const price = prices[item.symbol];
      if (!price) continue;

      // Rule: allocate maxPositionPct of equity
      const maxAlloc = state.equity * config.risk.maxPositionPct;
      if (state.cash > maxAlloc && maxAlloc > price) {
        const shares = Math.floor(maxAlloc / price);
        const cost = shares * price;
        const friction = calculateFriction(cost, 'BUY');

        if (state.cash >= cost + friction) {
          state.cash -= (cost + friction);
          state.positions[item.symbol] = {
            shares,
            buyPrice: price,
            enteredAt: timestamp
          };
          state.logs.unshift(`[${timestamp}] BOUGHT ${shares} shares of ${item.symbol} at ₹${price}`);
        }
      }
    }
  }

  state.equity = state.cash + totalPositionValue;
  state.logs = state.logs.slice(0, 50); // keep last 50 entries
  saveState(state);
}

// Start trading loop
setInterval(runBotCycle, config.loopSeconds * 1000);

// Web API
app.use(express.static('public'));
app.use(express.json());
app.get('/api/markets', (req, res) => {
  res.json(Object.entries(markets).map(([id, market]) => ({
    id,
    name: market.name,
    currency: market.currency,
    currencySymbol: market.currencySymbol,
    timeZone: market.timeZone,
    watchlist: market.watchlist
  })));
});
app.post('/api/market', (req, res) => {
  const { marketId } = req.body || {};
  const state = loadState();

  if (!markets[marketId]) return res.status(400).json({ error: 'Unsupported market' });
  if (state.selectedMarket === marketId) return res.json({ selectedMarket: marketId });
  if (Object.keys(state.positions).length > 0) {
    return res.status(409).json({ error: 'Close all open positions before changing markets' });
  }

  state.selectedMarket = marketId;
  saveState(state);
  res.json({ selectedMarket: marketId });
});
app.get('/api/state', (req, res) => {
  const state = loadState();
  const market = getSelectedMarket(state);
  res.json({
    ...state,
    market: {
      name: market.name,
      currency: market.currency,
      currencySymbol: market.currencySymbol,
      locale: market.locale,
      timeZone: market.timeZone,
      watchlist: market.watchlist
    },
    marketStatus: isMarketOpen(market)
  });
});

app.listen(PORT, () => {
  console.log(`FabInvests multi-market bot running on http://localhost:${PORT}`);
});