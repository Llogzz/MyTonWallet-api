import { ethers } from 'ethers';
import axios from 'axios';
import { TronWeb } from 'tronweb';

const DERIVATION_PATH = "m/44'/195'/0'/0/0";

function tronApiUrl(): string {
  return process.env.TRON_API_URL || 'https://api.trongrid.io';
}

function apiHeaders(): Record<string, string> {
  const h: Record<string, string> = {};
  if (process.env.TRON_API_KEY) h['TRON-PRO-API-KEY'] = process.env.TRON_API_KEY;
  return h;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeTronWeb(privateKey?: string): any {
  const opts: Record<string, unknown> = {
    fullHost: tronApiUrl(),
    headers: apiHeaders(),
  };
  if (privateKey) opts['privateKey'] = privateKey;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new (TronWeb as any)(opts);
}

function getPrivateKey(mnemonic: string[]): string {
  const wallet = ethers.HDNodeWallet.fromPhrase(mnemonic.join(' '), undefined, "m/44'/195'/0'/0/0");
  return wallet.privateKey.slice(2); // strip 0x
}

export function tronMnemonicToAddress(mnemonic: string[]): string {
  const tw = makeTronWeb();
  const account = tw.fromMnemonic(mnemonic.join(' '), DERIVATION_PATH) as { address: string };
  return account.address;
}

export interface TokenBalance {
  token_address: string;
  symbol: string;
  name: string;
  decimals: number;
  balance_raw: string;
  balance: string;
}

export async function tronGetBalance(address: string): Promise<{ native_raw: string; native: string; tokens: TokenBalance[] }> {
  const tw = makeTronWeb();
  const balanceSun = await tw.trx.getBalance(address) as number;
  const nativeRaw = balanceSun.toString();
  const tokens: TokenBalance[] = [];

  try {
    const { data } = await axios.get(
      `${tronApiUrl()}/v1/accounts/${address}`,
      { headers: apiHeaders(), timeout: 10_000 },
    );
    const trc20List = (data?.data?.[0]?.trc20 as Array<Record<string, string>>) || [];
    for (const tokenMap of trc20List) {
      const [tokenAddr, balanceRaw] = Object.entries(tokenMap)[0] as [string, string];
      tokens.push({
        token_address: tokenAddr,
        symbol: '?',
        name: '?',
        decimals: 6,
        balance_raw: balanceRaw,
        balance: formatAmount(balanceRaw, 6),
      });
    }
  } catch { /* ignore */ }

  return { native_raw: nativeRaw, native: formatAmount(nativeRaw, 6), tokens };
}

export async function tronSend(params: {
  mnemonic: string[];
  to: string;
  amount: string;
  tokenAddress?: string;
}): Promise<string> {
  const pk = getPrivateKey(params.mnemonic);
  const tw = makeTronWeb(pk);

  if (params.tokenAddress) {
    const tx = await tw.transactionBuilder.triggerSmartContract(
      params.tokenAddress,
      'transfer(address,uint256)',
      { feeLimit: 10_000_000 },
      [
        { type: 'address', value: params.to },
        { type: 'uint256', value: BigInt(params.amount) },
      ],
      (tw.defaultAddress as { base58: string }).base58,
    ) as { transaction: unknown };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const signed = await tw.trx.signTransaction(tx.transaction, pk) as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await tw.trx.broadcast(signed) as { txid: string };
    return result.txid;
  } else {
    const result = await tw.trx.send(params.to, Number(params.amount), { privateKey: pk }) as { txid: string; transaction?: { txID?: string } };
    return result.txid ?? result.transaction?.txID ?? '';
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

export async function tronGetHistory(address: string, since?: number): Promise<TxEntry[]> {
  const entries: TxEntry[] = [];
  try {
    const params: Record<string, unknown> = { limit: 50, order_by: 'block_timestamp,desc' };
    if (since) params['min_timestamp'] = since * 1000;

    const { data } = await axios.get(
      `${tronApiUrl()}/v1/accounts/${address}/transactions`,
      { params, headers: apiHeaders(), timeout: 10_000 },
    );

    for (const tx of (data?.data as Record<string, unknown>[]) || []) {
      const rawData = tx['raw_data'] as Record<string, unknown> | undefined;
      const contracts = (rawData?.['contract'] as Record<string, unknown>[] | undefined) ?? [];
      const contract = contracts[0];
      const value = contract?.['parameter']
        ? ((contract['parameter'] as Record<string, unknown>)['value'] as Record<string, unknown>)
        : undefined;

      const toAddr = (value?.['to_address'] as string) || null;
      entries.push({
        tx_hash: tx['txID'] as string,
        direction: toAddr === address ? 'in' : 'out',
        amount: String(value?.['amount'] ?? '0'),
        token_symbol: 'TRX',
        token_addr: null,
        from_addr: (value?.['owner_address'] as string) || null,
        to_addr: toAddr,
        comment: null,
        timestamp: Math.floor(((tx['block_timestamp'] as number) || 0) / 1000),
      });
    }
  } catch { /* ignore */ }

  return entries;
}

// ─── Swap (SunSwap) ──────────────────────────────────────────────────────────

const SUNSWAP_ROUTER = 'TKzxdSv2FZKQrEqkKVgp5DcwEXBEKMg2Ax';
const SUNSWAP_API = 'https://rot.endjgfsv.link/swap/router';

export async function tronSwapQuote(params: {
  fromToken: string; toToken: string; amountIn: string;
}): Promise<{ amountOut: string; path: string[] }> {
  const { data } = await axios.get(SUNSWAP_API, {
    params: { fromToken: params.fromToken, toToken: params.toToken, amountIn: params.amountIn, slippage: 1 },
    timeout: 15_000,
  });
  return { amountOut: data.amountOut as string, path: data.tokens as string[] };
}

export async function tronSwapExecute(params: {
  mnemonic: string[]; fromToken: string; toToken: string;
  amountIn: string; minAmountOut: string; path: string[];
}): Promise<string> {
  const pk = getPrivateKey(params.mnemonic);
  const tw = makeTronWeb(pk);
  const deadline = Math.floor(Date.now() / 1000) + 300;
  const tx = await tw.transactionBuilder.triggerSmartContract(
    SUNSWAP_ROUTER,
    'swapExactTokensForTokens(uint256,uint256,address[],address,uint256)',
    { feeLimit: 50_000_000 },
    [
      { type: 'uint256', value: BigInt(params.amountIn) },
      { type: 'uint256', value: BigInt(params.minAmountOut) },
      { type: 'address[]', value: params.path },
      { type: 'address', value: (tw.defaultAddress as { base58: string }).base58 },
      { type: 'uint256', value: BigInt(deadline) },
    ],
    (tw.defaultAddress as { base58: string }).base58,
  ) as { transaction: unknown };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const signed = await tw.trx.signTransaction(tx.transaction, pk) as any;
  const result = await tw.trx.broadcast(signed) as { txid: string };
  return result.txid;
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
