// Creates fresh CHIPNET test keys in ./.env (gitignored) if they are missing. Prints addresses only, never keys.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { binToHex, generatePrivateKey } from '@bitauth/libauth';
import { p2pkhAddress, pubFromPriv } from '../src/agenttab.js';

const path = new URL('../.env', import.meta.url);
const env = existsSync(path) ? readFileSync(path, 'utf8') : '';
const lines = env.split('\n').filter(Boolean);
for (const role of ['OWNER', 'AGENT', 'PROVIDER']) {
  const name = `CHIPNET_${role}_PRIV`;
  if (!lines.some((l) => l.startsWith(`${name}=`))) lines.push(`${name}=${binToHex(generatePrivateKey())}`);
}
writeFileSync(path, lines.join('\n') + '\n', { mode: 0o600 });
const vars = Object.fromEntries(lines.map((l) => l.split('=')));
for (const role of ['OWNER', 'AGENT', 'PROVIDER']) {
  const priv = Uint8Array.from(Buffer.from(vars[`CHIPNET_${role}_PRIV`], 'hex'));
  console.log(role.padEnd(9), p2pkhAddress(pubFromPriv(priv), 'chipnet'));
}
