// Central multi-chain registry / dispatcher.
//
// Every per-chain concern (which chains exist, how an address is derived from a
// mnemonic, how a balance is read, how a transfer is sent, the native coin) is
// resolved here so routes stay chain-agnostic. The TON, EVM, Solana and TRON
// implementations live in sibling modules and ../transfer / ../../toncenter.

import { EVM_CHAINS, evmMnemonicToAddress, evmGetBalance, evmSend, evmEstimateFee, evmGetTxStatus, type TokenBalance as EvmTokenBalance } from './evm';
import { solanaMnemonicToAddress, solanaGetBalance, solanaSend, solanaEstimateFee, solanaGetTx } from './solana';
import { tronMnemonicToAddress, tronGetBalance, tronSend, tronEstimateFee, tronGetTx } from './tron';
import { mnemonicToWallet, isBip39Mnemonic, type WalletVersion } from '../wallet';
import { sendTon, sendJetton } from '../transfer';
import { getWalletStates, getJettonWallets } from '../../toncenter';

export { EVM_CHAINS };

// Order matters: this is the default derivation order for generate/import.
export const SUPPORTED_CHAINS: string[] = ['ton', ...EVM_CHAINS, 'solana', 'tron'];

export function isSupportedChain(chain: string): boolean {
  return chain === 'ton' || EVM_CHAINS.has(chain) || chain === 'solana' || chain === 'tron';
}

const NATIVE_SYMBOLS: Record<string, string> = {
  ton: 'TON', ethereum: 'ETH', base: 'ETH', bnb: 'BNB', polygon: 'POL',
  arbitrum: 'ETH', avalanche: 'AVAX', monad: 'MON', hyperliquid: 'HYPE',
  solana: 'SOL', tron: 'TRX',
};

export function nativeSymbol(chain: string): string {
  return NATIVE_SYMBOLS[chain] || '?';
}

// Small built-in token map used to enrich TON balances (jettons whose metadata
// is sometimes incomplete on-chain). The full token directory lives in routes/tokens.ts.
const TON_KNOWN_TOKENS: Record<string, { symbol: string; decimals: number }> = {
  'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs': { symbol: 'USDT', decimals: 6 },
  'EQAIb6KmdfdDR7CN1GBqVJuP25iCnLKCvBlJ07Evuu2dzP5f': { symbol: 'USDe', decimals: 6 },
  'EQDQ5UUyPHrLcQJlPAczd_fjxn8SLrlNQwolBznxCdSlfQwr': { symbol: 'tsUSDe', decimals: 6 },
  'EQBlqsm144Dq6SjbPI4jjZvA1hqTIP3CvHovbIfW_t-SCALE': { symbol: 'SCALE', decimals: 9 },
};

export interface ChainTokenBalance {
  token_address: string;
  symbol: string;
  name: string;
  decimals: number;
  balance_raw: string;
  balance: string;
}

export interface NativeBalance {
  native_raw: string;
  native: string;
  native_symbol: string;
  status?: string;
  tokens: ChainTokenBalance[];
}

// ─── Address derivation ─────────────────────────────────────────────────────────

export interface DerivedAddress {
  address: string;
  version: string | null;
}

// Derive the address for `chain` from a mnemonic. EVM/Solana/TRON require a
// BIP39 seed; a TON-only mnemonic can only produce a TON address — callers
// catch the thrown error and record the chain as skipped.
export async function deriveAddress(
  chain: string,
  words: string[],
  opts: { version?: WalletVersion } = {},
): Promise<DerivedAddress> {
  if (chain === 'ton') {
    const { address, version } = await mnemonicToWallet(words, opts.version || 'W5');
    return { address, version };
  }

  if (!isBip39Mnemonic(words)) {
    throw new Error(`Chain '${chain}' requires a BIP39 mnemonic`);
  }

  if (EVM_CHAINS.has(chain)) return { address: evmMnemonicToAddress(words), version: null };
  if (chain === 'solana') return { address: solanaMnemonicToAddress(words), version: null };
  if (chain === 'tron') return { address: tronMnemonicToAddress(words), version: null };

  throw new Error(`Unsupported chain: ${chain}`);
}

// ─── Balances ───────────────────────────────────────────────────────────────────

export async function getBalance(chain: string, address: string, network: string): Promise<NativeBalance> {
  if (chain === 'ton') {
    const [state] = await getWalletStates(network, [address]);
    const { jetton_wallets, metadata } = await getJettonWallets(network, address);
    const tokens: ChainTokenBalance[] = jetton_wallets
      .filter(j => j.balance !== '0')
      .map(j => {
        const meta = metadata[j.jetton] || {};
        const known = TON_KNOWN_TOKENS[j.jetton];
        const decimals = known?.decimals ?? parseInt(meta.decimals || '9', 10);
        return {
          token_address: j.jetton,
          symbol: known?.symbol || meta.symbol || '?',
          name: meta.name || known?.symbol || 'Unknown',
          decimals,
          balance_raw: j.balance,
          balance: formatAmount(j.balance, decimals),
        };
      });
    return {
      native_raw: state?.balance || '0',
      native: formatAmount(state?.balance || '0', 9),
      native_symbol: 'TON',
      status: state?.status || 'unknown',
      tokens,
    };
  }

  if (EVM_CHAINS.has(chain)) {
    const { native_raw, native, tokens } = await evmGetBalance(chain, address);
    return { native_raw, native, native_symbol: nativeSymbol(chain), tokens: mapTokens(tokens) };
  }
  if (chain === 'solana') {
    const { native_raw, native, tokens } = await solanaGetBalance(address);
    return { native_raw, native, native_symbol: 'SOL', tokens: mapTokens(tokens) };
  }
  if (chain === 'tron') {
    const { native_raw, native, tokens } = await tronGetBalance(address);
    return { native_raw, native, native_symbol: 'TRX', tokens: mapTokens(tokens) };
  }

  throw new Error(`Unsupported chain: ${chain}`);
}

// ─── Transfers ──────────────────────────────────────────────────────────────────

export interface FeeEstimateResult {
  fee_raw: string;
  fee: string;
  native_symbol: string;
  gas?: string;
  gas_price?: string;
  note?: string;
}

export interface TxStatusResult {
  tx_hash: string;
  chain: string;
  status: 'success' | 'failed' | 'pending' | 'not_found';
  block?: number;
  fee?: string | number;
  timestamp?: number | null;
  gas_used?: string;
  from?: string | null;
  to?: string | null;
}

export interface SendTxParams {
  mnemonic: string[];
  from?: string;           // sender address (used for all=true to derive balance)
  to: string;
  amount: string;
  all?: boolean;           // if true, send entire balance (minus fee)
  token?: string;          // jetton master / ERC-20 / SPL mint / TRC-20 contract
  comment?: string;        // TON only
  version?: WalletVersion; // TON only
  network: string;
  gasLimit?: number;       // EVM only
}

export async function estimateFee(chain: string, params: {
  token?: string;
  network: string;
}): Promise<FeeEstimateResult> {
  if (chain === 'ton') {
    return { fee_raw: '5000000', fee: '0.005', native_symbol: 'TON' };
  }
  if (EVM_CHAINS.has(chain)) {
    return evmEstimateFee({ chain, tokenAddress: params.token });
  }
  if (chain === 'solana') {
    return solanaEstimateFee();
  }
  if (chain === 'tron') {
    return tronEstimateFee();
  }
  throw new Error(`Unsupported chain: ${chain}`);
}

export async function getTxStatus(chain: string, hash: string, network: string): Promise<TxStatusResult> {
  if (chain === 'ton') {
    return { tx_hash: hash, chain, status: 'not_found', note: 'Use /transactions history for TON' } as TxStatusResult & { note?: string };
  }
  if (EVM_CHAINS.has(chain)) {
    const r = await evmGetTxStatus(chain, hash);
    return { ...r, chain, fee: r.gas_used };
  }
  if (chain === 'solana') {
    const r = await solanaGetTx(hash);
    return { ...r, chain, fee: r.fee?.toString() };
  }
  if (chain === 'tron') {
    const r = await tronGetTx(hash);
    return { ...r, chain };
  }
  throw new Error(`Unsupported chain: ${chain}`);
}

export async function sendTx(chain: string, p: SendTxParams): Promise<string> {
  if (chain === 'ton') {
    let amount = p.amount;
    if (p.all && p.from) {
      const [state] = await getWalletStates(p.network, [p.from]);
      const balance = BigInt(state?.balance || '0');
      const fee = BigInt('5000000');
      amount = balance > fee ? (balance - fee).toString() : '0';
    }
    const version = (p.version || 'W5') as WalletVersion;
    if (p.token) {
      return sendJetton({ mnemonic: p.mnemonic, version, network: p.network, toAddress: p.to, jettonMasterAddress: p.token, amount, commentText: p.comment });
    }
    return sendTon({ mnemonic: p.mnemonic, version, network: p.network, toAddress: p.to, amount, commentText: p.comment });
  }
  if (EVM_CHAINS.has(chain)) {
    return evmSend({ chain, mnemonic: p.mnemonic, to: p.to, amount: p.amount, tokenAddress: p.token, gasLimit: p.gasLimit, sendAll: p.all });
  }
  if (chain === 'solana') {
    return solanaSend({ mnemonic: p.mnemonic, to: p.to, amount: p.amount, tokenMint: p.token, sendAll: p.all });
  }
  if (chain === 'tron') {
    return tronSend({ mnemonic: p.mnemonic, to: p.to, amount: p.amount, tokenAddress: p.token, sendAll: p.all });
  }
  throw new Error(`Unsupported chain: ${chain}`);
}

// ─── helpers ────────────────────────────────────────────────────────────────────

function mapTokens(tokens: EvmTokenBalance[]): ChainTokenBalance[] {
  return tokens.map(t => ({
    token_address: t.token_address,
    symbol: t.symbol,
    name: t.name,
    decimals: t.decimals,
    balance_raw: t.balance_raw,
    balance: t.balance,
  }));
}

export function formatAmount(raw: string, decimals: number): string {
  try {
    const n = BigInt(raw || '0');
    const factor = BigInt(10) ** BigInt(decimals);
    const whole = n / factor;
    const frac = (n % factor).toString().padStart(decimals, '0').replace(/0+$/, '') || '0';
    return `${whole}.${frac}`;
  } catch {
    return '0';
  }
}
