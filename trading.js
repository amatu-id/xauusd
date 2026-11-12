/* Trading AI Yulius (web, amatu-id.github.io/xauusd) — satu layar penuh. Data & seluruh perhitungan dari mesin di Web Worker
   (mesin.js: Binance + spot emas langsung dari browser, memori di IndexedDB perangkat ini). Tanpa tab: detail di jendela sembul. */
(() => {
'use strict';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const ST = { get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
             set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} } };
const LIVE_OPS = [1, 2, 5, 15, 0];      // detik antar pembaruan otomatis; 0 = jeda (hanya tombol Segarkan)
const S = { sym: ST.get('xauusd.sym', 'XAUUSDm'), mode: ST.get('xauusd.mode', 'scalp'), st: null, rk: null, tvKey: '', petaTf: null,
            peta: null, petaT: 0, modal: null,
            live: LIVE_OPS.includes(ST.get('xauusd.live', 1)) ? ST.get('xauusd.live', 1) : 1, dn: null, tOk: 0, gagal: 0, putaran: {},
            tState: 0, tRk: 0, tTick: 0, tHilang: 0, segar: false, segarHasil: null, lama: false, webBaru: false,
            web0: /^[0-9a-f]{6,}$/.test(document.documentElement.dataset.web || '') ? document.documentElement.dataset.web : '' };
(() => { const q = new URLSearchParams(location.search);       // ?sym=XAUUSDm&mode=swing (opsional)
  if (['BTCUSDT', 'XAUUSDm'].includes(q.get('sym'))) S.sym = q.get('sym');
  if (['scalp', 'swing'].includes(q.get('mode'))) S.mode = q.get('mode'); })();
const TFS = { scalp: ['5m', '15m', '1h'], swing: ['1h', '4h', '1d'] };
const TV_INT = { scalp: '5', swing: '60' };

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (x, dp = 2) => (x == null || !isFinite(x)) ? '-' : (+x).toLocaleString('id-ID', { minimumFractionDigits: dp, maximumFractionDigits: dp });
const pct = (x, dp = 0) => (x == null || !isFinite(x)) ? '-' : fmt(x, dp) + '%';
const sR = (x, dp = 2) => (x == null || !isFinite(x)) ? '-' : (x > 0 ? '+' : '') + fmt(x, dp) + 'R';
const sgn = x => (x > 0 ? '+' : '');
const wib = (t, opt = { hour: '2-digit', minute: '2-digit' }) => t ? new Date(t).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', ...opt }) : '-';
const tgl = t => wib(t, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
const sejak = t => (wib(t, { day: '2-digit', month: '2-digit' }) === wib(Date.now(), { day: '2-digit', month: '2-digit' }) ? wib(t) : tgl(t));   // + tanggal bila bukan hari ini
const dpOf = () => S.st?.cfg?.dp ?? 2;
const kls = a => a === 'BUY' ? 'up' : a === 'SELL' ? 'dn' : 'wt';
const isAksi = a => a === 'BUY' || a === 'SELL';
/** Label status rencana: posisi yang sudah berjalan = "SELL berjalan" (bukan entry baru), selain itu "SELL SIAP" dst. */
const labelRencana = (aksi, status) => !aksi ? '' : aksi === 'TUNGGU' ? 'TUNGGU' : status === 'AKTIF' ? aksi + ' berjalan' : aksi + (status ? ' ' + status : '');
const TFL = tf => String(tf || '').toUpperCase();

/* Jembatan ke mesin (Web Worker). api('/api/state?sym=..&mode=..', {method, body}) sama seperti daemon AI Yulius. */
const MESIN = { w: null, id: 0, janji: new Map(), galat: '' };
function mesinMulai() {
  try {
    MESIN.w = new Worker('mesin.js?v=' + (S.web0 || 'dev'));
    MESIN.w.onmessage = ev => { const d = ev.data || {}, j = MESIN.janji.get(d.id); if (!j) return; MESIN.janji.delete(d.id); clearTimeout(j.tm); d.ok ? j.ok(d.hasil) : j.gagal(new Error(d.galat || 'galat mesin')); };
    MESIN.w.onerror = e => { MESIN.galat = (e && e.message) || 'skrip mesin gagal dimuat'; console.error('mesin', e); };
  } catch (e) { MESIN.galat = e.message; }
}
function api(path, opt = {}) {
  if (!MESIN.w) return Promise.reject(new Error(MESIN.galat || 'mesin belum berjalan'));
  const u = new URL(path, location.href), q = Object.fromEntries(u.searchParams.entries());
  let body = opt.body; try { body = typeof body === 'string' ? JSON.parse(body) : body; } catch (e) { body = {}; }
  const id = ++MESIN.id, lama = /segarkan/.test(path) ? 60000 : 30000;
  return new Promise((ok, gagal) => {
    const tm = setTimeout(() => { MESIN.janji.delete(id); gagal(new Error(MESIN.galat || 'mesin tidak menjawab')); }, lama);
    MESIN.janji.set(id, { ok, gagal, tm });
    MESIN.w.postMessage({ id, path: path.startsWith('/') ? u.pathname.replace(/^.*\/api\//, '/api/') : path, q, body, metode: (opt.method || 'GET').toUpperCase() });
  });
}
function toast(t, ms = 2400) { const el = $('#toast'); el.textContent = t; el.classList.remove('hidden'); clearTimeout(toast._t); toast._t = setTimeout(() => el.classList.add('hidden'), ms); }

/* ---------------- TradingView ---------------- */
function tv() {
  const sym = S.st?.cfg?.tv || (S.sym === 'XAUUSDm' ? 'OANDA:XAUUSD' : 'BINANCE:BTCUSDT');
  const key = sym + '|' + S.mode + '|' + (document.documentElement.dataset.theme || 'dark');
  if (key === S.tvKey) return;
  S.tvKey = key;
  if (!window.TradingView) { $('#tv-off').classList.remove('hidden'); return; }
  $('#tv-off').classList.add('hidden');
  $('#tv').innerHTML = '';
  const light = document.documentElement.dataset.theme === 'light';
  /* eslint-disable no-new */
  new window.TradingView.widget({
    container_id: 'tv', autosize: true, symbol: sym, interval: TV_INT[S.mode], timezone: 'Asia/Jakarta',
    theme: light ? 'light' : 'dark', style: '1', locale: 'id', enable_publishing: false, allow_symbol_change: true,
    hide_side_toolbar: false, hide_top_toolbar: false, withdateranges: false, details: false, hotlist: false, calendar: false,
    save_image: true, toolbar_bg: light ? '#ffffff' : '#12151c', studies: ['STD;EMA'],
  });
}

/* ---------------- header ---------------- */
function renderPairs() {
  const rk = S.rk || {};
  $$('.pair').forEach(b => {
    const s = b.dataset.sym, d = rk[s] || {};
    b.classList.toggle('on', s === S.sym);
    $('[data-px]', b).textContent = fmt(d.harga, 2);
    const c = $('[data-chg]', b);
    c.textContent = d.chg24 == null ? '' : sgn(d.chg24) + fmt(d.chg24, 2) + '% 24j';
    c.className = 'pc ' + (d.chg24 > 0 ? 'up' : d.chg24 < 0 ? 'dn' : '');
    const m = (d.mode || {})[S.mode] || {}, pa = m.pa || {};
    const g = $('[data-sig]', b);
    if (isAksi(pa.aksi)) { g.textContent = 'PA ' + pa.aksi; g.className = 'ps ' + kls(pa.aksi); }
    else { g.textContent = labelRencana(m.aksi, m.status); g.className = 'ps ' + kls(m.aksi); }
  });
  $$('#mode-seg button').forEach(b => b.classList.toggle('on', b.dataset.mode === S.mode));
}

function renderFeeds(st) {
  const f = st.feed; if (!f) return;
  const now = Date.now(), age = t => t ? (now - t) / 1000 : 1e9;
  const dot = (ok, warn) => `<i class="${ok ? 'ok' : warn ? 'warn' : 'bad'}"></i>`;
  const sp = f.spot || {}, bl = st.belajar || {};
  let h = `<span data-tip="feed" data-a="binance">${dot(age(f.binance) < 15)}<em>Binance</em></span>`;
  h += `<span data-tip="feed" data-a="spot">${dot(sp.tutup || age(sp.t) < 60, true)}<em>Spot emas${sp.tutup ? ' (tutup)' : ''}</em></span>`;
  h += `<span data-tip="feed" data-a="proxy">${dot(!!(f.rasio_xau || {}).sumber && (sp.tutup || age((f.rasio_xau || {}).t) < 120), true)}<em>XAU proxy</em></span>`;
  h += `<span data-tip="feed" data-a="memori">${dot(bl.siap && !bl.proses, bl.proses)}<em>Memori${bl.proses ? ' (belajar)' : ''}</em></span>`;
  $('#feeds').innerHTML = h;
}

/* ---------------- kolom 2: keputusan ---------------- */
function renderKeputusan(st) {
  const k = st.rencana?.utama || {}, p = st.pa || {}, pr = (st.prediksi || [])[0], el = $('#keputusan');
  const pa = p.aksi, pl = k.aksi, dp = dpOf();
  // posisi strategi yang sudah berjalan BUKAN entry baru: entry lamanya sudah lewat dan SL trailing-nya bisa sudah melewati entry
  const ps = k.status === 'AKTIF' && isAksi(pl) ? (k.posisi || {}) : null, plBaru = ps ? null : pl;
  let aksi = 'TUNGGU', kelas = 'wait', judul = 'Belum ada setup yang lolos', sub = [];
  if (isAksi(pa) && isAksi(plBaru) && pa === plBaru) { aksi = pa; kelas = pa === 'BUY' ? 'buy' : 'sell'; judul = `${pa} · price action dan strategi sepakat`; }
  else if (isAksi(pa) && isAksi(plBaru)) { aksi = 'HATI-HATI'; kelas = 'warn'; judul = `Price action ${pa} berlawanan dengan strategi ${plBaru}`; }
  else if (isAksi(pa) && ps && pa !== pl) { aksi = 'HATI-HATI'; kelas = 'warn'; judul = `Price action ${pa} berlawanan dengan posisi ${pl} strategi yang sedang berjalan`; }
  else if (isAksi(pa)) { aksi = pa; kelas = pa === 'BUY' ? 'buy' : 'sell'; judul = `${pa} dari ${p.nama} ${TFL(p.tf)} · ${p.jenis_entry || ''} ${fmt(p.entry, dp)}${ps ? ' · searah posisi strategi' : ''}`; }
  else if (isAksi(plBaru)) { aksi = plBaru; kelas = plBaru === 'BUY' ? 'buy' : 'sell'; judul = `${plBaru} dari strategi · ${k.jenis_entry || ''} ${k.entry != null ? fmt(k.entry, dp) : ''}`; }
  else if (ps) {
    aksi = 'BERJALAN'; kelas = 'jalan';
    judul = ps.kena_sl ? `Posisi ${pl} strategi menyentuh SL ${fmt(k.sl, dp)} · bukan entry baru` : `Posisi ${pl} strategi berjalan sejak ${sejak(ps.sejak || k.t_sinyal)} WIB · bukan entry baru`;
  }
  else if (!st.siap) judul = 'Menyiapkan data riwayat…';
  if (ps) sub.push(`Strategi: ${pl} berjalan, ${ps.terisi || 1} layer, SL ${ps.sl_geser ? 'trailing ' : ''}${fmt(k.sl, dp)}` +
    (ps.r_sl != null ? (ps.kunci ? ' kunci ' : ' bila kena ') + sR(ps.r_sl) : '') + ' · belum ikut: jangan kejar');
  else sub.push(`Strategi: ${pl ? labelRencana(pl, k.status) : '-'}`);
  sub.push(`Price action: ${pa || '-'}`);
  if (pr) sub.push(`Prediksi ${pr.label}: ${pr.p_naik >= 50 ? 'naik' : 'turun'} ${fmt(Math.max(pr.p_naik, 100 - pr.p_naik), 0)}%`);
  el.className = 'panel keputusan ' + kelas;
  $('#kp-aksi').textContent = aksi;
  $('#kp-judul').textContent = judul;
  $('#kp-sub').textContent = sub.join(' · ');
  const u = st.ketidakpastian;
  if (u && u.label) {
    const top = [...(u.komponen || [])].sort((a, b) => b.nilai - a.nilai)[0];
    $('#unc').innerHTML = `<span class="muted">Ketidakpastian</span><div class="bar"><i style="width:${Math.max(3, Math.min(100, u.skor))}%"></i></div>
      <b class="${u.skor >= 50 ? 'dn' : u.skor >= 30 ? 'wt' : 'up'}">${esc(u.label)} ${fmt(u.skor, 0)}</b>
      <span class="cap">${top ? esc(top.nama + ': ' + top.teks) + ' · ' : ''}${esc(u.cara || '')}</span>`;
  } else $('#unc').innerHTML = '<span class="cap">Indeks ketidakpastian aktif setelah memori belajar siap.</span>';
  const kb = st.kebiasaan || {}, rz = kb.rezim || {}, ad = kb.adr;
  $('#kondisi').innerHTML = [
    rz.tren_4h ? `<span class="chip" data-tip="tren4h">Tren 4H <b class="${rz.arah_4h > 0 ? 'up' : rz.arah_4h < 0 ? 'dn' : 'wt'}">${esc(rz.tren_4h)}</b></span>` : '',
    rz.vol ? `<span class="chip" data-tip="vol">Volatilitas <b>${esc(rz.vol)}</b> p${fmt(rz.vol_persentil, 0)}</span>` : '',
    kb.sesi_kini ? `<span class="chip" data-tip="sesi_kini">Sesi <b>${esc(kb.sesi_kini)}</b></span>` : '',
    ad ? `<span class="chip" data-tip="adr_pakai">ADR terpakai <b>${pct(ad.persen)}</b></span>` : '',
    rz.pengali_risiko && rz.pengali_risiko < 1 ? `<span class="chip warn-txt" data-tip="risiko">Risiko x${fmt(rz.pengali_risiko, 2)}</span>` : '',
  ].join('');
}

function lvBox(cls, label, v, px, note, prob, tip) {
  const dp = dpOf(), d = (v != null && px) ? v - px : null;
  return `<div class="${cls}"${tip ? ` data-tip="lv" data-a="${tip}"` : ''}><span>${label}<em>${d == null ? '' : sgn(d) + fmt(d, dp)}</em></span><b>${fmt(v, dp)}</b>` +
    (note ? `<em>${note}</em>` : '') + (prob != null ? `<div class="pb"><i style="width:${Math.max(2, Math.min(100, prob * 100))}%"></i></div>` : '') + '</div>';
}

function renderPA(st) {
  const p = st.pa || {}, el = $('#pa'), dp = dpOf(), px = st.harga, bl = st.belajar || {};
  el.classList.remove('buy', 'sell');
  const val = p.validasi || {};
  $('#pa-chips').innerHTML = Object.entries(val).map(([tf, v]) => `<span class="chip v-${esc(v.status || '')}" data-tip="val" data-a="${esc(tf)}">${TFL(tf)} ${esc(v.status || 'belum')}</span>`).join(' ');
  if (!bl.siap) {
    $('#pa-body').innerHTML = `<div class="kosong">${bl.proses ? 'Memori belajar sedang diisi dari riwayat candle…' : 'Memori belajar belum siap.'}</div>`;
    $('#btn-salin-pa').disabled = true; return;
  }
  let h = '';
  if (p.entry != null && (isAksi(p.aksi) || p.aksi === 'PANTAU')) {
    if (isAksi(p.aksi)) el.classList.add(p.aksi === 'BUY' ? 'buy' : 'sell');
    const arah = p.arah > 0 ? 'BUY' : 'SELL';
    h += `<div class="sig-h" data-tip="pa_sig"><span class="badge ${esc(p.aksi)}">${esc(p.aksi === 'PANTAU' ? 'PANTAU ' + arah : p.aksi)}</span>
      <div class="t"><b>${esc(p.nama)} · ${TFL(p.tf)} · ${esc(p.jenis_entry || '')}</b><small>${esc(p.konteks || '')}</small></div>
      <span class="chip ${p.yakin === 'Tinggi' ? 'g-A' : p.yakin === 'Sedang' ? 'g-B' : 'g-C'}" data-tip="pa_yakin">${esc(p.yakin || '')}</span></div>`;
    const tp = p.tp || [], tk = p.tp_k || [], tpp = p.tp_p || [];
    h += `<div class="lv">${lvBox('e', 'Entry', p.entry, px, p.aksi === 'PANTAU' ? 'pantau, belum rekomendasi' : esc(p.jenis_entry || ''), null, 'pa:e')}
      ${lvBox('s', 'Stop loss', p.sl, px, `1R = ${fmt(p.r, dp)} · struktural`, null, 'pa:s')}
      ${[0, 1, 2].map(i => lvBox('t', `TP${i + 1} ${fmt(tk[i], 2)}R`, tp[i], px, `peluang ${pct((tpp[i] || 0) * 100)}`, tpp[i], 'pa:t' + i)).join('')}
      <div data-tip="lv" data-a="pa:ek"><span>Ekspektasi</span><b class="${(p.e_kal || 0) > 0 ? 'up' : 'dn'}">${sR(p.e_kal)}</b><em>terkalibrasi uji</em></div></div>`;
    const v = val[p.tf] || {}, lt = p.lot;
    h += `<div class="stat"><span data-tip="pa_mem">Memori <b>${fmt(p.n, 0)}</b> serupa · <b>${fmt(p.n_maju, 0)}</b> maju</span>
      ${v.n_lolos ? `<span data-tip="pa_uji">Uji ${TFL(p.tf)} <b>${pct(v.tp1)}</b> TP1 · <b>${sR(v.e_lolos)}</b></span>` : ''}
      ${lt ? `<span data-tip="lot" data-a="pa">Lot <b>${lt.lot}</b> · rugi SL <b>${fmt(lt.rugi_sl, 0)} ${esc(lt.mata_uang)}</b></span>` : ''}
      ${p.pengali && p.pengali < 1 ? `<span class="warn-txt" data-tip="pa_pengali">risiko x${fmt(p.pengali, 2)}</span>` : ''}</div>`;
    h += `<ul class="alasan">${(p.alasan_teks || []).slice(1).map(a => `<li ${tipTeks('Alasan sinyal', a)}>${esc(a)}</li>`).join('')}${p.batal ? `<li ${tipTeks('Sinyal batal bila', p.batal)}>${esc(p.batal)}</li>` : ''}</ul>`;
  } else {
    h += `<div class="sig-h" data-tip="pa_sig"><span class="badge TUNGGU">TUNGGU</span><div class="t"><b>Belum ada pola segar yang layak</b>
      <small>Setiap candle ${(st.mode === 'scalp' ? 'M5/M15' : 'H1/H4')} yang tutup diperiksa otomatis</small></div></div>`;
    const pn = p.pantau || [];
    if (pn.length) {
      h += `<table><tr><th>Pantau level</th><th class="n">Harga</th><th class="n">Jarak</th><th>Skenario terbaik</th><th class="n">TP1</th><th class="n">Ekspektasi</th></tr>
        ${pn.map((x, i) => `<tr data-tip="pantau" data-a="${i}">
          <td>${esc(x.level)}</td><td class="n">${fmt(x.harga, dp)}</td><td class="n">${sgn(x.jarak_atr)}${fmt(x.jarak_atr, 1)} ATR</td>
          <td class="${x.arah > 0 ? 'up' : 'dn'}">${esc(x.skenario)}: ${esc(x.nama)} ${x.arah > 0 ? 'BUY' : 'SELL'}</td><td class="n">${pct(x.p1 * 100)}</td>
          <td class="n ${x.e > 0 ? 'up' : 'dn'}">${sR(x.e)}</td></tr>`).join('')}</table>`;
      if (pn.some(x => x.validasi !== 'aktif')) h += `<div class="mini" data-tip="val_st" data-a="${esc(pn[0].validasi)}">Skenario dari memori ${TFL(pn[0].tf)} (uji walk-forward: ${esc(pn[0].validasi)}): pantauan, bukan rekomendasi.</div>`;
    } else h += '<div class="kosong">Tidak ada level kunci dekat harga.</div>';
  }
  const lain = (p.calon || []).filter(c => c.id !== p.id).slice(0, 3);
  if (lain.length) h += lain.map((c, i) => `<div class="mini" data-tip="calon" data-a="${i}"><b class="${c.arah > 0 ? 'up' : 'dn'}">${esc(c.nama)} ${c.arah > 0 ? 'BUY' : 'SELL'} ${TFL(c.tf)}</b>
    ${wib(c.t_tutup)} · ${esc(c.status.toLowerCase())}: ${esc(c.alasan || '')}</div>`).join('');
  const hs = bl.terakhir || [];
  h += `<div class="sub mini-sub" data-tip="hasil_h">Hasil pola maju terakhir (dinilai otomatis)</div>` + (hs.length ? `<div class="hasil">${hs.slice(0, 8).map((x, i) =>
    `<span data-tip="hasil" data-a="${i}"
      class="${x.r1 > 0 ? 'ok' : 'no'}${x.disarankan ? ' sar' : ''}"><b>${TFL(x.tf)}</b> ${esc(x.nama)} ${x.arah > 0 ? 'BUY' : 'SELL'} <i>${x.r1 > 0 ? 'capai 1R' : x.kena_sl ? 'kena SL' : sR(x.r1)}</i></span>`).join('')}</div>`
    : '<div class="mini">Belum ada pola maju yang selesai dinilai (M5 butuh hingga 3 jam, M15 8 jam).</div>');
  $('#pa-body').innerHTML = h;
  $('#btn-salin-pa').disabled = !st.order_teks_pa;
}

function renderRencana(st) {
  const rc = st.rencana || {}, k = rc.utama, dp = dpOf(), px = st.harga;
  if (!k) { $('#rc-body').innerHTML = `<div class="kosong">${st.siap ? 'Menghitung rencana…' : (st.riwayat ? `Mengunduh ${esc(st.riwayat.sym)} ${esc(st.riwayat.tf)}…` : 'Menyiapkan data riwayat…')}</div>`; return; }
  $('#rc-sub').textContent = `${k.nama} · ${TFL(k.tf)}`;
  $('#rc-chips').innerHTML = `<span class="chip st-${esc(k.status)}" data-tip="rc_status">${esc(k.status)}</span> <span class="chip g-${esc(k.grade)}" data-tip="rc_grade">Grade ${esc(k.grade || '-')} · ${esc(k.yakin || '')}</span>`;
  const ps = k.status === 'AKTIF' && k.aksi !== 'TUNGGU' ? k.posisi : null;
  let h;
  if (ps) h = `<div class="sig-h" data-tip="rc_sig"><span class="badge ${esc(k.aksi)}">${esc(k.aksi)}</span><div class="t"><b>Posisi berjalan sejak ${sejak(ps.sejak)} WIB · ${ps.terisi} layer terisi</b>
    <small>Bukan entry baru — yang belum ikut: tunggu sinyal berikutnya · basket <span class="${ps.r_kini > 0 ? 'up' : 'dn'}">${sR(ps.r_kini)}</span>${ps.uang_kini != null ? ` (${sgn(ps.uang_kini)}${fmt(ps.uang_kini, 0)} ${esc(ps.mata_uang || '')})` : ''}</small></div></div>`;
  else h = `<div class="sig-h" data-tip="rc_sig"><span class="badge ${esc(k.aksi)}">${esc(k.aksi)}</span><div class="t"><b>${k.aksi === 'TUNGGU' ? 'Belum ada entry' : esc((k.jenis_entry || '') + (k.entry != null ? ' ' + fmt(k.entry, dp) : ''))}</b>
    <small>${esc(k.pemicu || '')}${k.berlaku ? ' · ' + esc(k.berlaku) : ''}${k.status === 'AKTIF' && k.maju_r != null ? ` · posisi ${sR(k.maju_r)}` : ''}</small></div></div>`;
  if (ps && k.entry != null) {
    const tp = k.tp || [], pel = (k.statistik || {}).tp_peluang || {}, kena = i => ps.terbaik != null && tp[i] != null && (ps.terbaik - tp[i]) * k.arah >= 0;
    const catSL = ps.kena_sl ? '<i class="dn">sudah tersentuh</i>' : ps.kunci ? `<i class="up">kunci ${sR(ps.r_sl)}</i>` : `bila kena ${sR(ps.r_sl)}`;
    h += `<div class="lv lima">${lvBox('e', 'Entry L1', k.entry, px, ps.terisi > 1 ? `rata² ${fmt(ps.avg, dp)}` : `terisi ${sejak(ps.sejak)}`, null, 'rc:e')}${lvBox('s', ps.sl_geser ? 'SL trailing' : 'SL', k.sl, px, catSL, null, 'rc:s')}
      ${[0, 1, 2].map(i => lvBox(kena(i) ? 't lewat' : 't', `TP${i + 1}`, tp[i], px, kena(i) ? 'sudah tersentuh' : pel[(i + 1) + 'R'] != null ? `peluang ${pct(pel[(i + 1) + 'R'])}` : '', null, 'rc:t' + i)).join('')}</div>`;
  } else if (k.entry != null && k.aksi !== 'TUNGGU') {
    const tp = k.tp || [], pel = (k.statistik || {}).tp_peluang || {};
    h += `<div class="lv lima">${lvBox('e', 'Entry', k.entry, px, '', null, 'rc:e')}${lvBox('s', 'SL', k.sl, px, k.r0 ? `1R ${fmt(k.r0, dp)}` : '', null, 'rc:s')}
      ${[0, 1, 2].map(i => lvBox('t', `TP${i + 1}`, tp[i], px, pel[(i + 1) + 'R'] != null ? `peluang ${pct(pel[(i + 1) + 'R'])}` : '', null, 'rc:t' + i)).join('')}</div>`;
  } else if (k.range) h += `<div class="mini" data-tip="rc_range">Range sesi <b>${fmt(k.range[0], dp)} - ${fmt(k.range[1], dp)}</b></div>`;
  const L = ps ? (k.layer || []) : (k.layer || []).slice(1);
  if (ps && L.length) h += `<div class="mini" data-tip="rc_layer">Layer: ${L.map(x => x.jenis === 'Terisi' ? `L${x.ke} <b>${fmt(x.harga, dp)}</b> <span class="up">terisi</span>`
    : `L${x.ke} <b>${fmt(x.harga, dp)}</b> ${x.jenis === 'Tambah berikutnya' ? esc(((ps.berikut || {}).jenis || 'berikutnya').toLowerCase()) : 'menunggu ruang SL'}${x.sl_basket != null ? ` → SL ${fmt(x.sl_basket, dp)}` : ''}`).join(' · ')}</div>`;
  else if (L.length) h += `<div class="mini" data-tip="rc_layer">Layer: ${L.map(x => `L${x.ke} <b>${fmt(x.harga, dp)}</b>`).join(' · ')}</div>`;
  const lt = k.lot;
  if (lt && ps) h += `<div class="mini" data-tip="lot" data-a="rc">Lot <b>${lt.lot}</b>/layer × ${ps.terisi} terisi · bila SL kena <b class="${ps.r_sl > 0 ? 'up' : 'dn'}">${ps.uang_sl != null ? sgn(ps.uang_sl) + fmt(ps.uang_sl, 0) + ' ' + esc(lt.mata_uang) : sR(ps.r_sl)}</b> (${sR(ps.r_sl)})${k.trailing ? ' · ' + esc(k.trailing) : ''}</div>`;
  else if (lt) h += `<div class="mini" data-tip="lot" data-a="rc">Lot <b>${lt.lot}</b>/layer · risiko ${fmt(lt.risiko, 0)} ${esc(lt.mata_uang)} (${fmt(lt.risiko_pct, 2)}%) · rugi SL <b>${fmt(lt.rugi_sl, 0)}</b>${k.trailing ? ' · ' + esc(k.trailing) : ''}</div>`;
  if (ps && ps.sl_geser && ps.sl_awal != null) h += `<div class="mini" data-tip="rc_slgeser">SL awal <b>${fmt(ps.sl_awal, dp)}</b> (${k.arah < 0 ? 'di atas' : 'di bawah'} entry, 1R ${fmt(k.r0, dp)}) sudah digeser trailing ke <b>${fmt(k.sl, dp)}</b>: tetap ${k.arah < 0 ? 'di atas' : 'di bawah'} harga` +
    (ps.kunci ? `, <span class="up">melewati ${ps.terisi > 1 ? 'harga rata-rata' : 'entry'} → untung terkunci</span>.` : '.') + '</div>';
  if (lt && lt.catatan) h += `<div class="mini warn-txt" ${tipTeks('Catatan lot', lt.catatan)}>${esc(lt.catatan)}</div>`;
  if (st.konflik) h += `<div class="mini warn-txt" ${tipTeks('Konflik sinyal', st.konflik)}>${esc(st.konflik)}</div>`;
  if (st.offset_exness != null && k.entry != null) h += `<div class="mini" data-tip="rc_offset">Harga Exness BTCUSDm ${sgn(st.offset_exness)}${fmt(st.offset_exness, 2)} dari Binance: geser level sebesar itu.</div>`;
  const s = k.statistik || {}, fw = k.forward;
  h += `<div class="stat">${s.pf != null ? `<span data-tip="rc_pf">PF <b>${fmt(s.pf, 2)}</b></span>` : ''}${s.wr != null ? `<span data-tip="rc_wr">Menang <b>${pct(s.wr)}</b></span>` : ''}
    ${s.n ? `<span data-tip="rc_n">Sampel <b>${s.n}</b></span>` : ''}${s.dd95 != null ? `<span data-tip="rc_dd95">DD95 <b>${fmt(s.dd95, 1)}R</b></span>` : ''}
    ${s.sumber ? `<span data-tip="rc_sumber">${esc(s.sumber)}</span>` : ''}${fw && fw.n ? `<span data-tip="rc_fwd">Forward <b>${fw.n}</b> · ${pct(fw.wr)} · <b>${fmt(fw.sum, 1)}R</b></span>` : ''}</div>`;
  $('#rc-body').innerHTML = h;
  $('#btn-salin').disabled = !st.order_teks;
  const alt = (rc.calon || []).slice(1);
  $('#btn-alt').textContent = alt.length ? `Strategi lain (${alt.length})` : 'Strategi lain';
}

function renderPrediksi(st) {
  const P = st.prediksi || [], ak = st.akurasi || {}, nyata = st.akurasi_nyata || {}, dp = dpOf();
  if (!P.length) { $('#prediksi').innerHTML = '<div class="kosong">Prediksi muncul setelah data cukup.</div>'; return; }
  $('#prediksi').innerHTML = P.map((p, i) => {
    const a = ak[p.label], n = nyata[p.label], up = p.p_naik;
    return `<div class="pr" data-tip="pred" data-a="${i}"><div class="pr-h"><b>${esc(p.label)}</b><span><span class="${up >= 50 ? 'up' : 'dn'}">${up >= 50 ? 'Naik' : 'Turun'} ${fmt(Math.max(up, 100 - up), 0)}%</span>
      <span class="muted">· dasar ${fmt(p.p_dasar, 0)}% · ${a ? `akurasi uji ${fmt(a.arah, 0)}%` : 'akurasi: menunggu lab'}${n && n.n ? ` · nyata ${fmt(n.arah_pct, 0)}%/${n.n}` : ''}</span></span></div>
      <div class="bar2"><i style="width:${Math.max(2, Math.min(98, up))}%"></i><u style="left:${p.p_dasar}%"></u></div>
      <div class="pr-r"><span>Median <b>${fmt(p.median, dp)}</b></span><span>Rentang 80% <b>${fmt(p.q10, dp)} - ${fmt(p.q90, dp)}</b></span></div></div>`;
  }).join('');
}

/* ---------------- kolom 3: memori & belajar ---------------- */
function warnaHeat(v, min, max) {
  const t = max > min ? (v - min) / (max - min) : 0;
  return `hsla(${220 - t * 200}, 80%, ${45 + t * 10}%, ${0.25 + t * 0.7})`;
}
function renderKebiasaan(st) {
  const kb = st.kebiasaan || {}, dp = dpOf();
  if (!kb.jam) { $('#kb-body').innerHTML = '<div class="kosong">Memori kebiasaan sedang dibangun…</div>'; return; }
  $('#kb-t').textContent = 'diperbarui ' + wib(kb.t);
  const jam = [...kb.jam].sort((a, b) => a.jam_wib - b.jam_wib);
  const mn = Math.min(...jam.map(j => j.range)), mx = Math.max(...jam.map(j => j.range));
  const kini = (new Date().getUTCHours() + 7) % 24;
  const jMin = jam.find(j => j.range === mn), jMax = jam.find(j => j.range === mx);
  let h = `<div class="heat">${jam.map(j => `<div class="${j.jam_wib === kini ? 'kini' : ''}" data-tip="jam" data-a="${j.jam_wib}" style="background:${warnaHeat(j.range, mn, mx)}"></div>`).join('')}</div>
    <div class="heat-leg" data-tip="heat_leg"><span>00 WIB</span><span>sepi ${fmt(mn, dp)} (${HH(jMin.jam_wib)}) · ramai ${fmt(mx, dp)} (${HH(jMax.jam_wib)})</span><span>23 WIB</span></div>`;
  const a = kb.asia || {}, ad = kb.adr, sy = kb.syok || {};
  const kv = (k, label, isi) => `<span data-tip="${k}">${label}</span><b data-tip="${k}">${isi}</b>`;
  h += `<div class="kb2"><table><tr><th>Sesi</th><th>WIB</th><th class="n">Range</th><th class="n">Naik</th></tr>
    ${(kb.sesi || []).map((s, i) => `<tr class="${s.nama === kb.sesi_kini ? 'now' : ''}" data-tip="sesi" data-a="${i}"><td>${esc(s.nama)}</td><td>${esc(s.jam_wib)}</td><td class="n">${fmt(s.range, dp)}</td><td class="n">${fmt(s.p_naik, 0)}%</td></tr>`).join('')}</table>
    <div class="kv">${a.hari ? kv('asia', 'Range awal hari', `pecah ${pct(a.p_pecah)} · lanjut <span class="up">${pct(a.p_lanjut)}</span> · balik <span class="dn">${pct(a.p_palsu)}</span>`) : ''}
      ${ad ? kv('adr20', 'ADR20', `${fmt(ad.adr20, dp)} · hari ini ${pct(ad.persen)}`) + kv('proyeksi', 'Proyeksi', `${fmt(ad.proyeksi_bawah, dp)} - ${fmt(ad.proyeksi_atas, dp)}`) : ''}
      ${sy.n >= 8 ? kv('syok', 'Candle 1H besar', `lanjut ${pct(sy.p_lanjut)} · balik ${pct(sy.p_balik)}`) : ''}
      ${kv('persisten', 'Warna berulang', `4H ${pct(kb.persisten_4h)} · 1D ${pct(kb.persisten_1d)}`)}</div></div>`;
  $('#kb-body').innerHTML = h;
}

function renderBelajar(st) {
  const bl = st.belajar || {}, pg = bl.progres || {}, ak = bl.akurasi || {}, tbl = bl.tabel || [];
  if (!bl.siap) { $('#bl-body').innerHTML = `<div class="kosong">${bl.proses ? 'Mengisi memori dari riwayat candle (sekali, ±10 detik)…' : 'Menunggu memori belajar.'}</div>`; return; }
  $('#bl-sub').textContent = `${fmt((pg.riwayat || 0) + (pg.maju || 0), 0)} kejadian`;
  let h = `<div class="mini" data-tip="bl_maju">Maju (sejak perangkat ini merekam) <b>${fmt(pg.maju, 0)}</b> · hari ini baru <b>${fmt(pg.baru_hari_ini, 0)}</b> · dinilai <b>${fmt(pg.selesai_hari_ini, 0)}</b>, capai 1R <b>${fmt(pg.kena1r_hari_ini, 0)}</b> · berjalan <b>${fmt(pg.berjalan, 0)}</b></div>`;
  h += `<div class="val">${Object.entries(bl.validasi || {}).map(([tf, v]) => v ? `<span class="chip v-${esc(v.status)}" data-tip="val" data-a="${esc(tf)}">
      ${TFL(tf)} uji ${esc(v.status)} · ${fmt(v.n_lolos, 0)} sinyal · <b>${sR(v.e_lolos)}</b> · TP1 ${pct(v.tp1)}</span>` : '').join('')}</div>`;
  h += `<div class="mini" data-tip="bl_akurasi">Sinyal yang disarankan (maju): ${ak.n ? `<b>${ak.n}</b> selesai · TP1 <b>${pct(ak.tp1)}</b> · TP2 <b>${pct(ak.tp2)}</b> · total <b class="${ak.total > 0 ? 'up' : 'dn'}">${sR(ak.total)}</b>` : 'belum ada yang selesai (dinilai otomatis)'}</div>`;
  if (tbl.length) h += `<table><tr><th>TF</th><th>Pola</th><th class="n">n</th><th class="n">1R</th><th class="n">TP opt</th><th class="n">Ekspektasi</th><th>30 hari</th></tr>
    ${tbl.slice(0, 8).map((r, i) => `<tr data-tip="pola" data-a="${i}">
      <td>${TFL(r.tf)}</td><td class="${r.arah > 0 ? 'up' : 'dn'}">${esc(r.nama)} ${r.arah > 0 ? 'BUY' : 'SELL'}</td><td class="n">${fmt(r.n, 0)}</td>
      <td class="n">${pct(r.p1r)}</td><td class="n">${fmt(r.k[1], 2)}R ${pct(r.p[1] * 100)}</td><td class="n ${r.e > 0 ? 'up' : 'dn'}">${sR(r.e)}</td>
      <td class="drift ${r.drift && r.drift.status === 'melemah' ? 'dn' : r.drift && r.drift.status === 'menguat' ? 'up' : 'dim'}">${r.drift ? esc(r.drift.status) : '-'}</td></tr>`).join('')}</table>`;
  else h += '<div class="kosong">Tabel pola muncul setelah statistik pertama dihitung.</div>';
  $('#bl-body').innerHTML = h;
}

function rekapItem(st) {
  const r = st.rekap || {}, it = [];
  (r.harian || []).slice(0, 1).forEach(x => it.push(['harian', x]));
  (r.sesi || []).slice(0, 1).forEach(x => it.push(['sesi', x]));
  (r.jam || []).slice(0, 2).forEach(x => it.push(['jam', x]));
  return it;
}
function renderRekap(st) {
  const it = rekapItem(st);
  $('#rk-body').innerHTML = it.length ? it.map(([j, x], i) => `<div class="rki ${j}" data-tip="rekap" data-a="${i}"><div class="rh"><span class="tag">${esc(j)}</span><b>${esc(x.judul)}</b></div><p>${esc(x.isi)}</p></div>`).join('')
    : '<div class="kosong">Rekap pertama ditulis setelah jam/sesi/hari pertama selesai direkam.</div>';
}

function renderAktivitas(st) {
  const P = st.pikiran || [];
  $('#ak-body').innerHTML = P.length ? P.slice(0, 7).map((p, i) => `<div class="pk" data-tip="pikir" data-a="${i}"><time>${wib(p.t)}</time><span class="j">${esc(p.jenis)}</span><span>${esc(p.isi)}</span></div>`).join('')
    : '<div class="kosong">Keputusan otonom (lab, belajar, sinyal, refleksi) muncul di sini.</div>';
}

function renderGerak(st) {
  const G = (st.gerak || []).filter(Boolean);
  $('#gerak').innerHTML = G.length ? G.map((g, i) => `<div class="gr" data-tip="gerak" data-a="${i}"><b>${TFL(g.tf)}</b><span class="${g.arah > 0 ? 'up' : g.arah < 0 ? 'dn' : ''}">${esc(g.teks)}</span></div>`).join('')
    : '<div class="gr"><b>-</b><span class="muted">Analisis tiap candle tutup muncul setelah memori belajar siap.</span></div>';
}

/* ---------------- peta sinyal (kanvas) ---------------- */
async function renderPeta(paksa) {
  const st = S.st; if (!st) return;
  const opts = TFS[S.mode], p = st.pa || {};
  if (!S.petaTf || !opts.includes(S.petaTf)) S.petaTf = (p.tf && opts.includes(p.tf)) ? p.tf : opts[0];
  $('#peta-tf').innerHTML = opts.map(t => `<button data-tf="${t}" class="${t === S.petaTf ? 'on' : ''}" data-tip="peta_tf" data-a="${t}">${TFL(t)}</button>`).join('');
  $$('#peta-tf button').forEach(b => b.onclick = () => { S.petaTf = b.dataset.tf; renderPeta(true); });
  $('#peta-judul').textContent = `${S.sym} ${TFL(S.petaTf)}`;
  if (paksa || Date.now() - S.petaT > 10000 || !S.peta || S.peta.tf !== S.petaTf) {
    S.petaT = Date.now();
    const w = $('#peta').getBoundingClientRect().width || 600, sym = S.sym, tf = S.petaTf;
    try {
      const d = await api(`/api/peta?sym=${sym}&tf=${tf}&n=${Math.max(60, Math.min(260, Math.floor((w - 96) / 6)))}`);
      if (sym !== S.sym || tf !== S.petaTf) return;          // simbol/TF sudah diganti saat menunggu
      S.peta = d;
    } catch (e) { return; }
    const h = S.dn?.harga?.[S.sym];
    if (h && h.p != null && S.st) return petaHidup(h.p);
  }
  if (S.st) drawPeta(S.peta, S.st);
}
// harga hidup (tiap denyut) → candle terakhir peta ikut bergerak; bila candle TF baru sudah dimulai, tambahkan sementara
function petaHidup(px) {
  const C = S.peta, ms = C && TF_MS[C.tf];
  if (!C || !ms || !C.t || !C.t.length || !isFinite(px)) return;
  const n = C.t.length - 1, awal = Math.floor(Date.now() / ms) * ms;
  if (C.t[n] === awal) { C.c[n] = px; if (px > C.h[n]) C.h[n] = px; if (px < C.l[n]) C.l[n] = px; }
  else if (C.t[n] < awal) { C.t.push(awal); C.o.push(px); C.h.push(px); C.l.push(px); C.c.push(px); ['t', 'o', 'h', 'l', 'c'].forEach(k => C[k].shift()); }
  if (S.st) drawPeta(C, S.st);
}
function drawPeta(C, st) {
  const cv = $('#peta'), r = cv.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  if (!C || r.width < 50 || r.height < 40) return;
  cv.width = r.width * dpr; cv.height = r.height * dpr;
  const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const W = r.width, H = r.height, padR = 92, padT = 8, padB = 16, n = C.c.length, dp = dpOf();
  const css = getComputedStyle(document.documentElement), col = v => css.getPropertyValue(v).trim();
  g.clearRect(0, 0, W, H);
  S.geo = null;
  if (!n) return;
  const lv = [];
  const p = st.pa || {}, k = st.rencana?.utama;
  if (p.entry != null && (isAksi(p.aksi) || p.aksi === 'PANTAU')) {
    const dash = p.aksi === 'PANTAU' ? [5, 4] : [], ps = `${p.nama || ''} ${TFL(p.tf)}`, pan = p.aksi === 'PANTAU' ? ' (pantau)' : '';
    lv.push({ v: p.entry, c: col('--entry'), t: 'PA E', w: 2, d: dash, nm: 'Entry sinyal price action' + pan, ket: `${ps} · ${p.jenis_entry || ''}` });
    lv.push({ v: p.sl, c: col('--sl'), t: 'PA SL', w: 2, d: dash, nm: 'Stop loss sinyal price action' + pan, ket: `${ps} · 1R = ${fmt(p.r, dp)}` });
    (p.tp || []).forEach((v, i) => lv.push({ v, c: col('--tp'), t: 'TP' + (i + 1), w: 1.5, d: dash, nm: `TP${i + 1} sinyal price action` + pan,
      ket: `Target ${fmt((p.tp_k || [])[i], 2)}R · peluang ${pct(((p.tp_p || [])[i] || 0) * 100)}` }));
  }
  if (k && k.entry != null && k.aksi !== 'TUNGGU') {
    const ps = k.status === 'AKTIF' ? k.posisi : null;
    lv.push({ v: k.entry, c: col('--entry'), t: ps ? 'Str L1' : 'Str E', w: 1, d: [2, 3], dim: true, nm: ps ? `Entry L1 posisi strategi yang berjalan sejak ${sejak(ps.sejak)} WIB (bukan entry baru)` : 'Entry rencana strategi', ket: `${k.nama || ''} · ${k.jenis_entry || ''}` });
    lv.push({ v: k.sl, c: col('--sl'), t: ps && ps.sl_geser ? 'Str TSL' : 'Str SL', w: 1, d: [2, 3], dim: true, nm: ps && ps.sl_geser ? 'Stop loss trailing posisi strategi (semua layer)' : 'Stop loss rencana strategi',
      ket: `${k.nama || ''}${ps ? ` · bila kena ${sR(ps.r_sl)}` : k.r0 ? ` · 1R = ${fmt(k.r0, dp)}` : ''}` });
  }
  let lo = Math.min(...C.l), hi = Math.max(...C.h);
  const pxNow = st.harga || C.c[n - 1];
  const lvKunci = ((st.kebiasaan || {}).level || []).filter(x => x.harga >= lo - (hi - lo) * 0.15 && x.harga <= hi + (hi - lo) * 0.15)
    .sort((a, b) => Math.abs(a.harga - pxNow) - Math.abs(b.harga - pxNow)).slice(0, 7);
  [...lv, ...lvKunci.map(x => ({ v: x.harga }))].forEach(x => { if (isFinite(x.v)) { lo = Math.min(lo, x.v); hi = Math.max(hi, x.v); } });
  const pad = (hi - lo) * 0.05; lo -= pad; hi += pad;
  const y = v => padT + (hi - v) / (hi - lo) * (H - padT - padB);
  const bw = (W - padR) / n;
  // geometri untuk kotak keterangan saat mouse di atas peta (candle, label pola, garis)
  const geo = { W, H, padR, bw, n, C, tf: C.tf || S.petaTf, garis: [], kotak: [], polaDi: {},
                inv: yy => hi - (yy - padT) / (H - padT - padB) * (hi - lo) };
  g.font = '10.5px ' + col('--font');
  g.strokeStyle = col('--line'); g.lineWidth = 1; g.fillStyle = col('--dim');
  for (let i = 0; i <= 4; i++) { const v = lo + (hi - lo) * i / 4, yy = y(v); g.beginPath(); g.moveTo(0, yy); g.lineTo(W - padR, yy); g.stroke(); g.fillText(fmt(v, dp), W - padR + 6, yy + 3); }
  // level kunci (kebiasaan): garis putus tipis; label kiri tanpa tumpang tindih (yang terlalu rapat digabung)
  g.save(); g.globalAlpha = 0.55; g.setLineDash([3, 4]); g.strokeStyle = col('--lvl'); g.fillStyle = col('--muted');
  const lbl = [];
  [...lvKunci].sort((a, b) => b.harga - a.harga).forEach(x => {
    const yy = y(x.harga); g.beginPath(); g.moveTo(0, yy); g.lineTo(W - padR, yy); g.stroke();
    geo.garis.push({ y: yy, v: x.harga, nm: x.nama, ket: 'Level kunci dari memori kebiasaan pasar (garis putus abu-abu).' });
    const last = lbl[lbl.length - 1];
    if (last && Math.abs(last.y - yy) < 12) { if (!last.teks.includes(x.nama)) last.teks += ' · ' + x.nama; }
    else lbl.push({ y: yy, teks: x.nama });
  });
  g.globalAlpha = 0.8; lbl.forEach(z => g.fillText(z.teks, 4, z.y - 3));
  g.restore();
  for (let i = 0; i < n; i++) {
    const x = i * bw + bw / 2, up = C.c[i] >= C.o[i];
    g.strokeStyle = g.fillStyle = up ? col('--buy') : col('--sell');
    g.beginPath(); g.moveTo(x, y(C.h[i])); g.lineTo(x, y(C.l[i])); g.stroke();
    const t = y(Math.max(C.o[i], C.c[i])), b = y(Math.min(C.o[i], C.c[i]));
    g.fillRect(x - Math.max(1, bw * 0.32), t, Math.max(1.5, bw * 0.64), Math.max(1, b - t));
  }
  // penanda pola price action: 14 terbaru + semua yang disarankan
  const idx = new Map(C.t.map((t, i) => [t, i]));
  const pol = (C.pola || []).filter(e => idx.has(e.t));
  pol.forEach(e => { const i = idx.get(e.t); (geo.polaDi[i] = geo.polaDi[i] || []).push(e); });
  const tampil = pol.filter((e, i) => e.disarankan || i >= pol.length - 14);
  const tumpuk = {};
  tampil.forEach(e => {
    const i = idx.get(e.t), x = i * bw + bw / 2, buy = e.arah > 0;
    const key = i + (buy ? 'b' : 's'); const lap = tumpuk[key] = (tumpuk[key] || 0) + 1;
    const yy = buy ? y(C.l[i]) + 6 + (lap - 1) * 13 : y(C.h[i]) - 17 - (lap - 1) * 13;
    const lbl = e.kode, tw = g.measureText(lbl).width + 6;
    geo.kotak.push({ x: x - tw / 2, y: yy, w: tw, h: 12, e, i });
    const warna = buy ? col('--buy') : col('--sell');
    g.fillStyle = e.status === 'selesai' ? (e.mfe >= 1 ? warna : col('--panel2')) : col('--panel');
    g.strokeStyle = e.disarankan ? col('--accent') : warna; g.lineWidth = e.disarankan ? 2 : 1;
    g.beginPath(); g.roundRect ? g.roundRect(x - tw / 2, yy, tw, 12, 3) : g.rect(x - tw / 2, yy, tw, 12); g.fill(); g.stroke();
    g.fillStyle = e.status === 'selesai' && e.mfe >= 1 ? '#fff' : warna; g.fillText(lbl, x - tw / 2 + 3, yy + 9.5);
  });
  // swing terakhir
  const sw = C.swing || {};
  [['high', -1], ['low', 1]].forEach(([kk, d]) => (sw[kk] || []).forEach(z => {
    const i = idx.get(z[0]); if (i == null) return;
    const x = i * bw + bw / 2, yy = y(z[1]);
    geo.kotak.push({ x: x - 6, y: Math.min(yy + d * 2, yy - d * 5) - 2, w: 12, h: 11, swing: kk, v: z[1], t: z[0], tembus: !!z[2], i });
    g.fillStyle = col('--accent2'); g.beginPath(); g.moveTo(x, yy + d * 2); g.lineTo(x - 4, yy - d * 5); g.lineTo(x + 4, yy - d * 5); g.closePath(); g.fill();
  }));
  // garis rencana + harga sekarang; label kanan digeser agar tidak bertumpuk
  const tag = [];
  lv.filter(x => isFinite(x.v)).sort((a, b) => b.v - a.v).forEach(x => {
    const yy = y(x.v); let ly = yy;
    const prev = tag[tag.length - 1];
    if (prev && ly - prev < 15) ly = prev + 15;
    tag.push(ly);
    geo.garis.push({ y: yy, ly, v: x.v, nm: x.nm, ket: x.ket });
    g.save(); if (x.dim) g.globalAlpha = 0.65; g.setLineDash(x.d || []); g.strokeStyle = x.c; g.lineWidth = x.w;
    g.beginPath(); g.moveTo(0, yy); g.lineTo(W - padR, yy); g.stroke(); g.setLineDash([]);
    g.fillStyle = x.c; g.fillRect(W - padR + 2, ly - 7, padR - 4, 14);
    g.fillStyle = '#fff'; g.fillText(`${x.t} ${fmt(x.v, dp)}`, W - padR + 4, ly + 3.5, padR - 8); g.restore();
  });
  if (st.harga) {
    const yy = y(st.harga); g.strokeStyle = col('--ink'); g.setLineDash([1, 3]); g.beginPath(); g.moveTo(0, yy); g.lineTo(W - padR, yy); g.stroke(); g.setLineDash([]);
    g.fillStyle = col('--ink'); g.fillRect(W - padR + 2, yy - 7, padR - 4, 14); g.fillStyle = col('--panel'); g.fillText(fmt(st.harga, dp), W - padR + 5, yy + 3.5);
    geo.garis.push({ y: yy, ly: yy, v: st.harga, nm: 'Harga sekarang', ket: 'Harga terakhir dari feed (garis titik-titik).' });
  }
  S.geo = geo;
  if (T.el && T.el.id === 'peta') tipTampil(T.el);
}

/* ---------------- jendela sembul ---------------- */
function buka(judul, isi, aksi = '') {
  $('#modal-judul').textContent = judul; $('#modal-isi').innerHTML = isi; $('#modal-aksi').innerHTML = aksi;
  $('#modal').classList.remove('hidden');
}
function tutup() { $('#modal').classList.add('hidden'); S.modal = null; }
function modalAnalisis() {
  const st = S.st; if (!st) return;
  buka(`Analisis AI Yulius · ${S.sym} ${S.mode === 'scalp' ? 'Scalping' : 'Swing'}`, (st.narasi || []).map(p => `<p>${esc(p)}</p>`).join('') +
    `<div class="sub">Ketidakpastian</div>${((st.ketidakpastian || {}).komponen || []).map(z => `<p><b>${esc(z.nama)}</b> (${fmt(z.nilai * 100, 0)}/100): ${esc(z.teks)}</p>`).join('')}` +
    `<p class="muted">Perhitungan statistik dari data historis dan real-time, bukan kepastian atau nasihat keuangan. AI Yulius tidak mengirim order.</p>`);
}
function modalLab() {
  const st = S.st, L = st.lab || {}, list = (st.strategi || []).filter(s => s.mode === S.mode), pr = L.progres;
  let h = `<p class="muted">${L.proses ? 'Lab sedang berjalan' + (pr ? ` · ${esc(pr.sym)} ${esc(pr.sid)} ${pr.i}/${pr.n}` : '') : 'Lab terakhir selesai ' + (L.selesai ? tgl(L.selesai) + ' WIB' : 'belum pernah')}.
    Lab menguji ulang tiap strategi dan variasinya pada seluruh riwayat (segmen A/B/C), wajib untung di semua segmen, stabil di parameter tetangga, tahan biaya 2x, dan diuji Monte Carlo. Strategi yang memburuk di forward-test diturunkan otomatis.</p>`;
  h += list.length ? `<table><tr><th>Strategi</th><th>Status</th><th>Grade</th><th class="n">PF</th><th class="n">PF A/B/C</th><th class="n">Transaksi</th><th class="n">Menang</th><th class="n">DD (R)</th><th class="n">DD95 MC</th><th class="n">Biaya 2x</th><th class="n">Kalah beruntun</th><th class="n">TP1/2/3</th></tr>
    ${list.map(s => `<tr><td>${esc(s.nama)}</td><td><span class="tag ${esc(s.status)}" data-tip="lab_st" data-a="${esc(s.status)}">${esc(s.status)}</span></td><td>${esc(s.grade)}</td><td class="n">${fmt(s.pf, 2)}</td>
      <td class="n">${(s.segmen || []).map(x => fmt(x, 2)).join(' / ')}</td><td class="n">${s.n ?? '-'}</td><td class="n">${pct(s.wr)}</td><td class="n">${fmt(s.dd, 1)}</td>
      <td class="n">${fmt(s.dd95, 1)}</td><td class="n">${fmt(s.pf_biaya2, 2)}</td><td class="n">${s.kalah_beruntun ?? '-'}</td>
      <td class="n">${s.tp_peluang ? ['1R', '2R', '3R'].map(k => fmt(s.tp_peluang[k], 0)).join('/') : '-'}</td></tr>`).join('')}</table>` : '<div class="kosong">Belum ada hasil lab untuk mode ini; rencana memakai preset teruji.</div>';
  buka('Lab strategi otonom', h, `<button class="btn" id="btn-lab-run" ${L.proses ? 'disabled' : ''}>Jalankan lab sekarang</button>`);
  $('#btn-lab-run').onclick = async e => { e.target.disabled = true; try { await api('/api/lab', { method: 'POST', body: '{}' }); toast('Lab otonom dimulai di latar.'); } catch (x) { toast(x.message); } };
}
function modalJurnal() {
  const st = S.st, J = st.jurnal || [], fw = st.forward || {}, dp = dpOf();
  let h = Object.keys(fw).length ? `<div class="stat">${Object.entries(fw).map(([sid, s]) => `<span>${esc(sid)} <b>${s.n}</b> sinyal · menang <b>${fmt(s.wr, 0)}%</b> · PF <b>${fmt(s.pf, 2)}</b> · <b>${fmt(s.sum, 1)}R</b></span>`).join('')}</div>` : '';
  h += J.length ? `<table><tr><th>Waktu (WIB)</th><th>Strategi</th><th>Arah</th><th class="n">Masuk</th><th class="n">SL awal</th><th class="n">TP1</th><th>Status</th><th class="n">Keluar</th><th class="n">Hasil</th><th>TP tersentuh</th></tr>
    ${J.map(j => `<tr><td>${tgl(j.t)}</td><td>${esc(j.nama || j.sid)}</td><td class="${j.arah > 0 ? 'up' : 'dn'}">${j.arah > 0 ? 'BUY' : 'SELL'}</td><td class="n">${fmt(j.masuk, dp)}</td>
      <td class="n">${fmt(j.sl0, dp)}</td><td class="n">${fmt(j.tp1, dp)}</td><td>${esc(j.status)}</td><td class="n">${fmt(j.keluar, dp)}</td>
      <td class="n ${j.r > 0 ? 'up' : j.r < 0 ? 'dn' : ''}">${j.r == null ? '-' : sR(j.r)}</td><td>${j.kena ? ['tp1', 'tp2', 'tp3'].filter(k => j.kena[k]).map(k => k.toUpperCase()).join(' ') || '-' : '-'}</td></tr>`).join('')}</table>`
    : '<div class="kosong">Belum ada sinyal strategi sejak perekaman dimulai. Setiap sinyal dan hasilnya dicatat otomatis.</div>';
  buka(`Jurnal forward-test strategi · ${S.sym}`, h);
}
async function modalPikiran() {
  let P = []; try { P = await api('/api/pikiran?n=200'); } catch (e) {}
  buka('Aktivitas & keputusan AI', P.map(p => `<div class="pk"><time>${tgl(p.t)}</time><span class="j">${esc(p.jenis)}</span><span style="white-space:normal">${esc(p.sym ? p.sym + ': ' : '')}${esc(p.isi)}</span></div>`).join('') || '<div class="kosong">Kosong.</div>');
}
async function modalRekap() {
  let R = []; try { R = await api(`/api/rekap?sym=${S.sym}&n=120`); } catch (e) {}
  buka(`Rekap memori · ${S.sym}`, R.map(x => `<div class="rki ${x.jenis}"><div class="rh"><span class="tag">${esc(x.jenis)}</span><b>${esc(x.judul)}</b></div><p style="-webkit-line-clamp:unset">${esc(x.isi)}</p></div><hr style="border:0;border-top:1px solid var(--line)">`).join('') || '<div class="kosong">Belum ada rekap.</div>');
}
async function modalPola() {
  let d; try { d = await api(`/api/belajar?sym=${S.sym}&mode=${S.mode}&semua=1`); } catch (e) { toast(e.message); return; }
  const info = d.info || {}, rw = info.riwayat || {};
  let h = `<p class="muted">Setiap candle M5/M15/H1/H4 yang tutup diperiksa: pola price action dicatat bersama konteksnya (tren TF atas, lokasi terhadap level kunci, volatilitas, sesi, ADR), lalu hasilnya diikuti sampai kena SL, target, atau batas waktu.
    Peluang TP dihitung bertingkat dan ditarik ke tingkat induk bila sampelnya kecil; bobot data baru lebih besar. Ekspektasi sudah dikurangi biaya spread. Pengisian riwayat terakhir ${rw.t ? tgl(rw.t) + ' WIB' : '-'} (${fmt(rw.detik, 1)} detik).</p>`;
  h += `<div class="sub">Uji walk-forward per timeframe (memori hanya dari data sebelum tiap jendela)</div><table><tr><th>TF</th><th>Status</th><th class="n">Sinyal lolos</th><th class="n">TP1</th><th class="n">TP2</th><th class="n">Rata-rata</th><th class="n">PF</th><th class="n">Semua pola</th><th>Per jendela waktu</th><th>Diblokir</th></tr>
    ${Object.entries(info.validasi || {}).map(([tf, v]) => v ? `<tr><td>${TFL(tf)}</td><td><span class="chip v-${esc(v.status)}" data-tip="val_st" data-a="${esc(v.status)}">${esc(v.status)}</span></td><td class="n">${fmt(v.n_lolos, 0)}</td><td class="n">${pct(v.tp1)}</td><td class="n">${pct(v.tp2)}</td>
      <td class="n ${v.e_lolos > 0 ? 'up' : 'dn'}">${sR(v.e_lolos)}</td><td class="n">${fmt(v.pf_lolos, 2)}</td><td class="n">${sR(v.e_semua)}</td>
      <td>${(v.lipatan || []).map(z => `${z.n}: ${sR(z.e)}`).join(' · ')}</td><td>${(v.blokir || []).join(', ') || '-'}</td></tr>` : '').join('')}</table>`;
  h += `<div class="sub">Semua pola (urut ekspektasi bersih)</div><table><tr><th>TF</th><th>Pola</th><th class="n">n</th><th class="n">maju</th><th class="n">TP 1R</th><th class="n">TP1</th><th class="n">TP2 (opt)</th><th class="n">TP3</th><th class="n">Ekspektasi</th><th>Konteks terbaik</th><th>30 hari terakhir</th></tr>
    ${(d.tabel || []).map(r => `<tr><td>${TFL(r.tf)}</td><td class="${r.arah > 0 ? 'up' : 'dn'}">${esc(r.nama)} ${r.arah > 0 ? 'BUY' : 'SELL'}</td><td class="n">${fmt(r.n, 0)}</td><td class="n">${fmt(r.n_maju, 0)}</td>
      <td class="n">${pct(r.p1r)}</td>${[0, 1, 2].map(i => `<td class="n">${fmt(r.k[i], 2)}R · ${pct(r.p[i] * 100)}</td>`).join('')}<td class="n ${r.e > 0 ? 'up' : 'dn'}">${sR(r.e)}</td>
      <td>${r.konteks_terbaik ? esc(r.konteks_terbaik) + ` (${sR(r.e_terbaik)}, ${r.n_terbaik})` : '-'}</td>
      <td class="${r.drift && r.drift.status === 'melemah' ? 'dn' : r.drift && r.drift.status === 'menguat' ? 'up' : 'dim'}">${r.drift ? `${esc(r.drift.status)} · TP 1R ${pct(r.drift.p1_baru)} vs ${pct(r.drift.p1_lama)}` : '-'}</td></tr>`).join('')}</table>`;
  buka(`Memori price action · ${S.sym}`, h, `<button class="btn" id="btn-uji">Uji ulang sekarang</button>`);
  $('#btn-uji').onclick = async e => { e.target.disabled = true; try { await api('/api/belajar', { method: 'POST', body: '{}' }); toast('Uji walk-forward memori dijalankan di latar.'); } catch (x) { toast(x.message); } };
}
function modalLevel() {
  const kb = S.st?.kebiasaan || {}, dp = dpOf();
  buka(`Level kunci · ${S.sym}`, `<table><tr><th>Level</th><th class="n">Harga</th><th class="n">Jarak</th><th class="n">ATR</th></tr>
    ${(kb.level || []).map(l => { const px = S.st?.harga, atr = l.jarak_atr ? l.jarak / l.jarak_atr : 0, j = px ? l.harga - px : l.jarak, ja = atr ? j / atr : l.jarak_atr;
      return `<tr><td>${esc(l.nama)}</td><td class="n">${fmt(l.harga, dp)}</td><td class="n ${j > 0 ? 'up' : 'dn'}">${sgn(j)}${fmt(j, dp)}</td><td class="n">${fmt(ja, 1)}</td></tr>`; }).join('')}</table>
    <div class="sub">Hari dalam minggu (1 tahun)</div><table><tr><th>Hari</th><th class="n">Range</th><th class="n">Naik</th></tr>${(kb.hari || []).map(d => `<tr><td>${esc(d.hari)}</td><td class="n">${fmt(d.range, dp)}</td><td class="n">${fmt(d.p_naik, 0)}%</td></tr>`).join('')}</table>
    <div class="sub">Catatan memori</div>${(kb.catatan || []).map(c => `<p>${esc(c)}</p>`).join('')}`);
}
function modalAlt() {
  const rc = S.st?.rencana || {}, alt = (rc.calon || []).slice(1), dp = dpOf();
  buka('Strategi lain untuk mode ini', `<div class="alt">${alt.map(a => `<div class="ai"><b class="${kls(a.aksi)}">${esc(a.aksi)}</b>
    <span class="sp">${esc(a.nama)} <span class="muted">· ${esc(a.status === 'AKTIF' ? 'berjalan, bukan entry baru' : a.status)} · grade ${esc(a.grade)}</span><br><span class="muted">${esc(a.pemicu || '')}</span></span>
    <span class="num">${a.entry != null ? fmt(a.entry, dp) : ''}${a.sl != null ? `<br><span class="dn">SL ${fmt(a.sl, dp)}</span>` : ''}</span></div>`).join('') || '<div class="kosong">Tidak ada strategi lain.</div>'}</div>`);
}

/* ---------------- kotak keterangan (arahkan mouse) ---------------- */
// Elemen ber-atribut data-tip="kunci" (opsional data-a="argumen") menampilkan keterangan singkat dari KET[kunci]:
// { j: judul, t: teks/daftar paragraf, kv: [[label, nilai, kelas]], c: catatan kecil }. Teks dari server selalu di-esc.
// Isi dihitung ulang setiap data diperbarui, jadi angka di kotak ikut terkini. Header tabel (th) memakai GLOS.
function HH(j) { return String(j).padStart(2, '0') + ':00'; }
function tipTeks(judul, teks) { return `data-tip="teks" data-tj="${esc(judul)}" data-tt="${esc(teks)}"`; }
const ARAH = a => (a > 0 ? 'BUY' : 'SELL');
const TF_MS = { '5m': 3e5, '15m': 9e5, '1h': 36e5, '4h': 144e5, '1d': 864e5 };
const VAL_ST = {
  aktif: 'Lolos uji: minimal 40 sinyal, rata-rata minimal +0,02R, untung di minimal 2 jendela, dan jendela terbaru tidak merugi. Timeframe ini boleh memberi sinyal BUY/SELL.',
  sedikit: 'Sinyal di data uji belum mencapai 40, jadi belum bisa dinilai. Pola di timeframe ini hanya dipantau.',
  nonaktif: 'Tidak lolos uji: merugi atau tidak stabil di data baru setelah biaya. Pola di timeframe ini hanya dipantau, bukan rekomendasi.',
  belum: 'Belum diuji. Pola hanya dipantau sampai uji walk-forward selesai.',
};
const RC_ST = {
  SIAP: 'Setup sudah terbentuk: pasang order di harga entry sesuai jenis entry-nya.',
  MASUK: 'Pemicu baru saja terjadi: masuk sekarang di harga pasar.',
  AKTIF: 'Posisi dari sinyal sebelumnya masih berjalan — bukan entry baru. Yang sudah ikut: kelola dengan SL semua layer dan layer berikutnya di kartu ini (SL trailing bisa sudah melewati entry = untung terkunci). Yang belum ikut: jangan kejar, tunggu sinyal berikutnya.',
  TUNGGU: 'Belum ada pemicu; rencana menunggu syaratnya terpenuhi.',
};
const LAB_ST = {
  aktif: 'Lulus lab dan termasuk 3 terbaik; dipakai untuk rencana.',
  cadangan: 'Lulus lab tapi bukan 3 terbaik; siap menggantikan.',
  gugur: 'Tidak lulus lab, atau memburuk di forward-test (PF di bawah 0,7 setelah minimal 20 sinyal).',
  referensi: 'Tidak ada strategi yang lulus; strategi terbaik disimpan sebagai acuan saja.',
  dipantau: 'Forward-test melemah (PF di bawah 0,8); bobotnya diturunkan dan diawasi.',
  preset: 'Preset yang sudah teruji; dipakai sampai lab punya hasil sendiri.',
};
const KET = {
  teks: el => ({ j: esc(el.dataset.tj || ''), t: esc(el.dataset.tt || '') }),
  // ---- header ----
  sub: (el, a, st) => ({ j: 'Status data', t: 'Nama pasar, sumber harga yang dipakai, dan jam analisis terakhir (WIB). Harga diperbarui ±1 detik, rencana dan sinyal dihitung ulang tiap 2 detik di browser ini (tanpa server).',
    kv: [['Pasar', esc(st.cfg?.judul || S.sym)], ['Sumber', esc(st.sumber || '-')], ['Diperbarui', wib(st.t_rencana || st.now, { hour: '2-digit', minute: '2-digit', second: '2-digit' }) + ' WIB']] }),
  pair: (el, sym) => {
    const d = (S.rk || {})[sym] || {}, m = (d.mode || {})[S.mode] || {}, pa = m.pa || {}, u = m.ketidakpastian || {};
    return { j: `${esc(sym)} · ${sym === 'XAUUSDm' ? 'Emas (Exness)' : 'Bitcoin'}`, t: sym === S.sym ? 'Simbol yang sedang ditampilkan.' : 'Klik untuk menampilkan simbol ini.',
      kv: [['Harga terakhir', fmt(d.harga, 2)], ['Perubahan 24 jam', d.chg24 == null ? '-' : sgn(d.chg24) + fmt(d.chg24, 2) + '%', d.chg24 > 0 ? 'up' : d.chg24 < 0 ? 'dn' : ''],
        ['Price action', esc(pa.aksi || '-'), isAksi(pa.aksi) ? kls(pa.aksi) : ''], ['Strategi', esc(labelRencana(m.aksi, m.status) || '-'), isAksi(m.aksi) ? kls(m.aksi) : ''],
        u.label ? ['Ketidakpastian', `${esc(u.label)} ${fmt(u.skor, 0)}`] : null],
      c: `Label kecil kanan bawah = sinyal mode ${S.mode === 'scalp' ? 'Scalping' : 'Swing'}: "PA BUY/SELL" dari price action, selain itu status rencana strategi.` };
  },
  mode: (el, m) => ({ j: m === 'scalp' ? 'Mode Scalping' : 'Mode Swing',
    t: m === 'scalp' ? 'Transaksi cepat: sinyal price action dari candle M5 dan M15, peta 5M/15M/1H, chart 5 menit, prediksi 1 jam dan 4 jam.'
      : 'Posisi lebih lama: sinyal price action dari candle H1 dan H4, peta 1H/4H/1D, chart 1 jam, prediksi 4 jam dan 1 hari.',
    c: S.mode === m ? 'Mode yang sedang aktif.' : 'Klik untuk pindah ke mode ini.' }),
  feed: (el, k, st) => {
    const f = st.feed || {}, sp = f.spot || {}, bl = st.belajar || {}, lalu = t => (t ? `${fmt(Math.max(0, (Date.now() - t) / 1000), 0)} detik lalu` : '-');
    if (k === 'binance') return { j: 'Binance', t: 'Sumber harga langsung BTCUSDT dan PAXGUSDT (token emas), diambil tiap ±1 detik. Hijau = data masuk kurang dari 15 detik lalu, merah = terputus. Bila server utama tidak menjawab, otomatis pindah ke server resmi cadangan.', kv: [['Data terakhir', lalu(f.binance)], f.binance_host ? ['Server', esc(f.binance_host)] : null] };
    if (k === 'spot') return { j: 'Spot emas', t: 'Harga emas spot (gold-api.com) untuk mengoreksi PAXG ke harga XAU, tiap 10 detik. Hijau = segar, kuning = terlambat, "(tutup)" = pasar emas tutup (akhir pekan).', kv: [['Data terakhir', sp.tutup ? 'pasar tutup' : lalu(sp.t)], sp.p ? ['Harga spot', fmt(sp.p, 2)] : null] };
    if (k === 'proxy') { const r = f.rasio_xau || {};
      return { j: 'XAUUSDm (proxy)', t: 'Situs web tidak tersambung ke MT5, jadi harga dan candle XAUUSDm = PAXGUSDT (Binance) x rasio harga spot emas, dan candle di luar jam pasar emas dibuang. Selisih ke XAUUSDm Exness biasanya kecil (spread).',
        kv: [['Rasio spot/PAXG', r.k ? fmt(r.k, 5) : '-'], ['Spot emas', r.spot ? fmt(r.spot, 2) : '-'], ['Diperbarui', r.t ? lalu(r.t) : 'belum']] }; }
    return { j: 'Memori belajar', t: 'Memori price action yang dipakai untuk sinyal. Hijau = siap, kuning "(belajar)" = sedang mengisi atau menguji ulang dari riwayat candle. Memori tersimpan di perangkat ini (IndexedDB) dan terus belajar selama halaman terbuka.', kv: [['Status', bl.proses ? 'sedang belajar' : bl.siap ? 'siap' : 'belum siap'], ['Penyimpan', f.pemimpin === false ? 'tab lain (tab ini hanya menghitung)' : 'tab ini']] };
  },
  jam_kini: { j: 'Jam WIB', t: 'Jam sekarang di Jakarta. Semua jam di layar ini memakai WIB (UTC+7).' },
  live: () => {
    const d = S.dn || {}, h = (d.harga || {})[S.sym] || {}, p = d.putaran || {}, sv = d.now || 0, dt = Date.now() - S.tOk;
    const umur = t => (t && sv ? lalu(sv - t + dt) + ' lalu' : '-'), k = liveKelas(), r = S.segarHasil;
    const judul = { on: 'Data real-time mengalir', lambat: 'Sumber harga terlambat', putus: 'Mesin trading tidak menjawab', jeda: 'Pembaruan otomatis dijeda', segar: 'Sedang menyegarkan semua data' }[k];
    const isi = { on: S.live === 1 ? 'Harga diambil tiap detik; rencana & sinyal dihitung ulang tiap 2 detik; candle diambil final ±1,5 detik setelah tutup.' : `Layar mengambil data tiap ${S.live} detik (mesin tetap menghitung tiap 1-2 detik).`,
      lambat: 'Harga terakhir lebih dari 6 detik lalu: cek koneksi internet. Akan pulih otomatis (server Binance cadangan dipakai bila perlu).',
      putus: 'Layar tidak mendapat jawaban dari mesin trading (Web Worker di browser ini). Mencoba lagi otomatis; muat ulang halaman (⇧⌘R) bila lama.',
      jeda: 'Angka di layar hanya berubah saat Segarkan diklik (⌘R). Pilih Real-time untuk kembali otomatis.', segar: 'Mengambil ulang semua candle dan sumber, lalu menghitung ulang memori, rencana, dan sinyal…' }[k];
    return { j: esc(judul), t: isi, kv: [[`Harga ${esc(S.sym)}`, `${umur(h.t)}${h.sumber ? ' · ' + esc(h.sumber) : ''}`], ['Rencana & sinyal', umur(p.hitung)],
      ['Memori price action', umur(p.belajar)], ['Kebiasaan & prediksi', umur(p.berkala)], ['Kecepatan', S.live === 0 ? 'jeda' : S.live === 1 ? 'real-time (1 detik)' : `tiap ${S.live} detik`],
      r && r.t ? ['Segarkan terakhir', `${wib(r.t, { hour: '2-digit', minute: '2-digit', second: '2-digit' })} WIB · ${fmt(r.detik, 1)} dtk${r.ok === false ? ' · ada kendala' : ''}`, r.ok === false ? 'wt' : ''] : null],
      c: 'Klik untuk memilih kecepatan pembaruan atau menjeda. ⌘R = segarkan semua, ⇧⌘R = muat ulang halaman + chart.' };
  },
  segar: () => {
    const r = S.segarHasil, L = (r && r.langkah) || {};
    if (S.webBaru) return { j: 'Versi tampilan baru tersedia', t: 'Berkas tampilan Trading sudah diperbarui. Klik untuk memuat ulang halaman (data, peta, dan chart dimuat dari awal).' };
    return { j: 'Segarkan semua data (⌘R)', t: ['Ambil ulang harga dan semua candle M1 sampai D1 (termasuk celah selama halaman ditutup) serta harga spot emas; lalu hitung ulang kebiasaan pasar, prediksi, memori price action, rekap, rencana strategi, dan sinyal.', 'Biasanya selesai dalam 2-3 detik. Chart TradingView sudah real-time sendiri dan tidak dimuat ulang (gambar di chart aman).'],
      kv: r && r.t ? [['Terakhir', `${wib(r.t, { hour: '2-digit', minute: '2-digit', second: '2-digit' })} WIB · ${fmt(r.detik, 1)} dtk`],
        L.data ? ['Data pasar', `${fmt(L.data.detik, 1)} dtk${L.data.ok ? '' : ' (sebagian belum selesai)'}`] : null, L.memori ? ['Memori & prediksi', `${fmt(L.memori.detik, 1)} dtk`] : null,
        L.rencana ? ['Rencana & sinyal', `${fmt(L.rencana.detik, 1)} dtk`] : null, r.catatan ? ['Catatan', esc(r.catatan), 'wt'] : null] : [],
      c: '⇧⌘R = muat ulang halaman + chart TradingView.' };
  },
  analisis: { j: 'Analisis lengkap', t: 'Membuka ringkasan naratif AI Yulius untuk simbol dan mode ini, plus rincian tiap komponen ketidakpastian.' },
  penuh: { j: 'Layar penuh', t: 'Membesarkan jendela trading ke seluruh layar. Klik lagi untuk kembali.' },
  tema: { j: 'Tema', t: 'Ganti tampilan terang atau gelap. Pilihan disimpan.' },
  setelan: { j: 'Setelan modal & risiko', t: 'Saldo, mata uang, persen risiko per posisi, dan kurs. Dipakai untuk menghitung lot dan nilai rugi jika kena SL.' },
  // ---- kolom 1 ----
  peta_h: { j: 'Peta sinyal AI', t: ['Candle dari data AI Yulius dengan tanda pola price action, garis entry/SL/TP, dan level kunci.', 'Arahkan mouse ke candle, label pola, garis, atau segitiga untuk melihat rinciannya.'] },
  peta_leg: { j: 'Arti tanda di peta', kv: [['Kotak berlabel', 'pola price action'], ['Garis biru', 'entry'], ['Garis merah', 'stop loss'], ['Garis hijau', 'target (TP)'], ['Putus abu-abu', 'level kunci'], ['Segitiga ungu', 'swing high / low'], ['Titik-titik', 'harga sekarang']],
    c: 'Kode pola: PB pin bar, EG engulfing, IB inside bar, BOS break of structure, CH change of character, SW sapu likuiditas, RT retest, MO momentum. Garis tebal = sinyal price action (putus-putus bila masih pantau), garis tipis putus = rencana strategi.' },
  peta_tf: (el, tf) => ({ j: `Timeframe ${TFL(tf)}`, t: `Tampilkan peta dengan candle ${TFL(tf)}.${S.petaTf === tf ? ' Sedang ditampilkan.' : ''}` }),
  peta: () => petaKet(),
  gerak: (el, i, st) => {
    const g = (st.gerak || []).filter(Boolean)[+i]; if (!g) return null;
    const dp = dpOf(), tutup = g.t + (TF_MS[g.tf] || 0);
    return { j: `Candle ${TFL(g.tf)} terakhir · tutup ${wib(tutup)} WIB`, t: 'Dianalisis otomatis setiap candle tutup. 1x ATR = besar gerak rata-rata satu candle.',
      kv: [['Arah', g.arah > 0 ? 'naik' : g.arah < 0 ? 'turun' : 'doji', g.arah > 0 ? 'up' : g.arah < 0 ? 'dn' : ''], ['Close', fmt(g.c, dp)], ['Badan', `${fmt(g.badan_atr, 1)}x ATR`], ['Range', `${fmt(g.range_atr, 1)}x ATR`],
        ['Struktur', esc(g.struktur_teks || '-')], (g.pola || []).length ? ['Pola', g.pola.map(e => `${esc(e.nama)} ${ARAH(e.arah)}`).join(', ')] : null,
        g.dekat ? ['Level terdekat', `${esc(g.dekat.nama)} ${fmt(g.dekat.harga, dp)} (${sgn(g.dekat.atr)}${fmt(g.dekat.atr, Math.abs(g.dekat.atr) < 0.1 ? 2 : 1)} ATR)`] : null] };
  },
  // ---- kolom 2: keputusan ----
  kp: (el, a, st) => {
    const k = st.rencana?.utama || {}, p = st.pa || {}, pr = (st.prediksi || [])[0];
    return { j: 'Keputusan gabungan', t: 'Menggabungkan sinyal price action (memori belajar) dan rencana strategi (lab). BUY/SELL = ada setup baru; BERJALAN = posisi strategi dari sinyal sebelumnya masih berjalan (bukan entry baru: yang belum ikut menunggu sinyal berikutnya); HATI-HATI = keduanya berlawanan arah; TUNGGU = belum ada setup yang lolos.',
      kv: [['Price action', esc(p.aksi || '-') + (p.nama && isAksi(p.aksi) ? ` · ${esc(p.nama)} ${TFL(p.tf)}` : ''), isAksi(p.aksi) ? kls(p.aksi) : ''],
        ['Strategi', esc(labelRencana(k.aksi, k.status) || '-') + (k.nama ? ` · ${esc(k.nama)}` : ''), isAksi(k.aksi) ? kls(k.aksi) : ''],
        pr ? [`Prediksi ${esc(pr.label)}`, `${pr.p_naik >= 50 ? 'naik' : 'turun'} ${fmt(Math.max(pr.p_naik, 100 - pr.p_naik), 0)}%`] : null],
      c: 'Perhitungan statistik dari data, bukan kepastian. AI Yulius tidak mengirim order.' };
  },
  unc: (el, a, st) => {
    const u = st.ketidakpastian; if (!u || !u.label) return { j: 'Ketidakpastian', t: 'Aktif setelah memori belajar siap.' };
    return { j: `Ketidakpastian ${esc(u.label)} · ${fmt(u.skor, 0)}/100`, t: 'Seberapa ragu kondisi pasar sekarang. Makin tinggi, makin ketat syarat sinyal dan makin kecil risiko per posisi.',
      kv: (u.komponen || []).map(z => [esc(z.nama), `${fmt(z.nilai * 100, 0)}/100 · ${esc(z.teks)}`]),
      c: `Bobot: volatilitas 30%, arah antar-timeframe 25%, pola 24 jam 22%, prediksi 13%, candle H1 10%. Rendah < 30, Sedang < 50, Tinggi < 70, di atasnya Sangat tinggi. Efek sekarang: ${esc(u.cara || '-')}` };
  },
  tren4h: (el, a, st) => { const rz = st.kebiasaan?.rezim || {};
    return { j: `Tren 4H: ${esc(rz.tren_4h || '-')}`, t: 'Posisi harga terhadap EMA50 dan EMA200 di candle 4 jam: harga > EMA50 > EMA200 = naik, kebalikannya turun, selain itu sideways. "kuat" bila ADX minimal 25, "(lemah)" bila ADX di bawah 18.',
      kv: [['ADX 4H', fmt(rz.adx_4h, 1)], ['Arah harian', rz.arah_1d > 0 ? 'naik' : rz.arah_1d < 0 ? 'turun' : 'belum jelas', rz.arah_1d > 0 ? 'up' : rz.arah_1d < 0 ? 'dn' : '']] }; },
  vol: (el, a, st) => { const kb = st.kebiasaan || {}, rz = kb.rezim || {};
    return { j: `Volatilitas ${esc(rz.vol || '-')}`, t: 'Besar ATR 1 jam sekarang dibanding 180 hari terakhir (persentil). Di bawah 25 tenang, 25-75 normal, 75-92 tinggi, 92 ke atas ekstrem.',
      kv: [['Persentil', fmt(rz.vol_persentil, 0)], ['ATR 1 jam', fmt(kb.atr_1h, dpOf())]], c: (rz.saran || []).map(esc).join(' ') }; },
  sesi_kini: (el, a, st) => { const kb = st.kebiasaan || {}, s = (kb.sesi || []).find(x => x.nama === kb.sesi_kini) || {};
    return { j: `Sesi ${esc(kb.sesi_kini || '-')}`, t: 'Sesi pasar yang sedang berjalan. Asia 07-14, London 14-20, New York 20-04, Penutupan 04-07 WIB.',
      kv: [['Jam', esc(s.jam_wib || '-') + ' WIB'], ['Range rata-rata', fmt(s.range, dpOf())], ['Sesi ditutup naik', pct(s.p_naik)]] }; },
  adr_pakai: (el, a, st) => KET.adr20(el, a, st),
  risiko: (el, a, st) => ({ j: `Risiko x${fmt(st.kebiasaan?.rezim?.pengali_risiko, 2)}`, t: 'Volatilitas sedang tinggi atau ekstrem, jadi lot otomatis dikecilkan (dikali angka ini): tinggi x0,75, ekstrem x0,50.' }),
  // ---- kolom 2: sinyal price action ----
  pa_h: { j: 'Sinyal price action', t: ['Setiap candle yang tutup diperiksa untuk 8 pola price action, lalu dibandingkan dengan kejadian serupa di memori: berapa yang mencapai target dan berapa yang kena SL.', 'BUY/SELL hanya keluar di timeframe yang lolos uji walk-forward dan ekspektasinya positif setelah biaya.'] },
  val: (el, tf, st) => {
    const v = (st.pa?.validasi || {})[tf] || (st.belajar?.validasi || {})[tf] || {};
    return { j: `Uji walk-forward ${TFL(tf)}: ${esc(v.status || 'belum')}`, t: VAL_ST[v.status] || VAL_ST.belum,
      kv: [['Sinyal lolos', fmt(v.n_lolos, 0)], ['Rata-rata', sR(v.e_lolos), v.e_lolos > 0 ? 'up' : 'dn'], ['Capai TP1', pct(v.tp1)], ['Profit factor', fmt(v.pf_lolos, 2)],
        (v.lipatan || []).length ? ['Per jendela', v.lipatan.map(z => `${z.n}: ${sR(z.e)}`).join(' · ')] : null],
      c: 'Memori diuji pada jendela data yang belum pernah dilihatnya (memori hanya dari data sebelum tiap jendela), sudah termasuk biaya spread.' };
  },
  val_st: (el, s) => ({ j: `Status uji: ${esc(s || 'belum')}`, t: VAL_ST[s] || VAL_ST.belum }),
  pa_sig: (el, a, st) => {
    const p = st.pa || {};
    if (!(p.entry != null && (isAksi(p.aksi) || p.aksi === 'PANTAU'))) return { j: 'TUNGGU', t: `Belum ada pola segar yang layak. Setiap candle ${st.mode === 'swing' ? 'H1/H4' : 'M5/M15'} yang tutup diperiksa otomatis; tabel di bawah = level yang dipantau.` };
    return { j: p.aksi === 'PANTAU' ? `PANTAU ${ARAH(p.arah)}` : `Sinyal ${esc(p.aksi)}`,
      t: p.aksi === 'PANTAU' ? 'Pola terdeteksi tapi belum layak direkomendasikan; hanya dipantau.' : 'Pola segar di timeframe yang lolos uji, dengan ekspektasi positif setelah biaya.',
      kv: [['Pola', `${esc(p.nama)} · ${TFL(p.tf)}`], ['Jenis entry', esc(p.jenis_entry || '-')], p.berlaku ? ['Berlaku sampai', wib(p.berlaku) + ' WIB'] : null, ['Konteks', esc(p.konteks || '-')]] };
  },
  pa_yakin: (el, a, st) => ({ j: `Keyakinan ${esc(st.pa?.yakin || '-')}`, t: 'Dari skor mutu sinyal: ekspektasi terkalibrasi, banyaknya kejadian serupa, searah tren TF atas, searah rencana strategi dan prediksi, lolos uji, lalu dikurangi ketidakpastian.',
    kv: [['Skor mutu', fmt(st.pa?.mutu, 0)]], c: 'Tinggi minimal 70, Sedang minimal 55, di bawahnya Rendah.' }),
  lv: (el, a, st) => {
    const [src, k] = String(a).split(':'), dp = dpOf(), px = st.harga, pa = src === 'pa';
    const p = pa ? (st.pa || {}) : (st.rencana?.utama || {}), R = pa ? p.r : p.r0, ps = !pa && p.status === 'AKTIF' ? p.posisi : null;
    const jarak = v => (v != null && px ? `${sgn(v - px)}${fmt(v - px, dp)} (${sgn(v - px)}${fmt((v - px) / px * 100, 2)}%)` : '-');
    const rugi = p.lot ? ['Rugi jika kena', `${fmt(p.lot.rugi_sl, 0)} ${esc(p.lot.mata_uang || '')}`] : null;
    if (k === 'e' && ps) return { j: 'Entry L1 (sudah terisi)', t: `Harga masuk layer pertama posisi strategi yang sudah berjalan sejak ${sejak(ps.sejak)} WIB. Bukan harga untuk entry baru: harga sudah bergerak ${fmt(Math.abs(px - p.entry), dp)} dari sini.`,
      kv: [['Harga L1', fmt(p.entry, dp)], ['Layer terisi', String(ps.terisi)], ps.terisi > 1 ? ['Harga rata-rata', fmt(ps.avg, dp)] : null, ['Jarak dari harga', jarak(p.entry)],
        ['Basket sekarang', sR(ps.r_kini), ps.r_kini > 0 ? 'up' : 'dn']] };
    if (k === 's' && ps) {
      const mu = esc(ps.mata_uang || ''), sisi = p.arah < 0 ? 'di atas' : 'di bawah';
      return { j: ps.sl_geser ? 'Stop loss trailing' : 'Stop loss',
        t: [`Untuk ${ARAH(p.arah)}, SL selalu ${sisi} harga sekarang. ` + (ps.sl_geser
          ? `SL awal ${fmt(ps.sl_awal, dp)} (${sisi} entry, 1R ${fmt(R, dp)}) sudah digeser trailing mengikuti harga terbaik${ps.terbaik != null ? ' ' + fmt(ps.terbaik, dp) : ''}` +
            (ps.kunci ? `, sampai melewati ${ps.terisi > 1 ? 'harga rata-rata basket' : 'entry'}: bila kena, posisi tetap untung.` : '.')
          : 'SL masih di posisi awal rencana.'),
          'Berlaku untuk semua layer yang sudah terisi. Bukan SL untuk entry baru: yang belum ikut menunggu sinyal berikutnya.'],
        kv: [['Harga SL', fmt(p.sl, dp)], ps.sl_geser ? ['SL awal', fmt(ps.sl_awal, dp)] : null, ['1R (SL awal)', fmt(R, dp)], ['Jarak dari harga', jarak(p.sl)],
          [ps.r_sl > 0 ? 'Untung jika kena' : 'Hasil jika kena', (ps.uang_sl != null ? `${sgn(ps.uang_sl)}${fmt(ps.uang_sl, 0)} ${mu} · ` : '') + sR(ps.r_sl), ps.r_sl > 0 ? 'up' : 'dn']],
        c: `${ps.terisi} layer terisi, sudah termasuk biaya spread.` };
    }
    if (k === 'e') return { j: 'Entry', t: `Harga masuk ${pa ? 'sinyal price action' : 'rencana strategi'} (${esc(p.jenis_entry || '-')}). Angka kecil di kanan atas kotak = jarak dari harga sekarang.`,
      kv: [['Harga', fmt(p.entry, dp)], ['Jarak dari harga', jarak(p.entry)]] };
    if (k === 's') return { j: 'Stop loss', t: pa ? 'Batas rugi, ditaruh di balik struktur pola. 1R = jarak entry ke SL; target dan hasil dihitung dalam kelipatan R.' : 'Batas rugi rencana strategi. 1R = jarak entry ke SL.',
      kv: [['Harga', fmt(p.sl, dp)], ['1R', fmt(R, dp)], ['Jarak dari harga', jarak(p.sl)], rugi] };
    if (k === 'ek') return { j: `Ekspektasi ${sR(p.e_kal)}`, t: 'Rata-rata hasil per sinyal dari kejadian serupa, sudah dikurangi biaya spread lalu dikalibrasi dengan hasil uji walk-forward (lebih hati-hati dari angka memori mentah). Positif = rata-rata menguntungkan.',
      kv: [['Memori mentah', sR(p.e)], ['Terkalibrasi', sR(p.e_kal), p.e_kal > 0 ? 'up' : 'dn']] };
    const i = +String(k).slice(1), tp = (p.tp || [])[i];
    if (pa) { const kk = (p.tp_k || [])[i], pp = (p.tp_p || [])[i];
      return { j: `TP${i + 1} · ${fmt(kk, 2)}R`, t: `Target ${fmt(kk, 2)}R dari entry. Peluang = persentase kejadian serupa di memori yang mencapai target ini sebelum kena SL (bar hijau di kotak).`,
        kv: [['Harga', fmt(tp, dp)], ['Jarak dari harga', jarak(tp)], ['Peluang', pct((pp || 0) * 100)]] }; }
    const pel = (p.statistik || {}).tp_peluang || {}, kr = tp != null && p.entry != null && R ? Math.abs(tp - p.entry) / R : null;
    const lewat = !!ps && ps.terbaik != null && tp != null && (ps.terbaik - tp) * p.arah >= 0;
    return { j: `TP${i + 1}${kr != null ? ` · ${fmt(kr, 2)}R` : ''}`, t: `Target ke-${i + 1} rencana strategi.` + (lewat ? ` Harga terbaik sejak masuk (${fmt(ps.terbaik, dp)}) sudah menyentuh level ini.` : ''),
      kv: [['Harga', fmt(tp, dp)], ['Jarak dari harga', jarak(tp)], ps ? ['Status', lewat ? 'sudah tersentuh' : 'belum tersentuh', lewat ? 'up' : ''] : null, [`Peluang capai ${i + 1}R (uji lab)`, pct(pel[(i + 1) + 'R'])]] };
  },
  pa_mem: (el, a, st) => ({ j: 'Memori serupa', t: 'Kejadian pola yang mirip (pola, arah, timeframe, konteks) di memori. "Maju" = yang terekam sejak perangkat ini mulai merekam (saat candle tutup), bukan dari riwayat. Makin banyak, makin bisa dipercaya.',
    kv: [['Serupa', fmt(st.pa?.n, 0)], ['Sampel efektif', fmt(st.pa?.n_eff, 0)], ['Maju', fmt(st.pa?.n_maju, 0)]] }),
  pa_uji: (el, a, st) => { const p = st.pa || {}, v = (p.validasi || {})[p.tf] || {};
    return { j: `Uji ${TFL(p.tf)}`, t: 'Hasil uji walk-forward timeframe ini: persentase sinyal lolos yang mencapai TP1 dan rata-rata hasilnya per sinyal.',
      kv: [['Capai TP1', pct(v.tp1)], ['Rata-rata', sR(v.e_lolos), v.e_lolos > 0 ? 'up' : 'dn'], ['Sinyal lolos', fmt(v.n_lolos, 0)]] }; },
  lot: (el, src, st) => {
    const p = src === 'pa' ? (st.pa || {}) : (st.rencana?.utama || {}), lt = p.lot || {}, s = st.setelan || {}, mu = esc(lt.mata_uang || s.mata_uang || '');
    return { j: `Lot ${esc(lt.lot ?? '-')}${src === 'rc' ? ' per layer' : ''}`, t: 'Dari Setelan: saldo x risiko% dibagi (jarak SL x ukuran kontrak).',
      kv: [['Saldo', `${fmt(s.saldo, 0)} ${esc(s.mata_uang || '')}`], ['Risiko per posisi', `${fmt(s.risiko_pct, 2)}%`], lt.risiko != null ? ['Nominal risiko', `${fmt(lt.risiko, 0)} ${mu}`] : null,
        [src !== 'pa' && p.status === 'AKTIF' && p.posisi ? 'Rugi 1R per layer (SL awal)' : 'Rugi jika kena SL', `${fmt(lt.rugi_sl, 0)} ${mu}`],
        src !== 'pa' && p.status === 'AKTIF' && p.posisi && p.posisi.uang_sl != null ? ['Hasil bila SL sekarang kena', `${sgn(p.posisi.uang_sl)}${fmt(p.posisi.uang_sl, 0)} ${mu}`, p.posisi.uang_sl > 0 ? 'up' : 'dn'] : null],
      c: lt.catatan ? esc(lt.catatan) : '' };
  },
  pa_pengali: (el, a, st) => ({ j: `Risiko x${fmt(st.pa?.pengali, 2)}`, t: 'Lot sinyal ini dikecilkan karena ketidakpastian atau volatilitas sedang tinggi.' }),
  pantau: (el, i, st) => {
    const x = ((st.pa || {}).pantau || [])[+i]; if (!x) return null; const dp = dpOf();
    return { j: `${esc(x.level)} · ${fmt(x.harga, dp)}`, t: `Jika harga sampai di level ini, skenario terbaik menurut memori: ${esc(x.skenario)} ${esc(x.nama)} ${ARAH(x.arah)} di ${TFL(x.tf)}.`,
      kv: [['Jarak', `${sgn(x.jarak_atr)}${fmt(x.jarak_atr, 1)} ATR`], ['Contoh di memori', fmt(x.n, 0)], ['Capai TP1', `${fmt(x.k1, 2)}R · ${pct(x.p1 * 100)}`],
        ['Ekspektasi memori', sR(x.e_memori)], ['Ekspektasi terkalibrasi', sR(x.e), x.e > 0 ? 'up' : 'dn'], ['Uji walk-forward', esc(x.validasi)]],
      c: 'Pantauan, bukan rekomendasi.' };
  },
  calon: (el, i, st) => {
    const p = st.pa || {}, c = (p.calon || []).filter(z => z.id !== p.id).slice(0, 3)[+i]; if (!c) return null;
    return { j: `${esc(c.nama)} ${ARAH(c.arah)} · ${TFL(c.tf)}`, t: esc(c.alasan || ''), kv: [['Candle tutup', wib(c.t_tutup) + ' WIB'], ['Status', esc(String(c.status || '').toLowerCase())]],
      c: 'Pola lain yang terdeteksi tapi tidak dipilih sebagai sinyal utama.' };
  },
  hasil_h: { j: 'Hasil pola maju terakhir', t: 'Pola yang terekam maju (saat candle tutup) dan sudah selesai dinilai. Hijau = sempat maju 1R, merah = kena SL lebih dulu. Bingkai biru = sinyal yang disarankan.' },
  hasil: (el, i, st) => {
    const x = ((st.belajar || {}).terakhir || [])[+i]; if (!x) return null;
    return { j: `${esc(x.nama)} ${ARAH(x.arah)} · ${TFL(x.tf)}`,
      kv: [['Candle pola (buka)', tgl(x.t) + ' WIB'], ['Maju maksimum', `${fmt(x.mfe, 2)}R sebelum SL`], ['Hasil', x.r1 > 0 ? 'capai 1R' : x.kena_sl ? 'kena SL' : sR(x.r1), x.r1 > 0 ? 'up' : 'dn'],
        ['Selesai', tgl(x.t_selesai) + ' WIB'], ['Disarankan', x.disarankan ? 'ya' : 'tidak']],
      c: '"Capai 1R" = harga sempat maju sejauh 1R (jarak entry ke SL) sebelum menyentuh SL.' };
  },
  salin_pa: { j: 'Salin sinyal', t: 'Menyalin sinyal price action (arah, entry, SL, TP, lot) sebagai teks ke clipboard.' },
  tanya: { j: 'Tanya AI Yulius', t: 'Menyalin pertanyaan untuk AI Yulius beserta analisis lengkap layar ini (narasi, rencana order, sinyal price action). Tempel di chat AI Yulius.' },
  // ---- kolom 2: rencana strategi ----
  rc_h: { j: 'Rencana strategi', t: ['Rencana dari strategi yang lolos lab otonom: diuji pada seluruh riwayat (segmen A/B/C), tahan biaya 2x, dan simulasi Monte Carlo.', 'Berbeda dari sinyal price action: ini aturan strategi tetap, misalnya breakout sesi atau ikut tren.'] },
  rc_status: (el, a, st) => { const k = st.rencana?.utama || {}; return { j: `Status ${esc(k.status || '-')}`, t: RC_ST[k.status] || 'Status rencana strategi.' }; },
  rc_grade: (el, a, st) => { const k = st.rencana?.utama || {};
    return { j: `Grade ${esc(k.grade || '-')} · keyakinan ${esc(k.yakin || '-')}`,
      t: 'Grade lab: A = profit factor minimal 1,35, semua segmen minimal 1,10, dan stabil di parameter tetangga; B = minimal 1,20 dan semua segmen minimal 1,00; selain itu C; D = tidak lulus. Turun satu tingkat bila drawdown Monte Carlo lebih dari 30R atau kalah beruntun minimal 14.',
      kv: [['Skor mutu', fmt(k.mutu, 0)]], c: 'Keyakinan dari skor mutu: Tinggi minimal 76, Sedang minimal 62, di bawahnya Rendah.' }; },
  rc_sig: (el, a, st) => { const k = st.rencana?.utama || {};
    const ps = k.status === 'AKTIF' ? k.posisi : null;
    return { j: `${esc(k.aksi || '-')} · ${esc(k.nama || '')} ${TFL(k.tf)}`, t: k.aksi === 'TUNGGU' ? 'Belum ada entry dari strategi ini.'
      : ps ? 'Posisi strategi dari sinyal sebelumnya masih berjalan — bukan entry baru. Yang belum ikut: tunggu sinyal berikutnya.' : `Jenis entry: ${esc(k.jenis_entry || '-')}.`,
      kv: [['Pemicu', esc(k.pemicu || '-')], k.berlaku ? ['Berlaku', esc(k.berlaku)] : null,
        ps ? ['Basket sekarang', `${sR(ps.r_kini)} (${ps.terisi} layer)`, ps.r_kini > 0 ? 'up' : 'dn'] : k.status === 'AKTIF' && k.maju_r != null ? ['Posisi sekarang', sR(k.maju_r), k.maju_r > 0 ? 'up' : 'dn'] : null,
        ps && k.maju_r != null ? ['Harga maju dari L1', sR(k.maju_r)] : null,
        ...(k.alasan || []).slice(0, 3).map((x, i) => [i ? '' : 'Alasan', esc(x)])] }; },
  rc_range: (el, a, st) => { const k = st.rencana?.utama || {}, dp = dpOf();
    return { j: 'Range sesi', t: 'High dan low range awal hari yang menjadi patokan strategi sesi; strategi menunggu harga menembus range ini.', kv: [['High', fmt(k.range?.[1], dp)], ['Low', fmt(k.range?.[0], dp)]] }; },
  rc_layer: { j: 'Layer piramida', t: ['Posisi tambahan (L2, L3, ...) hanya dibuka saat harga sudah maju searah; total rugi terburuk tetap sekitar 1R.',
    'Pada posisi berjalan: "terisi" = layer yang sudah masuk; layer berikutnya dipasang sebagai buy/sell stop, dan setelah terisi SL semua layer digeser ke angka setelah panah.'] },
  rc_slgeser: (el, a, st) => { const k = st.rencana?.utama || {}, ps = k.posisi || {}, dp = dpOf();
    return { j: 'SL sudah digeser (trailing)', t: [`Saat sinyal masuk, SL ${ARAH(k.arah)} ditaruh ${k.arah < 0 ? 'di atas' : 'di bawah'} entry (SL awal ${fmt(ps.sl_awal, dp)}). Setelah harga maju, SL ikut digeser mengikuti harga terbaik sesuai aturan trailing strategi.`,
      ps.kunci ? `Sekarang SL sudah melewati ${ps.terisi > 1 ? 'harga rata-rata basket' : 'entry'}: bila kena, posisi ditutup untung ${sR(ps.r_sl)}.` : `Bila kena sekarang, hasil basket ${sR(ps.r_sl)}.`],
      kv: [['SL awal', fmt(ps.sl_awal, dp)], ['SL sekarang', fmt(k.sl, dp)], ps.terbaik != null ? ['Harga terbaik sejak masuk', fmt(ps.terbaik, dp)] : null], c: esc(k.trailing || '') }; },
  rc_offset: (el, a, st) => ({ j: 'Selisih harga Exness', t: `Harga BTCUSDm di Exness berbeda ${sgn(st.offset_exness)}${fmt(st.offset_exness, 2)} dari Binance. Saat memasang order di Exness, geser entry, SL, dan TP sebesar selisih ini.` }),
  rc_pf: { j: 'Profit factor', t: 'Total untung dibagi total rugi pada uji strategi. Di atas 1 = untung; 1,3 ke atas tergolong bagus.' },
  rc_wr: { j: 'Persentase menang', t: 'Persentase transaksi uji yang ditutup untung.' },
  rc_n: { j: 'Sampel', t: 'Jumlah transaksi dalam uji. Makin banyak, makin bisa dipercaya.' },
  rc_dd95: { j: 'DD95', t: 'Drawdown (penurunan dari puncak) yang tidak terlampaui di 95% simulasi Monte Carlo, dalam R. Contoh: 8R dengan risiko 1% per posisi = turun sekitar 8%.' },
  rc_sumber: { j: 'Sumber statistik', t: 'Asal angka statistik di baris ini (hasil lab otonom atau preset teruji).' },
  rc_fwd: { j: 'Forward-test', t: 'Hasil nyata sejak sinyal strategi ini mulai dicatat otomatis: jumlah sinyal, persentase menang, dan total R.' },
  salin: { j: 'Salin order', t: 'Menyalin rencana order dalam format MT5 (simbol, arah, entry, SL, TP, lot) ke clipboard. Untuk XAUUSDm, level dihitung dari proxy PAXG x spot. Bila posisi strategi sudah berjalan, yang disalin adalah teks kelola posisi (layer terisi, SL semua layer, layer berikutnya), bukan order baru.' },
  alt: { j: 'Strategi lain', t: 'Strategi lain untuk mode ini beserta status, grade, pemicu, dan harga entry/SL-nya.' },
  lab: { j: 'Lab strategi', t: 'Hasil lab otonom per strategi: profit factor per segmen, drawdown, Monte Carlo, biaya 2x. Lab juga bisa dijalankan ulang dari sini.' },
  jurnal: { j: 'Jurnal forward-test', t: 'Setiap sinyal strategi dan hasilnya (masuk, SL, TP, keluar, R) dicatat otomatis.' },
  lab_st: (el, s) => ({ j: `Status ${esc(s || '-')}`, t: LAB_ST[s] || 'Status strategi di lab.' }),
  // ---- kolom 2: prediksi ----
  pred_h: { j: 'Prediksi analog', t: 'Mencari 60 kondisi pasar paling mirip di masa lalu (momentum, posisi dalam range, jarak ke EMA, jam, dan lain-lain), lalu melihat apa yang terjadi setelahnya. Hasilnya peluang, bukan kepastian.' },
  pred: (el, i, st) => {
    const p = (st.prediksi || [])[+i]; if (!p) return null;
    const a = (st.akurasi || {})[p.label], n = (st.akurasi_nyata || {})[p.label], dp = dpOf();
    return { j: `Prediksi ${esc(p.label)} ke depan`, t: `Dari ${fmt(p.n, 0)} kondisi paling mirip di masa lalu, ${fmt(p.p_naik, 0)}% berakhir naik setelah ${esc(p.label)}.`,
      kv: [['Peluang naik', pct(p.p_naik), p.p_naik >= 50 ? 'up' : 'dn'], ['Peluang dasar', pct(p.p_dasar)], ['Median harga', fmt(p.median, dp)], ['Rentang 80%', `${fmt(p.q10, dp)} - ${fmt(p.q90, dp)}`],
        ['Akurasi arah (uji)', a ? pct(a.arah) : 'menunggu lab'], n && n.n ? ['Akurasi nyata', `${pct(n.arah_pct)} dari ${fmt(n.n, 0)} prediksi`] : null],
      c: 'Bar hijau = peluang naik, garis tipis = peluang dasar (semua data). Makin jauh dari garis dasar, makin bermakna. Rentang 80% = 8 dari 10 kasus serupa berakhir di antara dua harga ini.' };
  },
  // ---- kolom 3: memori kebiasaan ----
  kb_h: { j: 'Memori kebiasaan pasar', t: 'Statistik perilaku harga simbol ini dari 180 hari terakhir: jam ramai/sepi, sesi, range harian, dan level kunci. Diperbarui otomatis.' },
  kb_t: (el, a, st) => ({ j: 'Diperbarui', t: `Statistik kebiasaan terakhir dihitung ulang pukul ${wib(st.kebiasaan?.t)} WIB (otomatis tiap 2 menit, atau saat Segarkan).` }),
  jam: (el, a, st) => {
    const J = (st.kebiasaan || {}).jam || [], j = J.find(x => x.jam_wib === +a); if (!j) return null;
    const dp = dpOf(), rs = J.map(x => x.range), mn = Math.min(...rs), mx = Math.max(...rs), rata = rs.reduce((s, x) => s + x, 0) / rs.length;
    const rank = [...J].sort((x, y) => y.range - x.range).indexOf(j) + 1, t = mx > mn ? (j.range - mn) / (mx - mn) : 0;
    const kini = (new Date().getUTCHours() + 7) % 24 === j.jam_wib;
    const kelas = rank <= 3 ? 'paling ramai' : rank > J.length - 3 ? 'paling sepi' : t >= 0.6 ? 'ramai' : t <= 0.25 ? 'sepi' : 'sedang';
    return { j: `${HH(j.jam_wib)}-${HH((j.jam_wib + 1) % 24)} WIB${kini ? ' · jam sekarang' : ''}`,
      t: `Jam ${kelas}: candle 1 jam di jam ini rata-rata bergerak ${fmt(j.range, dp)} dari low ke high.` + (Math.abs(j.p_naik - 50) < 8 ? ` Peluang ditutup naik ${fmt(j.p_naik, 0)}%: arahnya hampir 50:50.` : ''),
      kv: [['Rata-rata gerak', `${fmt(j.range, dp)} (${fmt(j.range_pct, 2)}%)`], ['Dibanding rata-rata jam', `${fmt(j.range / rata, 1)}x`], ['Peringkat', `${rank} dari ${J.length} (1 = paling ramai)`],
        ['Candle ditutup naik', pct(j.p_naik)], ['Sampel', `${fmt(j.n, 0)} hari`]],
      c: 'Warna = besar gerak, bukan arah. Biru = sepi, hijau lalu kuning = makin ramai, oranye = paling ramai.' };
  },
  heat_leg: (el, a, st) => {
    const J = (st.kebiasaan || {}).jam || []; if (!J.length) return null;
    const dp = dpOf(), s = [...J].sort((x, y) => x.range - y.range), rata = J.reduce((t, x) => t + x.range, 0) / J.length, f = x => `${HH(x.jam_wib)} (${fmt(x.range, dp)})`;
    return { j: 'Peta jam ramai dan sepi', t: '24 kotak = 24 jam WIB (kiri 00:00, kanan 23:00). Warnanya rata-rata jarak high-low candle 1 jam selama 180 hari; skalanya relatif, dari jam tersepi (biru) ke jam teramai (oranye).',
      kv: [['Paling sepi', s.slice(0, 3).map(f).join(', ')], ['Paling ramai', s.slice(-3).reverse().map(f).join(', ')], ['Rata-rata semua jam', fmt(rata, dp)]],
      c: 'Arahkan mouse ke tiap kotak untuk angka jam itu. Kotak berbingkai putih = jam sekarang.' };
  },
  sesi: (el, i, st) => {
    const kb = st.kebiasaan || {}, L = kb.sesi || [], s = L[+i]; if (!s) return null;
    const rank = [...L].sort((a, b) => b.range - a.range).indexOf(s) + 1;
    return { j: `Sesi ${esc(s.nama)} · ${esc(s.jam_wib)} WIB${s.nama === kb.sesi_kini ? ' · sedang berjalan' : ''}`,
      t: 'Range = rata-rata jarak high-low sepanjang sesi per hari. Naik = persentase hari sesi ini ditutup di atas harga pembukaannya.',
      kv: [['Range rata-rata', fmt(s.range, dpOf())], ['Peringkat', `${rank} dari ${L.length} sesi (1 = paling ramai)`], ['Ditutup naik', pct(s.p_naik)], ['Sampel', `${fmt(s.n, 0)} hari`]],
      c: 'Panjang sesi berbeda (New York 8 jam, Penutupan 3 jam), jadi sesi yang lebih panjang wajar punya range lebih besar.' };
  },
  asia: (el, a, st) => {
    const x = (st.kebiasaan || {}).asia || {}, akhir = x.range_end_wib ?? 15;
    return { j: 'Range awal hari', t: `High-low harga dari 07:00 sampai ${HH(akhir)} WIB. Setelah itu sampai 04:00 WIB dicek: apakah range ini ditembus, lalu ditutup searah tembusan (lanjut) atau kembali ke dalam range (balik).`,
      kv: [['Hari dihitung', fmt(x.hari, 0)], ['Range ditembus', pct(x.p_pecah)], ['Lanjut searah', pct(x.p_lanjut), 'up'], ['Balik ke dalam', pct(x.p_palsu), 'dn'],
        ['Tembus atas duluan', pct(x.p_atas_dulu)], ['Tembus bawah duluan', pct(x.p_bawah_dulu)]],
      c: 'Lanjut dan balik dihitung dari hari yang range-nya ditembus; sisanya ditutup di luar range pada sisi seberangnya. Dasar strategi breakout sesi.' };
  },
  adr20: (el, a, st) => { const ad = (st.kebiasaan || {}).adr || {}, dp = dpOf();
    return { j: 'ADR20 (rata-rata range harian)', t: 'Rata-rata jarak high-low candle harian 20 hari terakhir. "Hari ini" = berapa persen ADR20 yang sudah terpakai sejak 07:00 WIB.',
      kv: [['ADR20', fmt(ad.adr20, dp)], ['Range hari ini', fmt(ad.range_hari_ini, dp)], ['Terpakai', pct(ad.persen)], ['Sisa sampai rata-rata', fmt(ad.sisa, dp)]],
      c: 'Mendekati 100% = gerak hari ini sudah sebesar hari biasa.' }; },
  proyeksi: (el, a, st) => { const ad = (st.kebiasaan || {}).adr || {}, dp = dpOf();
    return { j: 'Proyeksi range hari ini', t: 'Batas wajar jika gerak hari ini mencapai rata-rata: batas bawah = high hari ini dikurangi ADR20, batas atas = low hari ini ditambah ADR20.',
      kv: [['High hari ini', fmt(ad.high, dp)], ['Low hari ini', fmt(ad.low, dp)], ['Proyeksi bawah', fmt(ad.proyeksi_bawah, dp), 'dn'], ['Proyeksi atas', fmt(ad.proyeksi_atas, dp), 'up']],
      c: 'Patokan statistik, bukan target pasti; hari yang ramai bisa melewatinya.' }; },
  syok: (el, a, st) => { const sy = (st.kebiasaan || {}).syok || {};
    return { j: 'Candle 1 jam besar', t: 'Candle 1H dengan badan lebih dari 2x ATR dalam 1 tahun terakhir. Dicek 4 jam kemudian: harga makin jauh searah candle (lanjut) atau berbalik (balik).',
      kv: [['Kejadian', fmt(sy.n, 0)], ['Lanjut', pct(sy.p_lanjut), 'up'], ['Balik', pct(sy.p_balik), 'dn'], ['Rata-rata gerak 4 jam', `${sgn(sy.rata_atr)}${fmt(sy.rata_atr, 2)}x ATR`]] }; },
  persisten: (el, a, st) => { const kb = st.kebiasaan || {};
    return { j: 'Warna berulang', t: 'Seberapa sering candle berikutnya berwarna sama dengan candle sebelumnya (hijau lalu hijau, merah lalu merah), 1 tahun terakhir.',
      kv: [['Candle 4H', pct(kb.persisten_4h)], ['Candle harian', pct(kb.persisten_1d)]],
      c: 'Sekitar 50% = acak: warna candle sebelumnya tidak membantu menebak warna berikutnya.' }; },
  level: { j: 'Level kunci', t: 'Daftar level harga penting (high/low kemarin, minggu lalu, range Asia, open hari ini, swing 1H, angka bulat) dengan jaraknya dari harga sekarang, statistik hari dalam minggu, dan catatan memori.' },
  // ---- kolom 3: belajar, rekap, aktivitas ----
  bl_h: { j: 'Belajar price action', t: 'Memori yang belajar sendiri: setiap candle M5/M15/H1/H4 yang tutup dicek untuk 8 pola, lalu hasilnya diikuti sampai kena SL, mencapai target, atau batas waktu.' },
  bl_sub: (el, a, st) => { const pg = st.belajar?.progres || {};
    return { j: 'Jumlah kejadian', t: 'Total kejadian pola di memori: dari riwayat candle ditambah yang terekam maju.', kv: [['Dari riwayat', fmt(pg.riwayat, 0)], ['Maju', fmt(pg.maju, 0)]] }; },
  bl_maju: { j: 'Perekaman maju', t: 'Maju = kejadian yang terekam saat candle tutup sejak perangkat ini merekam (bukan dari riwayat); candle selama halaman ditutup ikut dinilai saat dibuka lagi. Hari ini: baru = pola baru, dinilai = sudah selesai, capai 1R = sempat maju 1R sebelum SL, berjalan = belum selesai.' },
  bl_akurasi: { j: 'Hasil sinyal yang disarankan', t: 'Hasil nyata sinyal BUY/SELL yang benar-benar disarankan sejak perekaman maju: jumlah yang selesai, persentase capai TP1 dan TP2, dan total hasil dalam R.' },
  pola: (el, i, st) => {
    const r = (st.belajar?.tabel || [])[+i]; if (!r) return null;
    return { j: `${esc(r.nama)} ${ARAH(r.arah)} · ${TFL(r.tf)}`,
      kv: [['Kejadian', fmt(r.n, 0)], ['Capai 1R', pct(r.p1r)], ['TP optimal', `${fmt((r.k || [])[1], 2)}R · peluang ${pct(((r.p || [])[1] || 0) * 100)}`], ['Ekspektasi bersih', sR(r.e), r.e > 0 ? 'up' : 'dn'],
        ['30 hari terakhir', r.drift ? `${esc(r.drift.status)} · 1R ${pct(r.drift.p1_baru)} vs ${pct(r.drift.p1_lama)} sebelumnya` : '-'],
        r.konteks_terbaik ? ['Terbaik saat', `${esc(r.konteks_terbaik)} (${sR(r.e_terbaik)}, ${fmt(r.n_terbaik, 0)} kejadian)`] : null],
      c: 'Ekspektasi sudah dikurangi biaya spread. Melemah/menguat = 30 hari terakhir berbeda nyata dari sebelumnya; stabil = tidak berbeda.' };
  },
  pola_btn: { j: 'Semua pola', t: 'Tabel lengkap memori price action per pola dan timeframe, plus hasil uji walk-forward per jendela waktu.' },
  rk_h: { j: 'Rekap memori', t: 'Catatan ringkas yang ditulis otomatis setiap jam, sesi, dan hari selesai direkam: apa yang terjadi dan apa yang dipelajari.' },
  rekap: (el, i, st) => { const x = rekapItem(st)[+i]; if (!x) return null; return { j: `${esc(x[0])} · ${esc(x[1].judul)}`, t: esc(x[1].isi) }; },
  rekap_btn: { j: 'Riwayat rekap', t: 'Semua rekap memori simbol ini (120 terakhir).' },
  ak_h: { j: 'Aktivitas AI', t: 'Keputusan yang diambil AI secara otomatis: menjalankan lab, belajar, mengeluarkan sinyal, dan refleksi.' },
  pikir: (el, i, st) => { const p = (st.pikiran || [])[+i]; if (!p) return null; return { j: `${esc(p.jenis)} · ${wib(p.t)} WIB`, t: esc(p.isi) }; },
  pikir_btn: { j: 'Semua aktivitas', t: '200 aktivitas dan keputusan AI terakhir.' },
  // ---- setelan ----
  s_saldo: { j: 'Saldo akun', t: 'Modal untuk menghitung lot. Situs web tidak membaca akun MT5; isi saldo akun Anda di sini.' },
  s_uang: { j: 'Mata uang', t: 'Mata uang saldo; nilai risiko dan rugi ditampilkan dalam mata uang ini.' },
  s_risiko: { j: 'Risiko per posisi', t: 'Persen saldo yang siap hilang jika satu posisi kena SL. Contoh: 1% dari Rp10.000.000 = Rp100.000 per posisi.' },
  s_kurs: { j: 'Kurs USD/IDR', t: 'Untuk mengubah nilai dolar ke rupiah saat menghitung lot dan rugi.' },
  s_reset: { j: 'Setelan bawaan', t: 'Menghapus setelan manual: saldo Rp10.000.000, risiko 1% per posisi, kurs dari open.er-api.com.' },
};
const GLOS = {
  'sesi': 'Sesi pasar menurut jam WIB.', 'wib': 'Jam dalam WIB (UTC+7).', 'range': 'Rata-rata jarak high-low: besar gerak harga.',
  'naik': 'Persentase periode yang ditutup lebih tinggi dari harga pembukaannya.', 'tf': 'Timeframe: ukuran satu candle (5M = 5 menit, 1H = 1 jam, 4H = 4 jam).',
  'pola': 'Pola price action dan arahnya.', 'n': 'Jumlah kejadian di memori.', '1r': 'Persentase kejadian yang sempat maju 1R sebelum kena stop loss.',
  'tp opt': 'Target optimal (kelipatan R) dan peluang mencapainya.', 'ekspektasi': 'Rata-rata hasil per sinyal dalam R, sudah dikurangi biaya spread.',
  '30 hari': '30 hari terakhir dibanding sebelumnya: melemah, stabil, atau menguat.', '30 hari terakhir': '30 hari terakhir dibanding sebelumnya: peluang capai 1R baru vs lama.',
  'pantau level': 'Level kunci dekat harga yang sedang dipantau.', 'harga': 'Harga level.', 'jarak': 'Jarak dari harga sekarang. ATR = gerak rata-rata satu candle.',
  'atr': 'Jarak dalam satuan ATR 1 jam (gerak rata-rata satu candle 1 jam).', 'skenario terbaik': 'Skenario dengan ekspektasi terbaik di memori jika harga sampai di level ini.',
  'tp1': 'Target pertama: kelipatan R, harga, atau peluang mencapainya.', 'tp2': 'Target kedua: persentase sinyal yang mencapainya.', 'tp3': 'Target ketiga: kelipatan R dan peluang mencapainya.',
  'tp 1r': 'Persentase kejadian yang mencapai 1R sebelum kena stop loss.', 'tp2 (opt)': 'Target kedua = target optimal (ekspektasi terbaik): kelipatan R dan peluangnya.',
  'level': 'Nama level kunci.', 'hari': 'Hari dalam minggu (UTC).', 'strategi': 'Nama strategi yang diuji lab.', 'status': 'Status saat ini.',
  'grade': 'Grade lab: A terbaik, lalu B dan C; D = tidak lulus.', 'pf': 'Profit factor: total untung dibagi total rugi. Di atas 1 = untung.',
  'pf a/b/c': 'Profit factor di tiap segmen riwayat (A lama, B tengah, C terbaru). Strategi wajib untung di semua segmen.', 'transaksi': 'Jumlah transaksi dalam uji.',
  'menang': 'Persentase transaksi yang ditutup untung.', 'dd (r)': 'Drawdown terbesar dalam uji: penurunan dari puncak, dalam R.',
  'dd95 mc': 'Drawdown yang tidak terlampaui di 95% simulasi Monte Carlo (urutan transaksi diacak), dalam R.', 'biaya 2x': 'Profit factor jika biaya transaksi dua kali lipat. Di atas 1 = tetap untung.',
  'kalah beruntun': 'Kalah berturut-turut terpanjang dalam uji.', 'tp1/2/3': 'Persentase transaksi uji yang menyentuh 1R / 2R / 3R.', 'waktu (wib)': 'Waktu sinyal (WIB).',
  'arah': 'BUY atau SELL.', 'masuk': 'Harga masuk.', 'sl awal': 'Stop loss saat sinyal dibuat.', 'keluar': 'Harga keluar.', 'hasil': 'Hasil dalam R (kelipatan risiko 1R).',
  'tp tersentuh': 'Target yang sempat tersentuh.', 'sinyal lolos': 'Jumlah sinyal yang lolos aturan di data uji walk-forward.', 'rata-rata': 'Rata-rata hasil per sinyal dalam R, sudah termasuk biaya.',
  'semua pola': 'Rata-rata hasil jika semua pola diambil tanpa saringan (pembanding).', 'per jendela waktu': 'Hasil di tiap jendela uji: jumlah sinyal dan rata-rata R.',
  'diblokir': 'Pola yang diblokir karena merugi di data uji (minimal 20 sinyal, rata-rata di bawah -0,10R).', 'maju': 'Kejadian yang terekam maju sejak perangkat ini merekam (bukan dari riwayat).',
  'konteks terbaik': 'Konteks (tren, lokasi, volatilitas, sesi) dengan ekspektasi terbaik untuk pola ini.',
};

const T = { el: null, calon: null, diam: null, x: -1, y: -1, tShow: 0, tHide: 0, akhir: 0, raf: 0, fokus: false };
function tipCari(t) {
  let el = t && t.closest ? t.closest('[data-tip], th') : null;
  while (el && !el.dataset.tip) {
    if (GLOS[el.textContent.trim().toLowerCase()]) return el;
    el = el.parentElement ? el.parentElement.closest('[data-tip], th') : null;
  }
  return el;
}
function tipIsi(el) {
  if (!el.dataset.tip) { const k = el.textContent.trim(); return { j: esc(k), t: GLOS[k.toLowerCase()] }; }
  const f = KET[el.dataset.tip];
  try { return typeof f === 'function' ? f(el, el.dataset.a, S.st || {}) : (f || null); } catch (e) { console.error('keterangan', el.dataset.tip, e); return null; }
}
function tipHtml(o) {
  const par = Array.isArray(o.t) ? o.t : o.t ? [o.t] : [], kv = (o.kv || []).filter(Boolean);
  return (o.j ? `<b class="tj">${o.j}</b>` : '') + par.map(p => `<p>${p}</p>`).join('') +
    (kv.length ? `<div class="tkv">${kv.map(([k, v, c]) => `<span>${k}</span><b class="${c || ''}">${v ?? '-'}</b>`).join('')}</div>` : '') +
    (o.c ? `<span class="tc">${o.c}</span>` : '');
}
function tipLetak() {
  const b = $('#tip'), w = b.offsetWidth, h = b.offsetHeight, W = innerWidth, H = innerHeight, m = 8;
  let x, y;
  if (T.fokus && T.el) { const r = T.el.getBoundingClientRect(); x = r.left; y = r.bottom + 8; if (y + h > H - m) y = r.top - h - 8; }
  else { x = T.x + 14; y = T.y + 18; if (x + w > W - m) x = T.x - w - 12; if (y + h > H - m) y = T.y - h - 12; }
  b.style.left = Math.round(Math.max(m, Math.min(x, W - w - m))) + 'px';
  b.style.top = Math.round(Math.max(m, Math.min(y, H - h - m))) + 'px';
}
function tipTampil(el) {
  const b = $('#tip'); T.el = el;
  const o = el.isConnected ? tipIsi(el) : null;
  if (!o || !(o.j || o.t || (o.kv || []).length)) { b.classList.remove('on'); return; }
  b.innerHTML = tipHtml(o); tipLetak(); b.classList.add('on');
}
function tipSembunyi() {
  clearTimeout(T.tShow); clearTimeout(T.tHide); T.calon = null;
  if (T.el) T.akhir = Date.now();
  T.el = null; T.fokus = false; $('#tip').classList.remove('on'); petaHl(-1);
}
function tipSegarkan() {            // dipanggil setelah render ulang: elemen di bawah kursor mungkin sudah diganti
  if (!T.el) return;
  if (T.el.isConnected) return tipTampil(T.el);
  if (T.fokus) return tipSembunyi();
  const el = T.x >= 0 ? tipCari(document.elementFromPoint(T.x, T.y)) : null;
  if (el) tipTampil(el); else tipSembunyi();
}
function tipPasang() {
  document.addEventListener('mouseover', e => {
    const el = tipCari(e.target);
    if (el && el === T.diam) return;                    // baru diklik: tunggu kursor pindah dulu
    T.diam = null;
    if (el && (el === T.el || el === T.calon)) { clearTimeout(T.tHide); return; }
    clearTimeout(T.tShow); clearTimeout(T.tHide); T.calon = null;
    if (!el) { if (T.el) T.tHide = setTimeout(tipSembunyi, 120); return; }
    if (T.el || Date.now() - T.akhir < 500) { T.fokus = false; tipTampil(el); return; }
    T.calon = el;
    T.tShow = setTimeout(() => { T.calon = null; T.fokus = false; tipTampil(el); }, 220);
  });
  document.addEventListener('mousemove', e => {
    T.x = e.clientX; T.y = e.clientY;
    if (!T.el || T.fokus || T.raf) return;
    T.raf = requestAnimationFrame(() => {
      T.raf = 0; if (!T.el) return;
      if (T.el.hasAttribute('data-gerak')) tipTampil(T.el); else if ($('#tip').classList.contains('on')) tipLetak();
    });
  }, { passive: true });
  document.documentElement.addEventListener('mouseleave', tipSembunyi);
  document.addEventListener('mousedown', e => { const el = tipCari(e.target); if (el && el.hasAttribute('data-gerak')) return; T.diam = el; tipSembunyi(); }, true);
  addEventListener('wheel', tipSembunyi, { passive: true });
  addEventListener('blur', tipSembunyi);
  addEventListener('keydown', e => { if (e.key === 'Escape') tipSembunyi(); });
  document.addEventListener('focusin', e => { const el = tipCari(e.target); if (el && e.target.matches(':focus-visible')) { clearTimeout(T.tShow); T.fokus = true; tipTampil(el); } });
  document.addEventListener('focusout', () => { if (T.fokus) tipSembunyi(); });
}

/* keterangan di peta sinyal: candle, label pola, segitiga swing, garis, sumbu harga */
function petaHl(i) {
  const hl = $('#peta-hl'), G = S.geo, cv = $('#peta');
  if (!hl) return;
  if (!G || i == null || i < 0 || i >= G.n) { hl.classList.add('hidden'); return; }
  hl.style.left = (cv.offsetLeft + i * G.bw) + 'px'; hl.style.top = cv.offsetTop + 'px';
  hl.style.width = Math.max(2, G.bw) + 'px'; hl.style.height = G.H + 'px';
  hl.classList.remove('hidden');
}
function polaKet(e, tf) {
  const dp = dpOf(), STS = { selesai: 'selesai dinilai', berjalan: 'masih diikuti', menunggu: 'menunggu candle entry', batal: 'batal (harga melompati SL)' };
  const hasil = e.status === 'selesai' ? (e.mfe >= 1 ? ['Hasil', 'capai 1R', 'up'] : ['Hasil', e.kena_sl ? 'kena SL sebelum 1R' : `maju maks ${fmt(e.mfe, 2)}R`, 'dn'])
    : e.mfe != null ? ['Maju sejauh ini', `${fmt(e.mfe, 2)}R`] : null;
  return { j: `${esc(e.nama)} ${ARAH(e.arah)} · ${TFL(tf)}`, t: e.disarankan ? 'Pola ini disarankan sebagai sinyal saat itu (bingkai biru).' : 'Pola yang terdeteksi dan dicatat di memori belajar.',
    kv: [['Candle pola (buka)', tgl(e.t) + ' WIB'], ['Close pola', fmt(e.harga, dp)], ['Stop loss', fmt(e.sl, dp)], ['Status', STS[e.status] || esc(e.status || '-')], hasil,
      ['Sumber', e.sumber === 'maju' ? 'terekam maju' : 'riwayat']],
    c: 'Kotak terisi warna = sudah capai 1R; abu-abu = selesai tanpa 1R; polos = belum selesai.' };
}
function petaKet() {
  const G = S.geo, cv = $('#peta'), st = S.st || {};
  if (!G || !cv) return { j: 'Peta sinyal AI', t: 'Peta sedang dimuat.' };
  const r = cv.getBoundingClientRect(), x = T.x - r.left, y = T.y - r.top, dp = dpOf(), px = st.harga;
  if (x < 0 || y < 0 || x > r.width || y > r.height) { petaHl(-1); return null; }
  const jarak = v => (px && v != null ? `${sgn(v - px)}${fmt(v - px, dp)} (${sgn(v - px)}${fmt((v - px) / px * 100, 2)}%)` : '-');
  const kt = G.kotak.find(b => x >= b.x - 1 && x <= b.x + b.w + 1 && y >= b.y - 1 && y <= b.y + b.h + 1);
  if (kt && kt.swing) {
    petaHl(kt.i);
    return { j: `Swing ${kt.swing} · ${fmt(kt.v, dp)}`, t: `Titik balik ${kt.swing === 'high' ? 'tertinggi' : 'terendah'} terakhir yang dipakai untuk membaca struktur pasar${kt.tembus ? ' (sudah ditembus)' : ''}.`,
      kv: [['Waktu', tgl(kt.t) + ' WIB'], ['Jarak dari harga', jarak(kt.v)]] };
  }
  if (kt) { petaHl(kt.i); return polaKet(kt.e, G.tf); }
  const sumbu = x > G.W - G.padR;
  let best = null;
  G.garis.forEach(gx => { const d = Math.abs((sumbu && gx.ly != null ? gx.ly : gx.y) - y); if (d <= (sumbu ? 7 : 3.5) && (!best || d < best.d)) best = { ...gx, d }; });
  if (best) {
    petaHl(sumbu ? -1 : Math.floor(x / G.bw));
    return { j: `${esc(best.nm || '')} · ${fmt(best.v, dp)}`, t: esc(best.ket || ''), kv: [best.nm === 'Harga sekarang' ? null : ['Jarak dari harga', jarak(best.v)]] };
  }
  if (sumbu) { petaHl(-1); return { j: 'Sumbu harga', t: `Harga di posisi kursor: ${fmt(G.inv(y), dp)}. Kotak berwarna di sumbu = label garis entry, SL, TP, dan harga sekarang.` }; }
  const i = Math.floor(x / G.bw); if (i < 0 || i >= G.n) { petaHl(-1); return null; }
  petaHl(i);
  const C = G.C, o = C.o[i], h = C.h[i], l = C.l[i], c = C.c[i], pl = G.polaDi[i] || [], kc = c > o ? 'up' : c < o ? 'dn' : '';
  return { j: `Candle ${TFL(G.tf)} · buka ${tgl(C.t[i])} WIB`,
    kv: [['Open', fmt(o, dp)], ['High', fmt(h, dp)], ['Low', fmt(l, dp)], ['Close', fmt(c, dp), kc], ['Perubahan', `${sgn(c - o)}${fmt(c - o, dp)} (${sgn(c - o)}${fmt(o ? (c - o) / o * 100 : 0, 2)}%)`, kc],
      ['Range', fmt(h - l, dp)], pl.length ? ['Pola', pl.map(e => `${esc(e.nama)} ${ARAH(e.arah)}`).join(', ')] : null],
    c: `Harga di posisi kursor ${fmt(G.inv(y), dp)}.` };
}

/* ---------------- loop ---------------- */
function renderAll() {
  const st = S.st; if (!st) return;
  $('#subjudul').textContent = `${st.cfg?.judul || ''} · ${st.sumber || '-'} · ${wib(st.t_rencana || st.now, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
  const tugas = [tv, () => renderFeeds(st), () => renderKeputusan(st), () => renderPA(st), () => renderRencana(st), () => renderPrediksi(st),
    () => renderKebiasaan(st), () => renderBelajar(st), () => renderRekap(st), () => renderAktivitas(st), () => renderGerak(st), () => renderPeta(false)];
  tugas.forEach(f => { try { f(); } catch (e) { console.error(e); } });
  renderBanner();
  tipSegarkan();
}
function renderBanner() {
  const st = S.st || {}, b = $('#banner');
  let html = '';
  if (S.webBaru) html = 'Tampilan Trading versi baru tersedia.<button class="btn utama" id="btn-muat">Muat sekarang</button>';
  else if (S.st && !st.siap) html = esc(st.riwayat ? `Mengunduh riwayat ${st.riwayat.sym} ${st.riwayat.tf} (sekali saja)…` : 'Menyiapkan data riwayat…');
  else if (st.belajar && st.belajar.proses && !st.belajar.siap) html = 'AI Yulius sedang mengisi memori price action dari riwayat candle (sekali, beberapa detik)…';
  if (b.dataset.isi !== html) { b.innerHTML = html; b.dataset.isi = html; }
  b.classList.toggle('hidden', !html);
}

/* ---------------- pembaruan real-time + tombol Segarkan ----------------
   Tiap S.live detik: denyut (harga hidup + jam putaran tiap loop mesin). Harga di header & candle terakhir peta langsung
   ikut; state lengkap hanya diambil bila mesin selesai menghitung putaran baru (±2 dtk). */
let janjiState = null;
function poll() {                       // permintaan bersamaan digabung; hasil simbol/mode lama dibuang
  if (janjiState) return janjiState;
  const sym = S.sym, mode = S.mode;
  janjiState = (async () => {
    try {
      const st = await api(`/api/state?sym=${sym}&mode=${mode}`);
      if (sym !== S.sym || mode !== S.mode) return;
      const h = S.dn?.harga?.[sym];
      if (h && h.p != null && h.t > (st.t_rencana || 0)) st.harga = h.p;      // harga denyut lebih baru dari hitungan terakhir
      S.st = st; S.tState = S.tOk = Date.now(); S.gagal = 0;
      if (st.web) cekVersi(st.web);
      renderAll();
    } catch (e) { S.gagal++; $('#subjudul').textContent = 'Mesin trading belum menjawab: ' + e.message; }
    finally { janjiState = null; }
  })();
  return janjiState;
}
async function pollBaru() { if (janjiState) await janjiState; return poll(); }      // pasti mengambil yang terbaru
async function pollRingkas() { try { S.rk = await api('/api/ringkas'); S.tRk = Date.now(); renderPairs(); tipSegarkan(); } catch (e) {} }

async function denyut() {
  const d = await api('/api/denyut');
  S.dn = d; S.tOk = Date.now(); S.gagal = 0;
  cekVersi(d.web);
  const rk = S.rk || (S.rk = {});
  Object.entries(d.harga || {}).forEach(([s, h]) => { if (h && h.p != null) (rk[s] = rk[s] || {}).harga = h.p; });
  renderPairs();
  const h = (d.harga || {})[S.sym];
  if (S.st && h && h.p != null) { S.st.harga = h.p; petaHidup(h.p); }
  const p = d.putaran || {}, baru = p.hitung !== S.putaran.hitung, now = Date.now(), tugas = [];
  S.putaran = p;
  if (baru) kedip();
  if (baru || now - S.tState > 10000) tugas.push(pollBaru());
  if (baru || now - S.tRk > 6000) tugas.push(pollRingkas());
  if (now - S.petaT > 5000) tugas.push(renderPeta(true));
  await Promise.all(tugas);
}

async function detak() {
  clearTimeout(S.tmr);
  const now = Date.now(), jeda = S.tTick ? now - S.tTick : 0;
  S.tTick = now;
  if (jeda > 45000 && S.live > 0 && !document.hidden && !S.segar) segarkan('bangun');   // perangkat baru bangun dari tidur
  else if (S.live > 0 && !S.segar && !document.hidden) {
    try {
      await denyut();
    } catch (e) {
      S.gagal++;
    }
  }
  liveUi();
  S.tmr = setTimeout(detak, S.live > 0 ? S.live * 1000 : 1000);
}

function lalu(ms) { const d = Math.max(0, ms) / 1000; return d < 10 ? fmt(d, 1) + ' dtk' : d < 90 ? fmt(d, 0) + ' dtk' : fmt(d / 60, 0) + ' mnt'; }
function liveKelas() {
  const now = Date.now(), h = S.dn?.harga?.[S.sym], umur = h?.t && S.dn ? S.dn.now - h.t + (now - S.tOk) : null;
  if (S.segar) return 'segar';
  if (S.live === 0) return 'jeda';
  if (S.gagal >= 2 || (S.tOk && now - S.tOk > 6000 + S.live * 2000)) return 'putus';
  if (!S.lama && umur != null && umur > 6000) return 'lambat';
  return 'on';
}
function liveUi() {
  const el = $('#live'); if (!el) return;
  const k = liveKelas();
  el.classList.remove('on', 'lambat', 'putus', 'jeda', 'segar'); el.classList.add(k);
  const lbl = { on: 'LIVE', lambat: 'LAMBAT', putus: 'TERPUTUS', jeda: 'JEDA', segar: 'SEGARKAN' }[k];
  if ($('#live-lbl').textContent !== lbl) $('#live-lbl').textContent = lbl;
  $$('#live-menu [data-live]').forEach(b => { const on = +b.dataset.live === S.live; b.classList.toggle('on', on); b.setAttribute('aria-checked', on ? 'true' : 'false'); });
  if (T.el && T.el.id === 'live-btn') tipTampil(T.el);
}
function kedip() { const el = $('#live'); el.classList.remove('kedip'); void el.offsetWidth; el.classList.add('kedip'); clearTimeout(kedip._t); kedip._t = setTimeout(() => el.classList.remove('kedip'), 450); }
function kilat() { $$('.panel').forEach(p => { p.classList.remove('kilat'); void p.offsetWidth; p.classList.add('kilat'); }); setTimeout(() => $$('.panel.kilat').forEach(p => p.classList.remove('kilat')), 950); }

function cekVersi(v) {
  if (!v) return;
  if (!S.web0) { S.web0 = v; return; }
  if (v === S.web0 || S.webBaru) return;
  S.webBaru = true;
  if (document.hidden) return muatUlang();               // tidak sedang dilihat: langsung pakai versi baru
  $('#btn-segar').classList.add('baru'); $('#btn-segar').setAttribute('aria-label', 'Muat versi tampilan baru');
  renderBanner();
}
function muatUlang() {                                  // halaman + chart dimuat dari awal (memori tetap di IndexedDB)
  ST.set('xauusd.sym', S.sym); ST.set('xauusd.mode', S.mode);
  try { MESIN.w && MESIN.w.postMessage({ id: 0, path: 'simpan' }); } catch (e) {}
  if (location.search || location.hash) location.replace(location.pathname); else location.reload();
}
function tvMuat() {                                     // chart TradingView gagal dimuat (mis. internet putus saat dibuka) → coba lagi
  if (window.TradingView) { S.tvKey = ''; tv(); return; }
  if (tvMuat.jalan) return;
  tvMuat.jalan = true;
  const sc = document.createElement('script');
  sc.src = 'https://s3.tradingview.com/tv.js';
  sc.onload = () => { tvMuat.jalan = false; S.tvKey = ''; tv(); };
  sc.onerror = () => { tvMuat.jalan = false; sc.remove(); };
  document.body.appendChild(sc);
}

async function segarkan(asal = 'tombol') {
  if (S.segar) return;
  if (S.webBaru && asal === 'tombol') return muatUlang();
  S.segar = true; menuLive(false); liveUi();
  const btn = $('#btn-segar'); btn.classList.add('putar'); btn.disabled = true;
  const t0 = performance.now();
  let r = null, err = null;
  try { r = await api('/api/segarkan', { method: 'POST', body: JSON.stringify({ sym: S.sym, mode: S.mode }) }); }
  catch (e) { err = e; }
  S.petaT = 0; S.tState = 0; S.tRk = 0; S.putaran = {};       // semua panel diambil ulang
  try { await denyut(); }
  catch (e) { await Promise.all([pollBaru(), pollRingkas(), renderPeta(true)]).catch(() => {}); }
  if (!window.TradingView || !$('#tv-off').classList.contains('hidden')) tvMuat();
  const dt = (performance.now() - t0) / 1000;
  S.segarHasil = r ? { ...r, klien: dt } : { ok: false, t: Date.now(), detik: dt, catatan: err ? err.message : '' };
  S.segar = false; btn.classList.remove('putar'); btn.disabled = false;
  liveUi(); kilat(); tipSegarkan();
  const diam = asal !== 'tombol';
  if (err) toast('Gagal menyegarkan: ' + err.message, 4500);
  else if (r.ok === false && r.pesan) toast(r.pesan, 4500);
  else if (r.ok === false) toast(`Sebagian data belum tersegarkan · ${r.catatan || 'coba lagi sebentar'}`, 5000);
  else if (!diam || r.catatan) toast(`${diam ? 'Data diperbarui setelah jeda' : 'Semua data disegarkan'} · ${fmt(dt, 1)} dtk${r.catatan ? ' · ' + r.catatan : ''}`, r.catatan ? 4500 : 2600);
}

function menuLive(buka) {
  const m = $('#live-menu'), b = $('#live-btn');
  if (!m) return;
  const on = buka == null ? m.classList.contains('hidden') : !!buka;
  if (on === !m.classList.contains('hidden')) return;
  m.classList.toggle('hidden', !on); b.setAttribute('aria-expanded', on ? 'true' : 'false');
  if (on) { tipSembunyi(); liveUi(); (m.querySelector('[data-live].on') || m.querySelector('button')).focus(); }
}
function pasangLive() {
  $('#live-btn').onclick = () => menuLive();
  $$('#live-menu [data-live]').forEach(b => b.onclick = () => {
    S.live = +b.dataset.live; ST.set('xauusd.live', S.live); menuLive(false); liveUi(); detak();
    toast(S.live === 0 ? 'Pembaruan otomatis dijeda. Tekan ⌘R untuk menyegarkan.' : S.live === 1 ? 'Pembaruan real-time: harga tiap detik.' : `Pembaruan otomatis tiap ${S.live} detik.`);
  });
  $('#lm-segar').onclick = () => segarkan();
  $('#lm-muat').onclick = () => muatUlang();
  $('#btn-segar').onclick = () => segarkan();
  $('#banner').onclick = e => { if (e.target.closest('#btn-muat')) muatUlang(); };
  document.addEventListener('mousedown', e => { if (!e.target.closest('#live')) menuLive(false); });
  $('#live-menu').addEventListener('keydown', e => {
    const it = $$('#live-menu button'), i = it.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); it[(i + (e.key === 'ArrowDown' ? 1 : -1) + it.length) % it.length].focus(); }
    if (e.key === 'Escape') { menuLive(false); $('#live-btn').focus(); }
  });
  addEventListener('keydown', e => {                    // ⌘R / Ctrl+R / F5 = segarkan; dengan Shift = muat ulang halaman
    if (!(((e.metaKey || e.ctrlKey) && (e.key === 'r' || e.key === 'R')) || e.key === 'F5')) return;
    e.preventDefault();
    if (e.shiftKey) muatUlang(); else segarkan();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { S.tHilang = Date.now(); try { MESIN.w && MESIN.w.postMessage({ id: 0, path: 'simpan' }); } catch (e) {} return; }
    const lama = S.tHilang ? Date.now() - S.tHilang : 0; S.tHilang = 0;
    if (lama > 60000 && S.live > 0) segarkan('kembali'); else detak();
  });
  addEventListener('online', () => segarkan('online'));
  addEventListener('offline', liveUi);
}

function pilih(sym, mode) {
  if (sym) S.sym = sym; if (mode) S.mode = mode;
  ST.set('xauusd.sym', S.sym); ST.set('xauusd.mode', S.mode);
  S.st = null; S.peta = null; S.petaTf = null; S.petaT = 0; renderPairs(); pollBaru();
}

function teksTanya() {
  const k = S.st?.rencana?.utama, p = S.st?.pa;
  return `Analisis trading ${S.sym} mode ${S.mode === 'scalp' ? 'scalping' : 'swing'} sekarang memakai tool trading: jelaskan keputusan AI Yulius, ` +
    `sinyal price action ${p && p.aksi ? p.aksi + (p.nama ? ' (' + p.nama + ' ' + TFL(p.tf) + ')' : '') : ''}, rencana strategi ${k ? k.aksi + ' (' + k.nama + ')' : ''}, ` +
    `entry, SL, TP, ketidakpastian pasar, memori kebiasaan, dan apa yang harus saya waspadai.`;
}

function init() {
  $$('.pair').forEach(b => b.onclick = () => pilih(b.dataset.sym));
  $$('#mode-seg button').forEach(b => b.onclick = () => pilih(null, b.dataset.mode));
  $('#btn-salin').onclick = async () => { const t = S.st?.order_teks; if (!t) return; try { await navigator.clipboard.writeText(t); toast('Rencana order disalin (format MT5).'); } catch (e) { toast('Gagal menyalin'); } };
  $('#btn-salin-pa').onclick = async () => { const t = S.st?.order_teks_pa; if (!t) return; try { await navigator.clipboard.writeText(t); toast('Sinyal price action disalin.'); } catch (e) { toast('Gagal menyalin'); } };
  $('#btn-tanya').onclick = async () => {
    let teks = teksTanya();
    try { const t = await api(`/api/teks?sym=${S.sym}&mode=${S.mode}`); if (t) teks += '\n\nData dari layar Trading (web):\n' + t; } catch (e) {}
    try { await navigator.clipboard.writeText(teks); toast('Pertanyaan + analisis disalin; tempel di chat AI Yulius.', 3200); } catch (e) { toast('Gagal menyalin'); }
  };
  $('#btn-alt').onclick = modalAlt; $('#btn-lab').onclick = modalLab; $('#btn-jurnal').onclick = modalJurnal;
  $('#btn-pikiran').onclick = modalPikiran; $('#btn-rekap').onclick = modalRekap; $('#btn-pola').onclick = modalPola;
  $('#btn-level').onclick = modalLevel; $('#btn-analisis').onclick = modalAnalisis;
  $('#modal-tutup').onclick = tutup; $('#modal').onclick = e => { if (e.target.id === 'modal') tutup(); };
  addEventListener('keydown', e => { if (e.key === 'Escape') { tutup(); $('#modal-setelan').classList.add('hidden'); } });
  $('#btn-penuh').onclick = () => {
    if (document.fullscreenElement) document.exitFullscreen?.(); else document.documentElement.requestFullscreen?.();
  };
  $('#btn-tema').onclick = () => { const cur = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'; document.documentElement.dataset.theme = cur; try { localStorage.setItem('xauusd.tema', cur); } catch (e) {} renderAll(); };
  $('#btn-setelan').onclick = () => {
    const s = S.st?.setelan || {}; $('#s-saldo').value = s.saldo ?? ''; $('#s-uang').value = s.mata_uang || 'IDR'; $('#s-risiko').value = s.risiko_pct ?? 1; $('#s-kurs').value = Math.round(s.usd_idr || 16500);
    $('#s-info').textContent = 'Lot dihitung dari saldo x risiko ÷ (jarak SL x ukuran kontrak). Setelan disimpan di perangkat ini.';
    $('#modal-setelan').classList.remove('hidden');
  };
  $('#s-batal').onclick = () => $('#modal-setelan').classList.add('hidden');
  $('#s-reset').onclick = async () => { await api('/api/setelan', { method: 'POST', body: JSON.stringify({ reset: true }) }); $('#modal-setelan').classList.add('hidden'); toast('Setelan kembali ke bawaan (Rp10.000.000, risiko 1%).'); poll(); };
  $('#s-simpan').onclick = async () => {
    try { await api('/api/setelan', { method: 'POST', body: JSON.stringify({ saldo: $('#s-saldo').value, mata_uang: $('#s-uang').value, risiko_pct: $('#s-risiko').value, usd_idr: $('#s-kurs').value }) });
      $('#modal-setelan').classList.add('hidden'); toast('Setelan disimpan.'); poll(); } catch (e) { toast(e.message); }
  };
  let rz; addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => { if (S.st) drawPeta(S.peta, S.st); }, 120); });
  const jam = () => { $('#clock').textContent = new Date().toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit', second: '2-digit' }) + ' WIB'; liveUi(); };
  jam(); setInterval(jam, 1000);
  tipPasang(); pasangLive();
  mesinMulai();
  renderPairs(); poll(); pollRingkas(); detak();
  window.__trading = { pilih, state: () => S.st, render: () => renderAll(), geo: () => S.geo, segarkan, muatUlang,
    live: () => ({ live: S.live, kelas: liveKelas(), dn: S.dn, putaran: S.putaran, segarHasil: S.segarHasil, webBaru: S.webBaru, web0: S.web0 }), api };
}
init();
})();
