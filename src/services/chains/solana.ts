import axios from 'axios';
import {
  Connection,
  PublicKey,
  Keypair,
  SystemProgram,
  Transaction,
  VersionedTransaction,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import {
  getOrCreateAssociatedTokenAccount,
  createTransferInstruction,
  getMint,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import * as bip39 from 'bip39';
import { derivePath } from 'ed25519-hd-key';

const DERIVATION_PATH = "m/44'/501'/0'/0'";
const TX_FEE = 5000; // lamports per signature (fixed in Solana base fee)

// RPC fallback list — deduplicated, first working endpoint wins
const RPC_LIST = [
  process.env.SOLANA_RPC_URL,
  'https://solana-rpc.publicnode.com',
].filter((v, i, a) => v && a.indexOf(v) === i) as string[];

async function withConnection<T>(fn: (conn: Connection) => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (const rpc of RPC_LIST) {
    try {
      return await fn(new Connection(rpc, 'confirmed'));
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

function mnemonicToKeypair(mnemonic: string[]): Keypair {
  const seed = bip39.mnemonicToSeedSync(mnemonic.join(' '));
  const { key } = derivePath(DERIVATION_PATH, seed.toString('hex'));
  return Keypair.fromSeed(key);
}

export function solanaMnemonicToAddress(mnemonic: string[]): string {
  return mnemonicToKeypair(mnemonic).publicKey.toBase58();
}

export interface TokenBalance {
  token_address: string;
  symbol: string;
  name: string;
  decimals: number;
  balance_raw: string;
  balance: string;
}

export async function solanaEstimateFee(): Promise<{ fee_raw: string; fee: string; native_symbol: string }> {
  return {
    fee_raw: TX_FEE.toString(),
    fee: (TX_FEE / LAMPORTS_PER_SOL).toFixed(9),
    native_symbol: 'SOL',
  };
}

export async function solanaGetBalance(address: string): Promise<{ native_raw: string; native: string; tokens: TokenBalance[] }> {
  return withConnection(async (connection) => {
    const pubkey = new PublicKey(address);
    const balance = await connection.getBalance(pubkey);

    let tokens: TokenBalance[] = [];
    try {
      const tokenAccounts = await connection.getParsedTokenAccountsByOwner(pubkey, { programId: TOKEN_PROGRAM_ID });
      tokens = tokenAccounts.value
        .filter(a => {
          const amt = a.account.data.parsed.info.tokenAmount.amount as string;
          return BigInt(amt) > 0n;
        })
        .map(a => {
          const info = a.account.data.parsed.info as {
            mint: string;
            tokenAmount: { amount: string; decimals: number; uiAmountString: string };
          };
          const amt = info.tokenAmount;
          return {
            token_address: info.mint,
            symbol: '?',
            name: '?',
            decimals: amt.decimals,
            balance_raw: amt.amount,
            balance: amt.uiAmountString || '0',
          };
        });
    } catch {
      // RPC may not support getParsedTokenAccountsByOwner — skip token lookup
    }

    return {
      native_raw: balance.toString(),
      native: (balance / LAMPORTS_PER_SOL).toFixed(9),
      tokens,
    };
  });
}

export async function solanaSend(params: {
  mnemonic: string[];
  to: string;
  amount: string;
  tokenMint?: string;
  sendAll?: boolean;
}): Promise<string> {
  return withConnection(async (connection) => {
    const keypair = mnemonicToKeypair(params.mnemonic);
    const toPubkey = new PublicKey(params.to);
    const tx = new Transaction();

    if (params.tokenMint) {
      const mintPubkey = new PublicKey(params.tokenMint);
      const mintInfo = await getMint(connection, mintPubkey);
      const amount = BigInt(params.amount);

      const fromAta = await getOrCreateAssociatedTokenAccount(connection, keypair, mintPubkey, keypair.publicKey);
      const toAta = await getOrCreateAssociatedTokenAccount(connection, keypair, mintPubkey, toPubkey);

      tx.add(createTransferInstruction(fromAta.address, toAta.address, keypair.publicKey, amount));
      void mintInfo;
    } else {
      let lamports: bigint;
      if (params.sendAll) {
        // Drain entire account: send balance minus the tx fee so account closes to 0
        const balance = await connection.getBalance(keypair.publicKey);
        lamports = BigInt(balance) - BigInt(TX_FEE);
        if (lamports <= 0n) throw new Error('Insufficient balance to cover transaction fee');
      } else {
        lamports = BigInt(params.amount);
      }
      tx.add(SystemProgram.transfer({
        fromPubkey: keypair.publicKey,
        toPubkey,
        lamports,
      }));
    }

    return sendAndConfirmTransaction(connection, tx, [keypair]);
  });
}

export interface SolanaTxStatus {
  tx_hash: string;
  status: 'success' | 'failed' | 'pending' | 'not_found';
  block?: number;
  fee?: number;
  timestamp?: number | null;
}

export async function solanaGetTx(hash: string): Promise<SolanaTxStatus> {
  try {
    return await withConnection(async (conn) => {
      const tx = await conn.getTransaction(hash, { maxSupportedTransactionVersion: 0 });
      if (!tx) return { tx_hash: hash, status: 'not_found' };
      return {
        tx_hash: hash,
        status: tx.meta?.err ? 'failed' : 'success',
        block: tx.slot,
        fee: tx.meta?.fee,
        timestamp: tx.blockTime,
      };
    });
  } catch {
    return { tx_hash: hash, status: 'not_found' };
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

// ─── Swap (Jupiter) ───────────────────────────────────────────────────────────

export async function solanaSwapQuote(params: {
  inputMint: string; outputMint: string; amount: string; slippageBps?: number;
}): Promise<{ outAmount: string; quoteResponse: unknown }> {
  const { data } = await axios.get('https://quote-api.jup.ag/v6/quote', {
    params: { inputMint: params.inputMint, outputMint: params.outputMint, amount: params.amount, slippageBps: params.slippageBps ?? 50 },
    timeout: 15_000,
  });
  return { outAmount: data.outAmount as string, quoteResponse: data };
}

export async function solanaSwapExecute(params: {
  mnemonic: string[]; quoteResponse: unknown; userPublicKey: string;
}): Promise<string> {
  return withConnection(async (connection) => {
    const keypair = mnemonicToKeypair(params.mnemonic);
    const { data } = await axios.post('https://quote-api.jup.ag/v6/swap', {
      quoteResponse: params.quoteResponse,
      userPublicKey: params.userPublicKey,
      wrapAndUnwrapSol: true,
    }, { timeout: 15_000 });
    const swapTransactionBuf = Buffer.from(data.swapTransaction as string, 'base64');
    const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
    transaction.sign([keypair]);
    return connection.sendRawTransaction(transaction.serialize(), { skipPreflight: true, maxRetries: 2 });
  });
}

export async function solanaGetHistory(address: string, since?: number): Promise<TxEntry[]> {
  return withConnection(async (connection) => {
    const pubkey = new PublicKey(address);

    const sigs = await connection.getSignaturesForAddress(pubkey, { limit: 50 });
    const filtered = since ? sigs.filter(s => s.blockTime && s.blockTime >= since) : sigs;
    if (!filtered.length) return [];

    const txs = await connection.getParsedTransactions(
      filtered.map(s => s.signature),
      { maxSupportedTransactionVersion: 0 },
    );

    const entries: TxEntry[] = [];
    for (let i = 0; i < txs.length; i++) {
      const tx = txs[i];
      const sig = filtered[i];
      if (!tx || !sig) continue;

      const accounts = tx.transaction.message.accountKeys;
      const myIndex = accounts.findIndex(a => a.pubkey.toBase58() === address);
      const pre = tx.meta?.preBalances[myIndex] ?? 0;
      const post = tx.meta?.postBalances[myIndex] ?? 0;
      const diff = post - pre;

      entries.push({
        tx_hash: sig.signature,
        direction: diff >= 0 ? 'in' : 'out',
        amount: Math.abs(diff).toString(),
        token_symbol: 'SOL',
        token_addr: null,
        from_addr: accounts[0]?.pubkey.toBase58() ?? null,
        to_addr: accounts[1]?.pubkey.toBase58() ?? null,
        comment: null,
        timestamp: sig.blockTime ?? 0,
      });
    }

    return entries;
  });
}
