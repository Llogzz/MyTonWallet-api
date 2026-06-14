import { Router, Request, Response } from 'express';
import axios from 'axios';
import { getSwapAssets, getSwapPairs, postSwapEstimate } from '../toncenter';
import { cache, TTL } from '../cache';
import { resolveOr400, mnemonicWords } from '../services/addressContext';
import { sendTonMessages } from '../services/transfer';
import type { WalletVersion } from '../services/wallet';
import { EVM_CHAINS, evmSwapQuote, evmSwapBuild, evmSwapExecute } from '../services/chains/evm';
import { solanaSwapQuote, solanaSwapExecute } from '../services/chains/solana';
import { tronSwapQuote, tronSwapExecute } from '../services/chains/tron';

// Generic swap routes (assets, pairs, estimate, build) — mounted at /swap
const router = Router();

// Address-specific swap execution — mounted at /addresses/:address/swap
export const addressSwapRouter = Router({ mergeParams: true });

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
    // Include swap versioning parameters required by the MyTonWallet backend
    const result = await postSwapEstimate({
      ...body,
      walletVersion: body.walletVersion || 'W5',
      swapVersion: body.swapVersion ?? 2,
    });
    res.json(result);
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
});

// POST /swap/build — build swap tx without executing (TON only)
// Body: { from, to, amount, slippage, walletAddress, walletVersion?, swapVersion? }
router.post('/build', async (req: Request, res: Response) => {
  try {
    const body = req.body as {
      from?: string; to?: string; amount?: string; slippage?: number;
      walletAddress?: string; walletVersion?: string; swapVersion?: number;
    };
    if (!body.from || !body.to || !body.amount || !body.walletAddress) {
      res.status(400).json({ error: 'from, to, amount, walletAddress are required' });
      return;
    }
    const { data } = await axios.post(`${SWAP_API}/swap/build`, {
      ...body,
      walletVersion: body.walletVersion || 'W5',
      swapVersion: body.swapVersion ?? 2,
      isMsgHashMode: true,
    }, { timeout: 15_000 });
    res.json(data);
  } catch (err: unknown) {
    if (axios.isAxiosError(err)) {
      res.status(err.response?.status || 500).json(err.response?.data || { error: String(err) });
    } else {
      res.status(500).json({ error: String(err) });
    }
  }
});

// POST /addresses/:address/swap — build + execute swap (all chains)
addressSwapRouter.post('/', async (req: Request, res: Response) => {
  try {
    const ctx = resolveOr400(req, res);
    if (!ctx) return;

    const body = req.body as {
      mnemonic?: string | string[];
      from?: string; to?: string;
      fromToken?: string; toToken?: string;
      amount?: string; slippage?: number;
      srcDecimals?: number; destDecimals?: number; slippageBps?: number;
      walletVersion?: string; swapVersion?: number;
    };

    const mnemonic = mnemonicWords(ctx, body.mnemonic);
    if (!mnemonic) { res.status(400).json({ error: 'mnemonic required' }); return; }

    const { address, chain, network } = ctx;

    if (chain === 'ton') {
      if (!body.from || !body.to || !body.amount) {
        res.status(400).json({ error: 'from, to, amount are required' }); return;
      }
      const version = (body.walletVersion || ctx.version || 'W5') as WalletVersion;

      const { data: buildResult } = await axios.post(`${SWAP_API}/swap/build`, {
        from: body.from, to: body.to, amount: body.amount,
        slippage: body.slippage ?? 0.5, walletAddress: address,
        walletVersion: version,
        swapVersion: body.swapVersion ?? 2,
        isMsgHashMode: true,
      }, { timeout: 15_000 });

      const messages = (buildResult.messages || buildResult.txs || []) as Array<Record<string, unknown>>;
      if (!messages.length) { res.status(500).json({ error: 'No messages returned from swap build' }); return; }

      // Send ALL messages in one external transaction (multi-step swaps require this)
      const tonMessages = messages.map(msg => ({
        to: (msg['toAddress'] || msg['to']) as string,
        amount: String(msg['amount'] || msg['value'] || '0'),
        payload: msg['payload'] as string | undefined,
        bounce: false,
      }));

      const txHash = await sendTonMessages({ mnemonic, version, network, messages: tonMessages });
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

export default router;
