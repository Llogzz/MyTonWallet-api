import { Router, Request, Response } from 'express';
import axios from 'axios';
import { getSwapAssets, getSwapPairs, postSwapEstimate } from '../toncenter';
import { cache, TTL } from '../cache';
import { stmtGetWallet, WalletRow } from '../db';
import { normalizeAddress } from '../services/wallet';
import { sendTon } from '../services/transfer';
import type { WalletVersion } from '../services/wallet';
import { EVM_CHAINS, evmSwapQuote, evmSwapBuild, evmSwapExecute } from '../services/chains/evm';
import { solanaSwapQuote, solanaSwapExecute } from '../services/chains/solana';
import { tronSwapQuote, tronSwapExecute } from '../services/chains/tron';

const router = Router();

const SWAP_API = 'https://api.mytonwallet.org';

// GET /swap/assets
router.get('/assets', async (_req: Request, res: Response) => {
  try {
    const cacheKey = 'swap:assets';
    let cached = cache.get<unknown>(cacheKey);
    if (!cached) {
      cached = await getSwapAssets();
      cache.set(cacheKey, cached, TTL.TOKEN_META);
    }
    res.json(cached);
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /swap/pairs?asset=TON
router.get('/pairs', async (req: Request, res: Response) => {
  try {
    const asset = req.query.asset as string;
    if (!asset) { res.status(400).json({ error: 'asset query param required' }); return; }
    const cacheKey = `swap:pairs:${asset}`;
    let cached = cache.get<unknown>(cacheKey);
    if (!cached) {
      cached = await getSwapPairs(asset);
      cache.set(cacheKey, cached, TTL.JETTONS);
    }
    res.json(cached);
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
});

// POST /swap/estimate
router.post('/estimate', async (req: Request, res: Response) => {
  try {
    const body = req.body;
    if (!body.from || !body.to || !body.fromAmount) {
      res.status(400).json({ error: 'from, to, fromAmount are required' });
      return;
    }
    const result = await postSwapEstimate(body);
    res.json(result);
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
});

// POST /swap/build  — build swap tx without executing (TON only)
// Body: { from, to, amount, slippage, walletAddress }
router.post('/build', async (req: Request, res: Response) => {
  try {
    const body = req.body as { from?: string; to?: string; amount?: string; slippage?: number; walletAddress?: string };
    if (!body.from || !body.to || !body.amount || !body.walletAddress) {
      res.status(400).json({ error: 'from, to, amount, walletAddress are required' });
      return;
    }
    const { data } = await axios.post(`${SWAP_API}/swap/build`, body, { timeout: 15_000 });
    res.json(data);
  } catch (err: unknown) {
    if (axios.isAxiosError(err)) {
      res.status(err.response?.status || 500).json(err.response?.data || { error: String(err) });
    } else {
      res.status(500).json({ error: String(err) });
    }
  }
});

// POST /wallets/:address/swap  — build + execute swap (all chains)
// TON body:  { mnemonic?, from, to, amount, slippage }
// EVM body:  { mnemonic?, fromToken, toToken, amount, slippage, srcDecimals, destDecimals }
// SOL body:  { mnemonic?, fromToken, toToken, amount, slippageBps }
// TRON body: { mnemonic?, fromToken, toToken, amount, slippage }
router.post('/wallets/:address/swap', async (req: Request, res: Response) => {
  try {
    const address = normalizeAddress(req.params['address'] as string);
    const body = req.body as {
      mnemonic?: string | string[];
      from?: string; to?: string;
      fromToken?: string; toToken?: string;
      amount?: string; slippage?: number;
      srcDecimals?: number; destDecimals?: number; slippageBps?: number;
    };

    const wallet = stmtGetWallet.get(address) as WalletRow | undefined;
    const mnemonic = body.mnemonic
      ? (Array.isArray(body.mnemonic) ? body.mnemonic : body.mnemonic.trim().split(/\s+/))
      : wallet?.mnemonic?.split(' ');

    if (!mnemonic) { res.status(400).json({ error: 'mnemonic required' }); return; }

    const chain = wallet?.chain || 'ton';
    const network = wallet?.network || process.env.NETWORK || 'mainnet';

    if (chain === 'ton') {
      if (!body.from || !body.to || !body.amount) {
        res.status(400).json({ error: 'from, to, amount are required' }); return;
      }
      const version = (wallet?.version || 'W5') as WalletVersion;
      const { data: buildResult } = await axios.post(`${SWAP_API}/swap/build`, {
        from: body.from, to: body.to, amount: body.amount,
        slippage: body.slippage ?? 0.5, walletAddress: address,
      }, { timeout: 15_000 });
      const messages = (buildResult.messages || buildResult.txs || []) as Array<Record<string, unknown>>;
      if (!messages.length) { res.status(500).json({ error: 'No messages returned from swap build' }); return; }
      const msg = messages[0] as Record<string, unknown>;
      const txHash = await sendTon({
        mnemonic, version, network,
        toAddress: (msg['toAddress'] || msg['to']) as string,
        amount: (msg['amount'] || msg['value']) as string,
        commentText: undefined,
      });
      res.json({ ok: true, tx_hash: txHash, messages_count: messages.length });

    } else if (EVM_CHAINS.has(chain)) {
      const { fromToken, toToken, amount, slippage = 0.5, srcDecimals = 18, destDecimals = 18 } = body;
      if (!fromToken || !toToken || !amount) {
        res.status(400).json({ error: 'fromToken, toToken, amount are required for EVM swap' }); return;
      }
      const slippageBps = Math.round(slippage * 100);
      const { destAmount, spender, priceRoute } = await evmSwapQuote({ srcToken: fromToken, destToken: toToken, amount, srcDecimals, destDecimals, chain });
      const swapTx = await evmSwapBuild({ srcToken: fromToken, destToken: toToken, srcAmount: amount, slippageBps, priceRoute, userAddress: address, chain });
      const txHash = await evmSwapExecute({ chain, mnemonic, srcToken: fromToken, srcAmount: amount, spender, swapTx });
      res.json({ ok: true, tx_hash: txHash, est_received: destAmount });

    } else if (chain === 'solana') {
      const { fromToken, toToken, amount, slippageBps = 50 } = body;
      if (!fromToken || !toToken || !amount) {
        res.status(400).json({ error: 'fromToken, toToken, amount are required for Solana swap' }); return;
      }
      const { outAmount, quoteResponse } = await solanaSwapQuote({ inputMint: fromToken, outputMint: toToken, amount, slippageBps });
      const txHash = await solanaSwapExecute({ mnemonic, quoteResponse, userPublicKey: address });
      res.json({ ok: true, tx_hash: txHash, est_received: outAmount });

    } else if (chain === 'tron') {
      const { fromToken, toToken, amount, slippage = 1 } = body;
      if (!fromToken || !toToken || !amount) {
        res.status(400).json({ error: 'fromToken, toToken, amount are required for TRON swap' }); return;
      }
      const { amountOut, path } = await tronSwapQuote({ fromToken, toToken, amountIn: amount });
      const minAmountOut = (BigInt(amountOut) * BigInt(Math.round((1 - slippage / 100) * 1000)) / 1000n).toString();
      const txHash = await tronSwapExecute({ mnemonic, fromToken, toToken, amountIn: amount, minAmountOut, path });
      res.json({ ok: true, tx_hash: txHash, est_received: amountOut });

    } else {
      res.status(400).json({ error: `Swap not supported for chain: ${chain}` });
    }
  } catch (err: unknown) {
    if (axios.isAxiosError(err)) {
      res.status(err.response?.status || 500).json(err.response?.data || { error: String(err) });
    } else {
      res.status(500).json({ error: String(err) });
    }
  }
});

// Re-export for use in index.ts
export { router as swapWalletHandler };
export default router;
