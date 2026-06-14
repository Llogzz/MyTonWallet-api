import { Router, Request, Response } from 'express';
import { resolveOr400 } from '../services/addressContext';
import { getBalance } from '../services/chains';
import { cache, TTL } from '../cache';

const router = Router();

// GET /addresses/:address  — native + token balances for one chain.
// Use ?chain= (and ?network=) when the same address exists on several chains.
router.get('/:address', async (req: Request, res: Response) => {
  try {
    const ctx = resolveOr400(req, res);
    if (!ctx) return;

    const cacheKey = `balance:${ctx.address}:${ctx.chain}:${ctx.network}`;
    let cached = cache.get<object>(cacheKey);
    if (!cached) {
      const balance = await getBalance(ctx.chain, ctx.address, ctx.network);
      cached = { address: ctx.address, chain: ctx.chain, network: ctx.network, ...balance };
      cache.set(cacheKey, cached, TTL.BALANCE);
    }
    res.json(cached);
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
});

export default router;
