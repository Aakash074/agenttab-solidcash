// Fund one small AgentTab (SolidCash) from your own wallet over WizardConnect, then let the provider settle it.
// Runs locally (npm run page). Mainnet by default; ?net=chipnet to rehearse with Paytaca on chipnet.
// The page never sees a private key: it reads only the agent and provider PUBLIC keys from /tab-config.json
// (written by scripts/mainnet-keys.ts), builds the open transaction, and your wallet signs it.
import { StrictMode, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useWizardConnect, WizardConnectQRDialog } from '@wizardconnect/react';
import type { DappConnectionManager } from '@wizardconnect/dapp';
import { ElectrumNetworkProvider } from '@solidcash/solidcash/network/electrum';
import { hexToBin, binToHex } from '@bitauth/libauth';
import { p2pkhAddress, tabContract, type Network } from '../../src/agenttab.js';
import {
  buildWalletOpen, buildWalletRefund, explorerTx, gatherWalletUtxos, wizardConnectSignRequest, type InputPath, type WalletAddress,
} from '../../src/wallet.js';

const net: Network = new URLSearchParams(location.search).get('net') === 'chipnet' ? 'chipnet' : 'mainnet';
const provider = new ElectrumNetworkProvider(net === 'mainnet' ? 'mainnet' : 'chipnet');

interface TabConfig { network: Network; agentPub: string; providerPub: string; budget: string; timeoutHours: number }
interface TabRecord { net: Network; ownerPub: string; agentPub: string; providerPub: string; timeout: string; budget: string; txid: string; vout: number; at: string }

const STORE = `agenttab-solidcash.tabs.${net}`;
const loadTabs = (): TabRecord[] => { try { return JSON.parse(localStorage.getItem(STORE) ?? '[]'); } catch { return []; } };
const saveTabs = (t: TabRecord[]) => { try { localStorage.setItem(STORE, JSON.stringify(t)); } catch { /* storage blocked */ } };
const fmt = (n: bigint) => n.toLocaleString('en-US');

function walletAddresses(m: DappConnectionManager): WalletAddress[] {
  const out: WalletAddress[] = [];
  for (const [child, name, n] of [[0, 'receive', 10], [1, 'change', 5]] as const) {
    for (let i = 0; i < n; i++) {
      const k = m.getPubkey(child, BigInt(i));
      if (k) out.push({ address: p2pkhAddress(k, net), path: [name, i] });
    }
  }
  return out;
}

async function signAndSend(m: DappConnectionManager, req: ReturnType<typeof wizardConnectSignRequest>, inputPaths: InputPath[]) {
  const res = await m.signTransaction({ transaction: req as never, inputPaths });
  if (res.error || !res.signedTransaction) throw new Error(res.error ?? 'The wallet declined to sign.');
  return provider.sendRawTransaction(res.signedTransaction);
}

function App() {
  const wc = useWizardConnect({ dappName: 'AgentTab (SolidCash)' });
  const [showQr, setShowQr] = useState(false);
  const [cfg, setCfg] = useState<TabConfig | null>(null);
  const [cfgError, setCfgError] = useState('');
  const [balance, setBalance] = useState<bigint | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [tabs, setTabs] = useState<TabRecord[]>(loadTabs);
  const [status, setStatus] = useState<Record<string, string>>({});

  useEffect(() => {
    fetch('/tab-config.json').then((r) => (r.ok ? r.json() : Promise.reject(new Error('missing'))))
      .then((c: TabConfig) => (c.network === net ? setCfg(c) : setCfgError(`tab-config.json is for ${c.network}; run: npm run keys -- ${net}`)))
      .catch(() => setCfgError(`No tab-config.json yet. Run: npm run keys -- ${net}`));
  }, []);

  const m = wc.state === 'connected' ? wc.manager : undefined;
  const ownerPub = m?.getPubkey(0, 0n);
  const owner = ownerPub ? p2pkhAddress(ownerPub, net) : '';
  useEffect(() => { if (m) setShowQr(false); }, [m]);

  const refreshBalance = async () => {
    if (!m) return;
    const utxos = await gatherWalletUtxos(provider, walletAddresses(m));
    setBalance(utxos.reduce((s, x) => s + x.u.satoshis, 0n));
  };
  useEffect(() => { refreshBalance().catch(() => setBalance(null)); }, [m]); // eslint-disable-line react-hooks/exhaustive-deps

  const contractFor = (t: { ownerPub: string; agentPub: string; providerPub: string; timeout: string }) =>
    tabContract({ ownerPub: hexToBin(t.ownerPub), agentPub: hexToBin(t.agentPub), providerPub: hexToBin(t.providerPub), timeout: BigInt(t.timeout) }, provider);

  const open = async () => {
    if (!m || !ownerPub || !cfg) return;
    setError(''); setBusy('Waiting for your wallet to approve…');
    try {
      const timeout = BigInt(Math.floor(Date.now() / 1000) + cfg.timeoutHours * 3600);
      const rec = { ownerPub: binToHex(ownerPub), agentPub: cfg.agentPub, providerPub: cfg.providerPub, timeout: timeout.toString() };
      const contract = contractFor(rec);
      const funding = await gatherWalletUtxos(provider, walletAddresses(m));
      const budget = BigInt(cfg.budget);
      const { builder, inputPaths } = buildWalletOpen({ provider, contract, funding, budget, changeAddress: owner });
      const req = wizardConnectSignRequest(builder, { userPrompt: `Open an AgentTab (SolidCash) with ${budget} sats` });
      const txid = await signAndSend(m, req, inputPaths);
      const next = [{ ...rec, net, budget: budget.toString(), txid, vout: 0, at: new Date().toISOString() }, ...tabs];
      setTabs(next); saveTabs(next);
      refreshBalance().catch(() => {});
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(''); }
  };

  const check = async (t: TabRecord) => {
    const live = (await contractFor(t).getUtxos()).some((u) => u.txid === t.txid && u.vout === t.vout);
    setStatus((s) => ({ ...s, [t.txid]: live ? 'open (coins locked in the tab)' : 'closed (settled, cancelled or refunded)' }));
  };

  const refund = async (t: TabRecord) => {
    if (!m) return;
    setError(''); setBusy('Waiting for your wallet to approve the refund…');
    try {
      const contract = contractFor(t);
      const utxo = (await contract.getUtxos()).find((u) => u.txid === t.txid && u.vout === t.vout);
      if (!utxo) throw new Error('This tab is already closed.');
      const { builder, inputPaths } = buildWalletRefund({ provider, contract, tabUtxo: utxo, timeout: BigInt(t.timeout), to: owner });
      const txid = await signAndSend(m, wizardConnectSignRequest(builder, { userPrompt: 'Refund your AgentTab' }), inputPaths);
      setStatus((s) => ({ ...s, [t.txid]: `refunded in ${txid}` }));
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(''); }
  };

  const budget = cfg ? BigInt(cfg.budget) : 0n;
  const enough = balance !== null && balance >= budget + 1000n;
  const settleCmd = (t: TabRecord) =>
    `npm run settle -- --net ${t.net} --owner ${t.ownerPub} --timeout ${t.timeout} --txid ${t.txid} --vout ${t.vout}`;
  const nowSec = useMemo(() => Math.floor(Date.now() / 1000), [tabs, status]);

  return (
    <main>
      <header>
        <h1>AgentTab <span className="muted">on SolidCash</span></h1>
        <span className={`net ${net}`}>{net === 'mainnet' ? 'Mainnet · real BCH' : 'Chipnet · test coins'}</span>
      </header>
      <p className="lead">
        Lock a small budget in an AgentTab covenant compiled with SolidCash. The provider can only take what the agent
        signed for, and the rest comes back to your address in the same transaction. If nobody settles, you can refund
        everything after the timeout.
      </p>

      {cfgError && <p className="err">{cfgError}</p>}

      <section>
        <h2><span className="n">1</span> Connect your wallet</h2>
        {m ? (
          <dl>
            <dt>Wallet</dt><dd>{wc.walletName ?? 'WizardConnect wallet'}</dd>
            <dt>Owner address</dt><dd className="mono">{owner}</dd>
            <dt>Balance</dt><dd>{balance === null ? '…' : `${fmt(balance)} sats`}</dd>
          </dl>
        ) : (
          <>
            <p>Scan the code with Paytaca{net === 'mainnet' ? ' (in Settings, turn Chipnet off)' : ' (in Settings, turn Chipnet on)'}.</p>
            <button onClick={() => { wc.connect(); setShowQr(true); }}>Connect with WizardConnect</button>
          </>
        )}
      </section>

      <section>
        <h2><span className="n">2</span> Open the tab</h2>
        {cfg && (
          <dl>
            <dt>Budget</dt><dd>{fmt(budget)} sats{net === 'mainnet' ? ' (about 5¢)' : ''}</dd>
            <dt>Refund after</dt><dd>{cfg.timeoutHours} h</dd>
            <dt>Agent key</dt><dd className="mono">{cfg.agentPub.slice(0, 20)}…</dd>
            <dt>Provider key</dt><dd className="mono">{cfg.providerPub.slice(0, 20)}…</dd>
          </dl>
        )}
        <button disabled={!m || !cfg || !!busy || !enough} onClick={open}>Open a {cfg ? fmt(budget) : ''}-sat tab</button>
        {m && cfg && balance !== null && !enough && <p className="muted">You need at least {fmt(budget + 1000n)} sats in this wallet.</p>}
        {busy && <p className="muted">{busy}</p>}
        {error && <p className="err">{error}</p>}
      </section>

      <section>
        <h2><span className="n">3</span> Settle, or refund</h2>
        {tabs.length === 0 ? <p className="muted">Tabs you open from this browser are listed here.</p> : tabs.map((t) => (
          <div key={t.txid} className="tab">
            <p>Opened <a href={explorerTx(t.net, t.txid)} target="_blank" rel="noreferrer" className="mono">{t.txid.slice(0, 16)}…</a> with {fmt(BigInt(t.budget))} sats{status[t.txid] ? `: ${status[t.txid]}` : ''}</p>
            <p className="muted">The provider settles it from a terminal in this repo:</p>
            <pre>{settleCmd(t)}</pre>
            <div className="row">
              <button className="ghost" onClick={() => check(t).catch((e) => setError(String(e)))}>Check status</button>
              <button className="ghost" disabled={!m || nowSec < Number(t.timeout)} onClick={() => refund(t)}>
                {nowSec < Number(t.timeout) ? `Refund opens ${new Date(Number(t.timeout) * 1000).toLocaleString()}` : 'Refund to my wallet'}
              </button>
            </div>
          </div>
        ))}
      </section>

      <WizardConnectQRDialog show={showQr && !m} uri={wc.uri} qrUri={wc.qrUri} onClose={() => setShowQr(false)}
        title="Connect with WizardConnect" subtitle="Scan with Paytaca"
        theme={{ dialogBackground: '#ffffff', headerBackground: '#ffffff', titleColor: '#111827', subtitleColor: '#4b5563', uriRowBackground: '#f3f4f6', uriTextColor: '#374151', borderColor: '#e5e7eb', closeButtonColor: '#6b7280', copyButtonColor: '#6b7280' }} />
    </main>
  );
}

const css = `
:root { --bg:#f7f8fa; --card:#fff; --ink:#111827; --muted:#6b7280; --line:#e5e7eb; --accent:#0f766e; --err:#b91c1c; }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 720px; margin: 0 auto; padding: 32px 16px 64px; }
header { display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; }
h1 { font-size: 22px; margin: 0; } h2 { font-size: 16px; margin: 0 0 12px; display:flex; align-items:center; gap:8px; }
.n { display:inline-grid; place-items:center; width:22px; height:22px; border-radius:50%; background:var(--ink); color:#fff; font-size:12px; }
.lead { color:#374151; margin: 12px 0 24px; }
.muted { color: var(--muted); font-weight: 400; }
.net { font-size: 12px; padding: 3px 10px; border-radius: 999px; border:1px solid var(--line); background:#fff; }
.net.mainnet { color:#92400e; border-color:#fcd34d; background:#fffbeb; }
section { background: var(--card); border:1px solid var(--line); border-radius: 10px; padding: 20px; margin-bottom: 16px; }
dl { display:grid; grid-template-columns: 130px 1fr; gap: 6px 12px; margin: 0 0 16px; } dt { color: var(--muted); } dd { margin:0; overflow-wrap:anywhere; }
.mono, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; }
pre { background:#f3f4f6; border:1px solid var(--line); border-radius:8px; padding:10px; white-space:pre-wrap; overflow-wrap:anywhere; }
button { font: inherit; background: var(--accent); color:#fff; border:0; border-radius:8px; padding: 9px 16px; cursor:pointer; }
button:disabled { opacity:.45; cursor:not-allowed; } button.ghost { background:#fff; color:var(--ink); border:1px solid var(--line); }
.row { display:flex; gap:8px; flex-wrap:wrap; } .tab + .tab { border-top:1px solid var(--line); margin-top:16px; padding-top:16px; }
.err { color: var(--err); } a { color: var(--accent); }
`;
document.head.insertAdjacentHTML('beforeend', `<style>${css}</style>`);
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
