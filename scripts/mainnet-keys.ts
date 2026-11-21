// Makes the agent and provider keys for ONE small tab and writes apps/mainnet/public/tab-config.json (public keys
// only, gitignored) for the page. Private keys go to ./.env (gitignored, mode 600) and are never printed.
// No transaction is made. Usage: npm run keys -- [mainnet|chipnet] [budgetSats] [timeoutHours]
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { binToHex, generatePrivateKey, hexToBin } from '@bitauth/libauth';
import { p2pkhAddress, pubFromPriv, type Network } from '../src/agenttab.js';

const net = (process.argv[2] ?? 'mainnet') as Network;
if (net !== 'mainnet' && net !== 'chipnet') throw new Error('network must be mainnet or chipnet');
const budget = process.argv[3] ?? (net === 'mainnet' ? '24000' : '20000'); // 24,000 sats ≈ 5¢ in Nov 2026
const timeoutHours = Number(process.argv[4] ?? 24);
const P = net.toUpperCase();

const envPath = new URL('../.env', import.meta.url);
const lines = (existsSync(envPath) ? readFileSync(envPath, 'utf8') : '').split('\n').filter(Boolean);
const get = (k: string) => lines.find((l) => l.startsWith(`${k}=`))?.slice(k.length + 1);
for (const role of ['AGENT', 'PROVIDER']) if (!get(`${P}_${role}_PRIV`)) lines.push(`${P}_${role}_PRIV=${binToHex(generatePrivateKey())}`);
writeFileSync(envPath, lines.join('\n') + '\n', { mode: 0o600 });

const agentPub = pubFromPriv(hexToBin(get(`${P}_AGENT_PRIV`)!));
const providerPub = pubFromPriv(hexToBin(get(`${P}_PROVIDER_PRIV`)!));
const cfg = { network: net, agentPub: binToHex(agentPub), providerPub: binToHex(providerPub), budget, timeoutHours };
writeFileSync(new URL('../apps/mainnet/public/tab-config.json', import.meta.url), JSON.stringify(cfg, null, 2) + '\n');
console.log(`network        ${net}`);
console.log(`budget         ${budget} sats, refund after ${timeoutHours} h`);
console.log(`agent pubkey   ${cfg.agentPub}`);
console.log(`provider pub   ${cfg.providerPub}`);
console.log(`provider pays  ${p2pkhAddress(providerPub, net)}  (settle earnings land here; sweep with scripts/mainnet-settle.ts --sweep-to)`);
console.log('wrote apps/mainnet/public/tab-config.json (public keys only)');
