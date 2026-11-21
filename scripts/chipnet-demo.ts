// Chipnet run of the SolidCash AgentTab: open a tab -> the agent signs 3 cumulative vouchers -> the provider
// settles the highest one, exact remainder back to the owner. Keys come from ./.env (made by scripts/keygen.ts);
// nothing secret is printed. Usage: npx tsx scripts/chipnet-demo.ts [budgetSats] [settle|cancel|refund]
import { readFileSync } from 'node:fs';
import { ElectrumNetworkProvider } from '@solidcash/solidcash/network/electrum';
import { hexToBin } from '@bitauth/libauth';
import {
  buildCancel, buildOpen, buildRefund, buildSettle, p2pkhAddress, pubFromPriv, signVoucher, tabContract, verifyVoucher,
} from '../src/agenttab.js';

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => l.split('=')),
);
const priv = (role: string) => hexToBin(env[`CHIPNET_${role}_PRIV`]);
const owner = priv('OWNER'), agent = priv('AGENT'), svc = priv('PROVIDER');
const ownerPub = pubFromPriv(owner), agentPub = pubFromPriv(agent), providerPub = pubFromPriv(svc);

const budget = BigInt(process.argv[2] ?? '20000');
const mode = process.argv[3] ?? 'settle';
const host = process.env.CHIPNET_ELECTRUM; // e.g. chipnet.imaginary.cash; default is the SDK's chipnet.bch.ninja
const provider = host ? new ElectrumNetworkProvider('chipnet', { hostname: host }) : new ElectrumNetworkProvider('chipnet');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Timeout: unix time one week out. In `refund` mode the timeout is already an hour in the past (MTP lags
// wall-clock time by about an hour), so the owner can exercise the refund path right away.
const now = Math.floor(Date.now() / 1000);
const timeout = BigInt(mode === 'refund' ? now - 3 * 3600 : now + 7 * 24 * 3600);
const contract = tabContract({ ownerPub, agentPub, providerPub, timeout }, provider);
console.log('tab address ', contract.address);
console.log('timeout     ', timeout.toString());
console.log('bytecode    ', contract.bytesize, 'bytes');

const ownerAddr = p2pkhAddress(ownerPub, 'chipnet');
const funding = await provider.getUtxos(ownerAddr);
if (!funding.length) throw new Error(`owner ${ownerAddr} has no chipnet coins; use the faucet first`);
const open = await buildOpen({ provider, contract, payerPriv: owner, fundingUtxos: funding, budget, changeAddress: ownerAddr }).send();
console.log('OPEN        ', open.txid);

let tab;
for (let i = 0; i < 20 && !tab; i++) {
  tab = (await contract.getUtxos()).find((u) => u.txid === open.txid);
  if (!tab) await sleep(1500);
}
if (!tab) throw new Error('tab utxo not visible yet');

if (mode === 'refund') {
  const tx = await buildRefund({ provider, contract, tabUtxo: tab, ownerPriv: owner, timeout }).send();
  console.log('REFUND      ', tx.txid);
} else if (mode === 'cancel') {
  const tx = await buildCancel({ provider, contract, tabUtxo: tab, providerPriv: svc, ownerPub }).send();
  console.log('CANCEL      ', tx.txid);
} else {
  const amounts = [1000n, 2500n, 4000n];
  const vouchers = amounts.map((a) => signVoucher(agent, tab, a));
  for (const v of vouchers) {
    if (!verifyVoucher(agentPub, v)) throw new Error('voucher does not verify');
    console.log('voucher     ', v.amount.toString().padStart(6), 'sats', v.sig.slice(0, 24) + '…');
  }
  const settle = await buildSettle({ provider, contract, tabUtxo: tab, providerPriv: svc, ownerPub, voucher: vouchers.at(-1)! }).send();
  console.log('SETTLE      ', settle.txid);
  console.log('owner gets   exactly', (budget - amounts.at(-1)!).toString(), 'sats; provider gets', amounts.at(-1)!.toString(), 'minus fee');
}
process.exit(0);
