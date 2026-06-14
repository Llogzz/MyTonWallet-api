import { Router, Request, Response } from 'express';
import axios from 'axios';
import { stmtGetAllAddresses, AddressRow } from '../db';
import { EVM_CHAINS, evmGetBalance } from '../services/chains/evm';
import { solanaGetBalance } from '../services/chains/solana';
import { tronGetBalance } from '../services/chains/tron';
import { getWalletStates, getJettonWallets, getTokenPrices } from '../toncenter';

const router = Router();

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

interface AddressValue {
  address: string;
  chain: string;
  network: string;
  label: string | null;
  native: number;
  tokens: number;
}

async function valueAddress(row: AddressRow, prices: Record<string, number>): Promise<AddressValue> {
  const { address, chain, network, label } = row;
  let native = 0;
  let tokens = 0;

  try {
    if (chain === 'ton') {
      const [state] = await getWalletStates(network, [address]);
      native = (Number(BigInt(state?.balance || '0')) / 1e9) * (prices['toncoin'] || 0);

      const { jetton_wallets, metadata } = await getJettonWallets(network, address);
      const nonZero = jetton_wallets.filter(j => j.balance !== '0');
      if (nonZero.length) {
        const jettonPrices = await getTokenPrices(nonZero.map(j => j.jetton));
        for (const jw of nonZero) {
          const decimals = parseInt(metadata[jw.jetton]?.decimals || '9', 10);
          tokens += (Number(BigInt(jw.balance)) / 10 ** decimals) * (jettonPrices[jw.jetton] || 0);
        }
      }
    } else if (EVM_CHAINS.has(chain)) {
      const { native: bal } = await evmGetBalance(chain, address);
      native = parseFloat(bal) * (prices[COINGECKO_IDS[chain]] || 0);
    } else if (chain === 'solana') {
      const { native: bal } = await solanaGetBalance(address);
      native = parseFloat(bal) * (prices['solana'] || 0);
    } else if (chain === 'tron') {
      const { native: bal } = await tronGetBalance(address);
      native = parseFloat(bal) * (prices['tron'] || 0);
    }
  } catch { /* don't sink the whole portfolio on a single chain error */ }

  return { address, chain, network, label, native, tokens };
}

router.get('/portfolio', async (_req: Request, res: Response) => {
  try {
    const addresses = stmtGetAllAddresses.all() as AddressRow[];
    const prices = await getCoingeckoPrices();
    const valued = await Promise.all(addresses.map(a => valueAddress(a, prices)));

    const byChain: Record<string, number> = {};
    let total = 0;
    for (const a of valued) {
      const sum = a.native + a.tokens;
      total += sum;
      byChain[a.chain] = (byChain[a.chain] || 0) + sum;
    }

    res.json({
      total_usd: total.toFixed(2),
      addresses: valued.map(a => ({
        address: a.address,
        chain: a.chain,
        network: a.network,
        label: a.label,
        native_usd: a.native.toFixed(2),
        tokens_usd: a.tokens.toFixed(2),
        total_usd: (a.native + a.tokens).toFixed(2),
      })),
      by_chain: Object.fromEntries(Object.entries(byChain).map(([c, v]) => [c, v.toFixed(2)])),
    });
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
});

export default router;
