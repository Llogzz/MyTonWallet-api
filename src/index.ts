import 'dotenv/config';
import express, { Request, Response } from 'express';
import cors from 'cors';
import { db } from './db';

import walletsRouter from './routes/wallets';
import addressesRouter from './routes/addresses';
import transactionsRouter from './routes/transactions';
import tokensRouter from './routes/tokens';
import sendRouter from './routes/send';
import stakingRouter, { stakingCommonHandler } from './routes/staking';
import swapRouter, { addressSwapRouter } from './routes/swap';
import multisendRouter from './routes/multisend';
import webhooksRouter from './routes/webhooks';
import portfolioRouter from './routes/portfolio';
import { knownTokensHandler } from './routes/tokens';
import { startMonitor, stopMonitor } from './services/monitor';
import { getTokenPrices } from './toncenter';
import { cache, TTL } from './cache';

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

app.use(cors());
app.use(express.json());

// ── Wallets ───────────────────────────────────────────────────────────────────
app.use('/wallets', walletsRouter);

// ── Accounts (balance lookup + per-address operations) ────────────────────────
app.use('/accounts', addressesRouter);

// ── Transactions ──────────────────────────────────────────────────────────────
app.use('/accounts/:address/transactions', transactionsRouter);

app.get('/accounts/:address/incoming', (req: Request, res: Response, next) => {
  req.url = '/incoming';
  transactionsRouter(req, res, next);
});

// ── Tokens ────────────────────────────────────────────────────────────────────
app.use('/accounts/:address/tokens', tokensRouter);
app.get('/tokens/known', knownTokensHandler);

app.get('/tokens/prices', async (req: Request, res: Response) => {
  try {
    const slugsParam = req.query.slugs as string || '';
    const slugs = slugsParam.split(',').filter(Boolean);
    if (!slugs.length) { res.status(400).json({ error: 'slugs query param required' }); return; }
    const cacheKey = `prices:${slugs.sort().join(',')}`;
    let cached = cache.get<object>(cacheKey);
    if (!cached) {
      cached = await getTokenPrices(slugs);
      cache.set(cacheKey, cached, TTL.BALANCE);
    }
    res.json(cached);
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
});

// ── Send ──────────────────────────────────────────────────────────────────────
app.use('/accounts/:address/send', sendRouter);
app.use('/accounts/:address/send/multi', multisendRouter);

// ── Staking ───────────────────────────────────────────────────────────────────
app.use('/accounts/:address/staking', stakingRouter);
app.get('/staking/common', stakingCommonHandler);

// ── Swap ──────────────────────────────────────────────────────────────────────
app.use('/swap', swapRouter);
app.use('/accounts/:address/swap', addressSwapRouter);

// ── Webhooks ──────────────────────────────────────────────────────────────────
app.use('/accounts/:address/webhooks', webhooksRouter);

// ── Portfolio ─────────────────────────────────────────────────────────────────
app.use('/', portfolioRouter);

// ── Health ───────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ ok: true, time: Math.floor(Date.now() / 1000) });
});

// ── Start ────────────────────────────────────────────────────────────────────
const server = app.listen(PORT, () => {
  console.log(`MyTonWallet API running on http://localhost:${PORT}`);
  startMonitor();
});

function shutdown(): void {
  console.log('\n[server] Shutting down…');
  stopMonitor();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
