# MyTonWallet API

Multi-chain self-custody wallet REST API. Supports TON, EVM chains (Ethereum, Base, BNB, Polygon, Arbitrum, Avalanche, Monad, Hyperliquid), Solana, and TRON.

## Quick Start

```bash
cp .env.example .env   # fill in your keys
npm install
npm run dev            # http://localhost:3000
```

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `DB_PATH` | `./data/wallet.db` | SQLite file path |
| `NETWORK` | `mainnet` | Default TON network (`mainnet` / `testnet`) |
| `EXPOSE_SEED_PHRASE` | `false` | Return mnemonic in API responses (set `true` only in dev) |
| `DEFAULT_CHAINS` | all | Comma-separated chains to derive on import/generate |
| `TONCENTER_MAINNET_URL` | toncenter.mytonwallet.org | TON API base URL |
| `TONCENTER_TESTNET_URL` | toncenter-testnet.mytonwallet.org | TON testnet API base URL |
| `TONCENTER_API_KEY` | — | API key for higher rate limits |
| `SOLANA_RPC_URL` | https://solana-rpc.publicnode.com | Primary Solana RPC endpoint |
| `TELEGRAM_BOT_TOKEN` | — | Bot token for tx notifications |
| `TELEGRAM_CHAT_ID` | — | Chat ID to receive tx notifications |

## Database Schema

```
wallets    id, mnemonic, label, created_at
accounts   id, wallet_id, address, chain, network, version, label, created_at
```

One wallet (one mnemonic) → many accounts across chains and networks.

---

## API Reference

### Wallets

| Method | Path | Description |
|---|---|---|
| `POST` | `/wallets/generate` | Generate a new BIP39 wallet |
| `POST` | `/wallets/import` | Import existing mnemonic |
| `GET` | `/wallets` | List all wallets with their accounts |
| `GET` | `/wallets/:id` | Get one wallet |
| `GET` | `/wallets/:id/balance` | All chain balances in one call |
| `POST` | `/wallets/:id/accounts` | Derive account on another chain |
| `DELETE` | `/wallets/:id/accounts/:address[?chain=]` | Remove one account |
| `DELETE` | `/wallets/:id` | Delete wallet + all accounts |

**Generate wallet**
```http
POST /wallets/generate
{ "chains": ["ton","ethereum"], "label": "main", "network": "mainnet", "version": "W5" }
```

**Import wallet**
```http
POST /wallets/import
{ "mnemonic": "word1 word2 ... word24", "chains": ["ton"], "label": "imported" }
```

Response includes `id`, `label`, `accounts[]`, `created_at`. Mnemonic only included if `EXPOSE_SEED_PHRASE=true`.

**Wallet balance summary**

Returns native + token balances for all accounts in a single request. Individual chain errors do not fail the whole response.

```http
GET /wallets/1/balance
```
```json
{
  "wallet_id": 1,
  "balances": [
    { "address": "EQD...", "chain": "ton", "native_raw": "1000000000", "native": "1.0", "native_symbol": "TON", "tokens": [] },
    { "address": "0xABC...", "chain": "ethereum", "native_raw": "500000000000000000", "native": "0.5", "native_symbol": "ETH", "tokens": [] },
    { "address": "6UZ1...", "chain": "solana", "native_raw": "1000000", "native": "0.001000000", "native_symbol": "SOL", "tokens": [] }
  ]
}
```

**Delete account — chain-specific vs all**
```http
DELETE /wallets/1/accounts/0xABC...?chain=ethereum   # remove only ethereum entry
DELETE /wallets/1/accounts/0xABC...                  # remove all chains sharing this address
```

EVM chains (ethereum, base, bnb, polygon, arbitrum, avalanche) share the same derived address — use `?chain=` to remove just one chain without touching the others.

---

### Accounts

All account endpoints accept `?chain=` and `?network=` query params when the same address exists on multiple chains.

| Method | Path | Description |
|---|---|---|
| `GET` | `/accounts/:address` | Native + token balances |
| `GET` | `/accounts/:address/transactions` | Transaction history |
| `GET` | `/accounts/:address/transactions/:hash` | Status of a specific tx by hash |
| `GET` | `/accounts/:address/incoming` | Incoming transactions only |
| `GET` | `/accounts/:address/tokens` | Token / jetton balances |
| `POST` | `/accounts/:address/send` | Send native or token |
| `POST` | `/accounts/:address/send/estimate` | Estimate fee (all chains) |
| `POST` | `/accounts/:address/send/multi` | Multi-send (TON only, max 255) |
| `GET` | `/accounts/:address/staking` | Staking profits |
| `POST` | `/accounts/:address/stake` | Stake TON (liquid staking) |
| `POST` | `/accounts/:address/unstake` | Unstake |
| `POST` | `/accounts/:address/swap` | Execute swap |
| `GET` | `/accounts/:address/webhooks` | List webhooks |
| `POST` | `/accounts/:address/webhooks` | Register webhook |
| `DELETE` | `/accounts/:address/webhooks/:id` | Delete webhook |

**Get balance**
```http
GET /accounts/EQD...abc
GET /accounts/0xABC...?chain=ethereum
GET /accounts/6UZ1...?chain=solana
```

**Send — specify amount**
```http
POST /accounts/EQD...abc/send
{ "to": "EQD...xyz", "amount": "1000000000", "comment": "hi" }
```
Mnemonic is taken from the stored wallet. Pass `"mnemonic": [...]` to override.

**Send max (sweep entire balance)**

Pass `"all": true` instead of `"amount"`. The API deducts the estimated fee from the current balance and sends the remainder.

```http
POST /accounts/EQD...abc/send
{ "to": "EQD...xyz", "all": true }
```
```http
POST /accounts/0xABC.../send?chain=ethereum
{ "to": "0xDEF...", "all": true }
```
```http
POST /accounts/6UZ1.../send?chain=solana
{ "to": "DEST...", "all": true }
```

> **Solana note:** Sending `"all": true` on a Solana account deducts exactly 5 000 lamports (one signature fee) from the current balance. This drains the account to 0, which closes it on-chain. If the remaining lamports after fee would be below 0, the request returns an error.

**Send ERC-20 / SPL token / TRC-20**
```http
POST /accounts/0xABC.../send?chain=ethereum
{ "to": "0xDEF...", "amount": "1000000", "token": "0xUSDT..." }
```

**Multi-send (TON)**
```http
POST /accounts/EQD...abc/send/multi
{ "recipients": [{ "to": "EQD...", "amount": "1000000000" }, ...] }
```

---

### Fee Estimation

Works for all supported chains.

```http
POST /accounts/:address/send/estimate[?chain=]
```

Optional body fields: `{ "to": "...", "amount": "...", "token": "0x..." }` — used for a more precise TON estimate; ignored for other chains.

**TON**
```json
{ "estimated_fee": "0.005", "estimated_fee_raw": "5000000", "native_symbol": "TON" }
```

**Ethereum (live gas price)**
```json
{
  "fee_raw": "2614046778000",
  "fee": "0.000002614046778",
  "native_symbol": "ETH",
  "gas": "21000",
  "gas_price": "124478418"
}
```
Token transfers use `gas: "65000"` automatically.

**Solana**
```json
{ "fee_raw": "5000", "fee": "0.000005000", "native_symbol": "SOL" }
```

**TRON**
```json
{ "fee_raw": "1000000", "fee": "1.0", "native_symbol": "TRX", "note": "..." }
```

---

### Transaction Status by Hash

Checks the local DB first (TON txs cached by the background monitor), then falls back to the chain RPC.

```http
GET /accounts/EQD...abc/transactions/HASH
GET /accounts/0xABC.../transactions/0xHASH?chain=ethereum
GET /accounts/6UZ1.../transactions/SIGNATURE?chain=solana
```

```json
{
  "tx_hash": "0xabc...",
  "chain": "ethereum",
  "status": "success",
  "block": 21840000,
  "timestamp": 1718000000,
  "from": "0xSENDER",
  "to": "0xRECIPIENT"
}
```

Possible `status` values: `success`, `failed`, `pending`, `not_found`.

---

### Swap

| Method | Path | Description |
|---|---|---|
| `GET` | `/swap/assets` | Available swap assets |
| `GET` | `/swap/pairs?asset=TON` | Pairs for asset |
| `POST` | `/swap/estimate` | Estimate swap |
| `POST` | `/swap/build` | Build TON swap tx (no execution) |
| `POST` | `/accounts/:address/swap` | Execute swap |

**TON swap**
```http
POST /accounts/EQD...abc/swap
{ "from": "TON", "to": "USDT", "amount": "1000000000", "slippage": 0.5 }
```

**EVM swap**
```http
POST /accounts/0xABC.../swap?chain=ethereum
{ "fromToken": "0xETH", "toToken": "0xUSDC", "amount": "1000000000000000000" }
```

---

### Tokens & Prices

```http
GET /tokens/known              # built-in TON token list (~500 tokens)
GET /tokens/prices?slugs=TON,USDT
```

---

### Staking

```http
GET  /staking/common
GET  /accounts/EQD...abc/staking
POST /accounts/EQD...abc/stake    { "amount": "10" }    # 10 TON
POST /accounts/EQD...abc/unstake  { "amount": "..." }   # tsTON units
```

---

### Webhooks

Webhooks fire on every new TON transaction for the account.

```http
POST /accounts/EQD...abc/webhooks
{ "url": "https://yourserver.com/hook", "secret": "optional-hmac-secret" }
```

Delivery includes `X-Signature: sha256=<hmac>` header when secret is set.

---

### Portfolio

```http
GET /portfolio    # USD value across all accounts and chains
```

---

### Health

```http
GET /health
```

---

## Solana RPC Fallback

The Solana service tries RPCs in order: the value of `SOLANA_RPC_URL`, then the bundled fallback (`solana-rpc.publicnode.com`). If the primary endpoint fails, the next one is tried automatically. Set `SOLANA_RPC_URL` in `.env` to your preferred or paid RPC to reduce fallback reliance.

Some publicnode endpoints restrict methods like `getParsedTokenAccountsByOwner` — in that case token balances are returned as an empty array without erroring.
