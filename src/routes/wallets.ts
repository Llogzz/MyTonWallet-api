import { Router, Request, Response } from 'express';
import * as bip39 from 'bip39';
import { mnemonicValidate } from '@ton/crypto';
import {
  stmtInsertWallet, stmtGetWalletById, stmtGetWalletByMnemonic,
  stmtGetAllWallets, stmtDeleteWallet,
  stmtInsertAddress, stmtGetAddressesByWallet,
  stmtDeleteAddress, stmtDeleteAddressChain,
  type WalletRow, type AddressRow,
} from '../db';
import {
  SUPPORTED_CHAINS, isSupportedChain, deriveAddress, getBalance,
} from '../services/chains';
import { isBip39Mnemonic, type WalletVersion } from '../services/wallet';
import { notifyAddressesAdded, syncWalletNow } from '../services/monitor';

const router = Router();
const DEFAULT_NETWORK = process.env.NETWORK || 'mainnet';

function formatWallet(wallet: WalletRow, addresses: AddressRow[]) {
  return {
    id: wallet.id,
    label: wallet.label,
    created_at: wallet.created_at,
    addresses: addresses.map(a => ({
      address: a.address,
      chain: a.chain,
      network: a.network,
      version: a.version,
      label: a.label,
    })),
  };
}

function parseId(raw: string): number | null {
  const n = parseInt(raw, 10);
  return isNaN(n) ? null : n;
}

async function deriveAll(
  words: string[],
  chains: string[],
  version: WalletVersion,
  network: string,
  walletId: number,
  label: string | null,
): Promise<{ skipped: string[] }> {
  const now = Math.floor(Date.now() / 1000);
  const skipped: string[] = [];
  for (const chain of chains) {
    if (!isSupportedChain(chain)) { skipped.push(chain); continue; }
    try {
      const { address, version: addrVer } = await deriveAddress(chain, words, { version });
      stmtInsertAddress.run(walletId, address, chain, network, chain === 'ton' ? addrVer : null, label, now);
    } catch {
      skipped.push(chain);
    }
  }
  return { skipped };
}

function notifyAndSync(walletId: number): void {
  const all = stmtGetAddressesByWallet.all(walletId) as AddressRow[];
  const tonAddrs = all.filter(a => a.chain === 'ton');
  if (tonAddrs.length > 0) {
    notifyAddressesAdded(tonAddrs);
    tonAddrs.forEach(a => syncWalletNow(a.address, a.network).catch(() => {}));
  }
}

// POST /wallets/generate
router.post('/generate', async (req: Request, res: Response) => {
  try {
    const {
      chains = SUPPORTED_CHAINS,
      label = null,
      version = 'W5',
      network = DEFAULT_NETWORK,
    } = (req.body || {}) as {
      chains?: string[];
      label?: string | null;
      version?: string;
      network?: string;
    };

    const words = bip39.generateMnemonic(256).split(' ');
    const now = Math.floor(Date.now() / 1000);
    const { lastInsertRowid } = stmtInsertWallet.run(words.join(' '), label, now);
    const walletId = lastInsertRowid as number;

    const { skipped } = await deriveAll(words, chains, version as WalletVersion, network, walletId, label);
    notifyAndSync(walletId);

    const wallet = stmtGetWalletById.get(walletId) as WalletRow;
    const addresses = stmtGetAddressesByWallet.all(walletId) as AddressRow[];

    const response: Record<string, unknown> = {
      ...formatWallet(wallet, addresses),
      seed_stored: true,
      seed_returned: false,
      skipped,
    };
    if (process.env.EXPOSE_SEED_PHRASE === 'true') response['mnemonic'] = words;

    res.status(201).json(response);
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
});

// POST /wallets/import
router.post('/import', async (req: Request, res: Response) => {
  try {
    const {
      mnemonic,
      chains = SUPPORTED_CHAINS,
      label = null,
      version = 'W5',
      network = DEFAULT_NETWORK,
    } = (req.body || {}) as {
      mnemonic?: string | string[];
      chains?: string[] | string;
      label?: string | null;
      version?: string;
      network?: string;
    };

    if (!mnemonic) { res.status(400).json({ error: 'mnemonic is required' }); return; }

    const words = Array.isArray(mnemonic) ? mnemonic : mnemonic.trim().split(/\s+/);
    if (words.length !== 12 && words.length !== 24) {
      res.status(400).json({ error: 'Mnemonic must be 12 or 24 words' }); return;
    }

    const isTon = await mnemonicValidate(words);
    const isBip = isBip39Mnemonic(words);
    if (!isTon && !isBip) {
      res.status(400).json({ error: 'Invalid mnemonic: not a valid TON or BIP39 seed phrase' }); return;
    }

    const mnemonicStr = words.join(' ');
    const now = Math.floor(Date.now() / 1000);

    const existing = stmtGetWalletByMnemonic.get(mnemonicStr) as WalletRow | undefined;
    let walletId: number;
    if (existing) {
      walletId = existing.id;
    } else {
      const { lastInsertRowid } = stmtInsertWallet.run(mnemonicStr, label, now);
      walletId = lastInsertRowid as number;
    }

    const chainList = Array.isArray(chains) ? chains : [chains];
    const { skipped } = await deriveAll(words, chainList, version as WalletVersion, network, walletId, label);
    notifyAndSync(walletId);

    const wallet = stmtGetWalletById.get(walletId) as WalletRow;
    const addresses = stmtGetAddressesByWallet.all(walletId) as AddressRow[];

    const response: Record<string, unknown> = {
      ...formatWallet(wallet, addresses),
      mnemonic_type: isTon ? 'ton' : 'bip39',
      skipped,
    };
    if (process.env.EXPOSE_SEED_PHRASE === 'true') response['mnemonic'] = words;

    res.status(201).json(response);
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /wallets
router.get('/', (_req: Request, res: Response) => {
  const wallets = stmtGetAllWallets.all() as WalletRow[];
  res.json(wallets.map(w => {
    const addresses = stmtGetAddressesByWallet.all(w.id) as AddressRow[];
    return formatWallet(w, addresses);
  }));
});

// GET /wallets/:id/balance  — must be before /:id to avoid shadowing
router.get('/:id/balance', async (req: Request, res: Response) => {
  try {
    const id = parseId(req.params['id'] as string);
    if (id === null) { res.status(400).json({ error: 'Invalid wallet ID' }); return; }
    const wallet = stmtGetWalletById.get(id) as WalletRow | undefined;
    if (!wallet) { res.status(404).json({ error: 'Wallet not found' }); return; }
    const addresses = stmtGetAddressesByWallet.all(id) as AddressRow[];

    const balances = await Promise.all(addresses.map(async a => {
      try {
        const bal = await getBalance(a.chain, a.address, a.network);
        return { address: a.address, chain: a.chain, network: a.network, label: a.label, ...bal };
      } catch (err) {
        return { address: a.address, chain: a.chain, network: a.network, label: a.label, error: String(err) };
      }
    }));

    res.json({ wallet_id: id, balances });
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /wallets/:id
router.get('/:id', (req: Request, res: Response) => {
  const id = parseId(req.params['id'] as string);
  if (id === null) { res.status(400).json({ error: 'Invalid wallet ID' }); return; }
  const wallet = stmtGetWalletById.get(id) as WalletRow | undefined;
  if (!wallet) { res.status(404).json({ error: 'Wallet not found' }); return; }
  const addresses = stmtGetAddressesByWallet.all(id) as AddressRow[];
  res.json(formatWallet(wallet, addresses));
});

// POST /wallets/:id/accounts  — add another chain account
router.post('/:id/accounts', async (req: Request, res: Response) => {
  try {
    const id = parseId(req.params['id'] as string);
    if (id === null) { res.status(400).json({ error: 'Invalid wallet ID' }); return; }
    const wallet = stmtGetWalletById.get(id) as WalletRow | undefined;
    if (!wallet) { res.status(404).json({ error: 'Wallet not found' }); return; }
    if (!wallet.mnemonic) { res.status(400).json({ error: 'Wallet has no stored mnemonic' }); return; }

    const { chain, version = 'W5', network = DEFAULT_NETWORK } = (req.body || {}) as {
      chain?: string;
      version?: string;
      network?: string;
    };
    if (!chain || !isSupportedChain(chain)) {
      res.status(400).json({ error: `Valid chain required. Supported: ${SUPPORTED_CHAINS.join(', ')}` }); return;
    }

    const words = wallet.mnemonic.split(' ');
    const now = Math.floor(Date.now() / 1000);
    const { address, version: addrVer } = await deriveAddress(chain, words, { version: version as WalletVersion });
    stmtInsertAddress.run(id, address, chain, network, chain === 'ton' ? addrVer : null, wallet.label, now);

    if (chain === 'ton') {
      const all = stmtGetAddressesByWallet.all(id) as AddressRow[];
      const added = all.find(a => a.address === address && a.chain === chain);
      if (added) notifyAddressesAdded([added]);
      syncWalletNow(address, network).catch(() => {});
    }

    const allAddresses = stmtGetAddressesByWallet.all(id) as AddressRow[];
    const added = allAddresses.find(a => a.address === address && a.chain === chain);
    res.status(201).json({ added, wallet: formatWallet(wallet, allAddresses) });
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
});

// DELETE /wallets/:id/accounts/:address  — remove account(s) from wallet
router.delete('/:id/accounts/:address', (req: Request, res: Response) => {
  const id = parseId(req.params['id'] as string);
  if (id === null) { res.status(400).json({ error: 'Invalid wallet ID' }); return; }
  const wallet = stmtGetWalletById.get(id) as WalletRow | undefined;
  if (!wallet) { res.status(404).json({ error: 'Wallet not found' }); return; }

  const address = req.params['address'] as string;
  const chain = req.query['chain'] as string | undefined;

  if (chain) {
    const result = stmtDeleteAddressChain.run(id, address, chain);
    if (result.changes === 0) { res.status(404).json({ error: 'Account not found' }); return; }
    res.json({ deleted: true, address, chain });
  } else {
    const result = stmtDeleteAddress.run(id, address);
    if (result.changes === 0) { res.status(404).json({ error: 'Account not found' }); return; }
    res.json({ deleted: true, address, chains_removed: result.changes });
  }
});

// DELETE /wallets/:id  — delete wallet and all its addresses (CASCADE)
router.delete('/:id', (req: Request, res: Response) => {
  const id = parseId(req.params['id'] as string);
  if (id === null) { res.status(400).json({ error: 'Invalid wallet ID' }); return; }
  const result = stmtDeleteWallet.run(id);
  if (result.changes === 0) { res.status(404).json({ error: 'Wallet not found' }); return; }
  res.json({ deleted: true, id });
});

export default router;
