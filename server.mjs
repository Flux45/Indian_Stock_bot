import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

const config = JSON.parse(fs.readFileSync('./config.json', 'utf-8'));
const stateFile = './data/state.json';

const defaultConfig = {
  cash: config.startingCapital,
  equity: config.startingCapital,
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
function isMarketOpen() {
  const now = new Date();
  const istFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata',
    hour12: false,
    weekday: 'short',
    hour: 'numeric',
    minute: 'numeric'
  });
  const parts = Object.fromEntries(istFormatter.formatToParts(now).map(p => [p.type, p.value]));
  if (parts.weekday === 'Sat' || parts.weekday === 'Sun') return { open: false, reason: 'Weekend' };

  const mins = parseInt(parts.hour, 10) * 60 + parseInt(parts.minute, 10);
  if (mins < 9 * 60 + 15) return { open: false, reason: 'Pre-market' };
  if (mins >= 15 * 60 + 30) return { open: false, reason: 'Market Closed' };
  return { open: true, reason: 'Live Regular Session' };
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
  const market = isMarketOpen();
  const state = loadState();
  const timestamp = new Date().toISOString();

  let totalPositionValue = 0;
  const prices = {};

  // Update quotes & monitor existing positions
  for (const item of config.watchlist) {
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
    for (const item of config.watchlist) {
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
app.get('/api/state', (req, res) => {
  const state = loadState();
  res.json({ ...state, marketStatus: isMarketOpen() });
});

app.listen(PORT, () => {
  console.log(`FabInvests India running on http://localhost:${PORT}`);
});