import { ethers } from 'ethers';
import axios from 'axios';

export const EVM_CHAINS = new Set(['ethereum', 'base', 'bnb', 'polygon', 'arbitrum', 'avalanche', 'monad', 'hyperliquid']);

const DERIVATION_PATH = "m/44'/60'/0'/0/0";

const PUBLIC_RPCS: Record<string, string> = {
  ethereum: 'https://ethereum.publicnode.com',
  base: 'https://mainnet.base.org',
  bnb: 'https://bsc-dataseed1.binance.org',
  polygon: 'https://polygon-rpc.com',
  arbitrum: 'https://arb1.arbitrum.io/rpc',
  avalanche: 'https://api.avax.network/ext/bc/C/rpc',
  monad: 'https://rpc.monad.xyz',
  hyperliquid: 'https://api.hyperliquid.xyz/evm',
};

function evmApiUrl(): string {
  return process.env.EVM_API_URL || 'https://evmapi.mytonwallet.org';
}

function getProvider(chain: string): ethers.JsonRpcProvider {
  const rpc = PUBLIC_RPCS[chain] || `${evmApiUrl()}/v2/${chain}`;
  return new ethers.JsonRpcProvider(rpc);
}

export function evmMnemonicToAddress(mnemonic: string[]): string {
  const wallet = ethers.HDNodeWallet.fromPhrase(mnemonic.join(' '), undefined, DERIVATION_PATH);
  return wallet.address;
}

export interface TokenBalance {
  token_address: string;
  symbol: string;
  name: string;
  decimals: number;
  balance_raw: string;
  balance: string;
}

export async function evmGetBalance(chain: string, address: string): Promise<{ native_raw: string; native: string; tokens: TokenBalance[] }> {
  try {
    const url = `${evmApiUrl()}/v1/wallets/${address}/positions/?chain_id=${chain}`;
    const { data } = await axios.get(url, { timeout: 10_000 });
    const positions: unknown[] = (data?.data ?? data?.positions ?? []) as unknown[];
    let nativeRaw = '0';
    const tokens: TokenBalance[] = [];

    for (const pos of positions) {
      const attrs = (pos as Record<string, unknown>)['attributes'] ?? pos as Record<string, unknown>;
      const info = (attrs as Record<string, unknown>)['fungible_info'] as Record<string, unknown> | undefined;
      const qty = ((attrs as Record<string, unknown>)['quantity'] as Record<string, string> | undefined);
      const impls = info?.['implementations'] as Array<Record<string, unknown>> | undefined;

      if (!impls?.[0]?.['address']) {
        nativeRaw = qty?.['int'] ?? '0';
      } else {
        const impl = impls[0];
        const dec = (impl['decimals'] as number) ?? 18;
        tokens.push({
          token_address: impl['address'] as string,
          symbol: (info?.['symbol'] as string) || '?',
          name: (info?.['name'] as string) || '?',
          decimals: dec,
          balance_raw: qty?.['int'] ?? '0',
          balance: formatAmount(qty?.['int'] ?? '0', dec),
        });
      }
    }

    return { native_raw: nativeRaw, native: ethers.formatEther(BigInt(nativeRaw)), tokens };
  } catch {
    const provider = getProvider(chain);
    const balance = await provider.getBalance(address);
    return { native_raw: balance.toString(), native: ethers.formatEther(balance), tokens: [] };
  }
}

export async function evmSend(params: {
  chain: string;
  mnemonic: string[];
  to: string;
  amount: string;
  tokenAddress?: string;
  gasLimit?: number;
}): Promise<string> {
  const provider = getProvider(params.chain);
  const hdWallet = ethers.HDNodeWallet.fromPhrase(params.mnemonic.join(' '), undefined, DERIVATION_PATH);
  const wallet = hdWallet.connect(provider);

  if (params.tokenAddress) {
    const erc20 = new ethers.Contract(params.tokenAddress, [
      'function transfer(address to, uint256 amount) returns (bool)',
      'function decimals() view returns (uint8)',
    ], wallet);
    const tx = await erc20.transfer(params.to, BigInt(params.amount));
    return (tx as { hash: string }).hash;
  } else {
    const tx = await wallet.sendTransaction({
      to: params.to,
      value: BigInt(params.amount),
      ...(params.gasLimit ? { gasLimit: params.gasLimit } : {}),
    });
    return tx.hash;
  }
}

export interface TxEntry {
  tx_hash: string;
  direction: 'in' | 'out';
  amount: string;
  token_symbol: string | null;
  token_addr: string | null;
  from_addr: string | null;
  to_addr: string | null;
  comment: string | null;
  timestamp: number;
}

export async function evmGetHistory(chain: string, address: string, since?: number): Promise<TxEntry[]> {
  try {
    const provider = getProvider(chain);
    const addrLower = address.toLowerCase();
    const baseParams = {
      fromBlock: '0x0',
      toBlock: 'latest',
      category: ['external', 'erc20'],
      maxCount: '0x32',
      withMetadata: true,
    };

    const [inRes, outRes] = await Promise.all([
      provider.send('alchemy_getAssetTransfers', [{ ...baseParams, toAddress: address }]).catch(() => null),
      provider.send('alchemy_getAssetTransfers', [{ ...baseParams, fromAddress: address }]).catch(() => null),
    ]);

    const entries: TxEntry[] = [];
    const seen = new Set<string>();

    const process = (res: unknown, direction: 'in' | 'out') => {
      const transfers = (res as Record<string, unknown>)?.['transfers'] as Record<string, unknown>[] ?? [];
      for (const t of transfers) {
        const hash = t['hash'] as string;
        if (seen.has(hash)) continue;
        seen.add(hash);
        const meta = t['metadata'] as Record<string, unknown> | undefined;
        const ts = meta?.['blockTimestamp']
          ? Math.floor(new Date(meta['blockTimestamp'] as string).getTime() / 1000)
          : 0;
        if (since && ts && ts < since) continue;
        const fromAddr = (t['from'] as string) || null;
        const toAddr = (t['to'] as string) || null;
        const dir = fromAddr?.toLowerCase() === addrLower ? 'out' : direction;
        entries.push({
          tx_hash: hash,
          direction: dir,
          amount: String(t['value'] ?? '0'),
          token_symbol: (t['asset'] as string) || null,
          token_addr: ((t['rawContract'] as Record<string, string> | undefined)?.['address']) || null,
          from_addr: fromAddr,
          to_addr: toAddr,
          comment: null,
          timestamp: ts,
        });
      }
    };

    if (inRes) process(inRes, 'in');
    if (outRes) process(outRes, 'out');
    return entries.sort((a, b) => b.timestamp - a.timestamp);
  } catch {
    return [];
  }
}

function formatAmount(raw: string, decimals: number): string {
  try {
    const n = BigInt(raw || '0');
    const factor = BigInt(10 ** decimals);
    const whole = n / factor;
    const frac = (n % factor).toString().padStart(decimals, '0').replace(/0+$/, '') || '0';
    return `${whole}.${frac}`;
  } catch {
    return '0';
  }
}

// ─── Swap (Paraswap) ─────────────────────────────────────────────────────────

const PARASWAP_API = 'https://apiv5.paraswap.io';

// Paraswap's placeholder address for a chain's native coin (ETH/BNB/POL/…).
const NATIVE_TOKEN = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

const PARASWAP_CHAIN_ID: Record<string, number> = {
  ethereum: 1, bnb: 56, polygon: 137, arbitrum: 42161, avalanche: 43114, base: 8453,
};

const ERC20_ALLOWANCE_ABI = [
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
];

function paraswapNetwork(chain: string): number {
  const id = PARASWAP_CHAIN_ID[chain];
  if (!id) throw new Error(`EVM swap not supported on '${chain}' (available: ${Object.keys(PARASWAP_CHAIN_ID).join(', ')})`);
  return id;
}

export interface EvmSwapQuote {
  destAmount: string;
  spender: string;
  priceRoute: Record<string, unknown>;
}

export interface EvmSwapTx {
  to: string;
  data: string;
  value: string;
  gas?: string;
}

export async function evmSwapQuote(params: {
  srcToken: string; destToken: string; amount: string;
  srcDecimals: number; destDecimals: number; chain: string;
}): Promise<EvmSwapQuote> {
  const { data } = await axios.get(`${PARASWAP_API}/prices`, {
    params: {
      srcToken: params.srcToken,
      destToken: params.destToken,
      amount: params.amount,
      srcDecimals: params.srcDecimals,
      destDecimals: params.destDecimals,
      side: 'SELL',
      network: paraswapNetwork(params.chain),
    },
    timeout: 15_000,
  });
  const priceRoute = data.priceRoute as Record<string, unknown>;
  return {
    destAmount: priceRoute['destAmount'] as string,
    spender: priceRoute['tokenTransferProxy'] as string,
    priceRoute,
  };
}

export async function evmSwapBuild(params: {
  srcToken: string; destToken: string; srcAmount: string;
  slippageBps: number; priceRoute: Record<string, unknown>; userAddress: string; chain: string;
}): Promise<EvmSwapTx> {
  // ignoreChecks lets Paraswap build the tx before the ERC-20 approval lands;
  // we send the approval ourselves in evmSwapExecute.
  const { data } = await axios.post(
    `${PARASWAP_API}/transactions/${paraswapNetwork(params.chain)}`,
    {
      srcToken: params.srcToken,
      destToken: params.destToken,
      srcAmount: params.srcAmount,
      slippage: params.slippageBps,
      priceRoute: params.priceRoute,
      userAddress: params.userAddress,
    },
    { params: { ignoreChecks: true }, timeout: 15_000 },
  );
  return { to: data.to as string, data: data.data as string, value: data.value as string, gas: data.gas as string | undefined };
}

export async function evmSwapExecute(params: {
  chain: string; mnemonic: string[]; srcToken: string; srcAmount: string; spender: string; swapTx: EvmSwapTx;
}): Promise<string> {
  const provider = getProvider(params.chain);
  const wallet = ethers.HDNodeWallet.fromPhrase(params.mnemonic.join(' '), undefined, DERIVATION_PATH).connect(provider);

  // ERC-20 inputs must approve the Paraswap proxy before it can pull the tokens.
  if (params.srcToken.toLowerCase() !== NATIVE_TOKEN.toLowerCase()) {
    const token = new ethers.Contract(params.srcToken, ERC20_ALLOWANCE_ABI, wallet);
    const allowance = (await token.allowance(wallet.address, params.spender)) as bigint;
    if (allowance < BigInt(params.srcAmount)) {
      const approveTx = await token.approve(params.spender, ethers.MaxUint256);
      await approveTx.wait();
    }
  }

  const tx = await wallet.sendTransaction({
    to: params.swapTx.to,
    data: params.swapTx.data,
    value: BigInt(params.swapTx.value || '0'),
    ...(params.swapTx.gas ? { gasLimit: BigInt(params.swapTx.gas) } : {}),
  });
  return tx.hash;
}
