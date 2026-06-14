// Resolves a raw address (from a /addresses/:address route) into the full
// context the chain handlers need: which chain/network it is, the TON wallet
// version, and the owning wallet's mnemonic.
//
// One address string can map to several rows (e.g. the same EVM address on
// ethereum, base, bnb…). Callers may disambiguate with ?chain= / ?network=.

import { stmtGetAddressRows, stmtGetWalletById, AddressRow, WalletRow } from '../db';
import { normalizeAddress } from './wallet';

export interface AddressContext {
  walletId: number | null;
  address: string;
  chain: string;
  network: string;
  version: string | null;
  mnemonic: string | null;
}

export type ResolveResult =
  | { ok: true; ctx: AddressContext }
  | { ok: false; reason: 'ambiguous'; candidates: { chain: string; network: string }[] };

// TON addresses are normalized to the canonical user-friendly form; 0x… (EVM)
// and other chains are left as-is.
export function normalizeAddr(raw: string): string {
  if (raw.startsWith('0x') || raw.startsWith('0X')) return raw;
  try { return normalizeAddress(raw); } catch { return raw; }
}

export function resolveAddress(
  rawAddress: string,
  chainHint?: string,
  networkHint?: string,
): ResolveResult {
  const address = normalizeAddr(rawAddress);

  let rows = stmtGetAddressRows.all(address) as AddressRow[];
  if (chainHint) rows = rows.filter(r => r.chain === chainHint);
  if (networkHint) rows = rows.filter(r => r.network === networkHint);

  // Unknown address (not imported): allow read/operations using hints/defaults,
  // matching the previous behaviour where any address could be queried.
  if (rows.length === 0) {
    return {
      ok: true,
      ctx: {
        walletId: null,
        address,
        chain: chainHint || 'ton',
        network: networkHint || process.env.NETWORK || 'mainnet',
        version: (chainHint || 'ton') === 'ton' ? 'W5' : null,
        mnemonic: null,
      },
    };
  }

  if (rows.length > 1) {
    return {
      ok: false,
      reason: 'ambiguous',
      candidates: rows.map(r => ({ chain: r.chain, network: r.network })),
    };
  }

  const row = rows[0]!;
  const wallet = stmtGetWalletById.get(row.wallet_id) as WalletRow | undefined;
  return {
    ok: true,
    ctx: {
      walletId: row.wallet_id,
      address: row.address,
      chain: row.chain,
      network: row.network,
      version: row.version,
      mnemonic: wallet?.mnemonic ?? null,
    },
  };
}

// Convenience for routes: resolves and writes a 400 on ambiguity. Returns the
// context, or null when the response has already been sent.
import type { Request, Response } from 'express';

export function resolveOr400(req: Request, res: Response): AddressContext | null {
  const raw = req.params['address'] as string;
  const chainHint = (req.query.chain as string) || undefined;
  const networkHint = (req.query.network as string) || undefined;
  const result = resolveAddress(raw, chainHint, networkHint);
  if (!result.ok) {
    res.status(400).json({
      error: 'Address exists on multiple chains/networks — specify ?chain= (and ?network=)',
      candidates: result.candidates,
    });
    return null;
  }
  return result.ctx;
}

export function mnemonicWords(ctx: AddressContext, bodyMnemonic?: string | string[]): string[] | null {
  if (bodyMnemonic) return Array.isArray(bodyMnemonic) ? bodyMnemonic : bodyMnemonic.trim().split(/\s+/);
  if (ctx.mnemonic) return ctx.mnemonic.split(' ');
  return null;
}
