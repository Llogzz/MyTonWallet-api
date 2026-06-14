import crypto from 'crypto';
import WebSocket from 'ws';
import axios from 'axios';
import { Address } from '@ton/core';
import {
  getActions,
  AnyToncenterAction,
  TonTransferAction,
  JettonTransferAction,
} from '../toncenter';
import {
  stmtInsertTx,
  stmtGetMaxTs,
  stmtGetAllAddresses,
  stmtGetWebhooks,
  AddressRow,
  WebhookRow,
} from '../db';
import { normalizeAddress } from './wallet';
import { proxyManager } from './proxy';
import { cache } from '../cache';

const PING_INTERVAL_MS = 20_000;
const PONG_TIMEOUT_MS = 5_000;
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = parseInt(process.env.WS_RECONNECT_MAX_MS || '30000', 10);
const FALLBACK_INTERVAL_MS = parseInt(process.env.MONITOR_FALLBACK_INTERVAL_MS || '30000', 10);

function safeNormalize(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try { return Address.parse(raw).toString({ urlSafe: true, bounceable: false }); } catch { return raw; }
}

interface ParsedTx {
  tx_hash: string;
  wallet_addr: string;
  direction: 'in' | 'out';
  amount: string;
  token_addr: string | null;
  token_symbol: string | null;
  from_addr: string | null;
  to_addr: string | null;
  comment: string | null;
  lt: string | null;
  timestamp: number;
}

function parseActions(actions: AnyToncenterAction[], walletAddr: string): ParsedTx[] {
  const result: ParsedTx[] = [];
  const normalWallet = safeNormalize(walletAddr) || walletAddr;

  for (const action of actions) {
    const a = action as Record<string, unknown>;
    const type = a['type'] as string;
    const actionId = (a['action_id'] as string) || (a['trace_id'] as string) || '';
    if (!actionId) continue;
    const timestamp = (a['end_utime'] as number) || (a['start_utime'] as number) || 0;
    const lt = (a['end_lt'] as string | null) || null;

    if (type === 'ton_transfer') {
      const d = (a as unknown as TonTransferAction).ton_transfer_data;
      const src = safeNormalize(d.source);
      const dst = safeNormalize(d.destination);
      const direction: 'in' | 'out' = dst === normalWallet ? 'in' : 'out';
      result.push({ tx_hash: actionId, wallet_addr: walletAddr, direction, amount: d.amount, token_addr: null, token_symbol: 'TON', from_addr: src, to_addr: dst, comment: d.comment, lt, timestamp });
    } else if (type === 'jetton_transfer') {
      const d = (a as unknown as JettonTransferAction).jetton_transfer_data;
      const src = safeNormalize(d.source_owner);
      const dst = safeNormalize(d.destination_owner);
      const direction: 'in' | 'out' = dst === normalWallet ? 'in' : 'out';
      result.push({ tx_hash: actionId, wallet_addr: walletAddr, direction, amount: d.amount, token_addr: safeNormalize(d.jetton_master_address), token_symbol: null, from_addr: src, to_addr: dst, comment: d.comment, lt, timestamp });
    } else if (type === 'stake_deposit' || type === 'stake_withdrawal' || type === 'stake_withdrawal_request') {
      const amount = (a[`${type}_data`] as Record<string, string>)?.amount || '0';
      result.push({ tx_hash: actionId, wallet_addr: walletAddr, direction: type === 'stake_deposit' ? 'out' : 'in', amount, token_addr: null, token_symbol: 'TON', from_addr: type === 'stake_deposit' ? walletAddr : null, to_addr: type !== 'stake_deposit' ? walletAddr : null, comment: null, lt, timestamp });
    } else if (type === 'dex_swap') {
      const d = (a as Record<string, Record<string, unknown>>)['dex_swap_data'];
      result.push({ tx_hash: actionId, wallet_addr: walletAddr, direction: 'out', amount: (d?.['in'] as Record<string, string>)?.amount || '0', token_addr: (d?.['in'] as Record<string, string | null>)?.jetton_master || null, token_symbol: 'SWAP', from_addr: walletAddr, to_addr: walletAddr, comment: `swap via ${d?.dex || 'DEX'}`, lt, timestamp });
    }
  }

  return result;
}

function formatTgAmount(raw: string, symbol: string | null): string {
  if (symbol === 'TON') {
    const n = BigInt(raw || '0');
    const frac = (n % 1_000_000_000n).toString().padStart(9, '0').replace(/0+$/, '');
    return `${n / 1_000_000_000n}${frac ? '.' + frac : ''} TON`;
  }
  return `${raw} ${symbol ?? 'tokens'}`;
}

function fireTelegram(walletAddr: string, tx: ParsedTx): void {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;

  const arrow = tx.direction === 'in' ? '📥' : '📤';
  const peer = tx.direction === 'in' ? tx.from_addr : tx.to_addr;
  const peerLabel = peer ? `${tx.direction === 'in' ? 'from' : 'to'} ${peer.slice(0, 8)}...` : '';
  const comment = tx.comment ? `\n💬 ${tx.comment}` : '';
  const text = `${arrow} ${formatTgAmount(tx.amount, tx.token_symbol)} ${peerLabel}${comment}\n${walletAddr.slice(0, 10)}...`;

  axios.post(
    `https://api.telegram.org/bot${token}/sendMessage`,
    { chat_id: chatId, text },
    { timeout: 5_000 },
  ).catch(() => {});
}

function fireWebhooks(walletAddr: string, tx: ParsedTx): void {
  const hooks = stmtGetWebhooks.all(walletAddr) as WebhookRow[];
  if (!hooks.length) return;
  const body = JSON.stringify({ event: 'new_transaction', wallet: walletAddr, tx });
  for (const hook of hooks) {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (hook.secret) {
      const sig = crypto.createHmac('sha256', hook.secret).update(body).digest('hex');
      headers['X-Signature'] = `sha256=${sig}`;
    }
    axios.post(hook.url, body, { headers, timeout: 10_000 }).catch(() => {});
  }
}

function processActions(actions: AnyToncenterAction[], walletAddr: string): number {
  const parsed = parseActions(actions, walletAddr);
  const now = Math.floor(Date.now() / 1000);
  let inserted = 0;

  for (const tx of parsed) {
    try {
      const result = stmtInsertTx.run(
        tx.tx_hash, tx.wallet_addr, tx.direction, tx.amount,
        tx.token_addr, tx.token_symbol, tx.from_addr, tx.to_addr,
        tx.comment, tx.lt, tx.timestamp, now,
      );
      if (result.changes > 0) {
        inserted++;
        fireWebhooks(walletAddr, tx);
        fireTelegram(walletAddr, tx);
      }
    } catch { /* duplicate key */ }
  }

  if (inserted > 0) {
    cache.invalidatePrefix(`tx:${walletAddr}`);
    cache.invalidatePrefix(`balance:${walletAddr}`);
    console.log(`[monitor] ${walletAddr}: +${inserted} new actions`);
  }

  return inserted;
}

async function pollAddress(row: AddressRow): Promise<number> {
  const dbRow = stmtGetMaxTs.get(row.address) as { max_ts: number | null };
  const since = dbRow?.max_ts ? dbRow.max_ts + 1 : undefined;
  let actions: AnyToncenterAction[];
  try {
    actions = await getActions(row.network, row.address, { limit: 100, start_utime: since });
  } catch (err) {
    console.error(`[monitor] HTTP poll error for ${row.address}:`, err);
    return 0;
  }
  return processActions(actions, row.address);
}

// ─── WebSocket client ─────────────────────────────────────────────────────────

class ToncenterWS {
  private ws: WebSocket | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private fallbackTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectDelay = RECONNECT_BASE_MS;
  private connected = false;
  private destroyed = false;
  private currentProxy: string | null = null;
  private addresses: AddressRow[] = [];

  constructor(private readonly network: 'mainnet' | 'testnet') {}

  updateAddresses(allAddresses: AddressRow[]): void {
    this.addresses = allAddresses.filter((r) => r.chain === 'ton' && r.network === this.network);
    if (this.connected) this.subscribe();
  }

  connect(): void {
    if (this.destroyed) return;

    const proxy = proxyManager.getRandomProxy();
    this.currentProxy = proxy;

    const url = this.network === 'mainnet'
      ? `wss://${(process.env.TONCENTER_MAINNET_URL || 'https://toncenter.mytonwallet.org').replace(/^https?:\/\//, '')}/api/streaming/v2/ws`
      : `wss://${(process.env.TONCENTER_TESTNET_URL || 'https://toncenter-testnet.mytonwallet.org').replace(/^https?:\/\//, '')}/api/streaming/v2/ws`;

    const opts: WebSocket.ClientOptions = proxy
      ? { agent: proxyManager.createAgent(proxy) as unknown as import('http').Agent }
      : {};

    try {
      this.ws = new WebSocket(url, opts);
    } catch (err) {
      console.error(`[ws:${this.network}] Failed to create socket:`, err);
      this.scheduleReconnect();
      return;
    }

    this.ws.on('open', () => {
      this.connected = true;
      this.reconnectDelay = RECONNECT_BASE_MS;
      this.stopFallback();
      this.startPing();
      this.subscribe();
      const via = proxy ? ` via ${proxy}` : '';
      console.log(`[ws:${this.network}] Connected${via}`);
    });

    this.ws.on('message', (data: WebSocket.RawData) => {
      if (this.pongTimer) { clearTimeout(this.pongTimer); this.pongTimer = null; }
      try { this.handleMessage(data.toString()); } catch { /* ignore malformed */ }
    });

    this.ws.on('error', (err: Error) => {
      if (proxy && this.isProxyError(err)) {
        proxyManager.markFailed(proxy);
      } else {
        console.error(`[ws:${this.network}] Error:`, err.message);
      }
    });

    this.ws.on('close', () => {
      this.connected = false;
      this.stopPing();
      this.startFallback();
      this.scheduleReconnect();
      console.log(`[ws:${this.network}] Disconnected — fallback HTTP polling active`);
    });
  }

  private subscribe(): void {
    const addrs = this.addresses.map((r) => r.address);
    if (!addrs.length || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    this.ws.send(JSON.stringify({
      operation: 'subscribe',
      id: String(Date.now()),
      addresses: addrs,
      types: ['actions', 'account_state_change', 'jettons_change'],
      min_finality: 'pending',
      include_address_book: true,
      include_metadata: true,
      supported_action_types: ['v1'],
    }));
  }

  private handleMessage(raw: string): void {
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(raw); } catch { return; }

    if ('status' in msg || 'pong' in msg) return;

    const type = msg['type'] as string | undefined;

    if (type === 'actions') {
      const actions = (msg['actions'] as AnyToncenterAction[]) || [];
      const addressBook = (msg['address_book'] as Record<string, { user_friendly?: string }>) || {};

      const byAddr = new Map<string, AnyToncenterAction[]>();
      for (const action of actions) {
        const a = action as Record<string, unknown>;
        const accounts = (a['accounts'] as string[] | undefined) || [];
        for (const rawAddr of accounts) {
          const friendly = addressBook[rawAddr]?.user_friendly ?? rawAddr;
          const row = this.addresses.find(
            (r) => r.address === friendly || r.address === rawAddr,
          );
          if (!row) continue;
          const list = byAddr.get(row.address) ?? [];
          list.push(action);
          byAddr.set(row.address, list);
        }
      }

      for (const [addr, addrActions] of byAddr) {
        try { processActions(addrActions, addr); } catch { /* db error */ }
      }
    } else if (type === 'account_state_change') {
      const rawAccount = msg['account'] as string | undefined;
      if (!rawAccount) return;
      const friendly = safeNormalize(rawAccount) || rawAccount;
      const row = this.addresses.find((r) => r.address === friendly || r.address === rawAccount);
      if (row) cache.invalidatePrefix(`balance:${row.address}`);
    }
  }

  private startPing(): void {
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ operation: 'ping' }));
        this.pongTimer = setTimeout(() => {
          console.warn(`[ws:${this.network}] Pong timeout — reconnecting`);
          this.ws?.terminate();
        }, PONG_TIMEOUT_MS);
      }
    }, PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
    if (this.pongTimer) { clearTimeout(this.pongTimer); this.pongTimer = null; }
  }

  private startFallback(): void {
    if (this.fallbackTimer) return;
    console.log(`[ws:${this.network}] Starting fallback polling every ${FALLBACK_INTERVAL_MS / 1000}s`);
    this.fallbackTimer = setInterval(() => {
      for (const row of this.addresses) {
        pollAddress(row).catch(console.error);
      }
    }, FALLBACK_INTERVAL_MS);
  }

  private stopFallback(): void {
    if (this.fallbackTimer) { clearInterval(this.fallbackTimer); this.fallbackTimer = null; }
  }

  private scheduleReconnect(): void {
    if (this.destroyed) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const delay = this.reconnectDelay;
    console.log(`[ws:${this.network}] Reconnecting in ${delay}ms…`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
      this.connect();
    }, delay);
  }

  private isProxyError(err: Error): boolean {
    const m = err.message.toLowerCase();
    return m.includes('econnrefused') || m.includes('etimedout') ||
      m.includes('tunneling socket') || m.includes('econnreset') ||
      m.includes('proxy') || m.includes('403') || m.includes('407');
  }

  destroy(): void {
    this.destroyed = true;
    this.stopPing();
    this.stopFallback();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
  }
}

// ─── Module-level state ───────────────────────────────────────────────────────

const wsClients = new Map<string, ToncenterWS>();
let nonTonPollTimer: ReturnType<typeof setInterval> | null = null;

async function pollNonTonAddresses(): Promise<void> {
  const all = stmtGetAllAddresses.all() as AddressRow[];
  const nonTon = all.filter(r => r.chain !== 'ton');
  for (const row of nonTon) {
    try {
      cache.invalidatePrefix(`balance:${row.address}`);
      cache.invalidatePrefix(`tx:${row.address}`);
    } catch { /* ignore */ }
  }
}

export function startMonitor(): void {
  const allAddresses = stmtGetAllAddresses.all() as AddressRow[];
  const tonAddresses = allAddresses.filter(r => r.chain === 'ton');
  const networks = new Set(tonAddresses.map((r) => r.network));
  if (!networks.size) networks.add(process.env.NETWORK || 'mainnet');

  for (const network of networks) {
    if (wsClients.has(network)) continue;
    const ws = new ToncenterWS(network as 'mainnet' | 'testnet');
    ws.updateAddresses(allAddresses);
    wsClients.set(network, ws);
    ws.connect();
  }

  if (!nonTonPollTimer) {
    nonTonPollTimer = setInterval(pollNonTonAddresses, FALLBACK_INTERVAL_MS);
  }

  console.log(`[monitor] Started WebSocket monitoring (${[...networks].join(', ')})`);
}

export function stopMonitor(): void {
  for (const ws of wsClients.values()) ws.destroy();
  wsClients.clear();
  if (nonTonPollTimer) { clearInterval(nonTonPollTimer); nonTonPollTimer = null; }
  proxyManager.destroy();
}

// Called when new TON addresses are added so the WS subscription updates immediately.
export function notifyAddressesAdded(addrs: AddressRow[]): void {
  const allAddresses = stmtGetAllAddresses.all() as AddressRow[];

  const networks = new Set(addrs.filter(r => r.chain === 'ton').map(r => r.network));
  for (const network of networks) {
    if (!wsClients.has(network)) {
      const ws = new ToncenterWS(network as 'mainnet' | 'testnet');
      ws.updateAddresses(allAddresses);
      wsClients.set(network, ws);
      ws.connect();
    } else {
      wsClients.get(network)!.updateAddresses(allAddresses);
    }
  }
}

export async function syncWalletNow(address: string, network: string): Promise<number> {
  let normalized: string;
  try { normalized = normalizeAddress(address); } catch { normalized = address; }
  const fakeRow: AddressRow = {
    id: 0, wallet_id: 0,
    address: normalized,
    chain: 'ton',
    network,
    version: 'W5',
    label: null,
    created_at: 0,
  };
  return pollAddress(fakeRow);
}
