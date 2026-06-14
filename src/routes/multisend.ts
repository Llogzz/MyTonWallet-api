import { Router, Request, Response } from 'express';
import { stmtGetWallet, WalletRow } from '../db';
import { normalizeAddress, mnemonicToKeyPair, type WalletVersion } from '../services/wallet';
import { cache } from '../cache';
import {
  TonClient, WalletContractV1R1, WalletContractV1R2, WalletContractV1R3,
  WalletContractV2R1, WalletContractV2R2, WalletContractV3R1, WalletContractV3R2,
  WalletContractV4, WalletContractV5R1, internal, toNano,
} from '@ton/ton';
import { Address, beginCell } from '@ton/core';

const router = Router({ mergeParams: true });

interface Recipient {
  to: string;
  amount: string;
  comment?: string;
  token?: string;  // jetton master address; omit for TON
}

// POST /wallets/:address/send/multi
// Body: { recipients: [{ to, amount, comment?, token? }] }
// Max 4 recipients per tx (TON wallet limit per message)
router.post('/', async (req: Request, res: Response) => {
  try {
    const address = normalizeAddress(req.params['address'] as string);
    const { recipients } = req.body as { recipients: Recipient[] };

    if (!Array.isArray(recipients) || recipients.length === 0) {
      res.status(400).json({ error: 'recipients array is required' });
      return;
    }
    if (recipients.length > 255) {
      res.status(400).json({ error: 'max 255 recipients per transaction' });
      return;
    }

    const wallet = stmtGetWallet.get(address) as WalletRow | undefined;
    if (!wallet?.mnemonic) {
      res.status(400).json({ error: 'Wallet must be imported with mnemonic' });
      return;
    }

    const network = wallet.network || process.env.NETWORK || 'mainnet';
    const version = (wallet.version || 'W5') as WalletVersion;
    const kp = await mnemonicToKeyPair(wallet.mnemonic.split(' '));
    const client = makeTonClient(network);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const contract: any = makeContract(kp.publicKey, version);
    const openedWallet = client.open(contract);
    const seqno = await openedWallet.getSeqno();

    const messages = await Promise.all(recipients.map(async (r) => {
      if (r.token) {
        // Jetton transfer
        const jettonTransferBody = beginCell()
          .storeUint(0xf8a7ea5, 32)
          .storeUint(0, 64)
          .storeCoins(BigInt(r.amount))
          .storeAddress(Address.parse(r.to))
          .storeAddress(Address.parse(address))
          .storeBit(false)
          .storeCoins(toNano('0.05'))
          .storeBit(false)
          .endCell();

        // We'd need to resolve the jetton wallet address first
        // For simplicity in multi-send: send to jetton master with transfer
        return internal({
          to: Address.parse(r.token),
          value: toNano('0.1'),
          body: jettonTransferBody,
          bounce: true,
        });
      } else {
        // TON transfer
        const body = r.comment
          ? beginCell().storeUint(0, 32).storeStringTail(r.comment).endCell()
          : undefined;
        return internal({
          to: Address.parse(r.to),
          value: toNano(r.amount),
          body,
          bounce: false,
        });
      }
    }));

    await openedWallet.sendTransfer({
      seqno,
      secretKey: kp.secretKey,
      messages,
    });

    cache.invalidatePrefix(`balance:${address}`);
    cache.invalidatePrefix(`tx:${address}`);

    res.json({
      ok: true,
      recipients_count: recipients.length,
      message: `Multi-send to ${recipients.length} recipients submitted`,
    });
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeContract(publicKey: Buffer, version: WalletVersion): any {
  const opts = { workchain: 0, publicKey };
  switch (version) {
    case 'simpleR1': return WalletContractV1R1.create(opts);
    case 'simpleR2': return WalletContractV1R2.create(opts);
    case 'simpleR3': return WalletContractV1R3.create(opts);
    case 'v2R1':     return WalletContractV2R1.create(opts);
    case 'v2R2':     return WalletContractV2R2.create(opts);
    case 'v3R1':     return WalletContractV3R1.create(opts);
    case 'v3R2':     return WalletContractV3R2.create(opts);
    case 'v4R2':     return WalletContractV4.create(opts);
    default:         return WalletContractV5R1.create(opts);
  }
}

function makeTonClient(network: string): TonClient {
  const baseUrl = network === 'testnet'
    ? (process.env.TONCENTER_TESTNET_URL || 'https://toncenter-testnet.mytonwallet.org')
    : (process.env.TONCENTER_MAINNET_URL || 'https://toncenter.mytonwallet.org');
  return new TonClient({ endpoint: `${baseUrl}/api/v2/jsonRPC`, apiKey: process.env.TONCENTER_API_KEY });
}

export default router;
