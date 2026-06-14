import axios from 'axios';

const MAINNET = process.env.TONCENTER_MAINNET_URL || 'https://toncenter.mytonwallet.org';
const TESTNET = process.env.TONCENTER_TESTNET_URL || 'https://toncenter-testnet.mytonwallet.org';
const API_KEY = process.env.TONCENTER_API_KEY || '';

function baseUrl(network: string) {
  return network === 'testnet' ? TESTNET : MAINNET;
}

function headers() {
  return API_KEY ? { 'X-Api-Key': API_KEY } : {};
}

export async function v3<T>(network: string, path: string, params?: Record<string, unknown>): Promise<T> {
  const url = `${baseUrl(network)}/api/v3${path}`;
  const res = await axios.get<T>(url, { params, headers: headers(), timeout: 15_000 });
  return res.data;
}

async function v3post<T>(network: string, path: string, data: unknown): Promise<T> {
  const url = `${baseUrl(network)}/api/v3${path}`;
  const res = await axios.post<T>(url, data, {
    headers: { ...headers(), 'Content-Type': 'application/json' },
    timeout: 15_000,
  });
  return res.data;
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ToncenterWalletState {
  address: string;
  balance: string;
  status: string;
  last_transaction_lt: string;
  last_transaction_hash: string;
  seqno: number | null;
  wallet_type: string | null;
  is_wallet: boolean;
}

export interface ToncenterJettonWallet {
  address: string;
  balance: string;
  jetton: string;
  owner: string;
  last_transaction_lt: string;
}

export interface ToncenterJettonMeta {
  address: string;
  name: string;
  symbol: string;
  decimals: string;
  image?: string;
}

export interface ToncenterTransaction {
  hash: string;
  lt: string;
  account: string;
  now: number;
  orig_status: string;
  end_status: string;
  total_fees: string;
  in_msg: ToncenterMessage | null;
  out_msgs: ToncenterMessage[];
  description: { type: string; aborted?: boolean };
}

export interface ToncenterMessage {
  hash: string;
  source: string | null;
  destination: string | null;
  value: string | null;
  fwd_fee: string | null;
  ihr_fee: string | null;
  created_lt: string | null;
  body_hash: string;
  msg_data: { type: string; text?: string; body?: string };
  init_state: unknown | null;
}

// Toncenter v3 Actions (parsed by the indexer)
export interface TonTransferAction {
  type: 'ton_transfer';
  action_id: string;
  trace_id: string;
  start_utime: number;
  end_utime: number;
  success: boolean;
  transactions: string[];
  ton_transfer_data: {
    source: string;
    destination: string;
    amount: string;
    comment: string | null;
    encrypted_comment: string | null;
  };
}

export interface JettonTransferAction {
  type: 'jetton_transfer';
  action_id: string;
  trace_id: string;
  start_utime: number;
  end_utime: number;
  success: boolean;
  transactions: string[];
  jetton_transfer_data: {
    response_destination: string;
    forward_amount: string;
    query_id: string;
    custom_payload: string | null;
    forward_payload: string | null;
    comment: string | null;
    jetton_master_address: string;
    amount: string;
    source_owner: string;
    destination_owner: string;
    source: string;
    destination: string;
  };
}

export interface SwapAction {
  type: 'dex_swap';
  action_id: string;
  trace_id: string;
  start_utime: number;
  end_utime: number;
  success: boolean;
  transactions: string[];
  dex_swap_data: {
    sender: string;
    dex: string;
    in: { amount: string; asset: string | null; jetton_master: string | null };
    out: { amount: string; asset: string | null; jetton_master: string | null };
  };
}

export type AnyToncenterAction = TonTransferAction | JettonTransferAction | SwapAction | Record<string, unknown>;

// ─── API Calls ───────────────────────────────────────────────────────────────

export async function getWalletStates(network: string, addresses: string[]): Promise<ToncenterWalletState[]> {
  const data = await v3<{ wallets: ToncenterWalletState[] }>(network, '/walletStates', { address: addresses });
  return data.wallets || [];
}

export async function getJettonWallets(
  network: string,
  ownerAddress: string,
): Promise<{ jetton_wallets: ToncenterJettonWallet[]; metadata: Record<string, ToncenterJettonMeta> }> {
  const limit = 1000;
  let offset = 0;
  const all: ToncenterJettonWallet[] = [];
  let metadata: Record<string, ToncenterJettonMeta> = {};

  while (true) {
    const data = await v3<{
      jetton_wallets: ToncenterJettonWallet[];
      metadata: Record<string, ToncenterJettonMeta>;
    }>(network, '/jetton/wallets', { owner_address: ownerAddress, limit, offset });

    const batch = data.jetton_wallets || [];
    all.push(...batch);
    if (Object.keys(metadata).length === 0) metadata = data.metadata || {};
    if (batch.length < limit) break;
    offset += limit;
  }

  return { jetton_wallets: all, metadata };
}

export async function getTransactions(
  network: string,
  address: string,
  opts: { limit?: number; start_utime?: number; end_utime?: number } = {},
): Promise<ToncenterTransaction[]> {
  const params: Record<string, unknown> = {
    account: address,
    limit: opts.limit || 50,
    sort: 'desc',
  };
  if (opts.start_utime) params.start_utime = opts.start_utime;
  if (opts.end_utime) params.end_utime = opts.end_utime;

  const data = await v3<{ transactions: ToncenterTransaction[] }>(network, '/transactions', params);
  return data.transactions || [];
}

export async function getActions(
  network: string,
  address: string,
  opts: { limit?: number; start_utime?: number; end_utime?: number } = {},
): Promise<AnyToncenterAction[]> {
  const params: Record<string, unknown> = {
    account: address,
    limit: opts.limit || 100,
    sort: 'desc',
  };
  if (opts.start_utime) params.start_utime = opts.start_utime;
  if (opts.end_utime) params.end_utime = opts.end_utime;

  const data = await v3<{ actions: AnyToncenterAction[] }>(network, '/actions', params);
  return data.actions || [];
}

export async function sendBoc(network: string, boc: string): Promise<{ message_hash: string }> {
  return v3post<{ message_hash: string }>(network, '/message', { boc });
}

// Token prices via MyTonWallet backend
export async function getTokenPrices(slugs: string[]): Promise<Record<string, number>> {
  try {
    const res = await axios.get<Record<string, { price: number }>>(
      'https://api.mytonwallet.org/prices',
      { params: { slugs: slugs.join(',') }, timeout: 10_000 },
    );
    const result: Record<string, number> = {};
    for (const [slug, data] of Object.entries(res.data)) {
      result[slug] = data.price;
    }
    return result;
  } catch {
    return {};
  }
}

// Staking info
export async function getStakingCommonData(): Promise<unknown> {
  try {
    const res = await axios.get('https://api.mytonwallet.org/staking/common', { timeout: 10_000 });
    return res.data;
  } catch {
    return null;
  }
}

export async function getStakingProfits(address: string): Promise<unknown> {
  try {
    const res = await axios.get(`https://api.mytonwallet.org/staking/profits/${address}`, { timeout: 10_000 });
    return res.data;
  } catch {
    return [];
  }
}

// Swap assets / estimate
export async function getSwapAssets(): Promise<unknown> {
  const res = await axios.get('https://api.mytonwallet.org/swap/assets', { timeout: 10_000 });
  return res.data;
}

export async function getSwapPairs(asset: string): Promise<unknown> {
  const res = await axios.get('https://api.mytonwallet.org/swap/pairs', {
    params: { asset },
    timeout: 10_000,
  });
  return res.data;
}

export async function postSwapEstimate(body: unknown): Promise<unknown> {
  const res = await axios.post('https://api.mytonwallet.org/swap/ton/estimate', body, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 15_000,
  });
  return res.data;
}
