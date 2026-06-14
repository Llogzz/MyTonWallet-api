import { Router, Request, Response } from 'express';
import { generateMnemonic, mnemonicToWallet, normalizeAddress, type WalletVersion } from '../services/wallet';
import { mnemonicValidate } from '@ton/crypto';
import * as bip39 from 'bip39';
import { stmtInsertWallet, stmtGetWallet, stmtGetAllWallets, stmtDeleteWallet, WalletRow } from '../db';
import { getWalletStates, getJettonWallets } from '../toncenter';
import { cache, TTL } from '../cache';
import { syncWalletNow, notifyWalletAdded } from '../services/monitor';
import { EVM_CHAINS, evmMnemonicToAddress, evmGetBalance } from '../services/chains/evm';
import { solanaMnemonicToAddress, solanaGetBalance } from '../services/chains/solana';
import { tronMnemonicToAddress, tronGetBalance } from '../services/chains/tron';

const router = Router();
const NETWORK = process.env.NETWORK || 'mainnet';

const KNOWN_TOKENS: Record<string, { symbol: string; decimals: number }> = {
  'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs': { symbol: 'USDT', decimals: 6 },
  'EQAIb6KmdfdDR7CN1GBqVJuP25iCnLKCvBlJ07Evuu2dzP5f': { symbol: 'USDe', decimals: 6 },
  'EQDQ5UUyPHrLcQJlPAczd_fjxn8SLrlNQwolBznxCdSlfQwr': { symbol: 'tsUSDe', decimals: 6 },
  'EQBlqsm144Dq6SjbPI4jjZvA1hqTIP3CvHovbIfW_t-SCALE': { symbol: 'SCALE', decimals: 9 },
};

function tryNormalize(address: string): string {
  if (address.startsWith('0x') || address.startsWith('0X')) return address;
  try { return normalizeAddress(address); } catch { return address; }
}

// POST /wallets/generate
router.post('/generate', async (_req: Request, res: Response) => {
  try {
    const mnemonic = await generateMnemonic();
    const { address } = await mnemonicToWallet(mnemonic, 'W5');
    res.json({ mnemonic, address, version: 'W5', network: NETWORK, chain: 'ton' });
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
});

// POST /wallets/import
router.post('/import', async (req: Request, res: Response) => {
  try {
    const { mnemonic, version = 'W5', label, network = NETWORK, chain = 'ton' } = req.body as {
      mnemonic: string | string[];
      version?: WalletVersion;
      label?: string;
      network?: string;
      chain?: string;
    };

    if (!mnemonic) {
      res.status(400).json({ error: 'mnemonic is required' });
      return;
    }

    const words = Array.isArray(mnemonic) ? mnemonic : mnemonic.trim().split(/\s+/);
    if (words.length !== 12 && words.length !== 24) {
      res.status(400).json({ error: 'Mnemonic must be 12 or 24 words' });
      return;
    }

    const isTon = await mnemonicValidate(words);
    const isBip = bip39.validateMnemonic(words.join(' '));
    if (!isTon && !isBip) {
      res.status(400).json({ error: 'Invalid mnemonic: not a valid TON or BIP39 seed phrase' });
      return;
    }

    let address: string;
    if (chain === 'ton') {
      const result = await mnemonicToWallet(words, version as WalletVersion);
      address = result.address;
    } else if (EVM_CHAINS.has(chain)) {
      address = evmMnemonicToAddress(words);
    } else if (chain === 'solana') {
      address = solanaMnemonicToAddress(words);
    } else if (chain === 'tron') {
      address = tronMnemonicToAddress(words);
    } else {
      res.status(400).json({ error: `Unsupported chain: ${chain}. Supported: ton, ethereum, base, bnb, polygon, arbitrum, avalanche, monad, hyperliquid, solana, tron` });
      return;
    }

    const now = Math.floor(Date.now() / 1000);
    stmtInsertWallet.run(address, words.join(' '), version, network, chain, label || null, now);

    const walletRow = stmtGetWallet.get(address) as WalletRow;
    if (chain === 'ton') {
      notifyWalletAdded(walletRow);
      syncWalletNow(address, network).catch(() => {});
    }

    res.status(201).json({
      address,
      version: chain === 'ton' ? version : null,
      network,
      chain,
      label: label || null,
      mnemonic_type: isTon ? 'ton' : 'bip39',
    });
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /wallets
router.get('/', (_req: Request, res: Response) => {
  const wallets = stmtGetAllWallets.all() as WalletRow[];
  res.json(wallets.map(w => ({
    address: w.address,
    version: w.version,
    network: w.network,
    chain: w.chain || 'ton',
    label: w.label,
    created_at: w.created_at,
  })));
});

// GET /wallets/:address
router.get('/:address', async (req: Request, res: Response) => {
  try {
    const rawAddr = req.params['address'] as string;
    const address = tryNormalize(rawAddr);

    const wallet = stmtGetWallet.get(address) as WalletRow | undefined;
    const chain = wallet?.chain || 'ton';
    const network = wallet?.network || NETWORK;

    const cacheKey = `balance:${address}`;
    let cached = cache.get<object>(cacheKey);

    if (!cached) {
      if (chain === 'ton') {
        const [state] = await getWalletStates(network, [address]);
        const { jetton_wallets, metadata } = await getJettonWallets(network, address);
        const tokens = jetton_wallets
          .filter(j => j.balance !== '0')
          .map(j => {
            const meta = metadata[j.jetton] || {};
            const known = KNOWN_TOKENS[j.jetton];
            return {
              jetton_address: j.jetton,
              wallet_address: j.address,
              symbol: known?.symbol || meta.symbol || '?',
              name: meta.name || known?.symbol || 'Unknown',
              decimals: known?.decimals ?? parseInt(meta.decimals || '9', 10),
              balance_raw: j.balance,
              balance: formatAmount(j.balance, known?.decimals ?? parseInt(meta.decimals || '9', 10)),
            };
          });
        cached = {
          address,
          network,
          chain,
          version: wallet?.version || 'W5',
          label: wallet?.label || null,
          ton_balance_raw: state?.balance || '0',
          ton_balance: formatAmount(state?.balance || '0', 9),
          status: state?.status || 'unknown',
          tokens,
        };
      } else if (EVM_CHAINS.has(chain)) {
        const { native_raw, native, tokens } = await evmGetBalance(chain, address);
        cached = { address, chain, network, label: wallet?.label || null, native_raw, native, tokens };
      } else if (chain === 'solana') {
        const { native_raw, native, tokens } = await solanaGetBalance(address);
        cached = { address, chain, network, label: wallet?.label || null, native_raw, native, tokens };
      } else if (chain === 'tron') {
        const { native_raw, native, tokens } = await tronGetBalance(address);
        cached = { address, chain, network, label: wallet?.label || null, native_raw, native, tokens };
      } else {
        res.status(400).json({ error: `Unknown chain: ${chain}` });
        return;
      }

      cache.set(cacheKey, cached, TTL.BALANCE);
    }

    res.json(cached);
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
});

// DELETE /wallets/:address
router.delete('/:address', (req: Request, res: Response) => {
  const address = tryNormalize(req.params['address'] as string);
  const result = stmtDeleteWallet.run(address);
  if (result.changes === 0) {
    res.status(404).json({ error: 'Wallet not found' });
    return;
  }
  cache.invalidatePrefix(`balance:${address}`);
  cache.invalidatePrefix(`tx:${address}`);
  res.json({ deleted: true, address });
});

function formatAmount(raw: string, decimals: number): string {
  const n = BigInt(raw || '0');
  const factor = BigInt(10 ** decimals);
  const whole = n / factor;
  const frac = frac_str(n % factor, decimals);
  return `${whole}.${frac}`;
}

function frac_str(rem: bigint, decimals: number): string {
  return rem.toString().padStart(decimals, '0').replace(/0+$/, '') || '0';
}

export default router;
