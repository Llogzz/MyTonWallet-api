import { Router, Request, Response } from 'express';
import { stmtGetWallet, WalletRow } from '../db';
import { normalizeAddress, type WalletVersion } from '../services/wallet';
import { sendTon, sendJetton, estimateTonFee } from '../services/transfer';
import { cache } from '../cache';
import { EVM_CHAINS, evmSend } from '../services/chains/evm';
import { solanaSend } from '../services/chains/solana';
import { tronSend } from '../services/chains/tron';

const router = Router({ mergeParams: true });

interface SendBody {
  mnemonic?: string | string[];
  to: string;
  amount: string;
  token?: string;
  comment?: string;
  gasLimit?: number;
}

function tryNormalize(addr: string): string {
  if (addr.startsWith('0x') || addr.startsWith('0X')) return addr;
  try { return normalizeAddress(addr); } catch { return addr; }
}

function resolveMnemonic(bodyMnemonic: string | string[] | undefined, wallet: WalletRow | undefined): string[] | null {
  if (bodyMnemonic) return Array.isArray(bodyMnemonic) ? bodyMnemonic : bodyMnemonic.trim().split(/\s+/);
  if (wallet?.mnemonic) return wallet.mnemonic.split(' ');
  return null;
}

// POST /wallets/:address/send/estimate  (TON only)
router.post('/estimate', async (req: Request, res: Response) => {
  try {
    const address = normalizeAddress(req.params['address'] as string);
    const body = req.body as SendBody;
    const wallet = stmtGetWallet.get(address) as WalletRow | undefined;
    const mnemonic = resolveMnemonic(body.mnemonic, wallet);
    if (!mnemonic) { res.status(400).json({ error: 'mnemonic required' }); return; }

    const network = wallet?.network || process.env.NETWORK || 'mainnet';
    const version = (wallet?.version || 'W5') as WalletVersion;

    const result = await estimateTonFee({
      mnemonic, version, network,
      toAddress: body.to,
      amount: body.amount,
      commentText: body.comment,
    });

    res.json({ estimated_fee_ton: result.fee, estimated_fee_raw: result.feeNano });
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
});

// POST /wallets/:address/send
router.post('/', async (req: Request, res: Response) => {
  try {
    const rawAddr = req.params['address'] as string;
    const address = tryNormalize(rawAddr);
    const body = req.body as SendBody;
    const wallet = stmtGetWallet.get(address) as WalletRow | undefined;

    const mnemonic = resolveMnemonic(body.mnemonic, wallet);
    if (!mnemonic) { res.status(400).json({ error: 'mnemonic required' }); return; }
    if (!body.to) { res.status(400).json({ error: 'to is required' }); return; }
    if (!body.amount) { res.status(400).json({ error: 'amount is required' }); return; }

    const chain = wallet?.chain || 'ton';
    const network = wallet?.network || process.env.NETWORK || 'mainnet';
    const version = (wallet?.version || 'W5') as WalletVersion;

    let txResult: string;

    if (chain === 'ton') {
      if (body.token) {
        txResult = await sendJetton({ mnemonic, version, network, toAddress: body.to, jettonMasterAddress: body.token, amount: body.amount, commentText: body.comment });
      } else {
        txResult = await sendTon({ mnemonic, version, network, toAddress: body.to, amount: body.amount, commentText: body.comment });
      }
    } else if (EVM_CHAINS.has(chain)) {
      txResult = await evmSend({ chain, mnemonic, to: body.to, amount: body.amount, tokenAddress: body.token, gasLimit: body.gasLimit });
    } else if (chain === 'solana') {
      txResult = await solanaSend({ mnemonic, to: body.to, amount: body.amount, tokenMint: body.token });
    } else if (chain === 'tron') {
      txResult = await tronSend({ mnemonic, to: body.to, amount: body.amount, tokenAddress: body.token });
    } else {
      res.status(400).json({ error: `Unsupported chain: ${chain}` });
      return;
    }

    cache.invalidatePrefix(`balance:${address}`);
    cache.invalidatePrefix(`tx:${address}`);
    res.json({ ok: true, tx_hash: txResult });
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
});

export default router;
