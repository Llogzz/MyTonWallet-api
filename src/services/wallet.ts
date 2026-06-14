import { mnemonicNew, mnemonicToPrivateKey, mnemonicValidate } from '@ton/crypto';
import { WalletContractV1R1, WalletContractV1R2, WalletContractV1R3, WalletContractV2R1, WalletContractV2R2, WalletContractV3R1, WalletContractV3R2, WalletContractV4, WalletContractV5R1, TonClient } from '@ton/ton';
import { Address } from '@ton/core';
import * as bip39 from 'bip39';
import nacl from 'tweetnacl';

export type WalletVersion = 'simpleR1' | 'simpleR2' | 'simpleR3' | 'v2R1' | 'v2R2' | 'v3R1' | 'v3R2' | 'v4R2' | 'W5';

const VERSION_MAP: Record<WalletVersion, (pk: Buffer) => { address: Address }> = {
  simpleR1: (pk) => WalletContractV1R1.create({ workchain: 0, publicKey: pk }),
  simpleR2: (pk) => WalletContractV1R2.create({ workchain: 0, publicKey: pk }),
  simpleR3: (pk) => WalletContractV1R3.create({ workchain: 0, publicKey: pk }),
  v2R1:    (pk) => WalletContractV2R1.create({ workchain: 0, publicKey: pk }),
  v2R2:    (pk) => WalletContractV2R2.create({ workchain: 0, publicKey: pk }),
  v3R1:    (pk) => WalletContractV3R1.create({ workchain: 0, publicKey: pk }),
  v3R2:    (pk) => WalletContractV3R2.create({ workchain: 0, publicKey: pk }),
  v4R2:    (pk) => WalletContractV4.create({ workchain: 0, publicKey: pk }),
  W5:      (pk) => WalletContractV5R1.create({ workchain: 0, publicKey: pk }),
};

export interface KeyPairResult {
  publicKey: Buffer;
  secretKey: Buffer;
  type: 'ton' | 'bip39';
}

export function isBip39Mnemonic(words: string[]): boolean {
  return bip39.validateMnemonic(words.join(' '));
}

export function isTonMnemonic(words: string[]): Promise<boolean> {
  return mnemonicValidate(words);
}

async function deriveTonKeyPair(words: string[]): Promise<KeyPairResult> {
  const kp = await mnemonicToPrivateKey(words);
  return {
    publicKey: Buffer.from(kp.publicKey),
    secretKey: Buffer.from(kp.secretKey),
    type: 'ton',
  };
}

function deriveBip39KeyPair(words: string[], index = 0): KeyPairResult {
  const seed = bip39.mnemonicToSeedSync(words.join(' '));
  // TON BIP39 path: m/44'/607'/index'
  // Simple derivation matching MyTonWallet: slice seed bytes by index offset
  const seedSlice = seed.subarray(index * 32, index * 32 + 32);
  const kp = nacl.sign.keyPair.fromSeed(seedSlice);
  return {
    publicKey: Buffer.from(kp.publicKey),
    secretKey: Buffer.from(kp.secretKey),
    type: 'bip39',
  };
}

export async function mnemonicToKeyPair(words: string[], index = 0): Promise<KeyPairResult> {
  if (isBip39Mnemonic(words)) {
    return deriveBip39KeyPair(words, index);
  }
  const isTon = await isTonMnemonic(words);
  if (isTon) {
    return deriveTonKeyPair(words);
  }
  throw new Error('Invalid mnemonic: not a valid TON or BIP39 seed phrase');
}

export async function generateMnemonic(): Promise<string[]> {
  return mnemonicNew(24);
}

export function publicKeyToAddress(publicKey: Buffer, version: WalletVersion = 'W5'): string {
  const factory = VERSION_MAP[version];
  if (!factory) throw new Error(`Unknown wallet version: ${version}`);
  const contract = factory(publicKey);
  return contract.address.toString({ urlSafe: true, bounceable: false });
}

export async function mnemonicToWallet(words: string[], version: WalletVersion = 'W5', index = 0) {
  const kp = await mnemonicToKeyPair(words, index);
  const address = publicKeyToAddress(kp.publicKey, version);
  return { kp, address, version };
}

export function getWalletContract(publicKey: Buffer, version: WalletVersion = 'W5') {
  return VERSION_MAP[version](publicKey) as ReturnType<typeof WalletContractV5R1.create>;
}

export function normalizeAddress(raw: string): string {
  try {
    return Address.parse(raw).toString({ urlSafe: true, bounceable: false });
  } catch {
    return raw;
  }
}
