import { Router, Request, Response } from 'express';
import axios from 'axios';
import { stmtGetAllWallets, WalletRow } from '../db';
import { EVM_CHAINS, evmGetBalance } from '../services/chains/evm';
import { solanaGetBalance } from '../services/chains/solana';
import { tronGetBalance } from '../services/chains/tron';
import { getWalletStates, getJettonWallets, getTokenPrices } from '../toncenter';

const router = Router();

// Maps a chain to its native coin's CoinGecko id. Chains whose native coin
// has no listing yet (e.g. Monad) are omitted and priced at $0.
const COINGECKO_IDS: Record<string, string> = {
  ethereum:    'ethereum',
  base:        'ethereum',
  bnb:         'binancecoin',
  polygon:     'matic-network',
  arbitrum:    'ethereum',
  avalanche:   'avalanche-2',
  hyperliquid: 'hyperliquid',
  solana:      'solana',
  tron:        'tron',
};

async function getCoingeckoPrices(): Promise<Record<string, number>> {
  try {
    const ids = [...new Set([...Object.values(COINGECKO_IDS), 'toncoin'])].join(',');
    const { data } = await axios.get('https://api.coingecko.com/api/v3/simple/price', {
      params: { ids, vs_currencies: 'usd' },
      timeout: 10_000,
    });
    const result: Record<string, number> = {};
    for (const [id, price] of Object.entries(data as Record<string, { usd: number }>)) {
      result[id] = price.usd;
    }
    return result;
  } catch {
    return {};
  }
}

interface WalletValue {
  address: string;
  chain: string;
  label: string | null;
  native: number;
  tokens: number;
}

// Native + (TON only) Jetton value in USD for a single wallet.
async function valueWallet(wallet: WalletRow, prices: Record<string, number>): Promise<WalletValue> {
  const chain = wallet.chain || 'ton';
  let native = 0;
  let tokens = 0;

  try {
    if (chain === 'ton') {
      const network = wallet.network || process.env.NETWORK || 'mainnet';
      const [state] = await getWalletStates(network, [wallet.address]);
      native = (Number(BigInt(state?.balance || '0')) / 1e9) * (prices['toncoin'] || 0);

      const { jetton_wallets, metadata } = await getJettonWallets(network, wallet.address);
      const nonZero = jetton_wallets.filter(j => j.balance !== '0');
      if (nonZero.length) {
        const jettonPrices = await getTokenPrices(nonZero.map(j => j.jetton));
        for (const jw of nonZero) {
          const decimals = parseInt(metadata[jw.jetton]?.decimals || '9', 10);
          tokens += (Number(BigInt(jw.balance)) / 10 ** decimals) * (jettonPrices[jw.jetton] || 0);
        }
      }
    } else if (EVM_CHAINS.has(chain)) {
      const { native: bal } = await evmGetBalance(chain, wallet.address);
      native = parseFloat(bal) * (prices[COINGECKO_IDS[chain]] || 0);
    } else if (chain === 'solana') {
      const { native: bal } = await solanaGetBalance(wallet.address);
      native = parseFloat(bal) * (prices['solana'] || 0);
    } else if (chain === 'tron') {
      const { native: bal } = await tronGetBalance(wallet.address);
      native = parseFloat(bal) * (prices['tron'] || 0);
    }
  } catch { /* an unreachable chain shouldn't sink the whole portfolio */ }

  return { address: wallet.address, chain, label: wallet.label, native, tokens };
}

router.get('/portfolio', async (_req: Request, res: Response) => {
  try {
    const wallets = stmtGetAllWallets.all() as WalletRow[];
    const prices = await getCoingeckoPrices();
    const valued = await Promise.all(wallets.map(w => valueWallet(w, prices)));

    const byChain: Record<string, number> = {};
    let total = 0;
    for (const w of valued) {
      const sum = w.native + w.tokens;
      total += sum;
      byChain[w.chain] = (byChain[w.chain] || 0) + sum;
    }

    res.json({
      total_usd: total.toFixed(2),
      wallets: valued.map(w => ({
        address: w.address,
        chain: w.chain,
        label: w.label,
        native_usd: w.native.toFixed(2),
        tokens_usd: w.tokens.toFixed(2),
        total_usd: (w.native + w.tokens).toFixed(2),
      })),
      by_chain: Object.fromEntries(Object.entries(byChain).map(([c, v]) => [c, v.toFixed(2)])),
    });
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
});

export default router;
