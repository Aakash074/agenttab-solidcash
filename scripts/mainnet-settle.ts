// Provider side of the small tab you open on the page (apps/mainnet): the agent signs cumulative vouchers,
// and the provider settles the highest one. The owner gets exactly budget - amount back.
// DRY RUN BY DEFAULT: it builds the transaction and runs it through the BCH VM locally (builder.debug()), but
// does not broadcast. To broadcast, add --broadcast, and on mainnet also add --mainnet.
//
//   npm run settle -- --net mainnet --owner <ownerPubHex> --timeout <t> --txid <openTxid> --vout 0 [--amounts 1500,3500,6000]
//   npm run settle -- --net mainnet --sweep-to <yourAddress>   # move the provider's earnings to your wallet
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { ElectrumNetworkProvider } from '@solidcash/solidcash/network/electrum';
import { SignatureTemplate, TransactionBuilder } from '@solidcash/solidcash';
import { hexToBin } from '@bitauth/libauth';
import { buildSettle, DUST, p2pkhAddress, pubFromPriv, signVoucher, tabContract, verifyVoucher, type Network } from '../src/agenttab.js';
import { explorerTx } from '../src/wallet.js';

const { values: a } = parseArgs({
  options: {
    net: { type: 'string', default: 'mainnet' }, owner: { type: 'string' }, timeout: { type: 'string' },
    txid: { type: 'string' }, vout: { type: 'string', default: '0' }, amounts: { type: 'string', default: '1500,3500,6000' },
    'sweep-to': { type: 'string' }, broadcast: { type: 'boolean', default: false }, mainnet: { type: 'boolean', default: false },
  },
});
const net = a.net as Network;
if (net !== 'mainnet' && net !== 'chipnet') throw new Error('--net must be mainnet or chipnet');
if (a.broadcast && net === 'mainnet' && !a.mainnet) throw new Error('Refusing to broadcast on mainnet without --mainnet.');
const P = net.toUpperCase();
const env = Object.fromEntries(readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const need = (k: string) => { if (!env[k]) throw new Error(`${k} missing in .env; run: npm run keys -- ${net}`); return hexToBin(env[k]); };
const agent = need(`${P}_AGENT_PRIV`), svc = need(`${P}_PROVIDER_PRIV`);
const provider = new ElectrumNetworkProvider(net);
const mode = a.broadcast ? 'BROADCAST' : 'DRY RUN (add --broadcast to send)';

async function finish(builder: TransactionBuilder, label: string) {
  builder.debug(); // throws with the failing require / custom error if the covenant would refuse it
  console.log(`${label}: ${builder.getTransactionSize()} bytes, evaluates OK in the BCH VM`);
  for (const o of builder.outputs) console.log('  output', String(o.amount).padStart(8), 'sats ->', o.to);
  if (!a.broadcast) { console.log(mode); return; }
  const tx = await builder.send();
  console.log(`${label} txid ${tx.txid}\n  ${explorerTx(net, tx.txid)}`);
}

if (a['sweep-to']) {
  const addr = p2pkhAddress(pubFromPriv(svc), net);
  const utxos = (await provider.getUtxos(addr)).filter((u) => !u.token);
  const total = utxos.reduce((s, u) => s + u.satoshis, 0n);
  if (!utxos.length) throw new Error(`nothing to sweep at ${addr}`);
  const build = (fee: bigint) => {
    const b = new TransactionBuilder({ provider });
    for (const u of utxos) b.addInput(u, new SignatureTemplate(svc).unlockP2PKH());
    return b.addOutput({ to: a['sweep-to']!, amount: total - fee });
  };
  const fee = build(0n).getTransactionSize() + 2n;
  if (total - fee < DUST) throw new Error('balance too small to sweep');
  await finish(build(fee), 'SWEEP');
} else {
  if (!a.owner || !a.timeout || !a.txid) throw new Error('need --owner, --timeout and --txid (the page prints the full command)');
  const ownerPub = hexToBin(a.owner);
  const contract = tabContract({ ownerPub, agentPub: pubFromPriv(agent), providerPub: pubFromPriv(svc), timeout: BigInt(a.timeout) }, provider);
  const tab = (await contract.getUtxos()).find((u) => u.txid === a.txid && u.vout === Number(a.vout));
  if (!tab) throw new Error(`tab ${a.txid}:${a.vout} not found at ${contract.address} (already closed, or wrong --owner/--timeout)`);
  console.log(`tab ${contract.address}: ${tab.satoshis} sats`);
  const amounts = a.amounts!.split(',').map((x) => BigInt(x.trim()));
  const vouchers = amounts.map((n) => signVoucher(agent, tab, n));
  for (const v of vouchers) {
    if (!verifyVoucher(pubFromPriv(agent), v)) throw new Error('voucher does not verify');
    console.log(`  agent voucher: ${String(v.amount).padStart(6)} sats (cumulative)`);
  }
  const v = vouchers.at(-1)!;
  await finish(buildSettle({ provider, contract, tabUtxo: tab, providerPriv: svc, ownerPub, voucher: v, network: net }), 'SETTLE');
  console.log(`owner gets exactly ${tab.satoshis - v.amount} sats back at ${p2pkhAddress(ownerPub, net)}`);
}
process.exit(0);
