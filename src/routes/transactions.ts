import { Router, Request, Response } from 'express';
import { stmtGetTxs, stmtGetWallet, TxRow, WalletRow } from '../db';
import { getTransactions } from '../toncenter';
import { cache, TTL } from '../cache';
import { normalizeAddress } from '../services/wallet';
import { EVM_CHAINS, evmGetHistory } from '../services/chains/evm';
import { solanaGetHistory } from '../services/chains/solana';
import { tronGetHistory } from '../services/chains/tron';

const router = Router({ mergeParams: true });

function tryNormalize(addr: string): string {
  if (addr.startsWith('0x') || addr.startsWith('0X')) return addr;
  try { return normalizeAddress(addr); } catch { return addr; }
}

// GET /wallets/:address/transactions
router.get('/', async (req: Request, res: Response) => {
  try {
    const address = tryNormalize(req.params['address'] as string);
    const since = req.query.since ? parseInt(req.query.since as string, 10) : undefined;
    const until = req.query.until ? parseInt(req.query.until as string, 10) : undefined;
    const direction = req.query.direction as string | undefined;
    const token = req.query.token as string | undefined;
    const limit = Math.min(parseInt((req.query.limit as string) || '50', 10), 200);
    const network = (req.query.network as string) || process.env.NETWORK || 'mainnet';

    const wallet = stmtGetWallet.get(address) as WalletRow | undefined;
    const chain = wallet?.chain || 'ton';

    const cacheKey = `tx:${address}:${since}:${until}:${direction}:${token}:${limit}`;
    let cached = cache.get<object[]>(cacheKey);

    if (!cached) {
      if (chain === 'ton') {
        let rows = stmtGetTxs.all(address) as TxRow[];
        if (since !== undefined) rows = rows.filter(r => r.timestamp >= since);
        if (until !== undefined) rows = rows.filter(r => r.timestamp <= until);
        if (direction) rows = rows.filter(r => r.direction === direction);
        if (token) rows = rows.filter(r =>
          (r.token_addr || 'TON').toLowerCase().includes(token.toLowerCase()) ||
          (r.token_symbol || '').toLowerCase() === token.toLowerCase()
        );
        rows = rows.slice(0, limit);

        if (rows.length === 0 && since === undefined) {
          const liveTxs = await getTransactions(network, address, { limit, end_utime: until });
          cached = liveTxs.map(tx => ({
            tx_hash: tx.hash,
            lt: tx.lt,
            timestamp: tx.now,
            direction: (tx.in_msg?.source ? 'in' : 'out') as string,
            amount_raw: tx.in_msg?.value || tx.out_msgs[0]?.value || '0',
            amount_ton: formatTon(tx.in_msg?.value || tx.out_msgs[0]?.value || '0'),
            from_address: tx.in_msg?.source || null,
            to_address: tx.out_msgs[0]?.destination || null,
            comment: tx.in_msg?.msg_data?.type === 'text_comment' ? tx.in_msg.msg_data.text : null,
            token: null,
            fee: tx.total_fees,
          }));
        } else {
          cached = rows.map(formatTxRow);
        }
      } else if (EVM_CHAINS.has(chain)) {
        const entries = await evmGetHistory(chain, address, since);
        cached = entries.slice(0, limit).map(e => ({
          tx_hash: e.tx_hash, direction: e.direction, amount: e.amount,
          token_symbol: e.token_symbol, token_addr: e.token_addr,
          from_address: e.from_addr, to_address: e.to_addr, comment: null, timestamp: e.timestamp,
        }));
      } else if (chain === 'solana') {
        const entries = await solanaGetHistory(address, since);
        cached = entries.slice(0, limit).map(e => ({
          tx_hash: e.tx_hash, direction: e.direction, amount: e.amount,
          token_symbol: e.token_symbol, token_addr: e.token_addr,
          from_address: e.from_addr, to_address: e.to_addr, comment: null, timestamp: e.timestamp,
        }));
      } else if (chain === 'tron') {
        const entries = await tronGetHistory(address, since);
        cached = entries.slice(0, limit).map(e => ({
          tx_hash: e.tx_hash, direction: e.direction, amount: e.amount,
          token_symbol: e.token_symbol, token_addr: e.token_addr,
          from_address: e.from_addr, to_address: e.to_addr, comment: null, timestamp: e.timestamp,
        }));
      } else {
        cached = [];
      }

      cache.set(cacheKey, cached, TTL.TRANSACTIONS);
    }

    res.json({ count: cached.length, transactions: cached });
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /wallets/:address/incoming
router.get('/incoming', async (req: Request, res: Response) => {
  try {
    const address = tryNormalize(req.params['address'] as string);
    const since = req.query.since ? parseInt(req.query.since as string, 10) : undefined;
    const limit = Math.min(parseInt((req.query.limit as string) || '50', 10), 200);
    const network = (req.query.network as string) || process.env.NETWORK || 'mainnet';

    const wallet = stmtGetWallet.get(address) as WalletRow | undefined;
    const chain = wallet?.chain || 'ton';

    const cacheKey = `tx:${address}:in:${since}:${limit}`;
    let cached = cache.get<object[]>(cacheKey);

    if (!cached) {
      if (chain === 'ton') {
        let rows = stmtGetTxs.all(address) as TxRow[];
        rows = rows.filter(r => r.direction === 'in');
        if (since !== undefined) rows = rows.filter(r => r.timestamp >= since);
        rows = rows.slice(0, limit);

        if (rows.length === 0) {
          const liveTxs = await getTransactions(network, address, { limit, start_utime: since });
          const incoming = liveTxs.filter(tx => tx.in_msg?.source && tx.in_msg.value);
          cached = incoming.map(tx => ({
            tx_hash: tx.hash, lt: tx.lt, timestamp: tx.now, direction: 'in',
            amount_raw: tx.in_msg!.value,
            amount_ton: formatTon(tx.in_msg!.value || '0'),
            from_address: tx.in_msg!.source,
            to_address: address,
            comment: tx.in_msg?.msg_data?.type === 'text_comment' ? tx.in_msg.msg_data.text : null,
            token: null,
            fee: tx.total_fees,
          }));
        } else {
          cached = rows.map(formatTxRow);
        }
      } else {
        // For non-TON chains, filter from full history
        let getHistory: (addr: string, since?: number) => Promise<{ tx_hash: string; direction: 'in' | 'out'; amount: string; token_symbol: string | null; token_addr: string | null; from_addr: string | null; to_addr: string | null; comment: string | null; timestamp: number }[]>;
        if (EVM_CHAINS.has(chain)) getHistory = (a, s) => evmGetHistory(chain, a, s);
        else if (chain === 'solana') getHistory = solanaGetHistory;
        else if (chain === 'tron') getHistory = tronGetHistory;
        else getHistory = async () => [];

        const entries = await getHistory(address, since);
        cached = entries.filter(e => e.direction === 'in').slice(0, limit).map(e => ({
          tx_hash: e.tx_hash, direction: e.direction, amount: e.amount,
          token_symbol: e.token_symbol, token_addr: e.token_addr,
          from_address: e.from_addr, to_address: e.to_addr, comment: null, timestamp: e.timestamp,
        }));
      }

      cache.set(cacheKey, cached, TTL.TRANSACTIONS);
    }

    const total_received = (cached as Array<Record<string, unknown>>).reduce((sum: bigint, tx) => {
      try { return sum + BigInt((tx['amount_raw'] as string | undefined) || (tx['amount'] as string | undefined) || '0'); } catch { return sum; }
    }, BigInt(0));

    res.json({
      count: cached.length,
      total_received_raw: total_received.toString(),
      since: since || null,
      transactions: cached,
    });
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
});

function formatTxRow(row: TxRow): object {
  return {
    tx_hash: row.tx_hash, lt: row.lt, timestamp: row.timestamp, direction: row.direction,
    amount_raw: row.amount,
    amount_ton: row.token_addr ? null : formatTon(row.amount),
    token_address: row.token_addr, token_symbol: row.token_symbol,
    from_address: row.from_addr, to_address: row.to_addr, comment: row.comment,
  };
}

function formatTon(nanotons: string): string {
  try {
    const n = BigInt(nanotons);
    const whole = n / BigInt(1_000_000_000);
    const frac = (n % BigInt(1_000_000_000)).toString().padStart(9, '0').replace(/0+$/, '') || '0';
    return `${whole}.${frac}`;
  } catch { return '0'; }
}

export default router;
