import { Router, Request, Response } from 'express';
import { estimateTonFee } from '../services/transfer';
import { sendTx, estimateFee } from '../services/chains';
import { resolveOr400, mnemonicWords } from '../services/addressContext';
import { cache } from '../cache';
import type { WalletVersion } from '../services/wallet';

const router = Router({ mergeParams: true });

interface SendBody {
  mnemonic?: string | string[];
  to: string;
  amount?: string;
  all?: boolean;
  token?: string;
  comment?: string;
  gasLimit?: number;
}

// POST /accounts/:address/send/estimate — all chains
router.post('/estimate', async (req: Request, res: Response) => {
  try {
    const ctx = resolveOr400(req, res);
    if (!ctx) return;
    const body = req.body as SendBody;

    if (ctx.chain === 'ton') {
      const mnemonic = mnemonicWords(ctx, body.mnemonic);
      if (mnemonic && body.to) {
        try {
          const result = await estimateTonFee({
            mnemonic,
            version: (ctx.version || 'W5') as WalletVersion,
            network: ctx.network,
            toAddress: body.to,
            amount: body.amount || '0',
            commentText: body.comment,
          });
          res.json({ estimated_fee: result.fee, estimated_fee_raw: result.feeNano, native_symbol: 'TON' });
          return;
        } catch { /* fall through to generic estimate */ }
      }
    }

    const fee = await estimateFee(ctx.chain, { token: body.token, network: ctx.network });
    res.json(fee);
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
});

// POST /accounts/:address/send
router.post('/', async (req: Request, res: Response) => {
  try {
    const ctx = resolveOr400(req, res);
    if (!ctx) return;
    const body = req.body as SendBody;

    const mnemonic = mnemonicWords(ctx, body.mnemonic);
    if (!mnemonic) { res.status(400).json({ error: 'mnemonic required' }); return; }
    if (!body.to) { res.status(400).json({ error: 'to is required' }); return; }
    if (!body.all && !body.amount) {
      res.status(400).json({ error: 'amount is required (or pass "all": true to send full balance)' });
      return;
    }

    const txResult = await sendTx(ctx.chain, {
      mnemonic,
      from: ctx.address,
      to: body.to,
      amount: body.amount || '0',
      all: body.all,
      token: body.token,
      comment: body.comment,
      version: (ctx.version || 'W5') as WalletVersion,
      network: ctx.network,
      gasLimit: body.gasLimit,
    });

    cache.invalidatePrefix(`balance:${ctx.address}`);
    cache.invalidatePrefix(`tx:${ctx.address}`);
    res.json({ ok: true, tx_hash: txResult });
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
});

export default router;
