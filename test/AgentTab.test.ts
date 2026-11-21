// SolidHat tests for AgentTab.scash: the happy path plus the seven attacks the CashScript original
// was tested against (replay, overclaim, forged amount, remainder elsewhere, early refund, agent
// withdrawal, provider cancel into its own wallet), and a few SolidCash-specific ones.
import { describe, expect, it } from 'vitest';
import { SignatureTemplate, TransactionBuilder, randomUtxo, type Utxo } from '@solidcash/solidcash';
import { MockNetworkProvider, MOCK_PRODUCTION_LIMITS } from '@solidcash/solidcash/network/mock';
import { bigIntToBinUint64LE, generatePrivateKey, hexToBin } from '@bitauth/libauth';
import {
  artifact,
  buildCancel,
  buildOpen,
  buildRefund,
  buildSettle,
  p2pkhAddress,
  pubFromPriv,
  signVoucher,
  tabContract,
  verifyVoucher,
  type Voucher,
} from '../src/agenttab.js';

const key = () => {
  const priv = generatePrivateKey();
  return { priv, pub: pubFromPriv(priv) };
};

const TIMEOUT = 1_900_000_000n; // unix seconds
const BUDGET = 100_000n;

/** A mock run under the real BCH limits (10,000-byte inputs, dust rule), not the relaxed defaults. */
const productionMock = (enforceDust = true) =>
  new MockNetworkProvider({ consensusLimits: MOCK_PRODUCTION_LIMITS, policy: { enforceDust } });

async function setup(opts: { enforceDust?: boolean } = {}) {
  const provider = productionMock(opts.enforceDust ?? true);
  const owner = key();
  const agent = key();
  const svc = key();
  const contract = tabContract({ ownerPub: owner.pub, agentPub: agent.pub, providerPub: svc.pub, timeout: TIMEOUT }, provider);
  const ownerAddr = p2pkhAddress(owner.pub);
  await provider.addUtxo(ownerAddr, randomUtxo({ satoshis: 200_000n }));
  const funding = await provider.getUtxos(ownerAddr);
  const open = await buildOpen({
    provider, contract, payerPriv: owner.priv, fundingUtxos: funding, budget: BUDGET, changeAddress: ownerAddr,
  }).send();
  const [tab] = await contract.getUtxos();
  expect(tab.txid).toBe(open.txid);
  expect(tab.satoshis).toBe(BUDGET);
  return { provider, owner, agent, svc, contract, tab };
}

type Ctx = Awaited<ReturnType<typeof setup>>;

/** Hand-rolled settle so a test can tamper with any field. */
function rawSettle(c: Ctx, o: {
  voucher: Voucher;
  claimAmount?: bigint;
  providerOut?: { to: string; amount: bigint };
  ownerOut?: { to: string; amount: bigint };
  signer?: Uint8Array;
  inputs?: Utxo[];
  extraOutputs?: { to: string; amount: bigint }[];
}) {
  const claim = o.claimAmount ?? o.voucher.amount;
  const unlocker = c.contract.unlock.settle(
    new SignatureTemplate(o.signer ?? c.svc.priv), hexToBin(o.voucher.sig), bigIntToBinUint64LE(claim),
  );
  const b = new TransactionBuilder({ provider: c.provider });
  for (const u of o.inputs ?? [c.tab]) b.addInput(u, unlocker);
  b.addOutput(o.providerOut ?? { to: p2pkhAddress(c.svc.pub), amount: claim - 1200n });
  b.addOutput(o.ownerOut ?? { to: p2pkhAddress(c.owner.pub), amount: c.tab.satoshis - claim });
  for (const x of o.extraOutputs ?? []) b.addOutput(x);
  return b;
}

const send = (b: TransactionBuilder) => b.send();
/** The transaction is refused (by the covenant, by consensus or by relay policy). */
const rejects = (b: TransactionBuilder | (() => TransactionBuilder)) =>
  expect((async () => (typeof b === 'function' ? b() : b).send())()).rejects.toThrow();
/** The covenant itself refuses the spend, at the named require / custom error of AgentTab.scash.
 *  builder.debug() evaluates the script in the BCH VM; a FailedRequireError names the failing statement. */
const covenantRejects = async (b: TransactionBuilder, reason: RegExp) => {
  expect(() => b.debug()).toThrow(reason);
  await expect(b.send()).rejects.toThrow();
};

async function addTabUtxo(c: Ctx, satoshis: bigint): Promise<Utxo> {
  await c.provider.addUtxo(c.contract.address, randomUtxo({ satoshis }));
  const all = await c.contract.getUtxos();
  return all.find((u) => u.txid !== c.tab.txid)!;
}

describe('AgentTab.scash: artifact', () => {
  it('compiles to a small stateless P2SH32 script with the three entry points', () => {
    expect(artifact.abi.map((f: { name: string }) => f.name)).toEqual(['settle', 'cancel', 'refund']);
    expect(artifact.constructorInputs.map((i: { name: string }) => i.name)).toEqual(['owner', 'agent', 'provider', 'timeout']);
    expect((artifact as any).stateLayout).toBeUndefined(); // stateless: a tab is one plain utxo
    // Every entry point is guarded by a signature over a constructor key (never msg.sender).
    for (const f of artifact.abi as any[]) expect(f.signatureGuard.key.kind).toBe('constructorArg');
    expect((artifact as any).errors.map((e: { name: string }) => e.name)).toContain('Overclaim');
  });
});

describe('AgentTab.scash: lifecycle', () => {
  it('happy path: 3 cumulative vouchers, settle the highest, exact remainder back to the owner', async () => {
    const c = await setup();
    const vouchers = [1000n, 2000n, 3000n].map((a) => signVoucher(c.agent.priv, c.tab, a));
    for (const v of vouchers) expect(verifyVoucher(c.agent.pub, v)).toBe(true);
    await buildSettle({
      provider: c.provider, contract: c.contract, tabUtxo: c.tab, providerPriv: c.svc.priv, ownerPub: c.owner.pub, voucher: vouchers[2],
    }).send();
    expect(await c.contract.getUtxos()).toHaveLength(0);
    const back = await c.provider.getUtxos(p2pkhAddress(c.owner.pub));
    expect(back.some((u) => u.satoshis === BUDGET - 3000n)).toBe(true);
    const paid = await c.provider.getUtxos(p2pkhAddress(c.svc.pub));
    expect(paid).toHaveLength(1);
    expect(paid[0].satoshis > 2000n && paid[0].satoshis < 3000n).toBe(true);
  });

  it('owner refunds everything after the timeout', async () => {
    const c = await setup();
    // Before the timeout the refund tx is not even final.
    await rejects(() => buildRefund({ provider: c.provider, contract: c.contract, tabUtxo: c.tab, ownerPriv: c.owner.priv, timeout: TIMEOUT }));
    c.provider.increaseTime(TIMEOUT - BigInt(c.provider.getBlockTime()) + 1n);
    await buildRefund({ provider: c.provider, contract: c.contract, tabUtxo: c.tab, ownerPriv: c.owner.priv, timeout: TIMEOUT }).send();
    expect(await c.contract.getUtxos()).toHaveLength(0);
  });

  it('cancel: provider waives the tab, owner gets everything back minus the fee', async () => {
    const c = await setup();
    const tx = await buildCancel({ provider: c.provider, contract: c.contract, tabUtxo: c.tab, providerPriv: c.svc.priv, ownerPub: c.owner.pub }).send();
    const back = (await c.provider.getUtxos(p2pkhAddress(c.owner.pub))).find((u) => u.txid === tx.txid)!;
    expect(back.satoshis >= BUDGET - 1000n && back.satoshis < BUDGET).toBe(true);
  });
});

describe('AgentTab.scash: the seven attacks', () => {
  it('1. replay: a voucher is bound to its outpoint and cannot settle a second utxo at the same address', async () => {
    const c = await setup();
    const v = signVoucher(c.agent.priv, c.tab, 5000n);
    const second = await addTabUtxo(c, BUDGET);
    await covenantRejects(rawSettle({ ...c, tab: second }, { voucher: v }), /BadVoucher|checkDataSig|NULLFAIL|signature/i);
    await send(rawSettle(c, { voucher: v })); // the honest settle of the first one still works
  });

  it('1b. replay: two tab utxos cannot be bundled into one settle', async () => {
    const c = await setup();
    const second = await addTabUtxo(c, BUDGET);
    await covenantRejects(rawSettle(c, { voucher: signVoucher(c.agent.priv, c.tab, 5000n), inputs: [c.tab, second] }), /WrongShape/);
  });

  it('2. overclaim: provider output above the signed amount is rejected', async () => {
    const c = await setup();
    const b = rawSettle(c, {
      voucher: signVoucher(c.agent.priv, c.tab, 5000n),
      providerOut: { to: p2pkhAddress(c.svc.pub), amount: 6000n },
      ownerOut: { to: p2pkhAddress(c.owner.pub), amount: BUDGET - 6500n },
    });
    await covenantRejects(b, /Overclaim/);
  });

  it('3. forged amount: provider bumps the amount argument beyond what the voucher signs', async () => {
    const c = await setup();
    await covenantRejects(rawSettle(c, { voucher: signVoucher(c.agent.priv, c.tab, 5000n), claimAmount: 50_000n }), /BadVoucher|checkDataSig|NULLFAIL|signature/i);
  });

  it('3b. forged voucher: signed by the provider or the owner key instead of the agent', async () => {
    const c = await setup();
    const forged = signVoucher(c.svc.priv, c.tab, 5000n);
    expect(verifyVoucher(c.agent.pub, forged)).toBe(false);
    await covenantRejects(rawSettle(c, { voucher: forged }), /BadVoucher|checkDataSig|NULLFAIL|signature/i);
    await covenantRejects(rawSettle(c, { voucher: signVoucher(c.owner.priv, c.tab, 5000n) }), /BadVoucher|checkDataSig|NULLFAIL|signature/i);
  });

  it('4. remainder elsewhere: owner output to another address, or short by one sat, is rejected', async () => {
    const c = await setup();
    const v = signVoucher(c.agent.priv, c.tab, 5000n);
    await covenantRejects(rawSettle(c, { voucher: v, ownerOut: { to: p2pkhAddress(c.svc.pub), amount: BUDGET - 5000n } }), /WrongPayee/);
    await covenantRejects(rawSettle(c, { voucher: v, ownerOut: { to: p2pkhAddress(c.owner.pub), amount: BUDGET - 5000n - 1n } }), /OwnerShortchanged/);
    await covenantRejects(rawSettle(c, { voucher: v, providerOut: { to: p2pkhAddress(key().pub), amount: 3500n } }), /WrongPayee/);
    await covenantRejects(rawSettle(c, {
      voucher: v,
      extraOutputs: [{ to: p2pkhAddress(c.svc.pub), amount: 1000n }],
      ownerOut: { to: p2pkhAddress(c.owner.pub), amount: BUDGET - 5000n },
    }), /WrongShape/);
  });

  it('5. early refund: nLockTime before the timeout is rejected', async () => {
    const c = await setup();
    // Chain time is past the timeout, so a tx with nLockTime = timeout - 1 IS final: only the covenant stops it.
    c.provider.increaseTime(TIMEOUT - BigInt(c.provider.getBlockTime()) + 10n);
    await covenantRejects(
      buildRefund({ provider: c.provider, contract: c.contract, tabUtxo: c.tab, ownerPriv: c.owner.priv, timeout: TIMEOUT - 1n }),
      /TooEarly/,
    );
  });

  it('6. agent withdrawal: the agent key can neither refund, cancel nor settle', async () => {
    const c = await setup();
    c.provider.increaseTime(TIMEOUT - BigInt(c.provider.getBlockTime()) + 10n); // even after the timeout
    await covenantRejects(buildRefund({
      provider: c.provider, contract: c.contract, tabUtxo: c.tab, ownerPriv: c.agent.priv, timeout: TIMEOUT, to: p2pkhAddress(c.agent.pub),
    }), /NotOwner|checkSig|NULLFAIL|signature/i);
    await covenantRejects(buildCancel({ provider: c.provider, contract: c.contract, tabUtxo: c.tab, providerPriv: c.agent.priv, ownerPub: c.owner.pub }), /NotProvider|checkSig|NULLFAIL|signature/i);
    await covenantRejects(rawSettle(c, { voucher: signVoucher(c.agent.priv, c.tab, 5000n), signer: c.agent.priv }), /NotProvider|checkSig|NULLFAIL|signature/i);
  });

  it('7. provider cancel into its own wallet, an excessive fee, a split, or a foreign key is rejected', async () => {
    const c = await setup();
    const cancel = (out: { to: string; amount: bigint }[], signer = c.svc.priv) => {
      const b = new TransactionBuilder({ provider: c.provider }).addInput(c.tab, c.contract.unlock.cancel(new SignatureTemplate(signer)));
      for (const o of out) b.addOutput(o);
      return b;
    };
    await covenantRejects(cancel([{ to: p2pkhAddress(c.svc.pub), amount: BUDGET - 900n }]), /WrongPayee/);              // own wallet
    await covenantRejects(cancel([{ to: p2pkhAddress(c.owner.pub), amount: BUDGET - 1_500n }]), /miner fee above 1000 sats/);          // fee above cap
    await covenantRejects(cancel([{ to: p2pkhAddress(c.owner.pub), amount: BUDGET - 900n }], c.owner.priv), /NotProvider|checkSig|NULLFAIL|signature/i); // owner key
    await covenantRejects(cancel([{ to: p2pkhAddress(c.owner.pub), amount: BUDGET - 5_000n }, { to: p2pkhAddress(c.svc.pub), amount: 4_000n }]), /WrongShape/); // split
    await send(cancel([{ to: p2pkhAddress(c.owner.pub), amount: BUDGET - 900n }]));                                     // honest
  });
});

describe('AgentTab.scash: more edges', () => {
  it('provider cannot use the refund path, even after the timeout', async () => {
    const c = await setup();
    c.provider.increaseTime(TIMEOUT - BigInt(c.provider.getBlockTime()) + 10n);
    await covenantRejects(buildRefund({ provider: c.provider, contract: c.contract, tabUtxo: c.tab, ownerPriv: c.svc.priv, timeout: TIMEOUT }), /NotOwner|checkSig|NULLFAIL|signature/i);
  });

  it('a third party without the provider key cannot settle', async () => {
    const c = await setup();
    await covenantRejects(rawSettle(c, { voucher: signVoucher(c.agent.priv, c.tab, 5000n), signer: key().priv }), /NotProvider|checkSig|NULLFAIL|signature/i);
  });

  it('min bounds: a dust voucher and a dust remainder are rejected', async () => {
    // Relay policy (and the SDK) already refuse dust outputs; turn that policy off so the test isolates the covenant.
    const c = await setup({ enforceDust: false });
    expect(() => rawSettle(c, {
      voucher: signVoucher(c.agent.priv, c.tab, 545n),
      providerOut: { to: p2pkhAddress(c.svc.pub), amount: 545n },
    }).debug()).toThrow(/BelowDust/);
    const big = BUDGET - 500n;
    expect(() => rawSettle(c, {
      voucher: signVoucher(c.agent.priv, c.tab, big),
      providerOut: { to: p2pkhAddress(c.svc.pub), amount: big - 1500n },
      ownerOut: { to: p2pkhAddress(c.owner.pub), amount: 500n },
    }).debug()).toThrow(/BelowDust/);
  });

  it('a voucher amount with the sign bit set (negative) cannot be settled', async () => {
    const c = await setup();
    // bytes8 0x....80 is a negative VM number: -5000 encoded sign-magnitude.
    const neg = Uint8Array.from([...bigIntToBinUint64LE(5000n).slice(0, 7), 0x80]);
    const msg = signVoucher(c.agent.priv, c.tab, 0n); // placeholder to reuse the outpoint
    const { secp256k1, sha256 } = await import('@bitauth/libauth');
    const { voucherMessage } = await import('../src/agenttab.js');
    const raw = voucherMessage(c.tab, 0n);
    raw.set(neg, raw.length - 8);
    const sig = secp256k1.signMessageHashSchnorr(c.agent.priv, sha256.hash(raw)) as Uint8Array;
    const b = new TransactionBuilder({ provider: c.provider })
      .addInput(c.tab, c.contract.unlock.settle(new SignatureTemplate(c.svc.priv), sig, neg))
      .addOutput({ to: p2pkhAddress(c.svc.pub), amount: 1000n })
      .addOutput({ to: p2pkhAddress(c.owner.pub), amount: BUDGET + 5000n - 2000n });
    expect(msg.amount).toBe(0n);
    await covenantRejects(b, /BelowDust/);
  });

  it('tokens cannot ride out on a settle output', async () => {
    // The tab utxo holds no tokens, and the covenant also pins tokenCategory == 0x on both outputs.
    const c = await setup();
    const v = signVoucher(c.agent.priv, c.tab, 5000n);
    const ok = rawSettle(c, { voucher: v });
    expect(ok.outputs.every((o) => !o.token)).toBe(true);
    await send(ok);
  });

  it('a failing settle names the custom error from AgentTab.scash in debug output', async () => {
    const c = await setup();
    const b = rawSettle(c, {
      voucher: signVoucher(c.agent.priv, c.tab, 5000n),
      ownerOut: { to: p2pkhAddress(c.owner.pub), amount: BUDGET - 5000n - 1n },
    });
    expect(() => b.debug()).toThrow(/OwnerShortchanged/);
    expect(() => b.debug()).toThrow(/AgentTab\.scash/);
  });
});

describe('AgentTab.scash: SolidCash dispatcher', () => {
  // solidc compiles each entry point to OP_DEFINE under its 4-byte selector, and every internal helper
  // (paysTo, noTokens, Voucher.message, ...) to OP_DEFINE under a small id (1..13). The dispatcher takes the
  // first unlocking push, checks it is 4 bytes, and OP_INVOKEs it. If the VM resolved a 4-byte NON-MINIMAL
  // encoding of a small id (e.g. 0x0c000000 == 12) to the helper, anyone could jump straight into a helper and
  // skip every signature check. This proves it does not: function identifiers are matched as exact bytes.
  it('a 4-byte selector naming an internal helper id cannot be invoked', async () => {
    const c = await setup();
    const honest = c.contract.unlock.cancel(new SignatureTemplate(c.svc.priv));
    const selector = hexToBin('046f0f574a'); // push4 <cancel selector>
    let tried = 0;
    for (let id = 1; id <= 16; id++) {
      const evil = {
        generateLockingBytecode: () => honest.generateLockingBytecode(),
        generateUnlockingBytecode: (o: any) => {
          const u = honest.generateUnlockingBytecode(o);
          const at = u.findIndex((_, i) => selector.every((x, j) => u[i + j] === x));
          expect(at).toBeGreaterThanOrEqual(0);
          const out = u.slice();
          out.set([0x04, id, 0, 0, 0], at);
          return out;
        },
      };
      const b = new TransactionBuilder({ provider: c.provider })
        .addInput(c.tab, evil)
        .addOutput({ to: p2pkhAddress(key().pub), amount: BUDGET - 2000n });
      await expect(b.send()).rejects.toThrow();
      tried++;
    }
    expect(tried).toBe(16);
    expect(await c.contract.getUtxos()).toHaveLength(1); // the tab is untouched
  });
});
