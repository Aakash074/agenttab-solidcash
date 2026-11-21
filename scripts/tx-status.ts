// Confirmation status of chipnet txids, read from an independent Electrum server (default chipnet.imaginary.cash).
// Usage: npx tsx scripts/tx-status.ts <txid>...   (CHIPNET_ELECTRUM=host to pick another server)
import { ElectrumNetworkProvider } from '@solidcash/solidcash/network/electrum';

const host = process.env.CHIPNET_ELECTRUM ?? 'chipnet.imaginary.cash';
const provider = new ElectrumNetworkProvider('chipnet', { hostname: host, manualConnectionManagement: true });
await provider.connect();
for (const txid of process.argv.slice(2)) {
  try {
    const tx = (await provider.performRequest('blockchain.transaction.get', txid, true)) as { confirmations?: number; size?: number };
    console.log(txid, `confirmations=${tx.confirmations ?? 0}`, `size=${tx.size}`);
  } catch (e) {
    console.log(txid, 'NOT FOUND on', host, String(e).slice(0, 80));
  }
}
await provider.disconnect();
process.exit(0);
