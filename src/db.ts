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
  CREATE TABLE IF NOT EXISTS wallets (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    address     TEXT UNIQUE NOT NULL,
    mnemonic    TEXT,
    version     TEXT NOT NULL DEFAULT 'W5',
    network     TEXT NOT NULL DEFAULT 'mainnet',
    chain       TEXT NOT NULL DEFAULT 'ton',
    label       TEXT,
    created_at  INTEGER NOT NULL
  );

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
  address: string;
  mnemonic: string | null;
  version: string;
  network: string;
  chain: string;
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

// Migrate existing DB: add chain column if missing
try { db.prepare("ALTER TABLE wallets ADD COLUMN chain TEXT NOT NULL DEFAULT 'ton'").run(); } catch { /* already exists */ }

// Wallets
export const stmtInsertWallet = db.prepare<[string, string | null, string, string, string, string | null, number]>(
  `INSERT OR IGNORE INTO wallets (address, mnemonic, version, network, chain, label, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?)`
);

export const stmtGetWallet = db.prepare<[string]>(
  `SELECT * FROM wallets WHERE address = ?`
);

export const stmtGetAllWallets = db.prepare(
  `SELECT * FROM wallets ORDER BY created_at DESC`
);

export const stmtDeleteWallet = db.prepare<[string]>(
  `DELETE FROM wallets WHERE address = ?`
);

// Transactions
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

// Token balances
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

export interface WebhookRow {
  id: number;
  wallet_addr: string;
  url: string;
  secret: string | null;
  created_at: number;
}

// Webhooks
export const stmtInsertWebhook = db.prepare<[string, string, string | null, number]>(
  `INSERT INTO webhooks (wallet_addr, url, secret, created_at) VALUES (?, ?, ?, ?)`
);

export const stmtGetWebhooks = db.prepare<[string]>(
  `SELECT * FROM webhooks WHERE wallet_addr = ? ORDER BY created_at ASC`
);

export const stmtDeleteWebhook = db.prepare<[number, string]>(
  `DELETE FROM webhooks WHERE id = ? AND wallet_addr = ?`
);
