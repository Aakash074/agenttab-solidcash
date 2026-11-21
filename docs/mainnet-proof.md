# Mainnet proof: AgentTab compiled with SolidCash (2026-11-21)

One ~5¢ tab, funded from the author's own Paytaca wallet (WizardConnect) through `npm run page`, then settled by the provider with `npm run settle`.

| Step | Tx | Result |
|---|---|---|
| Open | 8c10fcd44b02ba31de5ae3916b083a541cc6ef7854dceb1a54d0e3c555e44fa0 | 24,000 sats locked in the SolidCash-compiled covenant (P2SH32 `pvmnsfn2…kqh`) |
| 3 calls | off-chain vouchers | cumulative 1,500 → 3,500 → 6,000 sats, 0 txs |
| Settle | 0fd00a082bd307255ac9f271528c185e13f531d7ac25ec7f79235457fe49a89d | 5,133 to provider (6,000 minus 867-sat fee for the 865-byte settle), exactly 18,000 back to the owner |
| Sweep (housekeeping) | 71282fbccefc34831ccf8e11a732a1bbffa68d2caba72467abeea4cd3e7287df | provider's 4,946 sats returned to the author |

Explorer: https://explorer.selene.cash/tx/0fd00a082bd307255ac9f271528c185e13f531d7ac25ec7f79235457fe49a89d?network=mainnet
