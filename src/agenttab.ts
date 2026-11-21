// AgentTab SDK on SolidCash: open a tab, sign/verify cumulative vouchers, settle, cancel, refund.
// Ported from the CashScript SDK in github.com/Aakash074/agenttab (packages/covenant/src/index.ts).
import {
  Contract,
  SignatureTemplate,
  TransactionBuilder,
  type NetworkProvider,
  type Unlocker,
  type Utxo,
} from '@solidcash/solidcash';
import {
  bigIntToBinUint64LE,
  binToHex,
  encodeCashAddress,
  hash160,
  hexToBin,
  numberToBinUint32LE,
  secp256k1,
  sha256,
} from '@bitauth/libauth';
import artifact from '../artifacts/solidcash/contracts/AgentTab.scash/AgentTab.artifact.js';

export { artifact };

/** Network dust limit for P2PKH outputs (the covenant enforces it on both settle outputs). */
export const DUST = 546n;
/** "AGENTTAB" domain tag prefixed to every voucher message. */
export const VOUCHER_DOMAIN = hexToBin('4147454e54544142');
/** Covenant cap on the miner fee a cancel may take. */
export const MAX_CANCEL_FEE = 1000n;
export const FEE_RATE = 1n;

export type Network = 'mainnet' | 'chipnet' | 'mocknet';

export interface Outpoint { txid: string; vout: number }

export interface TabParams {
  ownerPub: Uint8Array;
  agentPub: Uint8Array;
  providerPub: Uint8Array;
  /** Absolute nLockTime: block height (< 500M) or unix seconds (>= 500M). */
  timeout: bigint;
}

export interface Voucher {
  outpoint: Outpoint;
  amount: bigint; // cumulative satoshis owed
  sig: string; // hex schnorr datasig by the agent
}

export function pubFromPriv(priv: Uint8Array): Uint8Array {
  const pub = secp256k1.derivePublicKeyCompressed(priv);
  if (typeof pub === 'string') throw new Error(pub);
  return pub;
}

export function p2pkhAddress(pub: Uint8Array, network: Network = 'chipnet'): string {
  const prefix = network === 'mainnet' ? 'bitcoincash' : 'bchtest';
  return encodeCashAddress({ prefix, type: 'p2pkh', payload: hash160(pub) }).address;
}

export function tabContract(p: TabParams, provider: NetworkProvider): Contract {
  return new Contract(artifact as any, [p.ownerPub, p.agentPub, p.providerPub, p.timeout] as any, {
    provider,
    addressType: 'p2sh32',
  });
}

/** Exactly the bytes the covenant feeds to OP_CHECKDATASIG (Voucher.message in AgentTab.scash). */
export function voucherMessage(outpoint: Outpoint, amount: bigint): Uint8Array {
  if (amount < 0n) throw new Error('negative amount');
  // OP_OUTPOINTTXHASH yields the hash in internal (little-endian) byte order.
  const txHashLE = hexToBin(outpoint.txid).reverse();
  return Uint8Array.from([
    ...VOUCHER_DOMAIN,
    ...txHashLE,
    ...numberToBinUint32LE(outpoint.vout),
    ...bigIntToBinUint64LE(amount),
  ]);
}

export function signVoucher(agentPriv: Uint8Array, outpoint: Outpoint, amount: bigint): Voucher {
  const sig = secp256k1.signMessageHashSchnorr(agentPriv, sha256.hash(voucherMessage(outpoint, amount)));
  if (typeof sig === 'string') throw new Error(sig);
  return { outpoint: { txid: outpoint.txid, vout: outpoint.vout }, amount, sig: binToHex(sig) };
}

export function verifyVoucher(agentPub: Uint8Array, v: Voucher): boolean {
  try {
    return secp256k1.verifySignatureSchnorr(hexToBin(v.sig), agentPub, sha256.hash(voucherMessage(v.outpoint, v.amount)));
  } catch {
    return false;
  }
}

/** Largest voucher the covenant can ever settle for a given budget. */
export const maxSpendable = (budget: bigint) => budget - DUST;

/** Build twice: once with a zero fee to measure size, then with the real fee. */
function withFee(build: (fee: bigint) => TransactionBuilder, rate = FEE_RATE): TransactionBuilder {
  const size = build(0n).getTransactionSize();
  return build((size + 2n) * rate);
}

/** Funds a new tab from plain P2PKH utxos. Pass `payerPriv` to sign locally, or `unlockerFor`
 *  (placeholderP2PKHUnlocker) to have a wallet sign it over WalletConnect/WizardConnect. */
export function buildOpen(opts: {
  provider: NetworkProvider;
  contract: Contract;
  payerPriv?: Uint8Array;
  unlockerFor?: (u: Utxo) => Unlocker;
  fundingUtxos: Utxo[];
  budget: bigint;
  changeAddress: string;
}): TransactionBuilder {
  const { provider, contract, fundingUtxos, budget, changeAddress } = opts;
  if (budget < 2n * DUST) throw new Error(`budget must be >= ${2n * DUST} sats`);
  const spendable = fundingUtxos.filter((u) => !u.token);
  const total = spendable.reduce((s, u) => s + u.satoshis, 0n);
  const unlockerFor = opts.unlockerFor
    ?? (() => { const u = new SignatureTemplate(opts.payerPriv!).unlockP2PKH(); return () => u; })();
  return withFee((fee) => {
    const change = total - budget - fee;
    if (change < 0n) throw new Error(`insufficient funds: have ${total}, need ${budget + fee}`);
    const b = new TransactionBuilder({ provider });
    for (const u of spendable) b.addInput(u, unlockerFor(u));
    b.addOutput({ to: contract.address, amount: budget });
    if (change >= DUST) b.addOutput({ to: changeAddress, amount: change });
    return b;
  });
}

/** Provider settles the tab with the agent's highest voucher. The fee comes out of the provider's share. */
export function buildSettle(opts: {
  provider: NetworkProvider;
  contract: Contract;
  tabUtxo: Utxo;
  providerPriv: Uint8Array;
  ownerPub: Uint8Array;
  voucher: Voucher;
  network?: Network;
}): TransactionBuilder {
  const { provider, contract, tabUtxo, providerPriv, ownerPub, voucher, network = 'chipnet' } = opts;
  if (tabUtxo.txid !== voucher.outpoint.txid || tabUtxo.vout !== voucher.outpoint.vout) {
    throw new Error('voucher is for a different tab outpoint');
  }
  const providerPub = pubFromPriv(providerPriv);
  const remainder = tabUtxo.satoshis - voucher.amount;
  return withFee((fee) =>
    new TransactionBuilder({ provider })
      .addInput(tabUtxo, contract.unlock.settle(
        new SignatureTemplate(providerPriv), hexToBin(voucher.sig), bigIntToBinUint64LE(voucher.amount),
      ))
      .addOutput({ to: p2pkhAddress(providerPub, network), amount: voucher.amount - fee })
      .addOutput({ to: p2pkhAddress(ownerPub, network), amount: remainder }),
  );
}

/** Provider waives the tab: the budget minus the fee (capped at 1000 sats by the covenant) goes back to the owner. */
export function buildCancel(opts: {
  provider: NetworkProvider;
  contract: Contract;
  tabUtxo: Utxo;
  providerPriv: Uint8Array;
  ownerPub: Uint8Array;
  network?: Network;
}): TransactionBuilder {
  const { provider, contract, tabUtxo, providerPriv, ownerPub, network = 'chipnet' } = opts;
  return withFee((fee) =>
    new TransactionBuilder({ provider })
      .addInput(tabUtxo, contract.unlock.cancel(new SignatureTemplate(providerPriv)))
      .addOutput({ to: p2pkhAddress(ownerPub, network), amount: tabUtxo.satoshis - fee }),
  );
}

/** Owner reclaims the whole tab after the timeout. */
export function buildRefund(opts: {
  provider: NetworkProvider;
  contract: Contract;
  tabUtxo: Utxo;
  ownerPriv: Uint8Array;
  timeout: bigint;
  to?: string;
  network?: Network;
}): TransactionBuilder {
  const { provider, contract, tabUtxo, ownerPriv, timeout, network = 'chipnet' } = opts;
  const to = opts.to ?? p2pkhAddress(pubFromPriv(ownerPriv), network);
  return withFee((fee) =>
    new TransactionBuilder({ provider })
      .addInput(tabUtxo, contract.unlock.refund(new SignatureTemplate(ownerPriv)))
      .addOutput({ to, amount: tabUtxo.satoshis - fee })
      .setLocktime(Number(timeout)),
  );
}

export { binToHex, hexToBin };
