import {
  TonClient,
  WalletContractV1R1, WalletContractV1R2, WalletContractV1R3,
  WalletContractV2R1, WalletContractV2R2,
  WalletContractV3R1, WalletContractV3R2,
  WalletContractV4, WalletContractV5R1,
  internal, toNano, JettonMaster,
} from '@ton/ton';
import { Address, Cell, beginCell, comment as tonComment } from '@ton/core';
import { type WalletVersion, mnemonicToKeyPair } from './wallet';

function makeTonClient(network: string): TonClient {
  const baseUrl = network === 'testnet'
    ? (process.env.TONCENTER_TESTNET_URL || 'https://toncenter-testnet.mytonwallet.org')
    : (process.env.TONCENTER_MAINNET_URL || 'https://toncenter.mytonwallet.org');
  return new TonClient({
    endpoint: `${baseUrl}/api/v2/jsonRPC`,
    apiKey: process.env.TONCENTER_API_KEY,
  });
}

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
    case 'W5':
    default:         return WalletContractV5R1.create(opts);
  }
}

// Build and sign a transfer cell, then broadcast it.
// Returns the hex hash of the signed body cell — a stable identifier usable
// with TonCenter's /api/v3/messages?hash= endpoint.
async function buildAndSend(
  client: TonClient,
  contract: ReturnType<typeof makeContract>,
  kp: { publicKey: Buffer; secretKey: Buffer },
  messages: ReturnType<typeof internal>[],
): Promise<string> {
  const wallet = client.open(contract);
  const seqno = await (wallet as unknown as { getSeqno(): Promise<number> }).getSeqno();

  const transferCell = (wallet as unknown as {
    createTransfer(args: { seqno: number; secretKey: Buffer; messages: ReturnType<typeof internal>[] }): Cell;
  }).createTransfer({ seqno, secretKey: kp.secretKey, messages });

  const msgHash = transferCell.hash().toString('hex');
  await client.sendExternalMessage(contract, transferCell);
  return msgHash;
}

export interface SendTonParams {
  mnemonic: string[];
  version: WalletVersion;
  network: string;
  toAddress: string;
  amount: string;
  commentText?: string;
}

export interface SendJettonParams {
  mnemonic: string[];
  version: WalletVersion;
  network: string;
  toAddress: string;
  jettonMasterAddress: string;
  amount: string;
  commentText?: string;
}

export interface SendTonMessagesParams {
  mnemonic: string[];
  version: WalletVersion;
  network: string;
  // Each message amount is in nanotons (raw units), not TON.
  messages: Array<{ to: string; amount: string; payload?: string; bounce?: boolean }>;
}

export async function sendTon(params: SendTonParams): Promise<string> {
  const { mnemonic, version, network, toAddress, amount, commentText } = params;
  const kp = await mnemonicToKeyPair(mnemonic);
  const client = makeTonClient(network);
  const contract = makeContract(kp.publicKey, version);
  const msgBody = commentText ? tonComment(commentText) : undefined;

  return buildAndSend(client, contract, kp, [
    internal({
      to: Address.parse(toAddress),
      value: toNano(amount),
      body: msgBody,
      bounce: false,
    }),
  ]);
}

// Send multiple messages in one external transaction.
// Used by the TON swap flow where the DEX build API may return >1 message.
// Amounts must be in nanotons.
export async function sendTonMessages(params: SendTonMessagesParams): Promise<string> {
  const kp = await mnemonicToKeyPair(params.mnemonic);
  const client = makeTonClient(params.network);
  const contract = makeContract(kp.publicKey, params.version);

  const internalMessages = params.messages.map(msg => {
    let body: Cell | undefined;
    if (msg.payload) {
      try {
        body = Cell.fromBoc(Buffer.from(msg.payload, 'base64'))[0];
      } catch { /* invalid payload, skip */ }
    }
    return internal({
      to: Address.parse(msg.to),
      value: BigInt(msg.amount),   // already in nanotons
      body,
      bounce: msg.bounce ?? false,
    });
  });

  return buildAndSend(client, contract, kp, internalMessages);
}

export async function sendJetton(params: SendJettonParams): Promise<string> {
  const { mnemonic, version, network, toAddress, jettonMasterAddress, amount, commentText } = params;
  const kp = await mnemonicToKeyPair(mnemonic);
  const client = makeTonClient(network);
  const contract = makeContract(kp.publicKey, version);

  const jettonMaster = client.open(JettonMaster.create(Address.parse(jettonMasterAddress)));
  const senderAddr = contract.address;
  const jettonWalletAddress = await jettonMaster.getWalletAddress(senderAddr);

  const forwardPayload = commentText
    ? beginCell().storeUint(0, 32).storeStringTail(commentText).endCell()
    : null;

  const jettonTransferBody = beginCell()
    .storeUint(0xf8a7ea5, 32)           // op: jetton transfer
    .storeUint(0, 64)                    // query_id
    .storeCoins(BigInt(amount))          // amount in jetton units
    .storeAddress(Address.parse(toAddress))
    .storeAddress(senderAddr)            // response_destination
    .storeBit(false)                     // no custom payload
    .storeCoins(toNano('0.05'))          // forward_ton_amount
    .storeBit(forwardPayload !== null)
    .endCell();

  return buildAndSend(client, contract, kp, [
    internal({
      to: jettonWalletAddress,
      value: toNano('0.1'),
      body: jettonTransferBody,
      bounce: true,
    }),
  ]);
}

export async function estimateTonFee(_params: SendTonParams): Promise<{ fee: string; feeNano: string }> {
  // Conservative estimate: 0.005 TON for a simple transfer
  const feeNano = toNano('0.005');
  return { fee: '0.005', feeNano: feeNano.toString() };
}
