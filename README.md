# MyTonWallet API

Self-hosted REST API for multi-chain self-custody wallets.

**Chains:** TON · Ethereum · Base · BNB · Polygon · Arbitrum · Avalanche · Monad · Hyperliquid · Solana · TRON

## Setup

```bash
cp .env.example .env
npm install
npm run dev   # http://localhost:3000
```

Key env vars:

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `3000` | |
| `NETWORK` | `mainnet` | `mainnet` / `testnet` |
| `TONCENTER_API_KEY` | — | Higher TON rate limits |
| `SOLANA_RPC_URL` | https://solana-rpc.publicnode.com | Falls back to publicnode if unreachable |
| `TRON_API_KEY` | — | TronGrid key |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | — | TX notifications |
| `EXPOSE_SEED_PHRASE` | `false` | Never `true` in production |

## Endpoints

### Wallets

```
POST   /wallets/generate                          { chains, label, version, network }
POST   /wallets/import                            { mnemonic, chains, label }
GET    /wallets
GET    /wallets/:id
GET    /wallets/:id/balance                       all chain balances in one call
POST   /wallets/:id/accounts                      { chain } — add chain to existing wallet
DELETE /wallets/:id/accounts/:address[?chain=]
DELETE /wallets/:id
```

Wallets are identified by numeric ID. One wallet (one mnemonic) → many accounts across chains.

### Accounts

All accept `?chain=` and `?network=` when needed (e.g. EVM chains share a 0x address).

```
GET    /accounts/:address                         native + token balances
GET    /accounts/:address/tokens
GET    /accounts/:address/transactions[?since=&direction=&limit=]
GET    /accounts/:address/transactions/:hash      tx status by hash/signature
GET    /accounts/:address/incoming
POST   /accounts/:address/send                    { to, amount } or { to, all: true }
POST   /accounts/:address/send/estimate
POST   /accounts/:address/send/multi              { recipients } — TON only, up to 255
GET    /accounts/:address/staking
POST   /accounts/:address/stake                   { amount } — TON, in TON units
POST   /accounts/:address/unstake                 { amount } — tsTON nanoton units
POST   /accounts/:address/swap
GET    /accounts/:address/webhooks
POST   /accounts/:address/webhooks                { url, secret }
DELETE /accounts/:address/webhooks/:id
```

### Global

```
GET    /swap/assets
GET    /swap/pairs?asset=
POST   /swap/estimate
POST   /swap/build
GET    /tokens/known
GET    /tokens/prices?slugs=
GET    /staking/common
GET    /portfolio
GET    /health
```

## Docs

Full interactive docs: `http://localhost:3000` (served from `docs/`).
