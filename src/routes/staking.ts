import { Router, Request, Response } from 'express';
import { getStakingCommonData, getStakingProfits } from '../toncenter';
import { cache, TTL } from '../cache';
import { mnemonicToKeyPair, type WalletVersion } from '../services/wallet';
import { resolveOr400 } from '../services/addressContext';
import {
  TonClient, WalletContractV1R1, WalletContractV1R2, WalletContractV1R3,
  WalletContractV2R1, WalletContractV2R2, WalletContractV3R1, WalletContractV3R2,
  WalletContractV4, WalletContractV5R1, JettonMaster, internal, toNano,
} from '@ton/ton';
import { Address, Cell, beginCell } from '@ton/core';

const router = Router({ mergeParams: true });

// Tonstakers liquid staking pool — also the tsTON jetton master
const LIQUID_POOL = 'EQD2_4d91M4TVbEBVyBF8J1UwpMJc361LKVCz6bBlffMW05o';

export async function stakingCommonHandler(_req: Request, res: Response): Promise<void> {
  try {
    const cacheKey = 'staking:common';
    let cached = cache.get<unknown>(cacheKey);
    if (!cached) {
      cached = await getStakingCommonData();
      cache.set(cacheKey, cached, 60_000);
    }
    res.json(cached);
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
}

router.get('/', async (req: Request, res: Response) => {
  try {
    const ctx = resolveOr400(req, res);
    if (!ctx) return;
    const address = ctx.address;
    const cacheKey = `staking:profits:${address}`;
    let cached = cache.get<unknown>(cacheKey);
    if (!cached) {
      cached = await getStakingProfits(address);
      cache.set(cacheKey, cached, TTL.JETTONS);
    }
    res.json(cached);
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
});

// POST /addresses/:address/stake
// Body: { amount: "10" } — amount in TON
router.post('/stake', async (req: Request, res: Response) => {
  try {
    const ctx = resolveOr400(req, res);
    if (!ctx) return;
    if (ctx.chain !== 'ton') { res.status(400).json({ error: 'Staking is TON-only' }); return; }
    const { amount } = req.body as { amount: string };
    if (!amount) { res.status(400).json({ error: 'amount is required (in TON)' }); return; }
    if (!ctx.mnemonic) { res.status(400).json({ error: 'Wallet must be imported with mnemonic' }); return; }

    const version = (ctx.version || 'W5') as WalletVersion;
    const kp = await mnemonicToKeyPair(ctx.mnemonic.split(' '));
    const client = makeTonClient(ctx.network);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const contract: any = makeContract(kp.publicKey, version);
    const wallet = client.open(contract);
    const seqno = await wallet.getSeqno();

    // Tonstakers deposit op
    const stakeBody = beginCell()
      .storeUint(0x47d54391, 32)  // deposit
      .storeUint(0, 64)
      .endCell();

    const transferCell = (wallet as unknown as {
      createTransfer(a: { seqno: number; secretKey: Buffer; messages: ReturnType<typeof internal>[] }): Cell;
    }).createTransfer({
      seqno, secretKey: kp.secretKey,
      messages: [internal({ to: Address.parse(LIQUID_POOL), value: toNano(amount), body: stakeBody, bounce: true })],
    });
    const msgHash = transferCell.hash().toString('hex');
    await client.sendExternalMessage(contract, transferCell);

    res.json({ ok: true, tx_hash: msgHash, pool: LIQUID_POOL });
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
});

// POST /addresses/:address/unstake
// Body: { amount: "10" } — tsTON amount in nanoton units
// Correct flow: burn tsTON from user's jetton wallet (pool is the jetton master)
router.post('/unstake', async (req: Request, res: Response) => {
  try {
    const ctx = resolveOr400(req, res);
    if (!ctx) return;
    if (ctx.chain !== 'ton') { res.status(400).json({ error: 'Staking is TON-only' }); return; }
    const address = ctx.address;
    const { amount } = req.body as { amount: string };
    if (!amount) { res.status(400).json({ error: 'amount is required (tsTON nanoton units)' }); return; }
    if (!ctx.mnemonic) { res.status(400).json({ error: 'Wallet must be imported with mnemonic' }); return; }

    const version = (ctx.version || 'W5') as WalletVersion;
    const kp = await mnemonicToKeyPair(ctx.mnemonic.split(' '));
    const client = makeTonClient(ctx.network);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const contract: any = makeContract(kp.publicKey, version);
    const wallet = client.open(contract);
    const seqno = await wallet.getSeqno();

    // The liquid pool IS the tsTON jetton master.
    // We must send the burn op to the *user's* tsTON jetton wallet, not to the pool directly.
    const jettonMaster = client.open(JettonMaster.create(Address.parse(LIQUID_POOL)));
    const userJettonWallet = await jettonMaster.getWalletAddress(Address.parse(address));

    // TEP-74 burn op
    const burnBody = beginCell()
      .storeUint(0x595f07bc, 32)           // burn
      .storeUint(0, 64)                     // query_id
      .storeCoins(BigInt(amount))           // amount to burn
      .storeAddress(Address.parse(address)) // response_destination (receives leftover TON)
      .storeBit(false)                      // no custom payload
      .endCell();

    const transferCell = (wallet as unknown as {
      createTransfer(a: { seqno: number; secretKey: Buffer; messages: ReturnType<typeof internal>[] }): Cell;
    }).createTransfer({
      seqno, secretKey: kp.secretKey,
      messages: [internal({ to: userJettonWallet, value: toNano('0.5'), body: burnBody, bounce: true })],
    });
    const msgHash = transferCell.hash().toString('hex');
    await client.sendExternalMessage(contract, transferCell);

    res.json({ ok: true, tx_hash: msgHash, jetton_wallet: userJettonWallet.toString() });
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
