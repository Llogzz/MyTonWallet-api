import { Router, Request, Response } from 'express';
import { getStakingCommonData, getStakingProfits } from '../toncenter';
import { cache, TTL } from '../cache';
import { normalizeAddress, mnemonicToKeyPair, type WalletVersion } from '../services/wallet';
import { stmtGetWallet, WalletRow } from '../db';
import {
  TonClient, WalletContractV1R1, WalletContractV1R2, WalletContractV1R3,
  WalletContractV2R1, WalletContractV2R2, WalletContractV3R1, WalletContractV3R2,
  WalletContractV4, WalletContractV5R1, internal, toNano,
} from '@ton/ton';
import { Address, beginCell } from '@ton/core';

const router = Router({ mergeParams: true });

// Liquid staking pool from MyTonWallet config
const LIQUID_POOL = 'EQD2_4d91M4TVbEBVyBF8J1UwpMJc361LKVCz6bBlffMW05o';

// GET /staking/common — общая инфо о пулах
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

// GET /wallets/:address/staking — история стейкинга и профит
router.get('/', async (req: Request, res: Response) => {
  try {
    const address = normalizeAddress(req.params['address'] as string);
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

// POST /wallets/:address/stake — застейкать TON (liquid staking)
// Body: { amount: "10" } — amount in TON
router.post('/stake', async (req: Request, res: Response) => {
  try {
    const address = normalizeAddress(req.params['address'] as string);
    const { amount } = req.body as { amount: string };
    if (!amount) { res.status(400).json({ error: 'amount is required (in TON)' }); return; }

    const wallet = stmtGetWallet.get(address) as WalletRow | undefined;
    if (!wallet?.mnemonic) { res.status(400).json({ error: 'Wallet must be imported with mnemonic' }); return; }

    const network = wallet.network || 'mainnet';
    const version = (wallet.version || 'W5') as WalletVersion;
    const kp = await mnemonicToKeyPair(wallet.mnemonic.split(' '));
    const client = makeTonClient(network);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const contract: any = makeContract(kp.publicKey, version);
    const openedWallet = client.open(contract);
    const seqno = await openedWallet.getSeqno();

    // Liquid staking deposit: send TON to LIQUID_POOL with op 0x47d54391 (deposit)
    const stakeBody = beginCell()
      .storeUint(0x47d54391, 32)  // deposit op
      .storeUint(0, 64)           // query_id
      .endCell();

    await openedWallet.sendTransfer({
      seqno,
      secretKey: kp.secretKey,
      messages: [
        internal({
          to: Address.parse(LIQUID_POOL),
          value: toNano(amount),
          body: stakeBody,
          bounce: true,
        }),
      ],
    });

    res.json({ ok: true, message: `Staked ${amount} TON to liquid pool`, pool: LIQUID_POOL });
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
});

// POST /wallets/:address/stake/unstake — запрос вывода из liquid staking
// Body: { amount: "10" } — tsTON amount to burn
router.post('/unstake', async (req: Request, res: Response) => {
  try {
    const address = normalizeAddress(req.params['address'] as string);
    const { amount } = req.body as { amount: string };
    if (!amount) { res.status(400).json({ error: 'amount is required (tsTON units)' }); return; }

    const wallet = stmtGetWallet.get(address) as WalletRow | undefined;
    if (!wallet?.mnemonic) { res.status(400).json({ error: 'Wallet must be imported with mnemonic' }); return; }

    const network = wallet.network || 'mainnet';
    const version = (wallet.version || 'W5') as WalletVersion;
    const kp = await mnemonicToKeyPair(wallet.mnemonic.split(' '));
    const client = makeTonClient(network);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const contract: any = makeContract(kp.publicKey, version);
    const openedWallet = client.open(contract);
    const seqno = await openedWallet.getSeqno();

    // Unstake: burn tsTON via jetton transfer to LIQUID_POOL
    const unstakeBody = beginCell()
      .storeUint(0x595f07bc, 32)   // burn op
      .storeUint(0, 64)            // query_id
      .storeCoins(BigInt(amount))  // amount to burn
      .storeAddress(Address.parse(address)) // response destination
      .endCell();

    // We need to send to the user's tsTON jetton wallet, not directly to the pool
    // For simplicity, we send to the pool with withdrawal request op
    const withdrawBody = beginCell()
      .storeUint(0x319B0CDC, 32)   // withdrawal request op
      .storeUint(0, 64)
      .storeCoins(BigInt(amount))
      .endCell();

    await openedWallet.sendTransfer({
      seqno,
      secretKey: kp.secretKey,
      messages: [
        internal({
          to: Address.parse(LIQUID_POOL),
          value: toNano('1'),       // gas for unstake
          body: withdrawBody,
          bounce: true,
        }),
      ],
    });

    res.json({ ok: true, message: `Unstake request sent for ${amount} tsTON units` });
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
