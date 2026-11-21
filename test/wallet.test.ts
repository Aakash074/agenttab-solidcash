// The WizardConnect path (what Paytaca signs on mainnet), exercised end to end on the mock:
// build the open with placeholder unlockers -> produce the sign request -> "wallet" signs each input at its
// HD path -> broadcast -> settle. Then the wallet-signed refund after the timeout.
import { describe, expect, it } from 'vitest';
import { randomUtxo } from '@solidcash/solidcash';
import { MockNetworkProvider, MOCK_PRODUCTION_LIMITS } from '@solidcash/solidcash/network/mock';
import {
  decodeTransaction, encodeTransaction, generatePrivateKey, hexToBin, binToHex, generateSigningSerializationBch,
  hash256, secp256k1, SigningSerializationFlag,
} from '@bitauth/libauth';
import { buildSettle, p2pkhAddress, pubFromPriv, signVoucher, tabContract } from '../src/agenttab.js';
import { buildWalletOpen, buildWalletRefund, gatherWalletUtxos, wizardConnectSignRequest, type WalletAddress } from '../src/wallet.js';

const key = () => { const priv = generatePrivateKey(); return { priv, pub: pubFromPriv(priv) }; };

/** A stand-in for Paytaca: signs every input of a WizardConnect request with the key at its HD path. */
function fakeWalletSign(req: ReturnType<typeof wizardConnectSignRequest>, keys: Map<string, Uint8Array>, inputPaths: [number, string, number][]) {
  const tx = decodeTransaction(hexToBin(req.transaction));
  if (typeof tx === 'string') throw new Error(tx);
  const sourceOutputs = req.sourceOutputs.map((o: any) => ({
    lockingBytecode: hexToBin(o.lockingBytecode),
    valueSatoshis: BigInt(String(o.valueSatoshis).replace(/<bigint: (\d+)n>/, '$1')),
  }));
  const flags = Uint8Array.of(SigningSerializationFlag.allOutputs | SigningSerializationFlag.utxos | SigningSerializationFlag.forkId);
  for (const [i, child, idx] of inputPaths) {
    const priv = keys.get(`${child}/${idx}`)!;
    const pub = pubFromPriv(priv);
    const ser = generateSigningSerializationBch(
      { inputIndex: i, sourceOutputs, transaction: tx } as never,
      { coveredBytecode: sourceOutputs[i].lockingBytecode, signingSerializationType: flags },
    );
    const sig = secp256k1.signMessageHashSchnorr(priv, hash256(ser)) as Uint8Array;
    const sigAll = Uint8Array.from([...sig, flags[0]]);
    tx.inputs[i].unlockingBytecode = Uint8Array.from([sigAll.length, ...sigAll, pub.length, ...pub]);
  }
  return binToHex(encodeTransaction(tx));
}

describe('WizardConnect wallet path', () => {
  it('a wallet-signed open (two HD addresses) can then be settled; a wallet-signed refund works after the timeout', async () => {
    const provider = new MockNetworkProvider({ consensusLimits: MOCK_PRODUCTION_LIMITS, policy: { enforceDust: true } });
    const recv0 = key(), change0 = key(), agent = key(), svc = key();
    const addrs: WalletAddress[] = [
      { address: p2pkhAddress(recv0.pub, 'mainnet'), path: ['receive', 0] },
      { address: p2pkhAddress(change0.pub, 'mainnet'), path: ['change', 0] },
    ];
    // Mock is address-format agnostic; fund both HD addresses.
    await provider.addUtxo(addrs[0].address, randomUtxo({ satoshis: 15_000n }));
    await provider.addUtxo(addrs[1].address, randomUtxo({ satoshis: 15_000n }));
    const timeout = BigInt(provider.getBlockTime() + 3600);
    const contract = tabContract({ ownerPub: recv0.pub, agentPub: agent.pub, providerPub: svc.pub, timeout }, provider);

    const funding = await gatherWalletUtxos(provider, addrs);
    expect(funding).toHaveLength(2);
    const { builder, inputPaths } = buildWalletOpen({ provider, contract, funding, budget: 24_000n, changeAddress: addrs[0].address });
    const req = wizardConnectSignRequest(builder, { userPrompt: 'Open an AgentTab with 24000 sats' });
    expect(typeof req.transaction).toBe('string');
    expect(JSON.stringify(req)).not.toMatch(/"\d+n"|Uint8Array/);
    const keys = new Map([['receive/0', recv0.priv], ['change/0', change0.priv]]);
    const openTxid = await provider.sendRawTransaction(fakeWalletSign(req, keys, inputPaths));
    const [tab] = await contract.getUtxos();
    expect(tab.txid).toBe(openTxid);
    expect(tab.satoshis).toBe(24_000n);

    // The provider settles the agent's 6,000-sat voucher; exactly 18,000 goes back to the owner.
    await buildSettle({ provider, contract, tabUtxo: tab, providerPriv: svc.priv, ownerPub: recv0.pub, voucher: signVoucher(agent.priv, tab, 6_000n), network: 'mainnet' }).send();
    const back = await provider.getUtxos(addrs[0].address);
    expect(back.some((u) => u.satoshis === 18_000n)).toBe(true);

    // A second tab, refunded by the wallet after the timeout.
    const funding2 = await gatherWalletUtxos(provider, addrs);
    const open2 = buildWalletOpen({ provider, contract, funding: funding2, budget: 2_000n, changeAddress: addrs[0].address });
    await provider.sendRawTransaction(fakeWalletSign(wizardConnectSignRequest(open2.builder), keys, open2.inputPaths));
    const [tab2] = await contract.getUtxos();
    provider.increaseTime(7200);
    const r = buildWalletRefund({ provider, contract, tabUtxo: tab2, timeout, to: addrs[0].address });
    expect(r.inputPaths).toEqual([[0, 'receive', 0]]);
    // The refund request carries the covenant's ABI so the wallet can put its owner signature in place of the
    // placeholder, and nLockTime is the tab timeout.
    const req2 = wizardConnectSignRequest(r.builder, { userPrompt: 'Refund your AgentTab' });
    const src = req2.sourceOutputs[0] as any;
    expect(src.contract.abiFunction.name).toBe('refund');
    expect(src.contract.redeemScript).toMatch(/^[0-9a-f]+$/);
    const rtx = decodeTransaction(hexToBin(req2.transaction));
    if (typeof rtx === 'string') throw new Error(rtx);
    expect(BigInt(rtx.locktime)).toBe(timeout);
  });
});
