// Mok Strategy scanner for GitHub Actions. Reuses calc() straight from index.html
// (AI Renko Supertrend) and sends new fresh signals as phone notifications.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const cfg = JSON.parse(fs.readFileSync(path.join(here, 'config.json'), 'utf8'));
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- settings (same defaults as the app; override in config.json -> "params") ----
const C = Object.assign({
  mode: 'Both Agree', st1Len: 14, st1Mul: 3, st2Len: 60, st2Mul: 2, adxTh: 15, adxLen: 14, useCh: true,
  bMode: 'Auto', bLen: 14, bFac: 1, bPct: .3, bMan: 2.95, hist: 499, prim: cfg.prim || '5m', fresh: cfg.freshBars ?? 4
}, cfg.params || {});
const MIN = { '1m': 1, '3m': 3, '5m': 5, '15m': 15, '30m': 30, '1h': 60, '2h': 120, '4h': 240, '1d': 1440, '1w': 10080 };
if (!MIN[C.prim]) { console.error('Unknown timeframe: ' + C.prim); process.exit(1); }

// ---- load the engine straight from index.html ----
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const a = html.indexOf('function calc(k){'), b = html.indexOf('function evalTF(');
if (a < 0 || b < 0 || b < a) { console.error('calc() not found in index.html'); process.exit(1); }
const calc = new Function('C', html.slice(a, b) + '\nreturn calc;')(C);

const fmt = p => p >= 100 ? p.toFixed(2) : p >= .1 ? p.toFixed(4) : p.toFixed(6);
const LB = iv => iv.replace('h', 'H').replace('d', 'D').replace('w', 'W');

// ---- Binance ----
let mk = cfg.market === 'spot' ? 'spot' : 'fut';
let fellBack = false;
const BASES = { fut: ['https://fapi.binance.com/fapi/v1/'], spot: ['https://api.binance.com/api/v3/', 'https://data-api.binance.vision/api/v3/'] };
async function api(u) {
  let last;
  for (const base of BASES[mk]) {
    for (let t = 0; t < 3; t++) {
      try {
        const r = await fetch(base + u, { signal: AbortSignal.timeout(20000) });
        if (r.status === 429 || r.status === 418) { await sleep(4000); continue; }
        if (!r.ok) { const e = new Error('HTTP ' + r.status + ' from ' + base); e.status = r.status; throw e; }
        return await r.json();
      } catch (e) { last = e; if (e.status === 451 || e.status === 403) break; }
    }
  }
  throw last || new Error('request failed');
}
async function loadUniverse() {
  let ok = null;
  const t = await api('ticker/24hr');
  if (mk === 'fut') {
    try { const ei = await api('exchangeInfo'); ok = new Set(ei.symbols.filter(s => s.contractType === 'PERPETUAL' && s.status === 'TRADING' && s.quoteAsset === 'USDT').map(s => s.symbol)); } catch { }
  }
  let L = t.filter(x => x.symbol.endsWith('USDT') && (!ok || ok.has(x.symbol)) && !(mk === 'spot' && /(UP|DOWN|BULL|BEAR)USDT$/.test(x.symbol)))
    .sort((x, y) => y.quoteVolume - x.quoteVolume);
  if (cfg.minVolM) L = L.filter(x => +x.quoteVolume >= cfg.minVolM * 1e6);
  if (cfg.topN) L = L.slice(0, cfg.topN);
  return L.map(x => x.symbol);
}
async function getKlines(sym) {
  const k = await api('klines?symbol=' + sym + '&interval=' + C.prim + '&limit=' + Math.min(C.hist || 499, 1000));
  const now = Date.now();
  return k.filter(x => x[6] < now);
}

// ---- notifications: web push (your own app) and/or ntfy ----
const repo = process.env.GITHUB_REPOSITORY || '';
const APP_URL = process.env.APP_URL || (repo ? `https://${repo.split('/')[0].toLowerCase()}.github.io/${repo.split('/')[1]}/` : undefined);
async function push(title, message, priority = 3, tags = ['bell']) {
  let ok = 0;
  const subEnv = (process.env.PUSH_SUB || '').trim();
  if (subEnv) {
    if (!process.env.VAPID_PRIVATE_KEY) throw new Error('VAPID_PRIVATE_KEY secret is not set.');
    const wp = (await import('web-push')).default;
    wp.setVapidDetails(APP_URL || 'mailto:noreply@example.com', cfg.vapidPublic, process.env.VAPID_PRIVATE_KEY.trim());
    let subs; try { subs = JSON.parse(subEnv); } catch { throw new Error('PUSH_SUB is not valid JSON. Copy the full code from the app again.'); }
    if (!Array.isArray(subs)) subs = [subs];
    for (const s of subs) {
      try {
        await wp.sendNotification(s, JSON.stringify({ title, body: message, url: APP_URL || './' }), { TTL: 3600, urgency: priority >= 4 ? 'high' : 'normal' });
        ok++;
      } catch (e) {
        console.error('Web push failed:', e.statusCode || '', (e.body || e.message || '').toString().slice(0, 200));
        if (e.statusCode === 404 || e.statusCode === 410) console.error('This phone subscription expired. Open the app, tap Phone alerts, allow again and update the PUSH_SUB secret.');
      }
    }
  }
  const topic = process.env.NTFY_TOPIC;
  if (topic) {
    const server = (process.env.NTFY_SERVER || 'https://ntfy.sh').replace(/\/$/, '');
    const body = { topic, title, message, priority, tags };
    if (APP_URL) body.click = APP_URL;
    const r = await fetch(server + '/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
    if (r.ok) ok++; else console.error('ntfy HTTP ' + r.status);
  }
  if (!ok) throw new Error('No notification could be sent. Set the PUSH_SUB and VAPID_PRIVATE_KEY secrets (see instructions).');
}

// ---- state (dedupe between runs) ----
const stateFile = process.env.STATE_FILE || path.join(root, '.state', 'seen.json');
let seen = {}, firstRun = false;
try { seen = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { firstRun = true; }
const saveState = () => {
  const cut = Date.now() - 48 * 3600e3;
  for (const k of Object.keys(seen)) if (seen[k] < cut) delete seen[k];
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify(seen));
};

// ---- main ----
(async () => {
  if (process.env.TEST === 'true') {
    await push('Mok Strategy · test', 'Notifications are working. Scanner: ' + mk + ' ' + LB(C.prim), 3, ['white_check_mark']);
    console.log('Test notification sent.');
  }

  let syms;
  try { syms = await loadUniverse(); }
  catch (e0) {
    let e = e0;
    if (mk === 'fut' && cfg.fallbackToSpot !== false && (e.status === 451 || e.status === 403)) {
      console.error('Futures blocked from this server, falling back to spot.');
      mk = 'spot'; fellBack = true;
      try { syms = await loadUniverse(); e = null; } catch (e2) { e = e2; }
    }
    if (e) {
      console.error('Binance API not reachable: ' + e.message);
      if (e.status === 451 || e.status === 403) console.error('Binance blocks this server location. Set "market" to "spot" in scanner/config.json.');
      process.exit(1);
    }
  }

  const found = [];
  let idx = 0, fail = 0;
  const worker = async () => {
    while (idx < syms.length) {
      const sym = syms[idx++];
      try {
        const k = await getKlines(sym);
        if (k.length < 60) continue;
        const r = calc(k);
        const ag = C.mode === 'ST1 Only' ? r.d1 : C.mode === 'ST2 Only' ? r.d2 : (r.d1 === r.d2 ? r.d1 : 0);
        const q = !!ag && r.tr;
        if (r.sd && r.sa <= C.fresh && (q || cfg.requireQualified === false)) {
          found.push({ sym, dir: r.sd, sT: r.sT, bars: r.sa, adx: r.adx, p: +k[k.length - 1][4], q });
        }
      } catch { fail++; }
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  console.log(`Scanned ${syms.length} symbols (${mk}, ${LB(C.prim)}), ${found.length} fresh signals, ${fail} failed requests.`);
  if (syms.length && fail > syms.length * .5) { console.error('Too many failed requests (rate limit or blocked).'); process.exit(1); }

  const newOnes = [];
  for (const r of found) {
    const key = [C.prim, r.sym, r.dir, r.sT].join('|');
    if (!(key in seen)) {
      seen[key] = Date.now();
      if (cfg.directions === 'all' || !cfg.directions || (cfg.directions === 'buy' ? r.dir > 0 : r.dir < 0)) newOnes.push(r);
    }
  }

  const tag = fellBack ? ' (spot)' : '';
  if (firstRun && process.env.TEST !== 'true') {
    await push('Mok Strategy · scanner is live', `${fellBack ? '(Spot mode: futures blocked here) ' : ''}Watching ${syms.length} ${mk === 'fut' ? 'perpetual' : 'spot'} pairs on ${LB(C.prim)}. You will be notified of new fresh signals.`, 3, ['white_check_mark']);
    console.log('First run: marked current signals as seen, sent start notification.');
  } else if (newOnes.length) {
    newOnes.sort((x, y) => y.sT - x.sT || y.adx - x.adx);
    const lines = newOnes.slice(0, 6).map(r =>
      `${r.sym.replace(/USDT$/, '')} ${r.dir > 0 ? 'BUY' : 'SELL'} ${LB(C.prim)} @ ${fmt(r.p)} · ADX ${r.adx.toFixed(1)} · ${r.bars === 0 ? 'just closed' : r.bars + ' candle' + (r.bars > 1 ? 's' : '') + ' ago'}`);
    if (newOnes.length > 6) lines.push(`+${newOnes.length - 6} more`);
    const top = newOnes[0];
    await push(`Mok Strategy${tag} · ${newOnes.length} fresh signal${newOnes.length > 1 ? 's' : ''}`, lines.join('\n'), 4, [top.dir > 0 ? 'chart_with_upwards_trend' : 'chart_with_downwards_trend']);
    console.log('Notified:\n' + lines.join('\n'));
  } else console.log('No new fresh signals.');

  saveState();
})().catch(e => { console.error(e.message || e); process.exit(1); });
