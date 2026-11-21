# AgentTab on SolidCash

A refundable payment tab for AI agents on Bitcoin Cash, written in Solidity syntax and compiled to BCH Script with
[SolidCash](https://github.com/solidcash/solidcash). It is a port of
[AgentTab](https://github.com/Aakash074/agenttab), whose covenant was written in CashScript, and it keeps the same
protocol and security properties.

- **Owner** locks a budget in one covenant UTXO.
- **Agent** holds a key that can only sign off-chain vouchers for the *cumulative* amount owed:
  `datasig(agent, "AGENTTAB" ‖ outpointTxHash ‖ outpointIndex ‖ amount)`. A voucher is bound to one funding
  outpoint, so it cannot be replayed on another tab. The agent key can never move coins.
- **Provider** settles with the highest voucher it holds. Output 0 pays the provider *at most* the signed amount,
  and the provider pays the miner fee out of that. Output 1 pays the owner *exactly* `budget − amount`.
- The provider can **cancel** instead: everything goes back to the owner, minus a fee of 1,000 sats or less.
- The owner can **refund** everything after an absolute timeout (nLockTime).

Contract: [`contracts/AgentTab.scash`](contracts/AgentTab.scash). It compiles to 489 bytes with `@solidcash/solidc` 0.51.1
in native mode.

## SolidCash features used, and why each one fits

| Feature | Where | What it does here |
|---|---|---|
| Abstract base contract and inheritance with base args | `abstract contract TabRoles(owner, agent, provider)`, then `AgentTab(...) is TabRoles(...)` | puts the three roles and their gates in one place |
| Modifiers with parameters, applied left to right | `onlyProvider(sig)`, `onlyOwner(sig)`, `shaped(Close kind)` | signature gates, and a fixed transaction shape for each way of closing |
| Enum | `enum Close { Settle, Cancel }` | chooses the output count each close must have |
| User-defined value type with bound operators | `type Sats is bigint` plus `using { satsSub as -, satsLte as <=, ... } for Sats global` | keeps satoshi amounts apart from raw voucher bytes, while still reading as normal arithmetic |
| Libraries with constants and `using ... for` | `library Voucher` (domain tag, message layout), `library TabMath` (`DUST`, `split`, `aboveDust`), `amount.aboveDust()` | the voucher encoding and the budget arithmetic each live in one place |
| Struct | `struct Split { Sats providerMax; Sats ownerExact; }` | the budget split a settle must honour |
| Custom errors with arguments | `Overclaim(paid, signed)`, `OwnerShortchanged(paid, owed)`, `WrongPayee(i)`, `BadVoucher()`, ... | every attack test asserts the exact covenant reason |
| `require` with a string message | the cancel fee cap | |
| Internal `view` helpers | `paysTo(i, who)`, `noTokens(i)` | |
| Unit literals, introspection, locking-bytecode builder | `546 sats`, `1000 sats`, `tx.inputs[0].outpointTransactionHash`, `new LockingBytecodeP2PKH(...)`, `toPaddedBytes`, `tx.time` | |

**Security choices**

- **No `msg.sender`, ever.** In SolidCash `msg.sender` and `tx.origin` come from inputs the transaction builder
  chooses (the SolidCash docs call them unauthenticated), so every gate is `checkSig` or `checkDataSig` against a
  constructor key. The artifact's ABI confirms that each entry point's `signatureGuard` is a constructor argument,
  and a test asserts it.
- **Stateless on purpose.** State variables, mappings or `emit` would turn the tab into a CashToken-backed stateful
  contract. That would change funding, which today works from any wallet, and add NFT state to the trust surface.
  For that reason events are not used: lifecycle reasons are carried by custom errors instead.
- **Safety defaults left on**: `enforceFinalRequire`, `enforceLocktimeGuard`, parameter type enforcement, and no
  `unsafe` tiers.
- `Sats` wraps `bigint` rather than `int`. Every amount is a 64-bit VM number, so int256 overflow checks could never
  fire. They would only add script bytes (findings F3).

## Tests (SolidHat)

```sh
npm install
npm test            # = solidhat test: compiles, then runs 22 tests
```

The mock runs under real BCH limits (10,000-byte inputs, the dust rule, production consensus limits). Results:

- **Happy path**: three cumulative vouchers, settle the highest, exact remainder to the owner. Also refund after
  the timeout, and cancel.
- **The seven attacks from the original**, each asserted to fail *in the covenant* at the named error through
  `builder.debug()`, not only rejected by relay policy:
  1. **replay** of a voucher on a second UTXO at the same address (`BadVoucher`), and bundling two tab UTXOs
     (`WrongShape`)
  2. **overclaim**: provider output above the signed amount (`Overclaim`)
  3. **forged amount**: amount argument above what the voucher signs (`BadVoucher`); a voucher signed by the
     provider or owner key (`BadVoucher`)
  4. **remainder elsewhere**: owner output to another address (`WrongPayee`), 1 sat short (`OwnerShortchanged`),
     an extra output (`WrongShape`)
  5. **early refund**: nLockTime = timeout − 1 while chain time is past the timeout, so only the covenant can stop
     it (`TooEarly`)
  6. **agent withdrawal**: the agent key cannot refund (`NotOwner`), cancel or settle (`NotProvider`)
  7. **provider cancel into its own wallet** (`WrongPayee`), with an excessive fee, as a split payout, or with the
     owner's key
- Further cases: dust voucher and dust remainder (`BelowDust`), a negative amount encoded with the sign bit,
  third-party settle, and provider refund.
- **Dispatcher check**: none of the internal helper ids 1 to 16 can be invoked through a forged 4-byte selector.
- **Deployment artifact**: [`deployments/AgentTab.artifact.json`](deployments/AgentTab.artifact.json) must be
  byte-identical to a fresh compile.
- **WizardConnect path** (`test/wallet.test.ts`): an open signed by a stand-in wallet at two HD paths, then a
  settle; a refund request that carries the covenant ABI and the timeout as nLockTime.

## Chipnet

[`docs/chipnet-proof.md`](docs/chipnet-proof.md) has confirmed txids for open → vouchers → settle, cancel and refund.
To reproduce:

```sh
npx tsx scripts/keygen.ts                       # fresh chipnet test keys in .env (gitignored); prints addresses only
# fund the OWNER address at https://chipnet.bch.ninja
npm run chipnet -- 20000 settle                 # also: cancel | refund | open
```

## Mainnet: one ~5¢ tab from your own wallet

Nothing here broadcasts on mainnet unless you run it yourself.

```sh
npm run keys -- mainnet           # agent + provider keys into .env (never printed); public keys to the page config
npm run page                      # http://127.0.0.1:5188 : connect Paytaca (WizardConnect), open a 24,000-sat tab
# the page prints the settle command for that tab; run it without --broadcast first (dry run through the BCH VM)
npm run settle -- --net mainnet --owner <pub> --timeout <t> --txid <txid> --vout 0
npm run settle -- --net mainnet --owner <pub> --timeout <t> --txid <txid> --vout 0 --broadcast --mainnet
npm run settle -- --net mainnet --sweep-to <your address> --broadcast --mainnet   # provider earnings back to you
```

Settling sends 6,000 sats to the provider key (in this repo's `.env`) and exactly 18,000 sats back to your wallet.
If nobody settles, the page's Refund button returns everything to you after 24 h. Add `?net=chipnet` to the page
URL to rehearse with Paytaca on chipnet.

## SolidCash findings

[`docs/solidcash-findings.md`](docs/solidcash-findings.md) records 10 findings with minimal repros in
[`docs/repros/`](docs/repros/), plus 3 patches prepared locally in [`docs/patches/`](docs/patches/). The largest
finding: a struct local costs 484 bytes where two scalar locals cost 8, and the prepared compiler pass
(`ScalarReplaceStructLocals`) brings it back to 8.

## How this was built

This was written on 21–22 November 2026 (IST) for the BCH BLAZE "Best SolidCash Application" bounty, with heavy AI
assistance (Claude) driving the port, tests, chipnet runs and findings. The protocol, its threat model and the seven
attacks come from the original AgentTab (CashScript), built earlier for BCH BLAZE. This repository is a separate
port, and the original is unchanged.

Timeline (IST, 21 Nov; see `git log`): 15:50 project scaffolded with `create-solidhat`, and the contract compiled
on its first attempt minutes later. 15:55 first commit: contract, SDK, tests green including the seven attacks.
15:57–16:02 chipnet settle, cancel and refund, then the `bigint` change and a rerun. 16:07 the WizardConnect mainnet
page and the settle/sweep scripts. After that, the findings, repros and compiler patches.

## Layout

```text
contracts/AgentTab.scash      the covenant
src/agenttab.ts               SDK: vouchers, open / settle / cancel / refund builders
src/wallet.ts                 WizardConnect (Paytaca) open and refund builders
test/                         SolidHat tests
scripts/                      chipnet demo, key setup, settle and sweep (dry run by default), tx status
apps/mainnet/                 local page for the user-funded tab
deployments/                  exact deployed artifact
docs/                         chipnet proof, SolidCash findings, repros, patches
```

License: MIT, the same as the original.

## Upstream contributions
Pull requests opened against solidcash/solidcash from the findings in `docs/solidcash-findings.md`:
- https://github.com/solidcash/solidcash/pull/16 — accurate warning for `revert` with a custom error (F2)
- https://github.com/solidcash/solidcash/pull/17 — `solidhat init --no-sample` README (F5)
- https://github.com/solidcash/solidcash/pull/18 — scalar replacement of struct locals, 484 B → 8 B (F1)
