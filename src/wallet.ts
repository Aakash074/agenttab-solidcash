// Wallet-signed (WizardConnect, e.g. Paytaca) open and refund for a SolidCash AgentTab.
// The dapp builds the transaction with placeholder unlockers; the wallet signs it and returns the raw hex.
// Adapted from the CashScript AgentTab web app (apps/web/src/lib/wallet.ts).
import { TransactionBuilder, type NetworkProvider, type Utxo } from '@solidcash/solidcash';
import { placeholderP2PKHUnlocker, placeholderSignature } from '@solidcash/solidcash/walletconnect';
import { binToHex, encodeTransaction } from '@bitauth/libauth';
import { buildOpen, DUST, type Network } from './agenttab.js';
import type { Contract } from '@solidcash/solidcash';

/** An HD wallet address as WizardConnect names it: [child name, index]. */
export interface WalletAddress { address: string; path: ['receive' | 'change', number] }
export type InputPath = [number, string, number];

/**
 * The WizardConnect (hdwalletv1) sign_transaction_request `transaction` field, in the wire format wallets decode
 * (Paytaca: decodeTransaction(hexToBin(request.transaction.transaction))): the unsigned tx as HEX, plain hex for
 * bytes in sourceOutputs, "<bigint: Nn>" for bigints. The result is plain JSON, so it survives the relay.
 */
export function wizardConnectSignRequest(builder: TransactionBuilder, opts: { broadcast?: boolean; userPrompt?: string } = {}) {
  const wc = builder.generateWcTransactionObject({ broadcast: false, ...opts });
  const json = JSON.stringify({ ...wc, transaction: binToHex(encodeTransaction(wc.transaction as never)) }, (_k, v) =>
    typeof v === 'bigint' ? `<bigint: ${v}n>` : v instanceof Uint8Array ? binToHex(v) : v);
  return JSON.parse(json) as { transaction: string; sourceOutputs: Record<string, unknown>[]; broadcast?: boolean; userPrompt?: string };
}

/** Gathers the plain-BCH utxos on the given wallet addresses, remembering which HD path owns each. */
export async function gatherWalletUtxos(provider: NetworkProvider, addresses: WalletAddress[]) {
  const lists = await Promise.all(addresses.map(async (a) => (await provider.getUtxos(a.address)).filter((u) => !u.token).map((u) => ({ u, a }))));
  return lists.flat();
}

/** Open a tab from a WizardConnect wallet: every input gets a placeholder unlocker and its HD path. */
export function buildWalletOpen(opts: {
  provider: NetworkProvider;
  contract: Contract;
  funding: { u: Utxo; a: WalletAddress }[];
  budget: bigint;
  changeAddress: string;
}): { builder: TransactionBuilder; inputPaths: InputPath[] } {
  const { provider, contract, funding, budget, changeAddress } = opts;
  const byOutpoint = new Map(funding.map(({ u, a }) => [`${u.txid}:${u.vout}`, a]));
  const builder = buildOpen({
    provider, contract, budget, changeAddress,
    fundingUtxos: funding.map((f) => f.u),
    unlockerFor: (u) => placeholderP2PKHUnlocker(byOutpoint.get(`${u.txid}:${u.vout}`)!.address),
  });
  const inputPaths = builder.inputs.map((u, i) => [i, ...byOutpoint.get(`${u.txid}:${u.vout}`)!.path] as InputPath);
  return { builder, inputPaths };
}

/** Owner refund after the timeout, signed by the wallet's receive/0 key (the tab's owner key). */
export function buildWalletRefund(opts: {
  provider: NetworkProvider;
  contract: Contract;
  tabUtxo: Utxo;
  timeout: bigint;
  to: string;
}): { builder: TransactionBuilder; inputPaths: InputPath[] } {
  const { provider, contract, tabUtxo, timeout, to } = opts;
  const build = (fee: bigint) => new TransactionBuilder({ provider })
    .addInput(tabUtxo, contract.unlock.refund(placeholderSignature()))
    .addOutput({ to, amount: tabUtxo.satoshis - fee })
    .setLocktime(Number(timeout));
  const size = build(0n).getTransactionSize();
  const fee = size + 2n;
  if (tabUtxo.satoshis - fee < DUST) throw new Error('tab too small to refund');
  return { builder: build(fee), inputPaths: [[0, 'receive', 0]] };
}

export const explorerTx = (net: Network, txid: string) =>
  `https://explorer.selene.cash/tx/${txid}?network=${net === 'mainnet' ? 'mainnet' : 'chipnet'}`;
