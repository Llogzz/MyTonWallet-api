# MyTonWallet API · v4.10.7

Self-hosted REST API implementing the full [MyTonWallet](https://mytonwallet.io) v4.10.7 feature set.

**Docs:** https://llogzz.github.io/MyTonWallet-api

---

## Supported Chains

| Chain | Networks | Native | Tokens |
|---|---|---|---|
| **TON** | mainnet / testnet | TON | Jettons (USDT, NOT, DOGS, …) |
| **Ethereum** | mainnet | ETH | ERC-20 |
| **Base** | mainnet | ETH | ERC-20 |
| **BNB Smart Chain** | mainnet | BNB | BEP-20 |
| **Polygon** | mainnet | POL | ERC-20 |
| **Arbitrum** | mainnet | ETH | ERC-20 |
| **Avalanche** | mainnet | AVAX | ERC-20 |
| **Monad** | mainnet | MON | ERC-20 |
| **HyperLiquid** | mainnet | HYPE | ERC-20 |
| **Solana** | mainnet | SOL | SPL |
| **TRON** | mainnet | TRX | TRC-20 (USDT, …) |

---

## Features

- Wallet import / generation — TON (W5, v4R2, v3R2, v3R1), EVM, Solana, TRON
- Multi-chain balance queries (native + tokens)
- Transaction history (all chains)
- **Send:** TON, Jettons, ETH / ERC-20, BNB / BEP-20, SOL / SPL, TRX / TRC-20
- **Multi-send** up to 255 TON recipients in one transaction
- **Liquid staking** (TON via MyTonWallet pool)
- **Token swaps** (TON ↔ Jettons via MyTonWallet DEX; EVM via Paraswap; Solana via Jupiter; TRON via SunSwap)
- **Portfolio** (`GET /portfolio`) — aggregated USD value across all wallets using CoinGecko prices
- **Telegram notifications** — push new transactions to a Telegram chat via Bot API
- **Webhook callbacks** (HTTP POST + optional HMAC-SHA256 signing)
- **Proxy support** (HTTP / SOCKS5, hot-reload, random selection, 5-min failure cooldown)
- SQLite with WAL mode + in-memory TTL cache
- WebSocket real-time monitoring (TON); 30 s poll (EVM / Solana / TRON)

---

## Requirements

- Node.js 18+
- npm 8+

---

## Quick Start

```bash
git clone https://github.com/llogzz/MyTonWallet-api
cd MyTonWallet-api
npm install
# .env is included with sensible defaults — edit if needed
npm run dev
```

API is available at `http://localhost:3000`.

---

## Configuration

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP server port |
| `TONCENTER_MAINNET_URL` | `https://toncenter.mytonwallet.org` | Toncenter mainnet API |
| `TONCENTER_TESTNET_URL` | `https://toncenter-testnet.mytonwallet.org` | Toncenter testnet API |
| `TONCENTER_API_KEY` | *(empty)* | Optional Toncenter key (higher rate limits) |
| `NETWORK` | `mainnet` | Default network: `mainnet` or `testnet` |
| `DB_PATH` | `./data/wallet.db` | SQLite database path |
| `MONITOR_FALLBACK_INTERVAL_MS` | `30000` | HTTP poll interval (ms) when WebSocket is down |
| `WS_RECONNECT_MAX_MS` | `30000` | Max WebSocket reconnect backoff (ms) |
| `EVM_API_URL` | `https://evmapi.mytonwallet.org` | EVM balance / history backend |
| `SOLANA_RPC_URL` | `https://api.mainnet-beta.solana.com` | Solana JSON-RPC endpoint |
| `TRON_API_URL` | `https://api.trongrid.io` | TRON REST API |
| `TRON_API_KEY` | *(empty)* | Optional TronGrid API key |
| `TELEGRAM_BOT_TOKEN` | *(empty)* | Bot token from @BotFather (enables Telegram notifications) |
| `TELEGRAM_CHAT_ID` | *(empty)* | Your Telegram chat ID (find via @userinfobot) |

---

## Proxy Support

Add proxies to `proxy.txt` (one per line, created automatically on startup):

```
# Plain host:port
34.44.49.215:80

# With credentials
34.44.49.215:80:user:pass
socks5://user:pass@34.44.49.215:80
http://user:pass@34.44.49.215:80
```

Lines starting with `#` are ignored. Changes apply instantly without restart.

---

## API Reference

### Wallets
| Method | Path | Description |
|---|---|---|
| `POST` | `/wallets/generate` | Generate new TON wallet + mnemonic |
| `POST` | `/wallets/import` | Import wallet from mnemonic (all chains) |
| `GET` | `/wallets` | List all saved wallets |
| `GET` | `/wallets/:address` | Balance + token overview |
| `DELETE` | `/wallets/:address` | Remove wallet from DB |

### Transactions
| Method | Path | Description |
|---|---|---|
| `GET` | `/wallets/:address/transactions` | History with filters |
| `GET` | `/wallets/:address/incoming` | Incoming transactions only |

### Tokens
| Method | Path | Description |
|---|---|---|
| `GET` | `/wallets/:address/tokens` | Token balances (chain-aware) |
| `GET` | `/tokens/known` | Known TON token list |
| `GET` | `/tokens/prices` | USD prices by slug |

### Send
| Method | Path | Description |
|---|---|---|
| `POST` | `/wallets/:address/send` | Send native or token (all chains) |
| `POST` | `/wallets/:address/send/estimate` | Fee estimate (TON) |
| `POST` | `/wallets/:address/send/multi` | Multi-send up to 255 (TON) |

### Staking
| Method | Path | Description |
|---|---|---|
| `GET` | `/wallets/:address/staking` | Staking position |
| `POST` | `/wallets/:address/staking/stake` | Stake TON |
| `POST` | `/wallets/:address/staking/unstake` | Unstake TON |
| `GET` | `/staking/common` | Pool APY and stats |

### Swap (TON / Jettons)
| Method | Path | Description |
|---|---|---|
| `GET` | `/swap/assets` | Available swap assets |
| `GET` | `/swap/pairs` | Pairs for an asset |
| `POST` | `/swap/estimate` | Price estimate |
| `POST` | `/swap/build` | Build swap transaction (unsigned) |
| `POST` | `/wallets/:address/swap` | Build + execute swap |

### Webhooks
| Method | Path | Description |
|---|---|---|
| `POST` | `/wallets/:address/webhooks` | Register webhook URL |
| `GET` | `/wallets/:address/webhooks` | List webhooks |
| `DELETE` | `/wallets/:address/webhooks/:id` | Remove webhook |

### Portfolio
| Method | Path | Description |
|---|---|---|
| `GET` | `/portfolio` | USD summary across all wallets (CoinGecko prices) |

### Misc
| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Liveness check |

---

## Development

```bash
npm run dev    # TypeScript watch mode (ts-node-dev)
npm run build  # Compile to dist/
npm start      # Run compiled output
```

---

## License

MIT
"# MyTonWallet-api" 
