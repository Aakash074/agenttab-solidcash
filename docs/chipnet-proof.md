# Chipnet proof

The SolidCash `AgentTab` ran on BCH chipnet on 2026-11-21 (IST) with fresh test keys made for this repo
(`scripts/keygen.ts`, kept in the gitignored `.env`). No key from the CashScript AgentTab repo was used.

- Compiler: `@solidcash/solidc` 0.51.1, native mode. Artifact: [`deployments/AgentTab.artifact.json`](../deployments/AgentTab.artifact.json)
  (fingerprint `004170e934b54b096f2c02ec39bd8195f140909a432979e350f93c4f43882af5`).
- Contract script: 489 bytes without constructor arguments, 596 bytes with them. Every tab is a P2SH32 address.
- Script: `npx tsx scripts/chipnet-demo.ts <budgetSats> settle|cancel|refund`. Broadcasts went through the SDK's
  default chipnet server (`chipnet.bch.ninja`). Confirmations were read back from a separate server
  (`chipnet.imaginary.cash`) with `scripts/tx-status.ts`.
- Explorer: `https://explorer.selene.cash/tx/<txid>?network=chipnet`

## Final contract (489 bytes), all three close paths

| Step | Txid | Size | Status |
|---|---|---|---|
| Faucet → owner (300,000 sats) | `1af288117c99036aea72fcf825c2892c5efd12f05ca76a41dde75d322e2885e1` | 123 B | confirmed |
| **open** tab, 20,000 sats | `695a8adb6d1c6485c1a252cb3c5522d259b219bac9fa81225b52c9ad0ae692ce` | 370 B | confirmed |
| agent signs vouchers for 1,000, then 2,500, then 4,000 sats (off chain, cumulative, bound to the open outpoint) | none | | |
| **settle** with the 4,000-sat voucher: provider gets 4,000 minus the fee, owner gets exactly 16,000 | `f1f4ca55338111a0d2bba9c2d21afa29a7a8180312473009fc11097e010aa390` | 865 B | confirmed |
| **open** tab, 20,000 sats | `196a3a60cea1e2d188b6341a58c76090c87fab9cd176b3837b4a19189b8daca7` | 370 B | confirmed |
| **cancel** (provider waives the tab, so the owner gets everything back minus a fee of 1,000 sats or less) | `3bfd6e1de71587c4f79503f4925e8741d3b58b6765a4188a9f362ef78290963e` | 757 B | confirmed |
| **open** tab, 20,000 sats, timeout already in the past | `2f92a0a3c782b2c6061de7fcdc3b253e872a7c4ffd4df8bf77dd37006958da89` | 370 B | confirmed |
| **refund** (owner, nLockTime = timeout) | `f0128fc5f8250a050fb4c1bf97e16d0ee6aa70d1b90ae6af54cea01f98ba43bc` | 757 B | confirmed |

## Earlier build (559 bytes, `int`-based `Sats`), same flow

That build was replaced because `int` (int256) adds overflow checks that a 64-bit satoshi value never needs.
[`docs/solidcash-findings.md`](solidcash-findings.md) F3 explains the change.

| Step | Txid |
|---|---|
| open | `e3846cf639f385810e63ef3cb88c004cdcaf4e293b712c25d010e201a42d5877` |
| settle (4,000-sat voucher) | `1ef766ee8da74ae683b35fb2bcbb5c0c42b8ceec52e3aa99438f4e04bf7406d1` |
| open | `0c86412612537eb15d8b97fb3ac5fc89c4662e056b71b3bfec590a2687d1ea77` |
| cancel | `b853944b9832d4fb67e485cd5c012b4949cdc092439c85dd88bf7056613b8db1` |
| open (past timeout) | `a9c2bd309cfa88a55285afceb9575452732a5ba3c071f988646f52fb626bd981` |
| refund | `fda3cac80b9cfb99a9571f86dc5c80a91d41cff5b14ec3616f61b98e3461a36e` |

## Size against the CashScript original

| | CashScript `AgentTab.cash` (cashc 0.14) | SolidCash `AgentTab.scash` (solidc 0.51.1) |
|---|---|---|
| Script without constructor args | 176 B | 489 B (214 B for a straight syntax port, see findings F1) |
| settle tx (this run) | not measured here | 865 B |
| cancel tx (this run) | not measured here | 757 B, still under the 1,000-sat fee cap at 1 sat/B |

At 1 sat/byte a settle costs about 865 sats in fees, which is under half a US cent. The provider pays it out of its own share.
