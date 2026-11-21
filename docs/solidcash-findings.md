# SolidCash findings (solidc / SDK / SolidHat 0.51.1)

These came up while porting AgentTab to SolidCash on 2026-11-21. Each one has a minimal repro. The patches are
prepared locally in [`patches/`](patches/), made against upstream `master` at `eda85a88d`. None of them has been
submitted, and nobody has opened issues or PRs for them.

Unless stated otherwise, sizes are `solidc <file> --size` with `@solidcash/solidc` 0.51.1 in native mode.

| # | Area | Severity | Patch |
|---|---|---|---|
| F1 | compiler: a struct local always goes through the pushdata struct codec | **size/fee, large** (484 B vs 8 B) | [`0003-scalar-replace-struct-locals.patch`](patches/0003-scalar-replace-struct-locals.patch) |
| F2 | compiler: the `revert CustomError(...)` warning says a working revert "is a no-op"; it repeats once per modifier expansion | diagnostics | [`0001-revert-custom-error-warning.patch`](patches/0001-revert-custom-error-warning.patch) (wording) |
| F3 | compiler: `int` arithmetic on 64-bit introspection values runs an int256 range check on every operation | size | none (porting guidance in the AgentTab README) |
| F4 | solidhat typegen: a stateless contract gets `StatefulContract` / `ContractFactory` bindings, and UDVT struct fields come out as `unknown` | DX | none |
| F5 | create-solidhat: with `--no-sample` the README still tells you to look at `Counter.scash` | docs | [`0002-no-sample-readme.patch`](patches/0002-no-sample-readme.patch) |
| F6 | `solidhat run scripts/x.ts` cannot import local TS modules written with the NodeNext `.js` suffix | DX | none |
| F7 | SDK: the browser bundle for a plain stateless `Contract` + `TransactionBuilder` is about 4.9 MB, with one 1.6 MB chunk | web DX | none |
| F8 | SDK: `ElectrumNetworkProvider#disconnect()` throws by default instead of being a no-op | DX, minor | none |
| F9 | packaging: every package depends on a git fork of libauth (npm skips the integrity check), and the monorepo's `resolutions` point at a sibling `../mem-cash` checkout | supply chain / contributor DX | none |
| F10 | docs: "Library functions are inlined at each call", yet an internal library function is emitted as an `OP_DEFINE` subroutine | docs | none |
| N1 | security note (not a bug): selector dispatch matches function ids as exact bytes, so a 4-byte non-minimal id such as `0x0c000000` cannot reach an internal helper | none, by design | covered by a test here |

---

## F1. A struct local always pays for the struct encoder and decoder (484 B instead of 8 B)

The docs say a struct value is "its fields encoded back to back" with pushdata framing. The compiler does this
even for a local that never leaves the function. Building the local invokes an encoder subroutine (about 95 B), and
every `p.field` invokes a decoder subroutine (about 100 B) that parses the push opcodes back out.

Repro: [`repros/F1-struct-local.scash`](repros/F1-struct-local.scash) against [`repros/F1-scalar-locals.scash`](repros/F1-scalar-locals.scash)

```solidity
struct Pair { bigint a; bigint b; }
contract StructLocal(pubkey pk) {
    function f(sig s, bigint x) {
        require(checkSig(s, pk));
        Pair memory p = Pair({ a: tx.inputs[0].value, b: tx.outputs[0].value + x });
        require(p.a >= p.b);
    }
}
```

| | bytes |
|---|---|
| struct local (released 0.51.1) | **484** |
| the same logic with two scalar locals | 8 |
| struct local with patch 0003 | **8** (bytecode identical to the scalar version) |

In AgentTab, one two-field `Split` struct cost about 210 B of a 516-byte script, and every settle pays that in fees.
The deployed contract builds `Split` through a library function, so it still costs that much with the released
compiler.

**Patch 0003** adds a `ScalarReplaceStructLocals` AST pass. It runs just before `LowerMemoryModel`, after the
field-write coalescers. A struct local becomes one compiler-generated local per field, but only when all of these
hold, and otherwise nothing changes:

- the local is defined once, by a direct construction of its own struct type that names every field (positional,
  or named with all fields present);
- every field is a scalar (no nested struct, array or mapping);
- every other mention of the name in the function is the base of a read `v.field`.

A reflective walk over the function rejects any other occurrence, including assignments (a field write desugars to
a whole-struct rebuild), escaping as a whole, assembly, or a string-named reference. Initializers are emitted in
source argument order. The escape hatch `scalarReplaceStructLocals: false` keeps the old lowering, following the
existing `reuseEntryLocalForWriteback` pattern.

Validation, run locally against the upstream sources with `tsx`:

- the new `packages/solidc/test/ScalarReplaceStructLocals.test.ts` passes 7/7: bytecode identical to hand-written
  scalars, positional and reordered named construction, and no change for a written, escaping, call-initialized or
  nested struct;
- all 64 compiler test files that mention `struct` pass (1,473 tests);
- full `packages/solidc` suite: see the result recorded under "Patch validation" at the end of this file.

A natural follow-up is to inline a pure internal function whose body is `return S(...)`, as `TabMath.split` is
here, so the pass can also see that construction.

## F2. The `revert CustomError(...)` warning is wrong, and it repeats

```solidity
error TooMany(bigint n);
...
if (tx.outputs.length > 2) { revert TooMany(tx.outputs.length); }
```

solidc prints `Warning: revert with custom error is a no-op in SolidCash at line 8. ... the script simply fails
unconditionally.` The revert works: it fails the spend, and `builder.debug()` even names `TooMany`. Only the
arguments are dropped. Calling it a "no-op" tells a security reviewer the opposite of the truth.

When the revert sits inside a modifier, the warning prints once per function that applies the modifier. In AgentTab
it printed twice from `solidc` and four times under `solidhat test`. `require(cond, TooMany(n))` has exactly the
same semantics and prints no warning, which is inconsistent. Repro: [`repros/F2-revert-custom-error.scash`](repros/F2-revert-custom-error.scash).
Patch 0001 rewords the warning and updates the one test that pins its text. Deduplicating it would need a design
choice about the warning listener, so that is left to the maintainers.

## F3. `int` arithmetic on introspected values pays int256 range checks

`tx.inputs[i].value` and `tx.outputs[i].value` are at most 2^63, so neither a sum nor a difference of two of them can
leave the int256 range. Even so, each `int` operation invokes the range-check subroutine
(`OP_SIZE <33> OP_LESSTHANOREQUAL ...`). Repro: [`repros/F3-int-range-checks.scash`](repros/F3-int-range-checks.scash)
is **47 B**, against **18 B** for [`repros/F3-bigint-baseline.scash`](repros/F3-bigint-baseline.scash).

In AgentTab, moving the `Sats` value type from `int` to `bigint` saved 32 B (from 559 to 527, and then 489 with
the other changes). A range analysis could drop the check when both operands are known to be 64-bit. Until then
the docs could say that satoshi arithmetic should use `bigint`.

## F4. Typegen for a stateless contract

`typechain-types/contracts/AgentTab.ts` declares `type AgentTab = StatefulContract<...>` and a `ContractFactory`
with `deploy(...)`, but AgentTab has no state, so it is a plain `Contract` spent through `contract.unlock.*`. The
struct binding comes out as `{ providerMax: unknown; ownerExact: unknown }` because both fields have the UDVT type
`Sats is bigint`. It should be `bigint`.

## F5. `--no-sample` README

`npm create @solidcash/solidhat@0.51.1 app -- --template typescript --no-sample --yes` writes no Counter files, yet
its README says "The included `Counter.scash` and `Counter.test.ts` demonstrate...". Patch 0002 passes
`includeSample` to the README generator and adds a test to `packages/solidhat/test/init.test.ts`.

The scaffold also pins `vitest ^5.0.4`, and vitest 5.1.1 declares `node ^22.12 || ^24 || >=26`, so npm prints
EBADENGINE on Node 25. It still works. The scaffold's `evmCompat: true` default is documented, but it is easy to
miss when writing a BCH-native contract.

## F6. `solidhat run` and relative `.js` imports

`scripts/keygen.ts` imports `../src/agenttab.js`, the usual TypeScript NodeNext spelling. `npx solidhat run
scripts/keygen.ts` fails with `Cannot find module .../src/agenttab.js`, and the same script runs under `tsx`. The
scripts in this repo use `tsx` for that reason.

## F7. Browser bundle size

The mainnet page only needs `Contract`, `TransactionBuilder`, the WalletConnect placeholders and
`ElectrumNetworkProvider`. `vite build` still emits about 4.9 MB of JS, including `compose-recipes` (1.64 MB),
`TransactionBuilder` (272 KB), `combinations` (350 KB), message-bus `compose` and the stateful runtime. A stateless
dapp ends up shipping the message-bus and stateful machinery.

## F8. `disconnect()` throws

With the default `ElectrumNetworkProvider('chipnet')`, `await provider.disconnect()` throws `Manual connection
management is disabled`. A script that tidies up after itself fails at its last line. A no-op, or a documented
`provider.close()`, would be friendlier. The process does exit by itself after about 3 s.

## F9. Packaging

Every `@solidcash/*` 0.51.1 package depends on
`git+https://github.com/mainnet-pat/libauth.git#1cf4b43...`. The commit pin is good, but npm prints `skipping
integrity check for git dependency`, and installs need git. In the monorepo, the root `resolutions` map
`@mem-cash/*` to `file:../mem-cash/...`, so a fresh clone cannot run `yarn` without that sibling checkout. To
validate the patches here, the clone's `node_modules` was symlinked to this project's installed tree and the
compiler sources ran through `tsx`.

## F10. "Library functions are inlined"

The language reference says library functions "are inlined at each call". In AgentTab, `TabMath.split`,
`Voucher.message` and `TabMath.aboveDust` are each emitted once as an `OP_DEFINE` body and called with
`OP_INVOKE`, which is better for size. The documentation is what is inaccurate.

## N1. Dispatcher and function identifiers (checked; not a bug)

solidc defines each entry point under its 4-byte selector and each helper under a small id (`OP_1 ... OP_13
OP_DEFINE`). The dispatcher checks that the first push is 4 bytes, then `OP_INVOKE`s it. A helper such as
`noTokens` would return true for any input, so this is safe only if `0x0c000000` does not resolve to helper `0x0c`.
Under the 2026 functions rules, identifiers are keys compared as exact bytes (libauth `binToHex(identifier)` table
lookup), so it does not. `test/AgentTab.test.ts` ("SolidCash dispatcher") tries ids 1 to 16 as 4-byte selectors,
and every attempt is rejected.

## Things that worked well

- The contract compiled on the first attempt. `builder.debug()` names the failing `require` and the custom error
  (`require failed: OwnerShortchanged(...)`, with its source line), which made the attack tests precise.
- The mock with production limits caught a real problem: the mock's chain time refused a non-final refund, which
  the CashScript mock had never checked.
- The SDK API is close enough to CashScript's that the AgentTab SDK ported in about an hour.

## Patch validation

All three patches apply cleanly to upstream `master` (`eda85a88d`) with `git apply --check`. They were tested
against the upstream sources run through `tsx`. The monorepo cannot be installed from a fresh clone (F9), so the
clone's `node_modules` was symlinked to this project's installed tree.

| Patch | What ran | Result |
|---|---|---|
| 0001 warning text | `packages/solidcash/test/framed/shapes/revert-partway.test.ts`, which pins the warning text | 6/6 pass |
| 0002 `--no-sample` README | `packages/solidhat/test/init.test.ts`, the new test | passes |
| 0003 struct SROA | new `ScalarReplaceStructLocals.test.ts` | 7/7 pass |
| 0003 struct SROA | **full `packages/solidc` suite** (527 files, 7,801 tests) | 7,792 pass, 8 skipped. The 18 files that fail cannot load in this setup: 15 import `../dist/compiler.js` (no build), 1 needs `@openzeppelin/contracts`, and 2 hit a test-file parse error under vitest 5.1.1 / rolldown ("Identifier `sha256` has already been declared"). None of them reaches the new pass. |
| 0003 struct SROA | `tsc --noEmit` on the new pass with the package's build tsconfig | clean |

AgentTab itself compiles to the same 489 bytes with or without patch 0003, because its `Split` comes from the
`TabMath.split` call, and the pass leaves call-initialized locals alone. That keeps the deployed artifact
reproducible with the released 0.51.1.
