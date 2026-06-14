import { ethers } from 'ethers';
import axios from 'axios';
import { TronWeb } from 'tronweb';

const DERIVATION_PATH = "m/44'/195'/0'/0/0";

export interface TronFeeEstimate {
  fee_raw: string;
  fee: string;
  native_symbol: string;
  note: string;
}

export function tronEstimateFee(): TronFeeEstimate {
  return {
    fee_raw: '1000000',
    fee: '1.0',
    native_symbol: 'TRX',
    note: 'Conservative estimate. Actual fee depends on bandwidth; may be 0 if you have staked TRX.',
  };
}

export interface TronTxStatus {
  tx_hash: string;
  status: 'success' | 'failed' | 'not_found';
  block?: number;
  from?: string | null;
  to?: string | null;
}

export async function tronGetTx(hash: string): Promise<TronTxStatus> {
  try {
    const tw = makeTronWeb();
    const tx = await tw.trx.getTransaction(hash) as {
      txID?: string;
      blockNumber?: number;
      ret?: { contractRet: string }[];
      raw_data?: { contract?: { parameter?: { value?: { owner_address?: string; to_address?: string } } }[] };
    };
    if (!tx || !tx.txID) return { tx_hash: hash, status: 'not_found' };
    const contractRet = tx.ret?.[0]?.contractRet ?? '';
    const value = tx.raw_data?.contract?.[0]?.parameter?.value;
    return {
      tx_hash: hash,
      status: contractRet === 'SUCCESS' ? 'success' : 'failed',
      block: tx.blockNumber,
      from: (value?.owner_address as string | undefined) || null,
      to: (value?.to_address as string | undefined) || null,
    };
  } catch {
    return { tx_hash: hash, status: 'not_found' };
  }
}

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
  return wallet.privateKey.slice(2);
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
  sendAll?: boolean;
}): Promise<string> {
  const pk = getPrivateKey(params.mnemonic);
  const tw = makeTronWeb(pk);
  const fromAddr = tronMnemonicToAddress(params.mnemonic);

  // sendAll for native TRX
  if (params.sendAll && !params.tokenAddress) {
    const tw2 = makeTronWeb();
    const balanceSun = await tw2.trx.getBalance(fromAddr) as number;
    const fee = 1_000_000;
    const amount = balanceSun - fee;
    if (amount <= 0) throw new Error('Insufficient balance to cover fee');
    const result = await tw.trx.send(params.to, amount, { privateKey: pk }) as { txid: string; transaction?: { txID?: string } };
    return result.txid ?? result.transaction?.txID ?? '';
  }

  // sendAll for TRC-20: fetch balance via REST and send it all
  if (params.sendAll && params.tokenAddress) {
    const { data } = await axios.get(`${tronApiUrl()}/v1/accounts/${fromAddr}`, { headers: apiHeaders(), timeout: 10_000 });
    const trc20List = (data?.data?.[0]?.trc20 as Array<Record<string, string>>) || [];
    const tokenEntry = trc20List.find(m => Object.keys(m)[0] === params.tokenAddress);
    const balance = tokenEntry ? Object.values(tokenEntry)[0] : '0';
    if (!balance || balance === '0') throw new Error('No TRC-20 balance to send');
    return tronSend({ ...params, sendAll: false, amount: balance });
  }

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
  }

  const result = await tw.trx.send(params.to, Number(params.amount), { privateKey: pk }) as { txid: string; transaction?: { txID?: string } };
  return result.txid ?? result.transaction?.txID ?? '';
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
  const sinceMs = since ? since * 1000 : undefined;
  const reqParams: Record<string, unknown> = { limit: 50, order_by: 'block_timestamp,desc' };
  if (sinceMs) reqParams['min_timestamp'] = sinceMs;

  // Native TRX transfers
  try {
    const { data } = await axios.get(
      `${tronApiUrl()}/v1/accounts/${address}/transactions`,
      { params: reqParams, headers: apiHeaders(), timeout: 10_000 },
    );

    for (const tx of (data?.data as Record<string, unknown>[]) || []) {
      const rawData = tx['raw_data'] as Record<string, unknown> | undefined;
      const contracts = (rawData?.['contract'] as Record<string, unknown>[] | undefined) ?? [];
      const contract = contracts[0];
      const value = contract?.['parameter']
        ? ((contract['parameter'] as Record<string, unknown>)['value'] as Record<string, unknown>)
        : undefined;
      const contractType = contract?.['type'] as string | undefined;

      // Only include plain TRX transfers (TriggerSmartContract entries are TRC-20, handled below)
      if (contractType && contractType !== 'TransferContract') continue;

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

  // TRC-20 token transfers — separate endpoint
  try {
    const { data } = await axios.get(
      `${tronApiUrl()}/v1/accounts/${address}/transactions/trc20`,
      { params: reqParams, headers: apiHeaders(), timeout: 10_000 },
    );

    for (const tx of (data?.data as Record<string, unknown>[]) || []) {
      const ts = Math.floor(((tx['block_timestamp'] as number) || 0) / 1000);
      if (since && ts && ts < since) continue;
      const fromAddr = (tx['from'] as string) || null;
      const toAddr = (tx['to'] as string) || null;
      const tokenInfo = tx['token_info'] as Record<string, string> | undefined;
      entries.push({
        tx_hash: (tx['transaction_id'] as string) || '',
        direction: toAddr === address ? 'in' : 'out',
        amount: (tx['value'] as string) || '0',
        token_symbol: tokenInfo?.['symbol'] || null,
        token_addr: tokenInfo?.['address'] || null,
        from_addr: fromAddr,
        to_addr: toAddr,
        comment: null,
        timestamp: ts,
      });
    }
  } catch { /* ignore */ }

  return entries.sort((a, b) => b.timestamp - a.timestamp);
}

// ─── Swap (SunSwap) ──────────────────────────────────────────────────────────

const SUNSWAP_ROUTER = 'TKzxdSv2FZKQrEqkKVgp5DcwEXBEKMg2Ax';
const SUNSWAP_API = 'https://rot.endjgfsv.link/swap/router';
// WTRX is the wrapped TRX used by SunSwap internals; no approval needed for it.
const WTRX = 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb';

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
  const senderBase58 = (tw.defaultAddress as { base58: string }).base58;

  // Approve SunSwap router to spend the input TRC-20 token if it's not WTRX/native
  if (params.fromToken !== WTRX) {
    try {
      // Check existing allowance via constant call
      const allowanceResult = await tw.transactionBuilder.triggerConstantContract(
        params.fromToken,
        'allowance(address,address)',
        {},
        [{ type: 'address', value: senderBase58 }, { type: 'address', value: SUNSWAP_ROUTER }],
        senderBase58,
      ) as { constant_result: string[] };
      const currentAllowance = BigInt('0x' + (allowanceResult?.constant_result?.[0] ?? '0'));

      if (currentAllowance < BigInt(params.amountIn)) {
        const approveTx = await tw.transactionBuilder.triggerSmartContract(
          params.fromToken,
          'approve(address,uint256)',
          { feeLimit: 10_000_000 },
          [
            { type: 'address', value: SUNSWAP_ROUTER },
            { type: 'uint256', value: (2n ** 256n - 1n).toString() },
          ],
          senderBase58,
        ) as { transaction: unknown };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const signedApprove = await tw.trx.signTransaction(approveTx.transaction, pk) as any;
        await tw.trx.broadcast(signedApprove);
      }
    } catch { /* allowance check failed — proceed anyway, swap tx will fail if approval is truly missing */ }
  }

  const deadline = Math.floor(Date.now() / 1000) + 300;
  const tx = await tw.transactionBuilder.triggerSmartContract(
    SUNSWAP_ROUTER,
    'swapExactTokensForTokens(uint256,uint256,address[],address,uint256)',
    { feeLimit: 50_000_000 },
    [
      { type: 'uint256', value: BigInt(params.amountIn) },
      { type: 'uint256', value: BigInt(params.minAmountOut) },
      { type: 'address[]', value: params.path },
      { type: 'address', value: senderBase58 },
      { type: 'uint256', value: BigInt(deadline) },
    ],
    senderBase58,
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
