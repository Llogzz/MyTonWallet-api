import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const dbPath = process.env.DB_PATH || './data/wallet.db';
const dir = path.dirname(dbPath);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

export const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  -- A wallet is a single mnemonic (seed). One wallet can own many addresses
  -- across different chains and networks (see the addresses table).
  CREATE TABLE IF NOT EXISTS wallets (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    mnemonic    TEXT UNIQUE,
    label       TEXT,
    created_at  INTEGER NOT NULL
  );

  -- A concrete derived address. network + version determine the address, so
  -- they live here, not on the wallet. version is TON-only (NULL otherwise).
  CREATE TABLE IF NOT EXISTS addresses (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    wallet_id   INTEGER NOT NULL,
    address     TEXT NOT NULL,
    chain       TEXT NOT NULL,
    network     TEXT NOT NULL DEFAULT 'mainnet',
    version     TEXT,
    label       TEXT,
    created_at  INTEGER NOT NULL,
    UNIQUE(address, chain, network),
    FOREIGN KEY(wallet_id) REFERENCES wallets(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_addresses_wallet ON addresses(wallet_id);
  CREATE INDEX IF NOT EXISTS idx_addresses_addr   ON addresses(address);

  CREATE TABLE IF NOT EXISTS transactions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    tx_hash      TEXT UNIQUE NOT NULL,
    wallet_addr  TEXT NOT NULL,
    direction    TEXT NOT NULL,
    amount       TEXT NOT NULL,
    token_addr   TEXT,
    token_symbol TEXT,
    from_addr    TEXT,
    to_addr      TEXT,
    comment      TEXT,
    lt           TEXT,
    timestamp    INTEGER NOT NULL,
    cached_at    INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_tx_wallet_ts ON transactions(wallet_addr, timestamp);
  CREATE INDEX IF NOT EXISTS idx_tx_direction  ON transactions(wallet_addr, direction, timestamp);

  CREATE TABLE IF NOT EXISTS token_balances (
    wallet_addr  TEXT NOT NULL,
    token_addr   TEXT NOT NULL,
    token_symbol TEXT,
    decimals     INTEGER,
    balance      TEXT NOT NULL,
    updated_at   INTEGER NOT NULL,
    PRIMARY KEY (wallet_addr, token_addr)
  );

  CREATE TABLE IF NOT EXISTS webhooks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    wallet_addr TEXT NOT NULL,
    url         TEXT NOT NULL,
    secret      TEXT,
    created_at  INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_webhooks_wallet ON webhooks(wallet_addr);
`);

export interface WalletRow {
  id: number;
  mnemonic: string | null;
  label: string | null;
  created_at: number;
}

export interface AddressRow {
  id: number;
  wallet_id: number;
  address: string;
  chain: string;
  network: string;
  version: string | null;
  label: string | null;
  created_at: number;
}

export interface TxRow {
  id: number;
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
  cached_at: number;
}

export interface TokenBalanceRow {
  wallet_addr: string;
  token_addr: string;
  token_symbol: string | null;
  decimals: number | null;
  balance: string;
  updated_at: number;
}

export interface WebhookRow {
  id: number;
  wallet_addr: string;
  url: string;
  secret: string | null;
  created_at: number;
}

// ─── Wallets (a wallet = one mnemonic) ──────────────────────────────────────────
export const stmtInsertWallet = db.prepare<[string | null, string | null, number]>(
  `INSERT INTO wallets (mnemonic, label, created_at) VALUES (?, ?, ?)`
);

export const stmtGetWalletById = db.prepare<[number]>(
  `SELECT * FROM wallets WHERE id = ?`
);

export const stmtGetWalletByMnemonic = db.prepare<[string]>(
  `SELECT * FROM wallets WHERE mnemonic = ?`
);

export const stmtGetAllWallets = db.prepare(
  `SELECT * FROM wallets ORDER BY created_at DESC`
);

export const stmtDeleteWallet = db.prepare<[number]>(
  `DELETE FROM wallets WHERE id = ?`
);

// ─── Addresses (derived per chain/network) ──────────────────────────────────────
export const stmtInsertAddress = db.prepare<[number, string, string, string, string | null, string | null, number]>(
  `INSERT OR IGNORE INTO addresses (wallet_id, address, chain, network, version, label, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?)`
);

export const stmtGetAddressesByWallet = db.prepare<[number]>(
  `SELECT * FROM addresses WHERE wallet_id = ? ORDER BY id ASC`
);

// An address string may map to several rows (e.g. one EVM address across chains).
export const stmtGetAddressRows = db.prepare<[string]>(
  `SELECT * FROM addresses WHERE address = ?`
);

export const stmtGetAddressByChain = db.prepare<[string, string, string]>(
  `SELECT * FROM addresses WHERE address = ? AND chain = ? AND network = ?`
);

export const stmtGetAllAddresses = db.prepare(
  `SELECT * FROM addresses ORDER BY id ASC`
);

export const stmtDeleteAddress = db.prepare<[number, string]>(
  `DELETE FROM addresses WHERE wallet_id = ? AND address = ?`
);
export const stmtDeleteAddressChain = db.prepare<[number, string, string]>(
  `DELETE FROM addresses WHERE wallet_id = ? AND address = ? AND chain = ?`
);

// ─── Transactions (TON history is persisted by the monitor) ─────────────────────
export const stmtInsertTx = db.prepare<[string, string, string, string, string | null, string | null, string | null, string | null, string | null, string | null, number, number]>(
  `INSERT OR IGNORE INTO transactions
     (tx_hash, wallet_addr, direction, amount, token_addr, token_symbol, from_addr, to_addr, comment, lt, timestamp, cached_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);

export const stmtGetTxs = db.prepare<[string]>(
  `SELECT * FROM transactions WHERE wallet_addr = ? ORDER BY timestamp DESC, lt DESC`
);

export const stmtGetMaxTs = db.prepare<[string]>(
  `SELECT MAX(timestamp) as max_ts FROM transactions WHERE wallet_addr = ?`
);

export const stmtGetTxByHash = db.prepare<[string]>(
  `SELECT * FROM transactions WHERE tx_hash = ? LIMIT 1`
);

// ─── Token balances ─────────────────────────────────────────────────────────────
export const stmtUpsertBalance = db.prepare<[string, string, string | null, number | null, string, number]>(
  `INSERT INTO token_balances (wallet_addr, token_addr, token_symbol, decimals, balance, updated_at)
   VALUES (?, ?, ?, ?, ?, ?)
   ON CONFLICT(wallet_addr, token_addr) DO UPDATE SET
     token_symbol = excluded.token_symbol,
     decimals     = excluded.decimals,
     balance      = excluded.balance,
     updated_at   = excluded.updated_at`
);

export const stmtGetBalances = db.prepare<[string]>(
  `SELECT * FROM token_balances WHERE wallet_addr = ?`
);

// ─── Webhooks ───────────────────────────────────────────────────────────────────
export const stmtInsertWebhook = db.prepare<[string, string, string | null, number]>(
  `INSERT INTO webhooks (wallet_addr, url, secret, created_at) VALUES (?, ?, ?, ?)`
);

export const stmtGetWebhooks = db.prepare<[string]>(
  `SELECT * FROM webhooks WHERE wallet_addr = ? ORDER BY created_at ASC`
);

export const stmtDeleteWebhook = db.prepare<[number, string]>(
  `DELETE FROM webhooks WHERE id = ? AND wallet_addr = ?`
);
