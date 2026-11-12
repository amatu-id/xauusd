/* Trading AI Yulius (web) — mesin analisis yang berjalan di Web Worker browser.
   Port lengkap dari AI Yulius files/trading (Python): feed, indikator, strategi, uji balik, lab otonom, memori kebiasaan,
   prediksi analog, rencana posisi, memori belajar price action, sinyal, ketidakpastian, rekap, narasi.
   Tanpa server dan tanpa Mac: data langsung dari Binance (BTCUSDT, PAXGUSDT) + harga spot emas (gold-api.com),
   disimpan di IndexedDB perangkat ini. XAUUSDm = PAXGUSDT x rasio harga spot emas (jam pasar emas).
   Hanya membaca pasar — tidak pernah mengirim order.
   Berkas ini dibangun dari src/*.js oleh build.sh. */
'use strict';

// ================================================================== konfig
const DAY = 86400000, HOUR = 3600000, MENIT = 60000;
const WIB = 7 * HOUR;
const TF_MS = { '1m': 60000, '5m': 300000, '15m': 900000, '1h': 3600000, '4h': 14400000, '1d': 86400000 };
// Berapa hari riwayat yang disimpan per TF (cukup untuk kebiasaan, prediksi analog, lab walk-forward, memori belajar).
const SIMPAN_HARI = { '1m': 2, '5m': 400, '15m': 760, '1h': 1500, '4h': 3000, '1d': 3200 };

const SIMBOL = {
  XAUUSDm: {
    nama: 'XAUUSDm', judul: 'Emas (Exness)', tv: 'OANDA:XAUUSD', binance: 'PAXGUSDT', dp: 2, kontrak: 100.0, lot_min: 0.01, lot_step: 0.01,
    biaya_pct: 0.0001,            // ≈ $0,40 per transaksi (spread XAUUSDm ±0,2–0,3 + slip)
    bulat: 50.0, bulat_kecil: 10.0, pasar_24j: false,
    sesi_preset: { range_start: 0, range_end: 6, entry_end: 16, sl_max_atr: 2.0, trail_atr: 2.0 },
  },
  BTCUSDT: {
    nama: 'BTCUSDT', judul: 'Bitcoin', tv: 'BINANCE:BTCUSDT', binance: 'BTCUSDT', dp: 2, kontrak: 1.0, lot_min: 0.01, lot_step: 0.01,
    biaya_pct: 0.00025,           // spread + slip per transaksi (≈ $18 di 73k), konservatif
    bulat: 1000.0, bulat_kecil: 250.0, pasar_24j: true,
    sesi_preset: { range_start: 0, range_end: 8, entry_end: 16, sl_max_atr: 3.0, trail_atr: 3.0 },
  },
};
const SYMS = Object.keys(SIMBOL);           // XAUUSDm dulu: situs ini XAUUSD

// Sesi pasar (jam UTC). Asia 00–07 (07:00–14:00 WIB), London 07–13, New York 13–21, penutupan 21–24.
const SESI = [['Asia', 0, 7], ['London', 7, 13], ['New York', 13, 21], ['Penutupan', 21, 24]];

const MODE = {
  scalp: { judul: 'Scalping', tf_chart: '5', tf_utama: '15m', horizon: [['1 jam', '15m', 4], ['4 jam', '15m', 16]] },
  swing: { judul: 'Swing', tf_chart: '60', tf_utama: '1h', horizon: [['4 jam', '1h', 4], ['1 hari', '1h', 24]] },
};
const MODES = Object.keys(MODE);

const RISIKO_DEFAULT = { saldo: 10000000.0, mata_uang: 'IDR', risiko_pct: 1.0, usd_idr: 16500.0, gaya_layer: 'piramida', maks_layer: 3 };

// ================================================================== waktu
const hariKe = t => (Math.floor(t / DAY) + 3) % 7;            // Senin = 0 (1 Jan 1970 = Kamis)
const jamUtc = t => Math.floor((((t % DAY) + DAY) % DAY) / HOUR);
const hariKerja = t => hariKe(t) < 5;

/** Spot emas tutup Jumat 21:00 UTC s/d Minggu 22:00 UTC (perkiraan; jeda harian diabaikan). */
function pasarEmasBuka(t) {
  const wd = hariKe(t), h = jamUtc(t);
  if (wd === 5) return false;
  if (wd === 4 && h >= 21) return false;
  if (wd === 6 && h < 22) return false;
  return true;
}

function tahunUtc(t) { return new Date(t).getUTCFullYear(); }
/** Minggu ISO (tahun*100 + minggu), sama seperti datetime.isocalendar()[:2]. */
function mingguIso(t) {
  const d = new Date(Math.floor(t / DAY) * DAY);
  const wd = (d.getUTCDay() + 6) % 7;                        // Senin = 0
  const kamis = new Date(d.getTime() + (3 - wd) * DAY);
  const th = kamis.getUTCFullYear();
  const awal = Date.UTC(th, 0, 1);
  const mg = Math.floor((kamis.getTime() - awal) / DAY / 7) + 1;
  return th * 100 + mg;
}

const now = () => Date.now();
const tidur = ms => new Promise(r => setTimeout(r, ms));

// ================================================================== angka & teks (gaya Indonesia, sama seperti rencana.fmt)
const fin = x => typeof x === 'number' && Number.isFinite(x);
const nul = x => (x == null || (typeof x === 'number' && !Number.isFinite(x))) ? null : x;

function fmt(x, dp = 2) {
  if (x == null || typeof x !== 'number' || !Number.isFinite(x)) return '-';
  let s = x.toFixed(dp);
  let neg = '';
  if (s[0] === '-') { neg = '-'; s = s.slice(1); }
  const [a, b] = s.split('.');
  return neg + a.replace(/\B(?=(\d{3})+(?!\d))/g, '.') + (b ? ',' + b : '');
}
/** R bertanda gaya Indonesia: +0,12R / -0,31R. */
function fr(x, dp = 2) { if (x == null || !fin(x)) return '-'; return (x > 0 ? '+' : '') + fmt(x, dp) + 'R'; }
/** Angka bertanda gaya Indonesia (+0,46 / -2,20) + akhiran. */
function fs(x, dp = 2, akhir = '') { if (x == null || !fin(x)) return '-'; return (x > 0 ? '+' : '') + fmt(x, dp) + akhir; }
/** Format Python f'{x:.Nf}' (titik desimal, tanpa pemisah ribuan). */
const fx = (x, dp = 0) => (x == null || !fin(x)) ? 'nan' : x.toFixed(dp);
/** Format Python f'{x:g}' untuk angka sederhana. */
const fg = x => String(+x);
const pad2 = n => String(n).padStart(2, '0');
/** Jam/tanggal WIB: %H %M %d %m %Y. */
function wib(t, f = '%H:%M') {
  const d = new Date(t + WIB);
  return f.replace('%H', pad2(d.getUTCHours())).replace('%M', pad2(d.getUTCMinutes())).replace('%d', pad2(d.getUTCDate()))
    .replace('%m', pad2(d.getUTCMonth() + 1)).replace('%Y', String(d.getUTCFullYear()));
}
const AB = d => (d > 0 ? 'BUY' : 'SELL');

// ================================================================== statistik kecil (numpy)
function klip(x, a = 0, b = 1) { return Math.min(b, Math.max(a, x)); }
function jumlah(a) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s; }
function rata(a) { return a.length ? jumlah(a) / a.length : NaN; }
function simpangan(a) {       // np.std (ddof=0)
  const n = a.length; if (!n) return NaN;
  const m = rata(a); let s = 0; for (let i = 0; i < n; i++) s += (a[i] - m) ** 2; return Math.sqrt(s / n);
}
function urutF(a) { return Float64Array.from(a).sort(); }
function kuantil(a, q) {      // np.quantile (linear)
  const s = urutF(a), n = s.length; if (!n) return NaN;
  const pos = (n - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}
function median(a) { return kuantil(a, 0.5); }
/** searchsorted side='left': indeks pertama dengan a[i] >= x. */
function cariKiri(a, x, n = a.length) { let lo = 0, hi = n; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < x) lo = m + 1; else hi = m; } return lo; }
/** searchsorted side='right': indeks pertama dengan a[i] > x. */
function cariKanan(a, x, n = a.length) { let lo = 0, hi = n; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] <= x) lo = m + 1; else hi = m; } return lo; }
/** np.interp (dijepit di ujung). */
function interp(x, xs, ys) {
  const n = xs.length;
  if (x <= xs[0]) return ys[0];
  if (x >= xs[n - 1]) return ys[n - 1];
  let j = 1; while (j < n && xs[j] < x) j++;
  const x0 = xs[j - 1], x1 = xs[j];
  return ys[j - 1] + (ys[j] - ys[j - 1]) * (x - x0) / (x1 - x0);
}
const tanda = x => (x > 0 ? 1 : x < 0 ? -1 : 0);

/** PRNG deterministik (mulberry32) — pengganti random.Random(run) / np.random.default_rng. */
function acak(benih) {
  let a = (benih >>> 0) || 1;
  const f = () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return {
    acak: f,
    pilih: arr => arr[Math.floor(f() * arr.length)],
    acakUrut(arr) { const b = Array.from(arr); for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(f() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; },
  };
}

/** Kerja berat dipecah: beri jalan loop lain (harga, layar) setiap ±35 ms. */
const LEGA = { t: 0 };
async function lega(paksa = false) {
  const t = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  if (paksa || t - LEGA.t > 35) { await new Promise(r => setTimeout(r, 0)); LEGA.t = (typeof performance !== 'undefined' ? performance.now() : Date.now()); }
}

function klon(v) {
  if (v === undefined) return null;
  try { return structuredClone(v); } catch (e) { return JSON.parse(JSON.stringify(v)); }
}
const teksGalat = e => (e && e.message) ? `${e.name || 'Error'}: ${e.message}` : String(e);
// ================================================================== penyimpanan (IndexedDB perangkat ini)
// Pengganti SQLite db.py: candle (kolom Float64Array, dipotong per 2880 bar), kv (pengaturan, hasil uji, kursor),
// tabel kecil (pikiran, jurnal sinyal, prediksi, rekap, strategi aktif, kebiasaan) dan kejadian price action MAJU.
// Hanya satu tab (pemegang kunci) yang menulis ke IndexedDB; tab lain menghitung di memori saja.
const IDB_NAMA = 'trading-ai-yulius-xauusd';
const IDB_VERSI = 1;
let IDB = null;
let PEMIMPIN = false;
const KOL = ['t', 'o', 'h', 'l', 'c', 'v'];
const BAR_POTONG = 2880;

function idbBuka() {
  return new Promise((ok, gagal) => {
    if (typeof indexedDB === 'undefined') return ok(null);
    const r = indexedDB.open(IDB_NAMA, IDB_VERSI);
    r.onupgradeneeded = () => {
      const d = r.result;
      for (const s of ['candle', 'kv', 'pa']) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s);
    };
    r.onsuccess = () => { IDB = r.result; ok(IDB); };
    r.onerror = () => gagal(r.error);
    r.onblocked = () => gagal(new Error('IndexedDB terblokir tab lain'));
  });
}
function idbMinta(r) { return new Promise((ok, gagal) => { r.onsuccess = () => ok(r.result); r.onerror = () => gagal(r.error); }); }
function idbTx(tx) { return new Promise((ok, gagal) => { tx.oncomplete = () => ok(); tx.onerror = () => gagal(tx.error); tx.onabort = () => gagal(tx.error); }); }
async function idbSemua(store, awalan) {
  if (!IDB) return [];
  const tx = IDB.transaction(store, 'readonly'), os = tx.objectStore(store);
  const rng = awalan == null ? null : IDBKeyRange.bound(awalan, awalan + '￿');
  const [k, v] = await Promise.all([idbMinta(os.getAllKeys(rng)), idbMinta(os.getAll(rng))]);
  return k.map((kk, i) => [kk, v[i]]);
}

/** Kunci pemimpin antar-tab (Web Locks). Tab pemegang kunci menyimpan ke IndexedDB. */
function kunciPemimpin(saatJadi) {
  const L = (typeof navigator !== 'undefined') ? navigator.locks : null;
  if (!L || !L.request) { PEMIMPIN = true; saatJadi && saatJadi(); return; }
  L.request('trading-ai-yulius-mesin', () => { PEMIMPIN = true; saatJadi && saatJadi(); return new Promise(() => {}); }).catch(() => { PEMIMPIN = true; });
}

// ------------------------------------------------------------------ kv
const KV = new Map();
const KV_KOTOR = new Set();
function kvGet(k, d = null) { return KV.has(k) ? KV.get(k) : d; }
function kvSet(k, v) { KV.set(k, klon(v)); KV_KOTOR.add(k); }
function kvHapus(k) { KV.delete(k); KV_KOTOR.add(k); }

// ------------------------------------------------------------------ tabel kecil (disimpan utuh sebagai kv 'tbl:<nama>')
const TBL = { pikiran: [], sinyal: [], prediksi: [], rekap: [], strategi: [], kebiasaan: {} };
const TBL_KOTOR = new Set();
let ID_PIKIRAN = 0;

function pikir(sym, jenis, isi, data) {
  TBL.pikiran.push({ id: ++ID_PIKIRAN, t: now(), sym: sym || '', jenis, isi, data: data || null });
  if (TBL.pikiran.length > 3000) TBL.pikiran.splice(0, TBL.pikiran.length - 3000);
  TBL_KOTOR.add('pikiran');
}
function daftarPikiran(n = 60, sym = null) {
  const out = [];
  for (let i = TBL.pikiran.length - 1; i >= 0 && out.length < n; i--) {
    const p = TBL.pikiran[i];
    if (sym && !(p.sym === sym || p.sym === '')) continue;
    out.push({ t: p.t, sym: p.sym, jenis: p.jenis, isi: p.isi });
  }
  return out;
}

// ------------------------------------------------------------------ candle (kolom Float64Array per seri × TF)
class Seri {
  constructor(seri, tf) {
    this.seri = seri; this.tf = tf; this.ms = TF_MS[tf]; this.n = 0; this.cap = 0; this.ver = 0;
    for (const k of KOL) this[k] = new Float64Array(0);
    this.kotor = new Set();
  }
  potongKe(t) { return Math.floor(t / (BAR_POTONG * this.ms)); }
  _pastikan(cap) {
    if (cap <= this.cap) return;
    const c = Math.max(cap, Math.ceil(this.cap * 1.5) + 2048);
    for (const k of KOL) { const a = new Float64Array(c); a.set(this[k].subarray(0, this.n)); this[k] = a; }
    this.cap = c;
  }
  bawah(t) { return cariKiri(this.t, t, this.n); }
  /** Upsert baris [t,o,h,l,c,v] (urutan bebas; t sama = baris baru menimpa). */
  sisip(rows, tandai = true) {
    if (!rows || !rows.length) return 0;
    let R = rows, urut = true;
    for (let i = 1; i < R.length; i++) if (!(R[i][0] > R[i - 1][0])) { urut = false; break; }
    if (!urut) {
      R = [...R].sort((a, b) => a[0] - b[0]);
      const u = [];
      for (const r of R) { if (u.length && u[u.length - 1][0] === r[0]) u[u.length - 1] = r; else u.push(r); }
      R = u;
    }
    const m = R.length, t0 = R[0][0], i0 = this.bawah(t0);
    if (i0 === this.n) {
      this._pastikan(this.n + m);
      for (let j = 0; j < m; j++) { const r = R[j], i = this.n + j; this.t[i] = r[0]; this.o[i] = r[1]; this.h[i] = r[2]; this.l[i] = r[3]; this.c[i] = r[4]; this.v[i] = r[5]; }
      this.n += m;
    } else {
      const ek = this.n - i0, tmp = KOL.map(() => new Float64Array(ek + m));
      let a = i0, b = 0, w = 0;
      while (a < this.n || b < m) {
        let baru;
        if (a >= this.n) baru = true;
        else if (b >= m) baru = false;
        else if (R[b][0] < this.t[a]) baru = true;
        else if (R[b][0] > this.t[a]) baru = false;
        else { a++; baru = true; }
        if (baru) { const r = R[b++]; for (let k = 0; k < 6; k++) tmp[k][w] = r[k]; }
        else { for (let k = 0; k < 6; k++) tmp[k][w] = this[KOL[k]][a]; a++; }
        w++;
      }
      this._pastikan(i0 + w);
      for (let k = 0; k < 6; k++) this[KOL[k]].set(tmp[k].subarray(0, w), i0);
      this.n = i0 + w;
    }
    if (tandai) { const c0 = this.potongKe(t0), c1 = this.potongKe(R[m - 1][0]); for (let c = c0; c <= c1; c++) this.kotor.add(c); }
    this.ver++;
    return m;
  }
  view(a, b) { const o = {}; for (const k of KOL) o[k] = this[k].subarray(a, b); return o; }
  /** Buang bar lebih tua dari t (pangkas). */
  pangkas(t) {
    const i = this.bawah(t); if (i <= 0) return [];
    const lama = new Set(); for (let j = 0; j < i; j++) lama.add(this.potongKe(this.t[j]));
    for (const k of KOL) this[k].copyWithin(0, i, this.n);
    this.n -= i; this.ver++;
    const tetap = this.n ? this.potongKe(this.t[0]) : Infinity;
    return [...lama].filter(c => c < tetap);
  }
}
const DATA = new Map();
function seriData(seri, tf) {
  const k = seri + '|' + tf;
  let S = DATA.get(k);
  if (!S) { S = new Seri(seri, tf); DATA.set(k, S); }
  return S;
}
const POTONG_HAPUS = [];
function kosongD() { const o = {}; for (const k of KOL) o[k] = new Float64Array(0); return o; }
/** Kolom t,o,h,l,c,v (tampilan subarray, urut waktu): n terakhir, dalam [dari, sampai]. */
function candle(seri, tf, o = {}) {
  const S = DATA.get(seri + '|' + tf);
  if (!S || !S.n) return kosongD();
  let a = 0, b = S.n;
  if (o.dari != null) a = S.bawah(o.dari);
  if (o.sampai != null) b = cariKanan(S.t, o.sampai, S.n);
  if (o.n) a = Math.max(a, b - o.n);
  if (b < a) b = a;
  return S.view(a, b);
}
function candleInfo(seri, tf) {
  const S = DATA.get(seri + '|' + tf);
  if (!S || !S.n) return { n: 0, dari: null, sampai: null };
  return { n: S.n, dari: S.t[0], sampai: S.t[S.n - 1] };
}
function simpanCandle(seri, tf, rows) { return seriData(seri, tf).sisip(rows); }
function salinD(D) { const o = {}; for (const k of KOL) o[k] = D[k].slice(); return o; }

// ------------------------------------------------------------------ muat & simpan
async function muatSemua() {
  for (const [k, v] of await idbSemua('kv')) {
    if (k.startsWith('tbl:')) { const n = k.slice(4); if (n in TBL && v != null) TBL[n] = v; }
    else KV.set(k, v);
  }
  ID_PIKIRAN = TBL.pikiran.reduce((m, p) => Math.max(m, p.id || 0), 0);
  // candle: urut kunci 'SERI|TF|00000123' = urut waktu
  const per = new Map();
  for (const [k, v] of await idbSemua('candle')) {
    const [seri, tf] = k.split('|');
    if (!TF_MS[tf] || !v || !v.t) continue;
    const key = seri + '|' + tf;
    if (!per.has(key)) per.set(key, []);
    per.get(key).push(v);
  }
  for (const [key, list] of per) {
    const [seri, tf] = key.split('|'), S = seriData(seri, tf);
    let n = 0; for (const v of list) n += v.t.length;
    S._pastikan(n);
    let w = 0, lastT = -Infinity, rapi = true;
    for (const v of list) {
      if (v.t.length && v.t[0] <= lastT) rapi = false;
      for (const k of KOL) S[k].set(v[k], w);
      w += v.t.length;
      if (v.t.length) lastT = v.t[v.t.length - 1];
    }
    S.n = w;
    if (!rapi) {             // jaga-jaga: urutkan ulang
      const rows = []; for (let i = 0; i < S.n; i++) rows.push([S.t[i], S.o[i], S.h[i], S.l[i], S.c[i], S.v[i]]);
      S.n = 0; S.sisip(rows, false);
    }
    S.ver++;
  }
}

const SIMPAN = { tCandle: 0, jalan: false, paKotor: new Set(), paIsi: null };
async function simpanKe(paksaCandle = false) {
  if (!PEMIMPIN || !IDB || SIMPAN.jalan) return;
  SIMPAN.jalan = true;
  try {
    const tCandle = paksaCandle || now() - SIMPAN.tCandle > 45000;
    const kvK = [...KV_KOTOR], tbK = [...TBL_KOTOR], paK = [...SIMPAN.paKotor];
    const potong = [];
    if (tCandle) {
      SIMPAN.tCandle = now();
      for (const S of DATA.values()) {
        if (!S.kotor.size) continue;
        for (const c of S.kotor) {
          const t0 = c * BAR_POTONG * S.ms, t1 = (c + 1) * BAR_POTONG * S.ms;
          const a = S.bawah(t0), b = S.bawah(t1);
          const k = `${S.seri}|${S.tf}|${String(c).padStart(9, '0')}`;
          if (b <= a) { potong.push([k, null]); continue; }
          const v = {}; for (const kk of KOL) v[kk] = S[kk].slice(a, b);
          potong.push([k, v]);
        }
        S.kotor.clear();
      }
      while (POTONG_HAPUS.length) potong.push([POTONG_HAPUS.pop(), null]);
    }
    if (!kvK.length && !tbK.length && !paK.length && !potong.length) return;
    KV_KOTOR.clear(); TBL_KOTOR.clear(); SIMPAN.paKotor.clear();
    const tx = IDB.transaction(['candle', 'kv', 'pa'], 'readwrite');
    const kv = tx.objectStore('kv'), cs = tx.objectStore('candle'), ps = tx.objectStore('pa');
    for (const k of kvK) { if (KV.has(k)) kv.put(KV.get(k), k); else kv.delete(k); }
    for (const n of tbK) kv.put(TBL[n], 'tbl:' + n);
    for (const [k, v] of potong) { if (v) cs.put(v, k); else cs.delete(k); }
    if (paK.length && SIMPAN.paIsi) for (const k of paK) { const v = SIMPAN.paIsi(k); if (v && v.length) ps.put(v, k); else ps.delete(k); }
    await idbTx(tx);
  } catch (e) {
    console.warn('simpan gagal', e);
  } finally { SIMPAN.jalan = false; }
}
function tandaiSemuaKotor() {
  for (const k of KV.keys()) KV_KOTOR.add(k);
  for (const n of Object.keys(TBL)) TBL_KOTOR.add(n);
  for (const S of DATA.values()) {
    for (let i = 0; i < S.n; i += 500) S.kotor.add(S.potongKe(S.t[i]));
    if (S.n) S.kotor.add(S.potongKe(S.t[S.n - 1]));
  }
  if (SIMPAN.semuaPa) SIMPAN.semuaPa();
}
// ================================================================== indikator (ind.py)
// Rumus EMA/ATR/RSI/ADX sama persis dengan engine Trade Action (riset SC15/SW1H/SW4H dan Amatu EA).
const F64 = n => new Float64Array(n);
const penuhNaN = n => new Float64Array(n).fill(NaN);

function ema(a, n) {
  const m = a.length, out = F64(m);
  if (!m) return out;
  const k = 2.0 / (n + 1);
  let e = a[0];
  for (let i = 0; i < m; i++) { e = i ? e + k * (a[i] - e) : a[0]; out[i] = e; }
  return out;
}
function sma(a, n) {
  const m = a.length, out = penuhNaN(m);
  if (m >= n) {
    let s = 0;
    for (let i = 0; i < m; i++) { s += a[i]; if (i >= n) s -= a[i - n]; if (i >= n - 1) out[i] = s / n; }
  }
  return out;
}
function trueRange(h, l, c) {
  const m = c.length, out = F64(m);
  for (let i = 0; i < m; i++) {
    const pc = i ? c[i - 1] : c[0];
    out[i] = Math.max(h[i] - l[i], Math.abs(h[i] - pc), Math.abs(l[i] - pc));
  }
  return out;
}
function atr(h, l, c, n = 14) {
  const tr = trueRange(h, l, c), m = tr.length, out = F64(m);
  let e = null;
  for (let i = 0; i < m; i++) { e = e === null ? tr[i] : e + (tr[i] - e) / n; out[i] = e; }
  return out;
}
function rsi(c, n = 14) {
  const m = c.length, out = F64(m).fill(50.0);
  let g = 0, lo = 0;
  for (let i = 1; i < m; i++) {
    const d = c[i] - c[i - 1];
    g = (g * (n - 1) + Math.max(d, 0)) / n;
    lo = (lo * (n - 1) + Math.max(-d, 0)) / n;
    out[i] = lo ? 100 - 100 / (1 + g / lo) : 100.0;
  }
  return out;
}
/** [adx, +DI, -DI]. */
function adx(h, l, c, n = 14) {
  const m = c.length, ad = F64(m), pdiA = F64(m), mdiA = F64(m);
  let tr = 0, p = 0, mm = 0, a = null;
  for (let i = 1; i < m; i++) {
    const up = h[i] - h[i - 1], dn = l[i - 1] - l[i];
    const pdm = (up > dn && up > 0) ? up : 0, mdm = (dn > up && dn > 0) ? dn : 0;
    const t = Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]));
    tr = tr - tr / n + t; p = p - p / n + pdm; mm = mm - mm / n + mdm;
    const pdi = tr ? 100 * p / tr : 0, mdi = tr ? 100 * mm / tr : 0;
    const dx = 100 * Math.abs(pdi - mdi) / ((pdi + mdi) || 1);
    a = a === null ? dx : a + (dx - a) / n;
    ad[i] = a; pdiA[i] = pdi; mdiA[i] = mdi;
  }
  return [ad, pdiA, mdiA];
}
/** Maks jendela n bar yang BERAKHIR di i (inklusif); i < n-1 = maks prefiks. */
function rollMax(a, n) {
  const m = a.length, out = F64(m), dq = new Int32Array(m);
  let h = 0, t = 0;
  for (let i = 0; i < m; i++) {
    while (t > h && !(a[dq[t - 1]] > a[i])) t--;          // buang yang <= a[i] (NaN ikut terbuang seperti np.max? lihat catatan)
    dq[t++] = i;
    while (dq[h] <= i - n) h++;
    out[i] = a[dq[h]];
  }
  return out;
}
function rollMin(a, n) {
  const neg = F64(a.length); for (let i = 0; i < a.length; i++) neg[i] = -a[i];
  const r = rollMax(neg, n); for (let i = 0; i < r.length; i++) r[i] = -r[i];
  return r;
}
function rollStd(a, n) {
  const m = a.length, out = penuhNaN(m);
  if (m < n) return out;
  for (let i = n - 1; i < m; i++) {
    let s = 0; for (let j = i - n + 1; j <= i; j++) s += a[j];
    const mu = s / n; let v = 0; for (let j = i - n + 1; j <= i; j++) v += (a[j] - mu) ** 2;
    out[i] = Math.sqrt(v / n);
  }
  return out;
}
function bollinger(c, n = 20, k = 2.0) {
  const mid = sma(c, n), sd = rollStd(c, n), m = c.length, up = F64(m), lo = F64(m), bw = F64(m);
  for (let i = 0; i < m; i++) {
    up[i] = mid[i] + k * sd[i]; lo[i] = mid[i] - k * sd[i];
    bw[i] = mid[i] === 0 ? NaN : (up[i] - lo[i]) / mid[i];
  }
  return [mid, up, lo, bw];
}
/** Nilai TF tinggi yang SUDAH tutup sebelum bar TF rendah dibuka. Kembalikan [nilai, j]. */
function petakan(tRendah, tTinggi, msTinggi, nilai) {
  const m = tRendah.length, out = penuhNaN(m), J = new Int32Array(m);
  let j = -1;
  const nt = tTinggi.length;
  for (let i = 0; i < m; i++) {
    while (j + 1 < nt && tTinggi[j + 1] + msTinggi <= tRendah[i]) j++;
    J[i] = j;
    if (j >= 0 && nilai.length) out[i] = nilai[Math.min(j, nilai.length - 1)];
  }
  return [out, J];
}
/** Indeks swing high/low (k bar di kiri dan kanan). */
function fraktal(h, l, k = 2) {
  const hi = [], lo = [];
  for (let i = k; i < h.length - k; i++) {
    let mx = -Infinity, mn = Infinity, mxL = -Infinity, mnL = Infinity;
    for (let j = i - k; j <= i + k; j++) { if (h[j] > mx) mx = h[j]; if (l[j] < mn) mn = l[j]; }
    for (let j = i - k; j < i; j++) { if (h[j] > mxL) mxL = h[j]; if (l[j] < mnL) mnL = l[j]; }
    if (h[i] === mx && h[i] > mxL) hi.push(i);
    if (l[i] === mn && l[i] < mnL) lo.push(i);
  }
  return [hi, lo];
}
function persentilTerakhir(a, jendela) {
  const w = []; for (let i = Math.max(0, a.length - jendela); i < a.length; i++) if (!Number.isNaN(a[i])) w.push(a[i]);
  if (!w.length) return 50.0;
  const x = w[w.length - 1]; let k = 0; for (const v of w) if (v < x) k++;
  return k / w.length * 100;
}
// ================================================================== sumber data (feed.py versi browser)
// - BTCUSDT  : Binance spot publik (data-api.binance.vision; cadangan api1/api2/api3/api.binance.com), CORS terbuka.
// - XAUUSDm  : PAXGUSDT (Binance, emas ter-tokenisasi) x rasio harga spot emas (gold-api.com) supaya level mendekati
//              XAUUSDm; candle di luar jam pasar emas dibuang. (MT5/ClaudeBridge hanya ada di Mac, tidak dipakai di web.)
// Harga hidup ±1 dtk per simbol terpisah dari tugas lambat (candle TF lain, celah riwayat, spot, kurs).
const BINANCE_HOST = ['https://data-api.binance.vision/api/v3', 'https://api1.binance.com/api/v3', 'https://api2.binance.com/api/v3',
  'https://api3.binance.com/api/v3', 'https://api.binance.com/api/v3'];
const HOST = { i: 0, t: 0 };
const BINANCE_SERI = ['PAXGUSDT', 'BTCUSDT'];

function binanceHost() {
  if (HOST.i && now() - HOST.t > 600000) HOST.i = 0;
  return [HOST.i, BINANCE_HOST[HOST.i]];
}
class GalatHttp extends Error { constructor(s, m) { super(m || ('HTTP ' + s)); this.status = s; this.http = true; } }

async function ambilJson(url, timeout = 12000) {
  const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const tm = setTimeout(() => ac && ac.abort(), timeout);
  try {
    const r = await fetch(url, { signal: ac ? ac.signal : undefined, cache: 'no-store' });
    if (!r.ok) throw new GalatHttp(r.status);
    return await r.json();
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error('waktu habis');
    throw e;
  } finally { clearTimeout(tm); }
}

// pembatas permintaan bersamaan ke Binance (unduhan riwayat besar tidak boleh membanjiri)
const ANTRE = { jalan: 0, maks: 8, tunggu: [] };
async function slot(fn) {
  if (ANTRE.jalan >= ANTRE.maks) await new Promise(r => ANTRE.tunggu.push(r));
  ANTRE.jalan++;
  try { return await fn(); } finally { ANTRE.jalan--; const r = ANTRE.tunggu.shift(); if (r) r(); }
}

async function binanceKlines(symbol, tf, { start = null, limit = 1000, timeout = 12000, prioritas = false } = {}) {
  const p = new URLSearchParams({ symbol, interval: tf, limit: String(limit) });
  if (start != null) p.set('startTime', String(Math.floor(start)));
  const jalan = async () => {
    const [i, base] = binanceHost();
    let rows;
    try {
      rows = await ambilJson(`${base}/klines?${p}`, timeout);
    } catch (e) {
      if (!(e && e.http) && HOST.i === i) { HOST.i = (i + 1) % BINANCE_HOST.length; HOST.t = now(); }
      throw e;
    }
    return rows.map(k => [+k[0], +k[1], +k[2], +k[3], +k[4], +k[5]]);
  };
  return prioritas ? jalan() : slot(jalan);
}
async function klinesUlang(symbol, tf, start, coba = 4) {
  let e0;
  for (let i = 0; i < coba; i++) {
    try { return await binanceKlines(symbol, tf, { start, limit: 1000 }); }
    catch (e) { e0 = e; if (e && e.http && e.status !== 429 && e.status < 500) throw e; await tidur(800 * 2 ** i); }
  }
  throw e0;
}

/** Unduh riwayat dari titik terakhir tersimpan (atau `hari` ke belakang) sampai sekarang; potongan diunduh paralel,
 *  lalu celah di tengah diperiksa dan diisi ulang. majuSaja = selalu lanjut dari candle terakhir yang tersimpan. */
async function isiRiwayat(symbol, tf, hari, progres = null, majuSaja = false) {
  const ms = TF_MS[tf], info = candleInfo(symbol, tf);
  let mulai = now() - hari * DAY;
  if (info.sampai && (majuSaja || (info.dari && info.dari <= mulai + 2 * DAY))) mulai = info.sampai;
  const pertama = await klinesUlang(symbol, tf, mulai);
  if (!pertama.length) return 0;
  simpanCandle(symbol, tf, pertama);
  let total = pertama.length;
  progres && progres(symbol, tf, pertama[pertama.length - 1][0]);
  const nxt = pertama[pertama.length - 1][0] + ms;
  if (pertama.length < 1000 || nxt > now()) return total;
  const awal = [];
  for (let s = nxt; s <= now(); s += 1000 * ms) awal.push(s);
  let selesai = 0, gagal = null;
  await Promise.all(awal.map(s => klinesUlang(symbol, tf, s).then(rows => {
    total += simpanCandle(symbol, tf, rows);
    selesai++;
    progres && progres(symbol, tf, rows.length ? rows[rows.length - 1][0] : s, selesai / awal.length);
  }).catch(e => { gagal = e; })));
  await tambalCelah(symbol, tf, mulai);
  if (gagal) throw gagal;
  return total;
}
/** Celah > 1,5 bar di dalam data (potongan paralel gagal) → minta ulang dari awal celah. Celah asli bursa dibiarkan. */
async function tambalCelah(symbol, tf, dari) {
  const S = DATA.get(symbol + '|' + tf); if (!S || S.n < 2) return;
  const ms = TF_MS[tf], celah = [];
  for (let i = Math.max(1, S.bawah(dari)); i < S.n && celah.length < 40; i++) if (S.t[i] - S.t[i - 1] > 1.5 * ms) celah.push([S.t[i - 1] + ms, S.t[i]]);
  for (const [a, b] of celah) {
    let s = a;
    for (let k = 0; k < 30 && s < b; k++) {
      const rows = await klinesUlang(symbol, tf, s).catch(() => []);
      if (!rows.length) break;
      simpanCandle(symbol, tf, rows);
      const akhir = rows[rows.length - 1][0];
      if (rows[0][0] >= b || akhir >= b || rows.length < 1000) break;
      s = akhir + ms;
    }
  }
}

async function segarkanCandle(symbol, tf, n = 3, timeout = 12000, prioritas = false) {
  const rows = await binanceKlines(symbol, tf, { limit: n, timeout, prioritas });
  simpanCandle(symbol, tf, rows);
  return rows.length ? rows[rows.length - 1] : null;
}

/** [harga, sumber] spot emas: gold-api.com (CORS terbuka). */
async function spotEmas() {
  try {
    const d = await ambilJson('https://api.gold-api.com/price/XAU', 8000);
    const p = +(d && d.price || 0);
    if (p > 100) return [p, 'gold-api.com'];
  } catch (e) { /* lanjut */ }
  return [null, null];
}
async function usdIdr() {
  try {
    const d = await ambilJson('https://open.er-api.com/v6/latest/USD', 8000);
    const v = +d.rates.IDR;
    if (v > 5000 && v < 50000) return v;
  } catch (e) { /* lanjut */ }
  return null;
}

/** Pengelola data hidup. Mesin menjalankan harga1m (per simbol Binance) tiap ±1 dtk dan detak (tugas lambat, paralel). */
class Feed {
  constructor() {
    this.status = { binance: null, spot: null, galat: {} };
    this.harga = {};                       // sym tampilan / seri → {p, t, sumber}
    this.rasio = kvGet('rasio_xau', { k: 1.0, t: 0, sumber: null });
    this._t = {};
    this.siap = false;
    this.siapSeri = {};                    // seri → riwayat lengkap
    this.segar_tf = new Map();             // 'seri|tf' → ms candle TF itu terakhir diminta dari sumber
    this._tHarga = {};
    this._tLambat = 0;
    this._jalan = new Map();
    this.unduh = null;                     // progres unduhan riwayat
  }
  siapSym(sym) { return !!this.siapSeri[SIMBOL[sym].binance]; }

  /** Riwayat awal: PAXGUSDT dulu (XAU), lalu BTCUSDT; per seri 1d → 5m. */
  async isiAwal(progres) {
    for (const seri of BINANCE_SERI) {
      let ok = true;
      // semua TF satu seri paralel (dibatasi slot()); data yang sudah tersimpan cukup ditambal dari candle terakhir
      await Promise.all(['1d', '4h', '1h', '15m', '5m', '1m'].map(async tf => {
        const t0 = now();
        for (let coba = 0; ; coba++) {
          try { await isiRiwayat(seri, tf, SIMPAN_HARI[tf], progres); delete this.status.galat[`${seri} ${tf}`]; break; }
          catch (e) {
            this.status.galat[`${seri} ${tf}`] = teksGalat(e).slice(0, 200);
            if (coba >= 2) { ok = candleInfo(seri, tf).n > 0 && ok; break; }
            await tidur(3000 * (coba + 1));
          }
        }
        this.segar_tf.set(seri + '|' + tf, t0);
      }));
      this.siapSeri[seri] = true;
      if (typeof WAKTU !== 'undefined') WAKTU['seri ' + seri] = now() - T_MULAI;
      if (this.saatSiap) this.saatSiap(seri);
      this._t['susul'] = now() / 1000;
      if (!ok) this._t['susul'] = now() / 1000 - 540;   // coba isi lagi ±1 menit kemudian
    }
    this.siap = true;
    kvSet('riwayat_siap', now());
  }

  _boleh(k, detik) { const t = now() / 1000; if (t - (this._t[k] || 0) >= detik) { this._t[k] = t; return true; } return false; }
  /** Jatuh tempo bila sudah `detik` sejak terakhir ATAU ada candle `tf` yang tutup ≥1,5 dtk lalu sesudahnya. */
  _tempo(k, tf, detik) {
    const t = now() / 1000, ms = TF_MS[tf] / 1000, tutup = Math.floor((t - 1.5) / ms) * ms + 1.5, last = this._t[k] || 0;
    if (t - last >= detik || last < tutup) { this._t[k] = t; return true; }
    return false;
  }
  /** Tugas berkunci sama yang masih berjalan tidak digandakan. Kembalikan {p, selesai, galat, hasil}. */
  _kirim(k, fn) {
    let T = this._jalan.get(k);
    if (T && !T.selesai) return T;
    T = { selesai: false, galat: null, hasil: undefined };
    T.p = (async () => { try { T.hasil = await fn(); } catch (e) { T.galat = e; } finally { T.selesai = true; } })();
    this._jalan.set(k, T);
    return T;
  }

  async harga1m(seri) {
    const t0 = now();
    let b;
    try { b = await segarkanCandle(seri, '1m', 2, 4000, true); }
    catch (e) { this.status.galat[`harga ${seri}`] = teksGalat(e).slice(0, 200); return false; }
    const t = now();
    this.segar_tf.set(seri + '|1m', t0);
    if (b) this.harga[seri] = { p: b[4], t, sumber: 'Binance' };
    this._tHarga[seri] = t;
    this.status.binance = Math.min(...BINANCE_SERI.map(s => this._tHarga[s] || 0)) || null;
    delete this.status.galat[`harga ${seri}`];
    if (seri === 'PAXGUSDT') this._hargaXau();
    if (seri === 'BTCUSDT') this.harga.BTCUSDT = this.harga[seri];
    return true;
  }

  /** Tugas lambat yang jatuh tempo, dijalankan paralel. paksa = tombol Segarkan (semua TF + spot + kurs sekarang). */
  detak(paksa = false) {
    const t = now() / 1000, bangun = !!this._tLambat && t - this._tLambat > 60;
    this._tLambat = t;
    const tugas = {};
    const susul = paksa || bangun || this._boleh('susul', 600);
    if (susul) this._t['susul'] = t;
    const TF_LAMBAT = { '5m': 15, '15m': 15, '1h': 60, '4h': 60, '1d': 60 };
    for (const [tf, detik] of Object.entries(TF_LAMBAT)) {
      const due = this._tempo('tf ' + tf, tf, detik);
      if (susul || due) {
        this._t['tf ' + tf] = t;
        for (const s of BINANCE_SERI) if (this.siapSeri[s]) tugas[`${s} ${tf}`] = () => this._candleTf(s, tf, susul);
      }
    }
    if (susul) for (const s of BINANCE_SERI) if (this.siapSeri[s]) tugas[`${s} 1m`] = () => this._candleTf(s, '1m', true);
    if (paksa || this._boleh('spot', 10)) tugas.spot = () => this._spot();
    if (this._boleh('fx', 6 * 3600)) tugas.kurs = () => this._kurs();
    if (this._boleh('pangkas', 3600)) tugas.pangkas = () => this._pangkas();
    const out = {};
    for (const [k, fn] of Object.entries(tugas)) out[k] = this._kirim(k, fn);
    return out;
  }

  async _candleTf(seri, tf, susul = false) {
    const t0 = now();
    try {
      if (susul) await isiRiwayat(seri, tf, SIMPAN_HARI[tf], null, true);
      else await segarkanCandle(seri, tf, 3);
    } catch (e) { this.status.galat[`${seri} ${tf}`] = teksGalat(e).slice(0, 200); throw e; }
    this.segar_tf.set(seri + '|' + tf, t0);
    delete this.status.galat[`${seri} ${tf}`];
    return true;
  }
  async _kurs() { const v = await usdIdr(); if (v) kvSet('usd_idr', v); }
  _pangkas() {
    for (const S of DATA.values()) {
      const hari = SIMPAN_HARI[S.tf]; if (!hari) continue;
      for (const c of S.pangkas(now() - hari * DAY)) POTONG_HAPUS.push(`${S.seri}|${S.tf}|${String(c).padStart(9, '0')}`);
    }
  }
  async _spot() {
    if (!pasarEmasBuka(now())) { this.status.spot = { tutup: true, t: now() }; return; }
    const [p, src] = await spotEmas();
    const pg = (this.harga.PAXGUSDT || {}).p;
    if (p && pg) {
      let k = p / pg;
      const old = this.rasio.k || k;
      if (Math.abs(k / old - 1) > 0.02) k = old * (1 + 0.02 * (k > old ? 1 : -1));     // loncatan tak wajar → pelan-pelan
      k = this.rasio.t ? old * 0.7 + k * 0.3 : k;
      this.rasio = { k, t: now(), sumber: src, spot: p };
      kvSet('rasio_xau', this.rasio);
      this.status.spot = { p, sumber: src, t: now() };
      this._hargaXau();
    } else if (!p) this.status.galat.spot = 'gold-api.com tidak menjawab';
  }
  _hargaXau() {
    const pg = this.harga.PAXGUSDT;
    if (pg) this.harga.XAUUSDm = { p: pg.p * (this.rasio.k || 1.0), t: pg.t, sumber: this.rasio.sumber ? 'Proxy PAXG x spot' : 'PAXGUSDT (tanpa koreksi spot)' };
  }
  /** [seri, skala, sumber] untuk simbol tampilan. */
  seri(sym) {
    if (sym === 'BTCUSDT') return ['BTCUSDT', 1.0, 'Binance BTCUSDT'];
    return ['PAXGUSDT', +(this.rasio.k || 1.0), this.rasio.sumber ? 'PAXGUSDT x spot' : 'PAXGUSDT'];
  }
}
// ================================================================== strategi + data pasar + uji balik (strategi.py, uji.py)
// Famili: trend (SC15, SW1H, SW4H, Breakout 4H Liemyo), sesi (breakout range Asia + piramida, Amatu EA v2.11),
// squeeze (Bollinger squeeze 1H, kandidat lab). Aturan isi backtest konservatif: entry di open candle berikutnya,
// SL dicek lebih dulu, gap melewati SL keluar di open, trailing digeser setelah cek SL, layer hanya saat harga maju.
const NAMA = {
  SC15: 'Pullback tren 15M', SW1H: 'Breakout/pullback tren 1H', SW4H: 'Breakout/pullback tren 4H',
  BO4H: 'Breakout 4H Liemyo', SESI: 'Breakout sesi Asia + piramida (Amatu EA)', SQZ1H: 'Squeeze Bollinger 1H',
};
const PRESET = {
  SC15: { famili: 'trend', mode: 'scalp', tf: '15m', ht: ['1h', '4h'], ht_mode: 'ema50', bo: false, pb: true, n_bo: 20, adx_min: 20, k0: 2.5, kt: 4.0, maxB: 288, layers: 1, add_step: 1.0, lock_r: 1.0 },
  SESI: { famili: 'sesi', mode: 'scalp', tf: '5m', range_start: 0, range_end: 6, entry_end: 16, bo_buf: 0.1, range_min_atr: 0.5, range_max_atr: 4.0, sl_min_atr: 0.5, sl_max_atr: 2.0, trail_atr: 2.0, trail_start_r: 1.0, exit_h: 23, friday_h: 20, layers: 6, add_step: 2.0, lock_r: 1.0, add_gap: 1.0 },
  SW1H: { famili: 'trend', mode: 'swing', tf: '1h', ht: ['4h'], ht_mode: 'ema50', bo: true, pb: true, n_bo: 20, adx_min: 20, k0: 2.5, kt: 4.0, maxB: 400, layers: 1, add_step: 1.0, lock_r: 1.0 },
  SW4H: { famili: 'trend', mode: 'swing', tf: '4h', ht: ['1d'], ht_mode: 'ema50', bo: true, pb: true, n_bo: 20, adx_min: 20, k0: 2.5, kt: 4.0, maxB: 180, layers: 1, add_step: 1.0, lock_r: 1.0 },
  BO4H: { famili: 'trend', mode: 'swing', tf: '4h', ht: ['1d'], ht_mode: 'stack', bo: true, pb: false, n_bo: 20, adx_min: 0, k0: 3.0, kt: 3.0, maxB: 400, layers: 1, add_step: 1.0, lock_r: 1.0 },
  SQZ1H: { famili: 'squeeze', mode: 'swing', tf: '1h', bw_mult: 1.15, bw_look: 120, sl_atr: 1.0, tp_atr: 2.0, maxB: 48 },
};
const BAWAAN = {
  'BTCUSDT|scalp': ['SC15', 'SESI'], 'BTCUSDT|swing': ['SW4H', 'BO4H', 'SW1H', 'SQZ1H'],
  'XAUUSDm|scalp': ['SESI', 'SC15'], 'XAUUSDm|swing': ['SW4H', 'SW1H', 'BO4H', 'SQZ1H'],
};
const GRID = {
  SC15: { adx_min: [15, 20, 25], k0: [2.0, 2.5, 3.0], kt: [3.0, 4.0, 5.0], layers: [1, 3] },
  SW1H: { n_bo: [20, 30], k0: [2.0, 2.5, 3.0], kt: [3.0, 4.0, 5.0], layers: [1, 3] },
  SW4H: { n_bo: [20, 30], k0: [2.0, 2.5, 3.0], kt: [3.0, 4.0, 5.0], layers: [1, 3] },
  BO4H: { n_bo: [20, 30], k0: [2.5, 3.0, 3.5], kt: [2.5, 3.0, 4.0], layers: [1, 3] },
  SESI: { range_end: [5, 6, 7], entry_end: [14, 16], trail_atr: [1.5, 2.0, 2.5], layers: [1, 3, 6] },
  SQZ1H: { bw_mult: [1.1, 1.15, 1.25], sl_atr: [1.0, 1.5], tp_atr: [2.0, 3.0] },
};
const JELAJAH = {
  trend: { n_bo: [15, 20, 25, 30, 40], adx_min: [0, 15, 20, 25, 30], k0: [1.5, 2.0, 2.5, 3.0, 3.5], kt: [2.5, 3.0, 3.5, 4.0, 5.0, 6.0], layers: [1, 2, 3, 4], add_step: [0.75, 1.0, 1.5, 2.0] },
  sesi: { range_end: [4, 5, 6, 7, 8], entry_end: [12, 14, 16, 18], trail_atr: [1.0, 1.5, 2.0, 2.5, 3.0], sl_max_atr: [1.5, 2.0, 2.5, 3.0], add_step: [1.0, 1.5, 2.0, 2.5], layers: [1, 2, 3, 4, 6] },
  squeeze: { bw_mult: [1.05, 1.1, 1.15, 1.2, 1.3], sl_atr: [0.75, 1.0, 1.5, 2.0], tp_atr: [1.5, 2.0, 2.5, 3.0, 4.0] },
};

function preset(sid, sym) {
  const p = klon(PRESET[sid]);
  if (sid === 'SESI') {
    Object.assign(p, SIMBOL[sym].sesi_preset);
    if (SIMBOL[sym].pasar_24j) p.friday_h = null;
  }
  return p;
}
function kunciParam(p) {
  return JSON.stringify(Object.keys(p).filter(k => !k.startsWith('_')).sort().map(k => [k, p[k]]));
}
const ambil = (p, k, d) => (p[k] === undefined ? d : p[k]);

// ------------------------------------------------------------------ data pasar
/** Candle TERTUTUP per TF untuk satu simbol tampilan, sudah diskalakan (proxy XAU) dan difilter jam pasar emas. */
class Pasar {
  constructor(sym, seri, skala = 1.0, t = null) {
    this.sym = sym; this.seri = seri; this.skala = +skala; this.now = t || now();
    this.filterEmas = (sym === 'XAUUSDm' && seri === 'PAXGUSDT');
    this._c = new Map(); this._ind = new Map();
  }
  bar(tf, n = null) {
    const key = tf + '|' + n;
    if (this._c.has(key)) return this._c.get(key);
    const D0 = candle(this.seri, tf, n ? { n: n + 2 } : {});
    const ms = TF_MS[tf], T = D0.t, N = T.length, sk = this.skala;
    const emas = this.filterEmas && tf !== '1m', harian = tf === '1d';
    let idx, m = 0;
    if (!emas) {
      let b = N; while (b > 0 && T[b - 1] + ms > this.now) b--;
      const a = n ? Math.max(0, b - n) : 0;
      idx = null; m = b - a;
      const D = {};
      for (const k of KOL) {
        const src = D0[k], dst = new Float64Array(m);
        if (sk !== 1.0 && k !== 't' && k !== 'v') for (let i = 0; i < m; i++) dst[i] = src[a + i] * sk;
        else dst.set(src.subarray(a, b));
        D[k] = dst;
      }
      this._c.set(key, D);
      return D;
    }
    idx = new Int32Array(N);
    for (let i = 0; i < N; i++) {
      const t = T[i];
      if (t + ms <= this.now && (harian ? hariKerja(t) : pasarEmasBuka(t))) idx[m++] = i;
    }
    const a = n ? Math.max(0, m - n) : 0, len = m - a, D = {};
    for (const k of KOL) {
      const src = D0[k], dst = new Float64Array(len), kali = (k !== 't' && k !== 'v') ? sk : 1;
      for (let i = 0; i < len; i++) dst[i] = src[idx[a + i]] * kali;
      D[k] = dst;
    }
    this._c.set(key, D);
    return D;
  }
  forming(tf) {
    const D = candle(this.seri, tf, { n: 1 });
    if (!D.t.length) return null;
    const b = {}; for (const k of KOL) b[k] = D[k][D[k].length - 1];
    for (const k of ['o', 'h', 'l', 'c']) b[k] *= this.skala;
    return b;
  }
  indikator(tf, n = null) {
    const key = tf + '|' + n;
    if (this._ind.has(key)) return this._ind.get(key);
    const D = this.bar(tf, n), h = D.h, l = D.l, c = D.c;
    if (c.length < 30) { this._ind.set(key, null); return null; }
    const I = { atr: atr(h, l, c), e20: ema(c, 20), e50: ema(c, 50), e200: ema(c, 200) };
    [I.adx, I.pdi, I.mdi] = adx(h, l, c);
    I.rsi = rsi(c);
    this._ind.set(key, I);
    return I;
  }
}

// ------------------------------------------------------------------ sinyal
function arahHt(P, tf, mode, n = null) {
  const D = P.bar(tf, n), I = P.indikator(tf, n), m = D.c.length, d = new Float64Array(m);
  if (!I) return [D, d];
  const c = D.c;
  for (let i = 0; i < m; i++) {
    if (mode === 'stack') d[i] = (c[i] > I.e50[i] && I.e50[i] > I.e200[i]) ? 1 : (c[i] < I.e50[i] && I.e50[i] < I.e200[i]) ? -1 : 0;
    else d[i] = c[i] > I.e50[i] ? 1 : c[i] < I.e50[i] ? -1 : 0;
  }
  return [D, d];
}

function sinyalTrend(P, p, n = null) {
  const D = P.bar(p.tf, n), I = P.indikator(p.tf, n);
  if (!I || D.c.length < 260) return null;
  const m = D.c.length, arahs = [];
  for (const t of p.ht) {
    const nh = n == null ? null : Math.trunc(n * TF_MS[p.tf] / TF_MS[t]) + 400;
    const [Dh, dh] = arahHt(P, t, ambil(p, 'ht_mode', 'ema50'), nh);
    if (!Dh.t.length) return null;
    const [mm] = petakan(D.t, Dh.t, TF_MS[t], dh);
    for (let i = 0; i < m; i++) if (Number.isNaN(mm[i])) mm[i] = 0;
    arahs.push(mm);
  }
  const dirs = Float64Array.from(arahs[0]);
  for (const a of arahs.slice(1)) for (let i = 0; i < m; i++) if (a[i] !== dirs[i]) dirs[i] = 0;
  const c = D.c, h = D.h, l = D.l, nb = Math.trunc(ambil(p, 'n_bo', 20));
  const rmx = rollMax(h, nb), rmn = rollMin(l, nb);
  const hiPrev = new Float64Array(m), loPrev = new Float64Array(m);
  hiPrev[0] = NaN; loPrev[0] = NaN;
  for (let i = 1; i < m; i++) { hiPrev[i] = rmx[i - 1]; loPrev[i] = rmn[i - 1]; }
  const al = new Float64Array(m), sig = new Int8Array(m), kind = new Int8Array(m);
  const adxMin = ambil(p, 'adx_min', 20), pakaiPb = ambil(p, 'pb', true);
  for (let i = 0; i < m; i++) {
    al[i] = (I.e20[i] > I.e50[i] && I.e50[i] > I.e200[i]) ? 1 : (I.e20[i] < I.e50[i] && I.e50[i] < I.e200[i]) ? -1 : 0;
    const d = dirs[i];
    const bo = !!p.bo && ((d > 0 && c[i] > hiPrev[i]) || (d < 0 && c[i] < loPrev[i]));
    const pb = !!pakaiPb && I.adx[i] >= adxMin && al[i] === d && d !== 0 &&
      ((d > 0 && l[i] <= I.e20[i] && c[i] > I.e20[i]) || (d < 0 && h[i] >= I.e20[i] && c[i] < I.e20[i]));
    sig[i] = (bo || pb) ? d : 0;
    kind[i] = bo ? 1 : pb ? 2 : 0;
  }
  return { D, I, sig, kind, dir: dirs, al, hi_prev: hiPrev, lo_prev: loPrev, arah_ht: arahs.map(a => Math.trunc(a[m - 1])) };
}

function sinyalSqueeze(P, p, n = null) {
  const D = P.bar(p.tf, n), I = P.indikator(p.tf, n);
  if (!I || D.c.length < ambil(p, 'bw_look', 120) + 30) return null;
  const [mid, up, lo, bw] = bollinger(D.c, 20, 2.0), m = D.c.length;
  const look = Math.trunc(ambil(p, 'bw_look', 120));
  const bw9 = Float64Array.from(bw, x => Number.isNaN(x) ? 9e9 : x);
  const rm = rollMin(bw9, look), sq = new Uint8Array(m), sig = new Int8Array(m), mult = ambil(p, 'bw_mult', 1.15);
  for (let i = 1; i < m; i++) sq[i] = (bw[i - 1] <= mult * rm[i - 1]) ? 1 : 0;
  const c = D.c;
  for (let i = 0; i < m; i++) sig[i] = (sq[i] && c[i] > up[i]) ? 1 : (sq[i] && c[i] < lo[i]) ? -1 : 0;
  return { D, I, sig, mid, up, lo, bw, sq };
}

function dataSesi(P, n5 = null) {
  const M5 = P.bar('5m', n5), H1 = P.bar('1h', n5 == null ? null : Math.floor(n5 / 12) + 400);
  if (M5.c.length < 500 || H1.c.length < 260) return [null, null];
  const a = atr(H1.h, H1.l, H1.c), e50 = ema(H1.c, 50), e200 = ema(H1.c, 200), ms = TF_MS['1h'], h1 = {};
  for (const [k, v] of [['atr', a], ['e50', e50], ['e200', e200], ['c', H1.c]]) h1[k] = petakan(M5.t, H1.t, ms, v)[0];
  return [M5, h1];
}

// ------------------------------------------------------------------ uji balik
function tutupBasket(fills, x, d, biaya, Rm) {
  let pnl = 0;
  for (const [f, lot] of fills) pnl += ((x - f) * d - biaya * f) * lot;
  return Rm > 0 ? pnl / Rm : 0.0;
}
/** Seberapa jauh harga maju (R) sebelum SL awal kena. [fav, kena]. */
function bracket(D, i0, e, d, R0, maxB) {
  const H = D.h, L = D.l, n = H.length;
  let fav = 0;
  for (let j = i0; j < Math.min(n, i0 + maxB); j++) {
    if (d > 0) { if (L[j] <= e - R0) return [fav, true]; fav = Math.max(fav, (H[j] - e) / R0); }
    else { if (H[j] >= e + R0) return [fav, true]; fav = Math.max(fav, (e - L[j]) / R0); }
  }
  return [fav, false];
}
/** Tambah layer piramida pada candle j bila level tercapai; true bila stop terpicu di candle yang sama. */
function cobaTambah(fills, st, j, d, O, H, L, C, A0, p) {
  const lmax = Math.trunc(ambil(p, 'layers', 1));
  if (lmax <= 1) return false;
  const step = +ambil(p, 'add_step', 1.0), lock = +ambil(p, 'lock_r', 1.0), gap = +ambil(p, 'add_gap', 1.0);
  while (fills.length < lmax) {
    const lvl = st.last + d * step * A0;
    if (!((d > 0 && H[j] >= lvl) || (d < 0 && L[j] <= lvl))) return false;
    const fill = d > 0 ? Math.max(O[j], lvl) : Math.min(O[j], lvl);
    const V2 = st.V + 1.0, PV2 = st.PV + fill, avg = PV2 / V2;
    const sreq = avg - d * lock * st.Rm / V2;
    const snew = d > 0 ? Math.max(st.sl, sreq) : Math.min(st.sl, sreq);
    if ((fill - snew) * d < gap * A0) return false;
    fills.push([fill, 1.0]);
    st.V = V2; st.PV = PV2; st.last = fill; st.sl = snew;
    if ((d > 0 && C[j] < O[j] && L[j] <= snew) || (d < 0 && C[j] > O[j] && H[j] >= snew)) return true;
  }
  return false;
}

function simTrend(D, sig, A, p, biaya, start = 220, end = null) {
  const O = D.o, H = D.h, L = D.l, C = D.c, T = D.t;
  const n = end == null ? C.length : Math.min(end, C.length);
  const k0 = +ambil(p, 'k0', 2.5), kt = +ambil(p, 'kt', 4.0), maxB = Math.trunc(ambil(p, 'maxB', 300)), kind = p._kind || null;
  const trades = [];
  let openTr = null, fresh = null, busy = -1;
  for (let i = start; i < n; i++) {
    if (i <= busy || sig[i] === 0) continue;
    const d = sig[i];
    if (i === n - 1) { fresh = { i, t: T[i], d, atr: A[i], kind: kind ? kind[i] : 0 }; break; }
    const e = O[i + 1], A0 = A[i], R0 = k0 * A0;
    if (!(R0 > 0)) continue;
    const st = { sl: e - d * R0, last: e, V: 1.0, PV: e, Rm: R0 }, fills = [[e, 1.0]];
    let ext = e, x = null, jx = null;
    const jEnd = Math.min(n, i + 1 + maxB);
    for (let j = i + 1; j < jEnd; j++) {
      const sl = st.sl;
      if (d > 0 && L[j] <= sl) { x = O[j] < sl ? O[j] : sl; jx = j; break; }
      if (d < 0 && H[j] >= sl) { x = O[j] > sl ? O[j] : sl; jx = j; break; }
      if (cobaTambah(fills, st, j, d, O, H, L, C, A0, p)) { x = st.sl; jx = j; break; }
      if (d > 0) { ext = Math.max(ext, H[j]); st.sl = Math.max(st.sl, ext - kt * A[j]); }
      else { ext = Math.min(ext, L[j]); st.sl = Math.min(st.sl, ext + kt * A[j]); }
    }
    if (x === null) {
      const jlast = jEnd - 1;
      if (jlast >= n - 1 && i + 1 + maxB > n - 1) {
        openTr = { i, t: T[i], d, e, R0, sl: st.sl, sl0: e - d * R0, ext, fills, bars: n - 1 - i, atr: A0, kind: kind ? kind[i] : 0 };
        busy = n;
        break;
      }
      jx = jlast; x = C[jx];
    }
    const [fav] = bracket(D, i + 1, e, d, R0, maxB);
    trades.push({ t: T[i], tx: T[jx], d, e, x, r: tutupBasket(fills, x, d, biaya, R0), layers: fills.length, bars: jx - i, fav, kind: kind ? kind[i] : 0 });
    busy = jx;
  }
  return [trades, openTr, fresh];
}

function simSqueeze(D, sig, A, p, biaya, start = 150, end = null) {
  const O = D.o, H = D.h, L = D.l, C = D.c, T = D.t;
  const n = end == null ? C.length : Math.min(end, C.length);
  const sla = +ambil(p, 'sl_atr', 1.0), tpa = +ambil(p, 'tp_atr', 2.0), maxB = Math.trunc(ambil(p, 'maxB', 48));
  const trades = [];
  let openTr = null, fresh = null, busy = -1;
  for (let i = start; i < n; i++) {
    if (i <= busy || sig[i] === 0) continue;
    const d = sig[i];
    if (i === n - 1) { fresh = { i, t: T[i], d, atr: A[i], kind: 3 }; break; }
    const e = O[i + 1], R0 = sla * A[i], sl = e - d * R0, tp = e + d * tpa * A[i];
    let x = null, jx = null;
    for (let j = i + 1; j < Math.min(n, i + 1 + maxB); j++) {
      if ((d > 0 && L[j] <= sl) || (d < 0 && H[j] >= sl)) { x = sl; jx = j; break; }
      if ((d > 0 && H[j] >= tp) || (d < 0 && L[j] <= tp)) { x = tp; jx = j; break; }
    }
    if (x === null) {
      if (i + 1 + maxB > n - 1) {
        openTr = { i, t: T[i], d, e, R0, sl, sl0: sl, tp, fills: [[e, 1.0]], bars: n - 1 - i, atr: A[i], kind: 3 };
        break;
      }
      jx = Math.min(n - 1, i + maxB); x = C[jx];
    }
    const [fav] = bracket(D, i + 1, e, d, R0, maxB);
    trades.push({ t: T[i], tx: T[jx], d, e, x, r: ((x - e) * d - biaya * e) / R0, layers: 1, bars: jx - i, fav, kind: 3 });
    busy = jx;
  }
  return [trades, openTr, fresh];
}

/** Breakout range sesi (Amatu EA v2.11 'Momentum Piramida'). Kembalikan [trades, open_baskets, status_hari_terakhir]. */
function simSesi(M5, h1, p, biaya, pasarBuka = null, dariHari = null) {
  const O = M5.o, H = M5.h, L = M5.l, C = M5.c, T = M5.t, n = C.length;
  const rs = Math.trunc(ambil(p, 'range_start', 0)), re_ = Math.trunc(ambil(p, 'range_end', 6)), ee = Math.trunc(ambil(p, 'entry_end', 16));
  const bufK = +ambil(p, 'bo_buf', 0.1), rmin = +ambil(p, 'range_min_atr', 0.5), rmax = +ambil(p, 'range_max_atr', 4.0);
  const slmin = +ambil(p, 'sl_min_atr', 0.5), slmax = +ambil(p, 'sl_max_atr', 2.0);
  const trAtr = +ambil(p, 'trail_atr', 2.0), trR = +ambil(p, 'trail_start_r', 1.0);
  const exitH = Math.trunc(ambil(p, 'exit_h', 23)), friH = ambil(p, 'friday_h', 20);
  const spike = +ambil(p, 'max_bar_atr', 3.0);
  const pp = { add_step: 2.0, lock_r: 1.0, add_gap: 1.0, ...p };
  for (const k of ['add_step', 'lock_r', 'add_gap']) if (p[k] === undefined) pp[k] = { add_step: 2.0, lock_r: 1.0, add_gap: 1.0 }[k];
  const ATR = h1.atr, E50 = h1.e50, E200 = h1.e200, HC = h1.c;
  const trades = [], opens = [];
  let statusHari = null;
  let a = 0;
  while (a < n) {
    const hari = Math.floor(T[a] / DAY);
    let b = a + 1; while (b < n && Math.floor(T[b] / DAY) === hari) b++;
    const d0 = hari * DAY;
    if (dariHari != null && d0 < dariHari) { a = b; continue; }
    const idxR = [], idxE = [];
    for (let i = a; i < b; i++) { const j = Math.floor((T[i] - d0) / HOUR); if (j >= rs && j < re_) idxR.push(i); if (j >= re_ && j < ee) idxE.push(i); }
    const stH = { hari: d0, range_lengkap: false, hi: null, lo: null, atr: null, pemicu: {}, alasan: '' };
    if (idxR.length < 6) { stH.alasan = 'Range sesi belum lengkap'; statusHari = stH; a = b; continue; }
    let hi = -Infinity, lo = Infinity;
    for (const i of idxR) { if (H[i] > hi) hi = H[i]; if (L[i] < lo) lo = L[i]; }
    stH.hi = hi; stH.lo = lo;
    const ref = idxE.length ? idxE[0] : Math.min(b - 1, idxR[idxR.length - 1] + 1);
    const atr0 = Number.isNaN(ATR[ref]) ? 0.0 : ATR[ref];
    stH.atr = atr0;
    const jamLast = Math.floor((T[b - 1] - d0) / HOUR);
    stH.range_lengkap = jamLast >= re_ || idxE.length > 0;
    if (atr0 <= 0) { statusHari = stH; a = b; continue; }
    const w = hi - lo;
    if ((rmin > 0 && w < rmin * atr0) || (rmax > 0 && w > rmax * atr0)) {
      stH.alasan = `Lebar range ${fx(w, 2)} di luar ${fg(rmin)}-${fg(rmax)} x ATR (${fx(atr0, 2)})`;
      statusHari = stH; a = b; continue;
    }
    const buf = bufK * atr0;
    stH.pemicu = { '1': hi + buf, '-1': lo - buf };
    let limit = d0 + exitH * HOUR;
    if (friH != null && hariKe(d0) === 4) limit = Math.min(limit, d0 + Math.trunc(friH) * HOUR);
    stH.batas_keluar = limit; stH.entry_sampai = d0 + ee * HOUR;
    const diambil = {};
    for (const k of idxE) {
      if (k + 1 >= n) break;
      if (pasarBuka && !pasarBuka(T[k])) continue;
      const ak = Number.isNaN(ATR[k]) ? atr0 : ATR[k];
      for (const d of [1, -1]) {
        if (diambil[d] !== undefined) continue;
        if (d > 0 && !(C[k] > hi + buf && C[k] > O[k])) continue;
        if (d < 0 && !(C[k] < lo - buf && C[k] < O[k])) continue;
        if (spike > 0 && H[k] - L[k] > spike * ak) continue;
        const tren = d > 0 ? (E50[k] > E200[k] && HC[k] > E200[k]) : (E50[k] < E200[k] && HC[k] < E200[k]);
        if (!tren) continue;
        diambil[d] = k;
        const e = O[k + 1], slx = d > 0 ? lo - buf : hi + buf, ds = (e - slx) * d;
        const R0 = ds > 0 ? Math.min(Math.max(ds, slmin * ak), slmax * ak) : slmin * ak;
        const st = { sl: e - d * R0, last: e, V: 1.0, PV: e, Rm: R0 }, fills = [[e, 1.0]];
        let ext = e, x = null, jx = null, alasan = '';
        for (let j = k + 1; j < n; j++) {
          if (T[j] >= limit) { x = O[j]; jx = j; alasan = 'waktu'; break; }
          const sl = st.sl;
          if (d > 0 && L[j] <= sl) { x = O[j] < sl ? O[j] : sl; jx = j; alasan = 'sl'; break; }
          if (d < 0 && H[j] >= sl) { x = O[j] > sl ? O[j] : sl; jx = j; alasan = 'sl'; break; }
          if (cobaTambah(fills, st, j, d, O, H, L, C, ak, pp)) { x = st.sl; jx = j; alasan = 'sl'; break; }
          ext = d > 0 ? Math.max(ext, H[j]) : Math.min(ext, L[j]);
          const an = Number.isNaN(ATR[j]) ? ak : ATR[j];
          if (trAtr > 0 && (ext - e) * d >= trR * R0) {
            const tr = ext - d * trAtr * an;
            st.sl = d > 0 ? Math.max(st.sl, tr) : Math.min(st.sl, tr);
          }
        }
        if (x === null) {
          opens.push({ i: k, t: T[k], d, e, R0, sl: st.sl, sl0: e - d * R0, ext, fills, atr: ak, kind: 4, batas: limit });
          continue;
        }
        const [fav] = bracket(M5, k + 1, e, d, R0, Math.max(1, Math.floor((limit - T[k]) / 300000)));
        trades.push({ t: T[k], tx: T[jx], d, e, x, r: tutupBasket(fills, x, d, biaya, R0), layers: fills.length, bars: jx - k, fav, kind: 4, keluar: alasan });
      }
    }
    stH.diambil = {}; for (const dd of Object.keys(diambil)) stH.diambil[dd] = T[diambil[dd]];
    statusHari = stH;
    a = b;
  }
  return [trades, opens, statusHari];
}

function ringkasTr(tr) {
  const n = tr.length;
  if (!n) return { n: 0, wr: 0.0, pf: null, avg: 0.0, sum: 0.0, dd: 0.0 };
  let gp = 0, gl = 0, menang = 0, eq = 0, puncak = 0, dd = 0, s = 0;
  for (const x of tr) {
    const r = x.r; s += r;
    if (r > 0) { gp += r; menang++; } else gl -= r;
    eq += r; puncak = Math.max(puncak, eq); dd = Math.max(dd, puncak - eq);
  }
  return { n, wr: menang / n * 100, pf: gl > 0 ? gp / gl : (gp > 0 ? 99.0 : null), avg: s / n, sum: s, dd };
}
/** batas: waktu pemisah segmen, mis. [t50, t75] → segmen A/B/C. */
function metrik(trades, batas = null) {
  const out = ringkasTr(trades);
  if (trades.length) {
    const n = trades.length;
    out.tp_peluang = {};
    for (const k of [1, 2, 3]) out.tp_peluang[k + 'R'] = trades.filter(x => x.fav >= k).length / n * 100;
    out.rata_bar = rata(trades.map(x => x.bars));
    out.rata_layer = rata(trades.map(x => x.layers || 1));
    out.dari = trades[0].t; out.sampai = trades[n - 1].t;
    const th = {};
    for (const x of trades) { const y = tahunUtc(x.t); (th[y] = th[y] || { n: 0, sum: 0 }); th[y].n++; th[y].sum += x.r; }
    out.tahunan = th;
  }
  if (batas) {
    const seg = []; let sisa = trades;
    for (const b of batas) { seg.push(sisa.filter(x => x.t < b)); sisa = sisa.filter(x => x.t >= b); }
    seg.push(sisa);
    out.segmen = seg.map(ringkasTr);
  }
  return out;
}

/** Uji balik satu strategi pada data P. */
function jalankanStrategi(P, sid, p, biaya, n = null) {
  const fam = p.famili;
  if (fam === 'trend') {
    const S = sinyalTrend(P, p, n); if (!S) return null;
    const [tr, op, frs] = simTrend(S.D, S.sig, S.I.atr, { ...p, _kind: S.kind }, biaya);
    return { trades: tr, open: op, fresh: frs, S };
  }
  if (fam === 'squeeze') {
    const S = sinyalSqueeze(P, p, n); if (!S) return null;
    const [tr, op, frs] = simSqueeze(S.D, S.sig, S.I.atr, p, biaya);
    return { trades: tr, open: op, fresh: frs, S };
  }
  if (fam === 'sesi') {
    const [M5, h1] = dataSesi(P, n); if (!M5) return null;
    const [tr, op, hari] = simSesi(M5, h1, p, biaya, P.sym === 'XAUUSDm' ? pasarEmasBuka : null);
    return { trades: tr, open: op && op.length ? op.slice(-2) : [], fresh: null, hari, M5, h1 };
  }
  throw new Error(fam);
}
// ================================================================== memori kebiasaan pasar (kebiasaan.py)
// Statistik perilaku harga dari candle yang terekam (180 hari kecuali disebut lain). Jam UTC, tampil WIB.
const HARI = ['Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu', 'Minggu'];
const keWib = j => (j + 7) % 24;

function hitungKebiasaan(P, sym) {
  const cfg = SIMBOL[sym], t0 = P.now;
  const H1 = P.bar('1h'), D1 = P.bar('1d'), H4 = P.bar('4h'), M5 = P.bar('5m');
  if (H1.c.length < 300 || D1.c.length < 30) return null;
  const out = { t: t0, sym };
  const a1 = atr(H1.h, H1.l, H1.c), atr1 = a1[a1.length - 1];
  const cur = P.forming('1m') || { c: H1.c[H1.c.length - 1] }, px = cur.c;
  out.harga = px; out.atr_1h = atr1;

  // ---- profil per jam (180 hari) ----
  const i180 = cariKiri(H1.t, t0 - 180 * DAY);
  const per = Array.from({ length: 24 }, () => ({ r: 0, rp: 0, naik: 0, n: 0 }));
  const jamArr = [];
  for (let i = i180; i < H1.t.length; i++) {
    const j = jamUtc(H1.t[i]), r = H1.h[i] - H1.l[i], z = per[j];
    z.r += r; z.rp += r / H1.c[i]; z.naik += H1.c[i] > H1.o[i] ? 1 : 0; z.n++;
    jamArr.push(j);
  }
  const prof = [];
  for (let j = 0; j < 24; j++) {
    const z = per[j]; if (z.n < 10) continue;
    prof.push({ jam_utc: j, jam_wib: keWib(j), range: z.r / z.n, range_pct: z.rp / z.n * 100, p_naik: z.naik / z.n * 100, n: z.n });
  }
  out.jam = prof;
  if (prof.length) {
    const rt = rata(prof.map(x => x.range));
    out.jam_aktif = [...prof].sort((a, b) => b.range - a.range).slice(0, 3).map(x => ({ jam_wib: x.jam_wib, kali_rata: x.range / rt }));
    out.jam_sepi = [...prof].sort((a, b) => a.range - b.range).slice(0, 3).map(x => ({ jam_wib: x.jam_wib }));
  }

  // ---- sesi ----
  const sesi = [];
  for (const [nama, a, b] of SESI) {
    const hari = new Map(); let cnt = 0;
    for (let i = i180; i < H1.t.length; i++) {
      const j = jamArr[i - i180]; if (!(j >= a && j < b)) continue;
      cnt++;
      const dd = Math.floor(H1.t[i] / DAY);
      let z = hari.get(dd);
      if (!z) { z = { h: -1e18, l: 1e18, o: H1.o[i], c: H1.c[i] }; hari.set(dd, z); }
      z.h = Math.max(z.h, H1.h[i]); z.l = Math.min(z.l, H1.l[i]); z.c = H1.c[i];
    }
    if (cnt < 20) continue;
    const rs = [], nk = [];
    for (const z of hari.values()) { rs.push(z.h - z.l); nk.push(z.c > z.o ? 1 : 0); }
    sesi.push({ nama, jam_wib: `${pad2(keWib(a))}:00-${pad2(b < 24 ? keWib(b) : keWib(0))}:00`, utc: [a, b],
      range: rata(rs), p_naik: rata(nk) * 100, n: rs.length });
  }
  out.sesi = sesi;
  const jn = jamUtc(t0);
  out.sesi_kini = (sesi.find(s => s.utc[0] <= jn && jn < s.utc[1]) || {}).nama || '';

  // ---- range Asia → dipecah dan dilanjutkan? (dasar strategi sesi) ----
  const re_ = cfg.sesi_preset.range_end;
  out.asia = statistikAsia(M5, t0, re_, 21);
  out.asia.range_end_wib = keWib(re_);

  // ---- hari dalam minggu (1 tahun) ----
  const iY = cariKiri(D1.t, t0 - 365 * DAY), hw = Array.from({ length: 7 }, () => ({ r: 0, naik: 0, n: 0 }));
  for (let i = iY; i < D1.t.length; i++) { const z = hw[hariKe(D1.t[i])]; z.r += D1.h[i] - D1.l[i]; z.naik += D1.c[i] > D1.o[i] ? 1 : 0; z.n++; }
  out.hari = [];
  for (let w = 0; w < 7; w++) if (hw[w].n >= 8) out.hari.push({ hari: HARI[w], range: hw[w].r / hw[w].n, p_naik: hw[w].naik / hw[w].n * 100, n: hw[w].n });

  // ---- ADR & pemakaian hari ini ----
  const nD = D1.c.length;
  let sAdr = 0; for (let i = Math.max(0, nD - 20); i < nD; i++) sAdr += D1.h[i] - D1.l[i];
  const adr = sAdr / Math.min(20, nD);
  const hi = rangeHariIni(P, t0);
  if (hi) {
    const dipakai = hi.h - hi.l;
    out.adr = { adr20: adr, range_hari_ini: dipakai, persen: adr ? dipakai / adr * 100 : 0, open_hari: hi.o, high: hi.h, low: hi.l,
      proyeksi_atas: hi.l + adr, proyeksi_bawah: hi.h - adr, sisa: Math.max(adr - dipakai, 0.0) };
  }

  // ---- persistensi & syok ----
  if (H4.c.length > 400) {
    const s = Math.max(0, H4.c.length - 2190); let k = 0, m = 0;
    for (let i = s + 1; i < H4.c.length; i++) { m++; if (tanda(H4.c[i] - H4.o[i]) === tanda(H4.c[i - 1] - H4.o[i - 1])) k++; }
    out.persisten_4h = k / m * 100;
  }
  { const s = Math.max(0, nD - 365); let k = 0, m = 0;
    for (let i = s + 1; i < nD; i++) { m++; if (tanda(D1.c[i] - D1.o[i]) === tanda(D1.c[i - 1] - D1.o[i - 1])) k++; }
    out.persisten_1d = m ? k / m * 100 : NaN; }
  out.syok = syok(H1, a1, t0);
  out.rezim = rezim(P, a1, H4);
  out.level = levelKunci(P, D1, H1, M5, px, atr1, cfg, t0);
  out.catatan = catatanKebiasaan(out);
  return out;
}

function statistikAsia(M5, t0, re_, akhirUtc) {
  const i0 = cariKiri(M5.t, t0 - 180 * DAY), T = M5.t;
  if (T.length - i0 < 2000) return {};
  let nHari = 0, pecah = 0, lanjut = 0, palsu = 0, atas = 0, bawah = 0;
  let a = i0;
  while (a < T.length) {
    const dd = Math.floor(T[a] / DAY);
    let b = a + 1; while (b < T.length && Math.floor(T[b] / DAY) === dd) b++;
    let nr = 0, ns = 0, hi = -Infinity, lo = Infinity;
    for (let i = a; i < b; i++) { const j = jamUtc(T[i]); if (j < re_) { nr++; hi = Math.max(hi, M5.h[i]); lo = Math.min(lo, M5.l[i]); } else if (j < akhirUtc) ns++; }
    if (nr >= 30 && ns >= 30) {
      nHari++;
      let fu = -1, fd = -1, ks = 0, akhir = null;
      for (let i = a; i < b; i++) {
        const j = jamUtc(T[i]); if (!(j >= re_ && j < akhirUtc)) continue;
        if (fu < 0 && M5.h[i] > hi) fu = ks;
        if (fd < 0 && M5.l[i] < lo) fd = ks;
        akhir = M5.c[i]; ks++;
      }
      if (fu >= 0 || fd >= 0) {
        pecah++;
        const arah = (fu >= 0 ? fu : 1e9) < (fd >= 0 ? fd : 1e9) ? 1 : -1;
        if (arah > 0) atas++; else bawah++;
        if ((arah > 0 && akhir > hi) || (arah < 0 && akhir < lo)) lanjut++;
        else if (lo <= akhir && akhir <= hi) palsu++;
      }
    }
    a = b;
  }
  if (!nHari) return {};
  const pc = Math.max(pecah, 1);
  return { hari: nHari, p_pecah: pecah / nHari * 100, p_lanjut: lanjut / pc * 100, p_palsu: palsu / pc * 100, p_atas_dulu: atas / pc * 100, p_bawah_dulu: bawah / pc * 100 };
}

function rangeHariIni(P, t0) {
  const M = P.bar('5m', 400);
  if (!M.t.length) return null;
  const d0 = Math.floor(t0 / DAY) * DAY, k = cariKiri(M.t, d0), f = P.forming('1m');
  if (k >= M.t.length) { if (!f) return null; return { o: f.o, h: f.h, l: f.l }; }
  let h = -Infinity, l = Infinity;
  for (let i = k; i < M.t.length; i++) { h = Math.max(h, M.h[i]); l = Math.min(l, M.l[i]); }
  if (f) { h = Math.max(h, f.h); l = Math.min(l, f.l); }
  return { o: M.o[k], h, l };
}

function syok(H1, a1, t0) {
  const i0 = cariKiri(H1.t, t0 - 365 * DAY);
  let lanjut = 0, balik = 0; const gerak = [];
  for (let i = i0; i < H1.t.length; i++) {
    if (i < 20 || i + 4 >= H1.c.length) continue;
    const body = H1.c[i] - H1.o[i];
    if (Math.abs(body) > 2.0 * a1[i - 1]) {
      const f = (H1.c[i + 4] - H1.c[i]) * tanda(body);
      gerak.push(f / a1[i - 1]);
      if (f > 0) lanjut++; else balik++;
    }
  }
  const n = lanjut + balik;
  if (n < 8) return { n };
  return { n, p_lanjut: lanjut / n * 100, p_balik: balik / n * 100, rata_atr: rata(gerak) };
}

function rezim(P, a1, H4) {
  const pct = persentilTerakhir(a1, 24 * 180);
  let vl, vk;
  if (pct >= 92) { vl = 'ekstrem (tidak stabil)'; vk = 'ekstrem'; }
  else if (pct >= 75) { vl = vk = 'tinggi'; }
  else if (pct >= 25) { vl = vk = 'normal'; }
  else { vl = vk = 'tenang'; }
  const out = { vol_persentil: pct, vol: vl, vol_kode: vk };
  const I4 = P.indikator('4h');
  if (I4 && H4.c.length > 250) {
    const L = H4.c.length - 1, c = H4.c[L], e50 = I4.e50[L], e200 = I4.e200[L], ad = I4.adx[L];
    let tl, td;
    if (c > e50 && e50 > e200) { tl = ad >= 25 ? 'naik kuat' : 'naik'; td = 1; }
    else if (c < e50 && e50 < e200) { tl = ad >= 25 ? 'turun kuat' : 'turun'; td = -1; }
    else { tl = 'sideways / transisi'; td = 0; }
    if (ad < 18 && td !== 0) tl += ' (lemah)';
    Object.assign(out, { tren_4h: tl, arah_4h: td, adx_4h: ad });
  }
  const I1 = P.indikator('1d'), D1 = P.bar('1d');
  if (I1 && D1.c.length > 200) {
    const L = D1.c.length - 1, c = D1.c[L];
    out.arah_1d = (c > I1.e50[L] && I1.e50[L] > I1.e200[L]) ? 1 : (c < I1.e50[L] && I1.e50[L] < I1.e200[L]) ? -1 : 0;
  }
  const saran = [];
  if (vk === 'ekstrem') {
    saran.push('Pasar tidak stabil: risiko per posisi dipotong 50%, hanya setup grade A, SL mengikuti ATR (otomatis lebih lebar).');
    saran.push('Hindari entry 30 menit sebelum/sesudah berita besar; candle spike > 3x ATR dilewati.');
  } else if (vk === 'tinggi') saran.push('Volatilitas tinggi: risiko dipotong 25%, utamakan konfirmasi close candle sebelum entry.');
  else if (vk === 'tenang') saran.push('Volatilitas rendah: breakout sering gagal; target TP lebih realistis di 1R-2R.');
  if (out.arah_4h === 0) saran.push('Tren 4H belum jelas: strategi tren menunggu, strategi sesi/pullback lebih cocok.');
  out.saran = saran;
  out.pengali_risiko = { ekstrem: 0.5, tinggi: 0.75 }[vk] || 1.0;
  return out;
}

function levelKunci(P, D1, H1, M5, px, atr1, cfg, t0) {
  const lv = [], d0 = Math.floor(t0 / DAY) * DAY, nD = D1.t.length;
  const k = cariKiri(D1.t, d0);                       // bar harian sebelum hari ini
  if (k >= 2) lv.push(['High kemarin (PDH)', D1.h[k - 1]], ['Low kemarin (PDL)', D1.l[k - 1]]);
  const base = nD - 30, wk = [];
  for (let i = Math.max(0, base); i < nD; i++) wk.push(mingguIso(D1.t[i]));
  if (wk.length > 7) {
    const kini = wk[wk.length - 1], lalu = [];
    for (let i = 0; i < wk.length; i++) if (wk[i] !== kini) lalu.push(i);
    if (lalu.length) {
      const akhir = wk[lalu[lalu.length - 1]];
      let h = -Infinity, l = Infinity;
      for (let i = 0; i < wk.length; i++) if (wk[i] === akhir) { h = Math.max(h, D1.h[Math.max(0, base) + i]); l = Math.min(l, D1.l[Math.max(0, base) + i]); }
      lv.push(['High minggu lalu', h], ['Low minggu lalu', l]);
    }
  }
  const re_ = cfg.sesi_preset.range_end, kd0 = cariKiri(M5.t, d0), kr1 = cariKiri(M5.t, d0 + re_ * HOUR);
  if (kr1 - kd0 >= 6) {
    let h = -Infinity, l = Infinity; for (let i = kd0; i < kr1; i++) { h = Math.max(h, M5.h[i]); l = Math.min(l, M5.l[i]); }
    lv.push(['High range Asia', h], ['Low range Asia', l]);
  }
  if (kd0 < M5.t.length) lv.push(['Open hari ini', M5.o[kd0]]);
  const n = Math.min(H1.h.length, 240), hh = H1.h.subarray(H1.h.length - n), ll = H1.l.subarray(H1.l.length - n);
  const [hiI, loI] = fraktal(hh, ll, 3);
  const r2 = x => Math.round(x * 100) / 100;
  const sh = [...new Set(hiI.filter(i => hh[i] > px).map(i => r2(hh[i])))].sort((a, b) => a - b).slice(0, 2);
  const sl = [...new Set(loI.filter(i => ll[i] < px).map(i => r2(ll[i])))].sort((a, b) => a - b).slice(-2);
  for (const x of sh) lv.push(['Swing high 1H', x]);
  for (const x of sl) lv.push(['Swing low 1H', x]);
  const b = cfg.bulat;
  lv.push(['Angka bulat', Math.ceil(px / b) * b], ['Angka bulat', Math.floor(px / b) * b]);
  const out = [], seen = new Set();
  for (const [nama, harga] of lv) {
    const key = nama + '|' + Math.round(harga * 10) / 10;
    if (seen.has(key) || !fin(harga)) continue;
    seen.add(key);
    out.push({ nama, harga, jarak: harga - px, jarak_atr: atr1 ? (harga - px) / atr1 : 0, sisi: harga > px ? 'atas' : 'bawah' });
  }
  out.sort((a, b) => b.harga - a.harga);
  return out;
}

function catatanKebiasaan(o) {
  const c = [];
  if (o.jam_aktif && o.jam_aktif.length) {
    const j = o.jam_aktif[0];
    c.push(`Jam paling aktif sekitar ${pad2(j.jam_wib)}:00 WIB (range 1H ${fx(j.kali_rata, 1)}x rata-rata).`);
  }
  const a = o.asia || {};
  if (a.hari) c.push(`Range awal hari (07:00-${pad2(a.range_end_wib)}:00 WIB) dipecah di ${fx(a.p_pecah)}% hari; setelah pecah, ${fx(a.p_lanjut)}% hari ditutup searah dan ${fx(a.p_palsu)}% kembali ke dalam range.`);
  const ad = o.adr;
  if (ad) c.push(`Rata-rata range harian 20 hari ${fx(ad.adr20, 2)}; hari ini sudah terpakai ${fx(ad.persen)}%.`);
  const s = o.syok || {};
  if ((s.n || 0) >= 8) {
    if (s.p_balik >= 58) c.push(`Setelah candle 1H besar (>2 ATR), 4 jam berikutnya lebih sering berbalik (${fx(s.p_balik)}% dari ${s.n} kejadian).`);
    else if (s.p_lanjut >= 58) c.push(`Setelah candle 1H besar (>2 ATR), 4 jam berikutnya lebih sering melanjutkan (${fx(s.p_lanjut)}% dari ${s.n}).`);
  }
  const r = o.rezim || {};
  if (r.tren_4h) c.push(`Tren 4H ${r.tren_4h} (ADX ${fx(r.adx_4h || 0)}); volatilitas ${r.vol} (persentil ${fx(r.vol_persentil)}).`);
  return c;
}

// ================================================================== prediksi analog (prediksi.py)
// k-NN atas kondisi pasar yang mirip di masa lalu: peluang naik/turun + rentang wajar, BUKAN kepastian.
const K_ANALOG = 60, NF = 12;

function fitur(D, I) {
  const c = D.c, h = D.h, l = D.l, n = c.length, A = I.atr;
  const hi20 = rollMax(h, 20), lo20 = rollMin(l, 20), atrSma = sma(A, 100), F = new Float64Array(n * NF);
  const lag = (i, k) => (n > k && i >= k) ? c[i - k] : NaN;
  for (let i = 0; i < n; i++) {
    const a = A[i] > 0 ? A[i] : NaN, rg = hi20[i] - lo20[i] > 0 ? hi20[i] - lo20[i] : NaN;
    const jam = (((D.t[i] % DAY) + DAY) % DAY) / HOUR, o = i * NF;
    F[o] = (c[i] - lag(i, 1)) / a;
    F[o + 1] = (c[i] - lag(i, 4)) / a;
    F[o + 2] = (c[i] - lag(i, 12)) / a / 1.5;
    F[o + 3] = (c[i] - lag(i, 48)) / a / 3.0;
    F[o + 4] = (c[i] - lo20[i]) / rg - 0.5;
    F[o + 5] = (c[i] - I.e50[i]) / a / 2.0;
    F[o + 6] = (c[i] - I.e200[i]) / a / 4.0;
    F[o + 7] = I.adx[i] / 50.0;
    F[o + 8] = I.rsi[i] / 100.0 - 0.5;
    F[o + 9] = Math.log(atrSma[i] > 0 ? A[i] / atrSma[i] : NaN);
    F[o + 10] = 0.5 * Math.sin(jam / 24 * 2 * Math.PI);
    F[o + 11] = 0.5 * Math.cos(jam / 24 * 2 * Math.PI);
  }
  return F;
}

function siapkanAnalog(D, I, H) {
  const F = fitur(D, I), c = D.c, h = D.h, l = D.l, a = I.atr, n = c.length;
  const fwd = penuhNaN(n), up = penuhNaN(n), dn = penuhNaN(n), ok = new Uint8Array(n);
  if (n > H) {
    for (let i = 0; i < n - H; i++) {
      fwd[i] = (c[i + H] - c[i]) / a[i];
      let mx = -Infinity, mn = Infinity;
      for (let j = i + 1; j <= i + H; j++) { if (h[j] > mx) mx = h[j]; if (l[j] < mn) mn = l[j]; }
      up[i] = (mx - c[i]) / a[i]; dn[i] = (mn - c[i]) / a[i];
    }
  }
  let nOk = 0;
  for (let i = 0; i < n; i++) {
    let b = 1; for (let k = 0; k < NF; k++) if (!Number.isFinite(F[i * NF + k])) { b = 0; break; }
    ok[i] = b; nOk += b;
  }
  const sd = new Float64Array(NF).fill(1);
  if (nOk > 50) {
    for (let k = 0; k < NF; k++) {
      let s = 0; for (let i = 0; i < n; i++) if (ok[i]) s += F[i * NF + k];
      const mu = s / nOk; let v = 0; for (let i = 0; i < n; i++) if (ok[i]) v += (F[i * NF + k] - mu) ** 2;
      const x = Math.sqrt(v / nOk); sd[k] = x > 0 ? x : 1.0;
    }
  }
  for (let i = 0; i < n; i++) for (let k = 0; k < NF; k++) F[i * NF + k] /= sd[k];
  return { Fz: F, fwd, up, dn, ok };
}

/** Analog dari indeks < sampai (sudah matang). [fwd, up, dn, jarak median] atau null. */
function knn(A, q, sampai, k = K_ANALOG) {
  const { Fz, fwd, up, dn, ok } = A;
  let cnt = 0;
  for (let i = 0; i < sampai; i++) if (ok[i] && Number.isFinite(fwd[i])) cnt++;
  if (cnt < k * 3) return null;
  const hd = new Float64Array(k).fill(Infinity), hi = new Int32Array(k).fill(-1);   // max-heap sederhana: simpan k terkecil
  let isi = 0, maxI = 0;
  for (let i = 0; i < sampai; i++) {
    if (!ok[i] || !Number.isFinite(fwd[i])) continue;
    let d = 0; const o = i * NF;
    for (let j = 0; j < NF; j++) { const z = Fz[o + j] - Fz[q + j]; d += z * z; }
    if (isi < k) { hd[isi] = d; hi[isi] = i; isi++; if (isi === k) { maxI = 0; for (let j = 1; j < k; j++) if (hd[j] > hd[maxI]) maxI = j; } }
    else if (d < hd[maxI]) {
      hd[maxI] = d; hi[maxI] = i; maxI = 0;
      for (let j = 1; j < k; j++) if (hd[j] > hd[maxI]) maxI = j;
    }
  }
  const f = [], u = [], dd = [], jr = [];
  for (let j = 0; j < k; j++) { const i = hi[j]; f.push(fwd[i]); u.push(up[i]); dd.push(dn[i]); jr.push(Math.sqrt(hd[j])); }
  return [f, u, dd, median(jr)];
}

/** Prediksi semua horizon mode ini pada candle tertutup terakhir. */
function ramal(P, mode) {
  const out = [];
  for (const [label, tf, H] of MODE[mode].horizon) {
    const D = P.bar(tf), I = P.indikator(tf);
    if (!I || D.c.length < 1500) continue;
    const A = siapkanAnalog(D, I, H), L = D.c.length - 1;
    if (!A.ok[L]) continue;
    const r = knn(A, L * NF, L - H);
    if (!r) continue;
    const [f, u, d_, jarak] = r;
    let nb = 0, bn = 0; for (let i = 0; i < A.fwd.length; i++) if (Number.isFinite(A.fwd[i])) { nb++; if (A.fwd[i] > 0) bn++; }
    const a = I.atr[L], c = D.c[L], ref = P.forming('1m'), px = ref ? ref.c : c;
    out.push({
      label, tf, bar: H, t: D.t[L], harga: c, harga_kini: px, atr: a,
      p_naik: f.filter(x => x > 0).length / f.length * 100, p_dasar: nb ? bn / nb * 100 : 50, n: f.length,
      median: c + median(f) * a, q10: c + kuantil(f, 0.1) * a, q90: c + kuantil(f, 0.9) * a,
      atas_wajar: c + kuantil(u, 0.7) * a, bawah_wajar: c + kuantil(d_, 0.3) * a, jarak_analog: jarak,
      t_matang: D.t[L] + (H + 1) * TF_MS[tf],
    });
  }
  return out;
}

/** Walk-forward: tiap titik uji hanya memakai analog dari masa SEBELUMNYA. */
async function akurasiHistoris(P, mode, titik = 400) {
  const hasil = {};
  for (const [label, tf, H] of MODE[mode].horizon) {
    const D = P.bar(tf), I = P.indikator(tf);
    if (!I || D.c.length < 3000) continue;
    const A = siapkanAnalog(D, I, H), n = D.c.length, mulai = Math.trunc(n * 0.6), akhir = n - H - 2;
    let hit = 0, yh = 0, yn = 0, band = 0, brier = 0, m = 0;
    for (let s = 0; s < titik; s++) {
      const i = Math.trunc(mulai + (akhir - mulai) * (titik > 1 ? s / (titik - 1) : 0));
      if (!A.ok[i] || !Number.isFinite(A.fwd[i])) continue;
      const r = knn(A, i * NF, i - H);
      if (!r) continue;
      const f = r[0], p = f.filter(x => x > 0).length / f.length, y = A.fwd[i] > 0 ? 1 : 0;
      m++; hit += ((p > 0.5) === !!y) ? 1 : 0; brier += (p - y) ** 2;
      if (Math.abs(p - 0.5) >= 0.08) { yn++; yh += ((p > 0.5) === !!y) ? 1 : 0; }
      const lo = kuantil(f, 0.1), hi = kuantil(f, 0.9);
      if (lo <= A.fwd[i] && A.fwd[i] <= hi) band++;
      if (s % 20 === 0) await lega();
    }
    if (m) hasil[label] = { n: m, arah: hit / m * 100, yakin_n: yn, yakin: yn ? yh / yn * 100 : null, band80: band / m * 100, brier: brier / m, t: now() };
  }
  return hasil;
}

function catatPrediksi(sym, mode, list) {
  for (const p of list) {
    if (TBL.prediksi.some(x => x.sym === sym && x.mode === mode && x.label === p.label && x.t === p.t)) continue;
    TBL.prediksi.push({ sym, mode, label: p.label, tf: p.tf, bar: p.bar, t: p.t, t_matang: p.t_matang, harga: p.harga, atr: p.atr,
      p_naik: p.p_naik, p_dasar: p.p_dasar, q10: p.q10, q50: p.median, q90: p.q90, n: p.n, hasil: null, kena_arah: null, dalam_band: null, dievaluasi: 0 });
    TBL_KOTOR.add('prediksi');
  }
  const batas = now() - 45 * DAY;
  if (TBL.prediksi.length > 20000 || (TBL.prediksi.length && TBL.prediksi[0].t < batas)) {
    TBL.prediksi = TBL.prediksi.filter(x => x.t >= batas).slice(-20000);
    TBL_KOTOR.add('prediksi');
  }
}
/** Nilai prediksi yang sudah jatuh tempo memakai close candle saat jatuh tempo. */
function evaluasiPrediksi(sym, seri, skala) {
  const t = now();
  for (const r of TBL.prediksi) {
    if (r.sym !== sym || r.dievaluasi !== 0 || r.t_matang > t) continue;
    const ms = TF_MS[r.tf], target = r.t + r.bar * ms;
    let D = candle(seri, r.tf, { dari: target, sampai: target });
    if (!D.c.length) {
      const D2 = candle(seri, r.tf, { dari: target - 3 * ms, sampai: target + 3 * ms });
      if (!D2.c.length) { if (t - target > 3 * DAY) { r.dievaluasi = 2; TBL_KOTOR.add('prediksi'); } continue; }
      D = D2;
    }
    const c = D.c[D.c.length - 1] * skala, naik = c > r.harga;
    r.hasil = c;
    r.kena_arah = Math.abs(r.p_naik - 50) >= 0.01 ? (((r.p_naik > 50) === naik) ? 1 : 0) : null;
    r.dalam_band = (r.q10 <= c && c <= r.q90) ? 1 : 0;
    r.dievaluasi = 1;
    TBL_KOTOR.add('prediksi');
  }
}
function rekapPrediksi(sym, mode, n = 100) {
  const rows = TBL.prediksi.filter(x => x.sym === sym && x.mode === mode && x.dievaluasi === 1).sort((a, b) => b.t - a.t).slice(0, n);
  const out = {};
  for (const r of rows) {
    const o = out[r.label] || (out[r.label] = { n: 0, arah: 0, band: 0, yakin_n: 0, yakin: 0 });
    o.n++; o.arah += r.kena_arah || 0; o.band += r.dalam_band || 0;
    if (Math.abs(r.p_naik - 50) >= 8) { o.yakin_n++; o.yakin += r.kena_arah || 0; }
  }
  for (const o of Object.values(out)) {
    o.arah_pct = o.n ? o.arah / o.n * 100 : null; o.band_pct = o.n ? o.band / o.n * 100 : null; o.yakin_pct = o.yakin_n ? o.yakin / o.yakin_n * 100 : null;
  }
  return out;
}
// ================================================================== rencana posisi otomatis (rencana.py)
// Sumber kebenaran = strategi aktif hasil lab (atau preset teruji sebelum lab pertama). Level dihitung dengan rumus yang
// SAMA dengan backtest, jadi statistik yang ditampilkan memang milik rencana yang ditampilkan.
const RISET = {   // [n, WR, PF, PF latih, PF uji]
  'SC15|BTCUSDT': [469, 36, 1.27, 1.22, 1.35], 'SC15|XAUUSDm': [498, 36, 1.53, 1.83, 1.18],
  'SW1H|BTCUSDT': [592, 36, 1.36, 1.28, 1.48], 'SW1H|XAUUSDm': [538, 35, 1.27, 0.98, 1.59],
  'SW4H|BTCUSDT': [126, 37, 1.76, 2.0, 1.51], 'SW4H|XAUUSDm': [128, 41, 1.83, 1.41, 2.34],
  'SESI|XAUUSDm': [null, null, 1.63, 1.58, 1.75], 'SESI|BTCUSDT': [null, null, 1.0, 0.98, 1.67],
  'BO4H|BTCUSDT': [84, null, 2.07, 2.61, 1.65],
};

function hitungLot(setelan, sym, R0, pengali) {
  const cfg = SIMBOL[sym], saldo = +(setelan.saldo || 0), pct = +(setelan.risiko_pct || 1.0) * pengali;
  const mu = setelan.mata_uang || 'IDR', kurs = mu === 'IDR' ? +(setelan.usd_idr || 16500) : 1.0;
  const risiko = saldo * pct / 100.0, risikoUsd = risiko / kurs, nilaiLot = R0 * cfg.kontrak;
  if (!(nilaiLot > 0)) return null;
  let lot = Math.floor(risikoUsd / nilaiLot / cfg.lot_step + 1e-9) * cfg.lot_step, catatan = '';
  if (lot < cfg.lot_min) {
    lot = cfg.lot_min;
    const nyata = lot * nilaiLot * kurs;
    catatan = saldo ? `Lot minimum ${cfg.lot_min} berisiko ${fmt(nyata, 0)} ${mu} (${fx(nyata / saldo * 100, 1)}% saldo) > target ${fx(pct, 2)}%.` : '';
  }
  return { lot: Math.round(lot * 100) / 100, risiko, risiko_pct: pct, mata_uang: mu, rugi_sl: lot * nilaiLot * kurs, catatan };
}

/** Layer piramida: L1 di entry, L2.. tiap add_step x ATR searah; SL basket dikunci <= lock_r x R. */
function rencanaLayer(entry, d, a, R0, p, lot) {
  const n = Math.trunc(ambil(p, 'layers', 1)), step = +ambil(p, 'add_step', 1.0), lock = +ambil(p, 'lock_r', 1.0), gap = +ambil(p, 'add_gap', 1.0);
  let sl = entry - d * R0, last = entry;
  const fills = [entry], out = [{ ke: 1, harga: entry, lot, jenis: 'Entry', sl_basket: sl }];
  for (let k = 2; k <= n; k++) {
    const lvl = last + d * step * a, V = fills.length + 1, avg = (jumlah(fills) + lvl) / V;
    const sreq = avg - d * lock * R0 / V, snew = d > 0 ? Math.max(sl, sreq) : Math.min(sl, sreq);
    const ok = (lvl - snew) * d >= gap * a;
    out.push({ ke: k, harga: lvl, lot, jenis: ok ? 'Tambah saat harga maju' : 'Tambah (menunggu ruang SL)', sl_basket: snew });
    if (ok) { fills.push(lvl); sl = snew; }
    last = lvl;
  }
  return out;
}

function statistikStrategi(sid, sym, m) {
  if (m && m.n) {
    const seg = m.segmen || [];
    return { sumber: 'lab lokal', n: m.n, wr: m.wr, pf: m.pf, avg: m.avg, dd: m.dd, tp_peluang: m.tp_peluang,
      pf_segmen: seg.map(s => s.pf), dari: m.dari, dd95: m.dd95, kalah_beruntun: m.kalah_beruntun, pf_biaya2: m.pf_biaya2 };
  }
  const r = RISET[sid + '|' + sym];
  if (r) return { sumber: 'riset proyek', n: r[0], wr: r[1], pf: r[2], pf_segmen: [r[3], r[4]] };
  return { sumber: '-', n: 0 };
}
const tpDari = (e, d, R0) => [1, 2, 3].map(k => e + d * k * R0);
const lotOf = lt => (lt ? lt.lot : null);

function kandidatTrend(P, sa, sym, px, setelan, pengali) {
  const sid = sa.sid, p = sa.params;
  const n = { '15m': 2200, '1h': 1600, '4h': 1300 }[p.tf] || 1500;
  const res = jalankanStrategi(P, sid, p, SIMBOL[sym].biaya_pct, n);
  if (!res) return [null, null];
  const S = res.S, D = S.D, I = S.I, L = D.c.length - 1, a = I.atr[L];
  const k0 = +ambil(p, 'k0', 2.5), kt = +ambil(p, 'kt', 4.0), tf = p.tf.toUpperCase(), dirn = Math.trunc(S.dir[L]);
  const base = { sid, nama: sa.nama || NAMA[sid] || sid, famili: 'trend', tf: p.tf, atr: a, grade: sa.grade || 'B', params: p };
  const alasan = [];
  const ht = p.ht.map((t, i) => `${t.toUpperCase()} ${S.arah_ht[i] > 0 ? 'naik' : S.arah_ht[i] < 0 ? 'turun' : 'datar'}`).join(', ');
  alasan.push(`Tren TF besar: ${ht}.`);
  const op = res.open, frs = res.fresh;
  if (op) {
    const d = op.d, e0 = op.fills[0][0], R0 = op.R0, lt = hitungLot(setelan, sym, R0, pengali);
    const fills = op.fills.map(f => f[0]);
    const layer = fills.map((f, i) => ({ ke: i + 1, harga: f, lot: lotOf(lt), jenis: 'Terisi', sl_basket: op.sl }));
    if (fills.length < Math.trunc(ambil(p, 'layers', 1))) layer.push({ ke: fills.length + 1, harga: fills[fills.length - 1] + d * +ambil(p, 'add_step', 1.0) * op.atr, lot: lotOf(lt), jenis: 'Tambah berikutnya', sl_basket: null });
    alasan.push(`Posisi berjalan sejak ${wib(op.t, '%d/%m %H:%M')} WIB; SL sudah digeser trailing ke ${fmt(op.sl)}.`);
    return [{ ...base, status: 'AKTIF', arah: d, entry: e0, sl: op.sl, sl_awal: op.sl0, r0: R0, tp: tpDari(e0, d, R0), layer, lot: lt,
      maju_r: (px - e0) * d / R0, t_sinyal: op.t, pemicu: 'Sudah masuk (sinyal sebelumnya)', jenis_entry: 'berjalan',
      trailing: `Chandelier ${fg(kt)} x ATR ${tf} dari harga terbaik (${fmt(op.ext)})`, alasan }, res];
  }
  if (frs) {
    const d = frs.d, R0 = k0 * a, e = px, lt = hitungLot(setelan, sym, R0, pengali);
    const kind = frs.kind === 1 ? 'breakout' : 'pullback EMA20';
    alasan.push(`Sinyal ${kind} baru saja terkonfirmasi pada close candle ${tf} ${wib(frs.t + TF_MS[p.tf])} WIB.`);
    return [{ ...base, status: 'MASUK', arah: d, entry: e, sl: e - d * R0, r0: R0, tp: tpDari(e, d, R0), layer: rencanaLayer(e, d, a, R0, p, lotOf(lt)),
      lot: lt, t_sinyal: frs.t, pemicu: `Masuk sekarang (open candle ${tf} baru)`, jenis_entry: 'market',
      trailing: `SL awal ${fg(k0)} x ATR, lalu chandelier ${fg(kt)} x ATR ${tf} dari harga terbaik`, alasan }, res];
  }
  if (dirn === 0) {
    alasan.push('Arah TF besar tidak sepakat, strategi ini menunggu.');
    return [{ ...base, status: 'TUNGGU', arah: 0, alasan, pemicu: 'Tunggu tren TF besar searah' }, res];
  }
  const nb = Math.trunc(ambil(p, 'n_bo', 20));
  let hiN = -Infinity, loN = Infinity;
  for (let i = Math.max(0, D.c.length - nb); i < D.c.length; i++) { hiN = Math.max(hiN, D.h[i]); loN = Math.min(loN, D.l[i]); }
  const opsi = [];
  if (p.bo) { const lvl = dirn > 0 ? hiN : loN; opsi.push(['breakout', lvl, `Candle ${tf} close ${dirn > 0 ? 'di atas' : 'di bawah'} ${fmt(lvl)} (high/low ${nb} candle)`]); }
  if (ambil(p, 'pb', true)) {
    const e20 = I.e20[L], adxOk = I.adx[L] >= ambil(p, 'adx_min', 20), alOk = Math.trunc(S.al[L]) === dirn;
    if (adxOk && alOk) opsi.push(['pullback', e20 + dirn * 0.1 * a, `Harga turun ke EMA20 ${tf} (≈${fmt(e20)}) lalu candle close kembali ${dirn > 0 ? 'di atas' : 'di bawah'} EMA20`]);
    else {
      const why = [];
      if (!adxOk) why.push(`ADX ${fx(I.adx[L])} < ${ambil(p, 'adx_min', 20)}`);
      if (!alOk) why.push('EMA20/50/200 belum berjajar');
      alasan.push('Aturan pullback belum aktif (' + why.join(', ') + ').');
    }
  }
  if (!opsi.length) return [{ ...base, status: 'TUNGGU', arah: dirn, alasan, pemicu: 'Belum ada pemicu aktif' }, res];
  opsi.sort((x, y) => Math.abs(x[1] - px) - Math.abs(y[1] - px));
  const [jenis, lvl, teks] = opsi[0], e = lvl, R0 = k0 * a, lt = hitungLot(setelan, sym, R0, pengali);
  let jenisEntry = jenis === 'breakout' ? (dirn > 0 ? 'Buy stop' : 'Sell stop') : (dirn > 0 ? 'Buy limit' : 'Sell limit');
  if (jenis === 'breakout' && (px - lvl) * dirn > 0) jenisEntry = 'Tunggu close';
  return [{ ...base, status: 'SIAP', arah: dirn, entry: e, sl: e - dirn * R0, r0: R0, tp: tpDari(e, dirn, R0),
    layer: rencanaLayer(e, dirn, a, R0, p, lotOf(lt)), lot: lt, pemicu: teks, jenis_entry: jenisEntry, jarak_atr: a ? Math.abs(lvl - px) / a : 0,
    alternatif: opsi.slice(1).map(([j, v, t]) => ({ jenis: j, harga: v, pemicu: t })),
    trailing: `SL awal ${fg(k0)} x ATR, lalu chandelier ${fg(kt)} x ATR ${tf}`, alasan, berlaku: `Selama tren ${ht.toLowerCase()} bertahan` }, res];
}

function kandidatSesi(P, sa, sym, px, setelan, pengali) {
  const sid = sa.sid, p = sa.params;
  const res = jalankanStrategi(P, sid, p, SIMBOL[sym].biaya_pct, 3600);
  if (!res) return [null, null];
  const base = { sid, nama: sa.nama || NAMA[sid] || sid, famili: 'sesi', tf: '5m', grade: sa.grade || 'B', params: p };
  const t0 = P.now, d0 = Math.floor(t0 / DAY) * DAY, hari = res.hari || {};
  const re_ = Math.trunc(p.range_end), ee = Math.trunc(p.entry_end), ex = Math.trunc(ambil(p, 'exit_h', 23));
  const alasan = [`Range ${wib(d0 + Math.trunc(p.range_start) * HOUR)}-${wib(d0 + re_ * HOUR)} WIB, entry close M5 di luar range ` +
    `${wib(d0 + re_ * HOUR)}-${wib(d0 + ee * HOUR)} WIB, semua ditutup ${wib(d0 + ex * HOUR)} WIB.`];
  const h1 = res.h1, j = res.M5.c.length - 1;
  const tren = { 1: !!(h1.e50[j] > h1.e200[j] && h1.c[j] > h1.e200[j]), '-1': !!(h1.e50[j] < h1.e200[j] && h1.c[j] < h1.e200[j]) };
  const a0 = Number.isFinite(h1.atr[j]) ? h1.atr[j] : null;
  base.atr = a0;
  if (sym === 'XAUUSDm' && !pasarEmasBuka(t0)) return [{ ...base, status: 'TUNGGU', arah: 0, alasan: [...alasan, 'Pasar emas tutup (akhir pekan).'], pemicu: 'Pasar tutup' }, res];
  const ops = (res.open || []).filter(o => o.t >= d0);
  if (ops.length) {
    const o = ops.reduce((x, y) => (y.t > x.t ? y : x)), d = o.d, e0 = o.fills[0][0], R0 = o.R0, lt = hitungLot(setelan, sym, R0, pengali);
    const fills = o.fills.map(f => f[0]);
    const layer = fills.map((f, i) => ({ ke: i + 1, harga: f, lot: lotOf(lt), jenis: 'Terisi', sl_basket: o.sl }));
    if (fills.length < Math.trunc(ambil(p, 'layers', 1))) layer.push({ ke: fills.length + 1, harga: fills[fills.length - 1] + d * +p.add_step * o.atr, lot: lotOf(lt), jenis: 'Tambah berikutnya', sl_basket: null });
    alasan.push(`Basket ${AB(d)} berjalan sejak ${wib(o.t)} WIB, ${fills.length} layer terisi.`);
    return [{ ...base, status: 'AKTIF', arah: d, entry: e0, sl: o.sl, sl_awal: o.sl0, r0: R0, tp: tpDari(e0, d, R0), layer, lot: lt,
      maju_r: (px - e0) * d / R0, t_sinyal: o.t, pemicu: 'Sudah masuk', jenis_entry: 'berjalan',
      trailing: `Trailing ${fg(p.trail_atr)} x ATR H1 mulai +${fg(p.trail_start_r)}R; tutup ${wib(o.batas)} WIB`, alasan }, res];
  }
  if (hari.hari !== d0 || hari.hi == null) return [{ ...base, status: 'TUNGGU', arah: 0, alasan: [...alasan, 'Menunggu range sesi hari ini.'], pemicu: `Range terbentuk sampai ${wib(d0 + re_ * HOUR)} WIB` }, res];
  const jam = Math.floor((t0 - d0) / HOUR), hi = hari.hi, lo = hari.lo;
  if (jam < re_) {
    alasan.push(`Range sementara ${fmt(lo)} - ${fmt(hi)} (masih terbentuk).`);
    return [{ ...base, status: 'TUNGGU', arah: 0, alasan, range: [lo, hi], pemicu: `Range selesai ${wib(d0 + re_ * HOUR)} WIB` }, res];
  }
  if (jam >= ee) return [{ ...base, status: 'TUNGGU', arah: 0, alasan: [...alasan, 'Jendela entry hari ini sudah lewat.'], range: [lo, hi], pemicu: `Range berikutnya mulai ${wib(d0 + DAY)} WIB` }, res];
  if (!hari.pemicu || !Object.keys(hari.pemicu).length) return [{ ...base, status: 'TUNGGU', arah: 0, alasan: [...alasan, hari.alasan || 'Range tidak memenuhi syarat.'], range: [lo, hi], pemicu: 'Range hari ini dilewati' }, res];
  const a = hari.atr, buf = +p.bo_buf * a, sisi = [], sudah = new Set(Object.keys(hari.diambil || {}));
  for (const d of [1, -1]) {
    if (sudah.has(String(d))) continue;
    const trig = d > 0 ? hi + buf : lo - buf, slx = d > 0 ? lo - buf : hi + buf, ds = (trig - slx) * d;
    const R0 = Math.min(Math.max(ds, p.sl_min_atr * a), p.sl_max_atr * a), lt = hitungLot(setelan, sym, R0, pengali);
    sisi.push({ arah: d, entry: trig, sl: trig - d * R0, r0: R0, tp: tpDari(trig, d, R0), tren_ok: tren[d],
      layer: rencanaLayer(trig, d, a, R0, p, lotOf(lt)), lot: lt, pemicu: `Candle M5 close ${d > 0 ? 'di atas' : 'di bawah'} ${fmt(trig)} (range ${fmt(lo)}-${fmt(hi)} + buffer)` });
  }
  const boleh = sisi.filter(s => s.tren_ok);
  if (!boleh.length) {
    alasan.push('Filter tren EMA50/200 H1 tidak mengizinkan sisi yang tersisa.');
    return [{ ...base, status: 'TUNGGU', arah: 0, alasan, range: [lo, hi], sisi, pemicu: 'Tunggu tren H1 searah' }, res];
  }
  const utama = boleh.reduce((x, y) => (Math.abs(y.entry - px) < Math.abs(x.entry - px) ? y : x));
  const lain = boleh.filter(s => s !== utama);
  return [{ ...base, status: 'SIAP', arah: utama.arah, entry: utama.entry, sl: utama.sl, r0: utama.r0, tp: utama.tp, layer: utama.layer, lot: utama.lot,
    pemicu: utama.pemicu, jenis_entry: utama.arah > 0 ? 'Buy stop' : 'Sell stop', range: [lo, hi], jarak_atr: a ? Math.abs(utama.entry - px) / a : 0,
    alternatif: lain.map(s => ({ jenis: 'sisi lain', harga: s.entry, pemicu: s.pemicu, sl: s.sl })),
    trailing: `Trailing ${fg(p.trail_atr)} x ATR H1 mulai +${fg(p.trail_start_r)}R; tutup ${wib(d0 + ex * HOUR)} WIB`,
    berlaku: `Sampai ${wib(d0 + ee * HOUR)} WIB`, alasan }, res];
}

function kandidatSqueeze(P, sa, sym, px, setelan, pengali) {
  const sid = sa.sid, p = sa.params;
  const res = jalankanStrategi(P, sid, p, SIMBOL[sym].biaya_pct, 1600);
  if (!res) return [null, null];
  const S = res.S, D = S.D, I = S.I, L = D.c.length - 1, a = I.atr[L];
  const base = { sid, nama: sa.nama || NAMA[sid] || sid, famili: 'squeeze', tf: p.tf, atr: a, grade: sa.grade || 'C', params: p };
  const op = res.open, frs = res.fresh, sla = +p.sl_atr, tpa = +p.tp_atr;
  if (op) {
    const d = op.d, lt = hitungLot(setelan, sym, op.R0, pengali);
    return [{ ...base, status: 'AKTIF', arah: d, entry: op.e, sl: op.sl, r0: op.R0, tp: [op.e + d * op.R0, op.tp, op.tp + d * op.R0], lot: lt, t_sinyal: op.t,
      layer: [{ ke: 1, harga: op.e, lot: lotOf(lt), jenis: 'Terisi', sl_basket: op.sl }], maju_r: (px - op.e) * d / op.R0, pemicu: 'Sudah masuk',
      jenis_entry: 'berjalan', trailing: `SL/TP tetap (${fg(sla)} / ${fg(tpa)} x ATR)`, alasan: ['Breakout squeeze sedang berjalan.'] }, res];
  }
  if (frs) {
    const d = frs.d, R0 = sla * a, lt = hitungLot(setelan, sym, R0, pengali);
    return [{ ...base, status: 'MASUK', arah: d, entry: px, sl: px - d * R0, r0: R0, tp: [px + d * R0, px + d * tpa * a, px + d * (tpa + 1) * a], lot: lt, t_sinyal: frs.t,
      layer: [{ ke: 1, harga: px, lot: lotOf(lt), jenis: 'Entry', sl_basket: px - d * R0 }], pemicu: 'Masuk sekarang', jenis_entry: 'market', trailing: 'SL/TP tetap',
      alasan: ['Bandwidth Bollinger menyempit lalu candle 1H close di luar band.'] }, res];
  }
  let bwMin = Infinity; for (let i = Math.max(0, S.bw.length - Math.trunc(p.bw_look)); i < S.bw.length; i++) if (!Number.isNaN(S.bw[i])) bwMin = Math.min(bwMin, S.bw[i]);
  const sq = !!S.sq[L] || S.bw[L] <= p.bw_mult * bwMin;
  if (!sq) return [{ ...base, status: 'TUNGGU', arah: 0, pemicu: 'Belum ada squeeze', alasan: ['Bandwidth belum menyempit.'] }, res];
  const up = S.up[L], lo = S.lo[L], d = Math.abs(up - px) <= Math.abs(px - lo) ? 1 : -1, e = d > 0 ? up : lo, R0 = sla * a, lt = hitungLot(setelan, sym, R0, pengali);
  return [{ ...base, status: 'SIAP', arah: d, entry: e, sl: e - d * R0, r0: R0, tp: [e + d * R0, e + d * tpa * a, e + d * (tpa + 1) * a], lot: lt,
    layer: [{ ke: 1, harga: e, lot: lotOf(lt), jenis: 'Entry', sl_basket: e - d * R0 }], pemicu: `Candle 1H close di luar band (${fmt(lo)} / ${fmt(up)})`,
    jenis_entry: 'Tunggu close', jarak_atr: a ? Math.abs(e - px) / a : 0, trailing: 'SL/TP tetap',
    alternatif: [{ jenis: 'sisi lain', harga: d > 0 ? lo : up, pemicu: 'Close di luar band sisi lain' }], alasan: ['Bollinger squeeze aktif: menunggu arah pecah.'] }, res];
}

function kandidatRencana(P, sa, sym, px, setelan, pengali) {
  if (sa.famili === 'trend') return kandidatTrend(P, sa, sym, px, setelan, pengali);
  if (sa.famili === 'sesi') return kandidatSesi(P, sa, sym, px, setelan, pengali);
  if (sa.famili === 'squeeze') return kandidatSqueeze(P, sa, sym, px, setelan, pengali);
  return [null, null];
}

/** Mutu setup (0-100): grade lab + forward-test + kesepakatan prediksi + rezim. */
function kualitas(k, fwd, ramalan, rz) {
  let s = { A: 78, B: 66, C: 54 }[k.grade] || 42;
  if (fwd && (fwd.n || 0) >= 10 && fwd.pf != null) s += Math.max(-15, Math.min(10, (fwd.pf - 1) * 10));
  if (ramalan && ramalan.length && k.arah) s += Math.max(-8, Math.min(8, (ramalan[0].p_naik - 50) * k.arah / 2));
  if (rz && rz.vol_kode === 'ekstrem' && k.grade !== 'A') s -= 15;
  return Math.max(0, Math.min(100, s));
}
function skorRencana(k, fwd, ramalan, rz) {
  let s = kualitas(k, fwd, ramalan, rz);
  s += { AKTIF: 30, MASUK: 25, SIAP: 0, TUNGGU: -40 }[k.status] ?? -40;
  if (k.status === 'SIAP') s += Math.max(0, 10 - 3 * +(k.jarak_atr || 0));
  return s;
}
const labelYakin = q => (q >= 76 ? 'Tinggi' : q >= 62 ? 'Sedang' : 'Rendah');

function susunRencana(P, sym, mode, aktif, setelan, kb, ramalan, fwdStats, px) {
  const rz = (kb || {}).rezim || {}, pengali = +(rz.pengali_risiko || 1.0), calon = [], hasil = {};
  for (const sa of aktif) {
    let k, res;
    try { [k, res] = kandidatRencana(P, sa, sym, px, setelan, pengali); }
    catch (e) { k = { sid: sa.sid, nama: sa.nama, status: 'TUNGGU', arah: 0, alasan: [`Galat: ${teksGalat(e)}`], grade: sa.grade }; res = null; }
    if (!k) continue;
    k.statistik = statistikStrategi(sa.sid, sym, sa.metrik);
    // Batas risiko per strategi: DD 95% Monte Carlo (R) x risiko per posisi ≈ maks 20% saldo.
    const dd95 = (sa.metrik || {}).dd95;
    if (dd95 && k.r0 && k.lot) {
      const cap = 20.0 / dd95, dasar = +(setelan.risiko_pct || 1.0) * pengali;
      if (cap < dasar) {
        const lt = hitungLot(setelan, sym, k.r0, pengali * cap / dasar);
        if (lt) {
          lt.catatan = ((lt.catatan || '') + ` Risiko dibatasi ${fx(cap, 2)}% per posisi karena drawdown 95% Monte Carlo strategi ini ${fx(dd95)}R (target DD ±20% saldo).`).trim();
          k.lot = lt;
          for (const L of k.layer || []) L.lot = lt.lot;
          k.risiko_dibatasi = cap;
        }
      }
    }
    k.forward = fwdStats[sa.sid] || null;
    k.mutu = kualitas(k, k.forward, ramalan, rz);
    k.skor = skorRencana(k, k.forward, ramalan, rz);
    k.yakin = labelYakin(k.mutu);
    k.aksi = ((k.arah || 0) > 0 && k.status !== 'TUNGGU') ? 'BUY' : ((k.arah || 0) < 0 && k.status !== 'TUNGGU') ? 'SELL' : 'TUNGGU';
    calon.push(k);
    hasil[sa.sid] = res;
  }
  calon.sort((a, b) => b.skor - a.skor);
  return [{ sym, mode, utama: calon[0] || null, calon, pengali_risiko: pengali, t: now(), harga: px }, hasil];
}

/** Ringkasan siap salin (format MT5: titik desimal, tanpa pemisah ribuan). */
function teksOrder(sym, k) {
  if (!k || k.aksi === 'TUNGGU' || k.entry == null) return '';
  const dp = SIMBOL[sym].dp, f = v => (+v).toFixed(dp), lot = (k.lot || {}).lot;
  const b = [`${sym} ${k.aksi} (${k.nama}, ${k.status})`, `Entry: ${f(k.entry)} [${k.jenis_entry || ''}]`, `SL: ${f(k.sl)}`];
  (k.tp || []).forEach((t, i) => b.push(`TP${i + 1}: ${f(t)}`));
  for (const L of (k.layer || []).slice(1)) b.push(`Layer ${L.ke}: ${f(L.harga)}` + (L.lot ? ` lot ${L.lot}` : '') + (L.sl_basket ? ` (SL basket ${f(L.sl_basket)})` : ''));
  if (lot) b.push(`Lot per layer: ${lot}`);
  if (k.trailing) b.push(`Trailing: ${k.trailing}`);
  return b.join('\n');
}

// ================================================================== lab strategi otonom (lab.py)
// Data dibagi kronologis A (50%) / B (25%) / C (25%); wajib positif di semua segmen, 'dataran' parameter tetangga,
// sampel minimal, biaya selalu dihitung, hasil terlalu bagus dicurigai, uji siksa biaya 2x + Monte Carlo.
const MIN_N = { '15m': 150, '1h': 80, '4h': 40, '5m': 60 };

function batasSegmen(P, tf) {
  const D = P.bar(tf);
  if (D.t.length < 100) return null;
  const t0 = D.t[0], t1 = D.t[D.t.length - 1];
  return [t0 + (t1 - t0) * 0.5, t0 + (t1 - t0) * 0.75];
}
function nilaiLab(m, tf) {
  const seg = m.segmen || [], pf = m.pf || 0, pfs = seg.map(s => s.pf || 0), nseg = seg.map(s => s.n || 0);
  const minpf = pfs.length ? Math.min(...pfs) : 0, alasan = [], mn = MIN_N[tf] || 60;
  let lulus = true;
  if ((m.n || 0) < mn) { lulus = false; alasan.push(`sampel ${m.n || 0} < ${mn}`); }
  if (pf < 1.10) { lulus = false; alasan.push(`PF total ${fx(pf, 2)} < 1,10`); }
  if (nseg.some(n => n < 8)) { lulus = false; alasan.push('ada segmen dengan < 8 transaksi'); }
  if (minpf < 0.90) { lulus = false; alasan.push(`segmen terlemah PF ${fx(minpf, 2)} < 0,90`); }
  if ((m.wr || 0) > 90 && (m.dd || 0) < 2) { lulus = false; alasan.push('terlalu bagus (curiga bias)'); }
  const pen = Math.max(0, ((m.dd || 0) - 25) / 50);
  let skor = 0.35 * minpf + 0.25 * (pfs.length ? pfs[pfs.length - 1] : 0) + 0.25 * pf + 0.15 * Math.min(pf, 3) - pen;
  skor *= Math.min(1.0, Math.sqrt((m.n || 0) / mn));
  return [skor, lulus, alasan];
}
function gradeLab(m, nbr) {
  const pf = m.pf || 0, minpf = Math.min(...(m.segmen && m.segmen.length ? m.segmen : [{}]).map(s => s.pf || 0));
  let g = (pf >= 1.35 && minpf >= 1.10 && nbr >= 1.20) ? 'A' : (pf >= 1.20 && minpf >= 1.00 && nbr >= 1.05) ? 'B' : 'C';
  if ((m.dd95 || 0) > 30 || (m.kalah_beruntun || 0) >= 14) g = { A: 'B', B: 'C' }[g] || g;
  return g;
}
function kombinasi(sid, sym) {
  const base = preset(sid, sym), g = GRID[sid] || {}, keys = Object.keys(g), combos = [];
  const rek = (i, p) => { if (i === keys.length) { combos.push({ ...p }); return; } for (const v of g[keys[i]]) { p[keys[i]] = v; rek(i + 1, p); } };
  rek(0, { ...base });
  if (!combos.some(c => keys.every(k => c[k] === base[k]))) combos.push(base);
  return [combos, keys];
}
function tetangga(p, keys, grid, hasil) {
  const pfs = [];
  for (const k of keys) {
    const vals = grid[k], i = vals.indexOf(p[k]);
    if (i < 0) continue;
    for (const j of [i - 1, i + 1]) {
      if (j < 0 || j >= vals.length) continue;
      const r = hasil.get(kunciParam({ ...p, [k]: vals[j] }));
      if (r) pfs.push(r.metrik.pf || 0);
    }
  }
  return pfs.length ? median(pfs) : 0.0;
}
function ujiSatu(P, sid, p, sym, batas, kaliBiaya = 1.0, trades = false) {
  const res = jalankanStrategi(P, sid, p, SIMBOL[sym].biaya_pct * kaliBiaya);
  if (!res) return null;
  const m = metrik(res.trades, batas);
  return trades ? [m, res.trades] : m;
}
/** Uji siksa: biaya 2x harus tetap untung; Monte Carlo urutan transaksi untuk DD 95%. */
function stres(P, sid, p, sym, batas, rng) {
  const out = {}, m2 = ujiSatu(P, sid, p, sym, batas, 2.0);
  out.pf_biaya2 = (m2 || {}).pf ?? null;
  const r = ujiSatu(P, sid, p, sym, batas, 1.0, true);
  if (r) {
    const rs = r[1].map(t => t.r);
    if (rs.length >= 20) {
      const dds = [];
      for (let s = 0; s < 400; s++) {
        const pr = rng.acakUrut(rs);
        let eq = 0, pk = 0, dd = 0;
        for (const x of pr) { eq += x; pk = Math.max(pk, eq); dd = Math.max(dd, pk - eq); }
        dds.push(dd);
      }
      out.dd95 = kuantil(dds, 0.95);
    }
    let k = 0, mx = 0;
    for (const x of rs) { k = x <= 0 ? k + 1 : 0; mx = Math.max(mx, k); }
    out.kalah_beruntun = mx;
  }
  return out;
}

async function labSimbol(feed, sym, run, progres = null, eksplorasi = 14) {
  const [seri, skala, sumber] = feed.seri(sym), P = new Pasar(sym, seri, skala), rng = acak(run), ringkas = {};
  for (const mode of MODES) {
    const sids = BAWAAN[sym + '|' + mode], baris = [];
    for (const sid of sids) {
      const p0 = preset(sid, sym), tf = p0.tf, batas = batasSegmen(P, tf);
      if (!batas) continue;
      const [combos, keys] = kombinasi(sid, sym), hasil = new Map(), t0 = now();
      for (let i = 0; i < combos.length; i++) {
        const p = combos[i], m = ujiSatu(P, sid, p, sym, batas);
        if (m) { const [skor, lulus, alasan] = nilaiLab(m, tf); hasil.set(kunciParam(p), { p, metrik: m, skor, lulus, alasan }); }
        progres && progres(sym, mode, sid, i + 1, combos.length);
        await lega();
      }
      for (const h of hasil.values()) {
        h.nbr = tetangga(h.p, keys, GRID[sid] || {}, hasil);
        if (h.nbr < 1.05) { h.lulus = false; h.alasan = [...h.alasan, `tetangga median PF ${fx(h.nbr, 2)} < 1,05 (bukan dataran)`]; }
        h.skor = h.skor * 0.8 + 0.2 * h.nbr;
      }
      if (!hasil.size) continue;
      let best = [...hasil.values()].reduce((x, y) => ((y.lulus > x.lulus) || (y.lulus === x.lulus && y.skor > x.skor) ? y : x));
      // eksplorasi bebas: kombinasi acak di luar grid, hanya diambil bila jelas lebih baik DAN dataran
      const fam = p0.famili;
      let temuan = null;
      for (let e = 0; e < eksplorasi; e++) {
        const q = { ...p0 };
        for (const [k, vals] of Object.entries(JELAJAH[fam] || {})) if (k in q || fam === 'trend') q[k] = rng.pilih(vals);
        if (hasil.has(kunciParam(q))) continue;
        const m = ujiSatu(P, sid, q, sym, batas);
        await lega();
        if (!m) continue;
        const [skor, lulus] = nilaiLab(m, tf);
        if (!lulus || skor < best.skor * 1.05) continue;
        const nb = [];
        for (const [k, vals] of Object.entries(JELAJAH[fam] || {})) {
          const i = vals.indexOf(q[k]); if (i < 0) continue;
          for (const j of [i - 1, i + 1]) {
            if (j < 0 || j >= vals.length) continue;
            const mm = ujiSatu(P, sid, { ...q, [k]: vals[j] }, sym, batas);
            if (mm) nb.push(mm.pf || 0);
            await lega();
          }
        }
        const nbr = nb.length ? median(nb) : 0;
        if (nbr >= 1.10 && (temuan === null || skor > temuan.skor)) temuan = { p: q, metrik: m, skor: skor * 0.8 + 0.2 * nbr, lulus: true, alasan: [], nbr };
      }
      if (temuan && temuan.skor > best.skor * 1.03) {
        pikir(sym, 'eksplorasi', `${sym} ${MODE[mode].judul}: eksplorasi menemukan varian ${NAMA[sid]} yang lebih kuat dan tetap dataran — ` +
          `PF ${fmt(temuan.metrik.pf)} (tetangga ${fmt(temuan.nbr)}), ${temuan.metrik.n} transaksi. Dipakai menggantikan varian grid.`, { p: temuan.p });
        best = temuan;
      }
      const sx = stres(P, sid, best.p, sym, batas, acak((run % 4294967296) + 7));
      best.metrik = { ...best.metrik, ...sx };
      if (best.lulus && (sx.pf_biaya2 || 0) < 1.0) { best.lulus = false; best.alasan = [...best.alasan, `tidak tahan biaya 2x (PF ${fx(sx.pf_biaya2 || 0, 2)})`]; }
      const m = best.metrik, grade = best.lulus ? gradeLab(m, best.nbr || 0) : 'D';
      const seg = (m.segmen || []).map(s => fmt(s.pf || 0)).join('/');
      baris.push({ sid, famili: fam, nama: NAMA[sid], params: best.p, grade, lulus: best.lulus, skor: best.skor, metrik: { ...m, nbr: best.nbr || 0 }, diuji: hasil.size, detik: (now() - t0) / 1000 });
      const lulusN = [...hasil.values()].filter(h => h.lulus).length;
      const isi = best.lulus
        ? `${sym} ${MODE[mode].judul}: ${hasil.size} variasi ${NAMA[sid]} diuji (${sumber}). ${lulusN} lolos. Terbaik PF ${fmt(m.pf)} (segmen A/B/C ${seg}), ` +
          `${m.n} transaksi, WR ${fx(m.wr)}%, tetangga ${fmt(best.nbr || 0)}, biaya 2x PF ${fmt(m.pf_biaya2 || 0)}, DD 95% Monte Carlo ${fmt(m.dd95 || 0, 1)}R, ` +
          `kalah beruntun maks ${m.kalah_beruntun ?? '-'} → grade ${grade}.`
        : `${sym} ${MODE[mode].judul}: ${NAMA[sid]} tidak lolos (${best.alasan.slice(0, 3).join('; ')}). Terbaik PF ${fmt(m.pf || 0)} (segmen ${seg}). Hanya dipakai sebagai referensi.`;
      pikir(sym, 'lab', isi, { sid, p: best.p });
    }
    // pilih set aktif
    baris.sort((x, y) => (y.lulus - x.lulus) || (y.skor - x.skor));
    const lama = {};
    for (const r of TBL.strategi) if (r.sym === sym && r.mode === mode) lama[r.sid] = r.grade;
    TBL.strategi = TBL.strategi.filter(r => !(r.sym === sym && r.mode === mode));
    const adaLulus = baris.some(x => x.lulus);
    baris.forEach((b, i) => {
      let status = (b.lulus && i < 3) ? 'aktif' : (b.lulus ? 'cadangan' : 'gugur');
      if (!adaLulus && i === 0) status = 'referensi';
      TBL.strategi.push({ sym, mode, sid: b.sid, famili: b.famili, nama: b.nama, params: b.params, grade: b.grade, status, metrik: b.metrik, t: now() });
      if (lama[b.sid] && lama[b.sid] !== b.grade) pikir(sym, 'promosi', `${sym} ${MODE[mode].judul}: grade ${b.nama} berubah ${lama[b.sid]} → ${b.grade}.`);
    });
    TBL_KOTOR.add('strategi');
    if (!adaLulus) pikir(sym, 'lab', `${sym} ${MODE[mode].judul}: tidak ada strategi yang lolos semua uji. Rencana tetap ditampilkan sebagai referensi dengan keyakinan rendah; disarankan tidak entry besar.`);
    ringkas[mode] = baris.map(b => ({ sid: b.sid, grade: b.grade, lulus: b.lulus, skor: b.skor }));
    // akurasi prediksi walk-forward
    try {
      const ak = await akurasiHistoris(P, mode);
      kvSet(`akurasi:${sym}:${mode}`, ak);
      for (const [label, a] of Object.entries(ak)) {
        pikir(sym, 'prediksi', `${sym} prediksi ${label}: akurasi arah walk-forward ${fx(a.arah)}% dari ${a.n} titik` +
          (a.yakin != null ? `, saat yakin ${fx(a.yakin)}% (${a.yakin_n} titik)` : '') + `, harga jatuh di rentang 80% sebanyak ${fx(a.band80)}%.`);
      }
    } catch (e) { pikir(sym, 'galat', `Akurasi prediksi gagal: ${teksGalat(e)}`); }
  }
  return ringkas;
}

/** Strategi yang dipakai rencana: hasil lab (aktif/referensi/dipantau), atau preset teruji bila lab belum pernah jalan. */
function strategiAktif(sym, mode) {
  const r = TBL.strategi.filter(x => x.sym === sym && x.mode === mode && ['aktif', 'referensi', 'dipantau'].includes(x.status));
  if (r.length) {
    return r.map(x => ({ sid: x.sid, famili: x.famili, nama: x.nama, params: x.params, grade: x.grade, status: x.status, metrik: x.metrik }))
      .sort((a, b) => ({ A: 0, B: 1, C: 2 }[a.grade] ?? 3) - ({ A: 0, B: 1, C: 2 }[b.grade] ?? 3));
  }
  return BAWAAN[sym + '|' + mode].map(sid => { const p = preset(sid, sym); return { sid, famili: p.famili, nama: NAMA[sid], params: p, grade: 'B', status: 'preset', metrik: null }; });
}
function semuaStrategi(sym) {
  return TBL.strategi.filter(x => x.sym === sym).sort((a, b) => a.mode.localeCompare(b.mode)).map(x => {
    const m = x.metrik || {};
    return { mode: x.mode, sid: x.sid, nama: x.nama, grade: x.grade, status: x.status, t: x.t, params: x.params, pf: m.pf, wr: m.wr, n: m.n, avg: m.avg, dd: m.dd,
      segmen: (m.segmen || []).map(s => s.pf), nbr: m.nbr, tp_peluang: m.tp_peluang, rata_layer: m.rata_layer, tahunan: m.tahunan, alasan: m.alasan,
      pf_biaya2: m.pf_biaya2, dd95: m.dd95, kalah_beruntun: m.kalah_beruntun };
  });
}
/** Turunkan strategi aktif yang buruk di forward-test. */
function cekForward(fwdBySym) {
  for (const [sym, perMode] of Object.entries(fwdBySym)) for (const [mode, stats] of Object.entries(perMode)) for (const [sid, s] of Object.entries(stats)) {
    if ((s.n || 0) < 12 || s.pf == null) continue;
    const r = TBL.strategi.find(x => x.sym === sym && x.mode === mode && x.sid === sid);
    if (!r) continue;
    if (s.pf < 0.7 && s.n >= 20 && r.status !== 'gugur') {
      r.status = 'gugur'; TBL_KOTOR.add('strategi');
      pikir(sym, 'forward', `${sym} ${sid}: forward-test ${s.n} sinyal PF ${fmt(s.pf)} → digugurkan; lab akan mencari pengganti.`);
      kvSet('lab_minta', now());
    } else if (s.pf < 0.8 && r.status === 'aktif') {
      r.status = 'dipantau'; TBL_KOTOR.add('strategi');
      pikir(sym, 'forward', `${sym} ${sid}: forward-test ${s.n} sinyal PF ${fmt(s.pf)} → status dipantau (bobot turun).`);
    }
  }
}
// ================================================================== price action (pa.py)
// Deteksi pola pada candle TERTUTUP (kausal: bar i hanya memakai bar <= i) dan evaluasi hasilnya ke depan.
const POLA = {
  pin: 'Pin bar', engulf: 'Engulfing', inside: 'Inside bar breakout', bos: 'Break of structure',
  choch: 'Change of character', sweep: 'Sapu likuiditas', retest: 'Retest level tembus', momentum: 'Candle momentum',
};
const POLA_URUT = Object.keys(POLA);
const SINGKAT = { pin: 'PB', engulf: 'EG', inside: 'IB', bos: 'BOS', choch: 'CH', sweep: 'SW', retest: 'RT', momentum: 'MO' };
const K_TP = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 2.5, 3.0, 4.0];
const NK = K_TP.length;
const TF_BELAJAR = ['5m', '15m', '1h', '4h'];
const HORIZON = { '5m': 36, '15m': 32, '1h': 36, '4h': 30 };     // 3 jam / 8 jam / 1,5 hari / 5 hari
const TF_ATAS = { '5m': '1h', '15m': '1h', '1h': '4h', '4h': '1d' };
const VOL = ['tenang', 'normal', 'tinggi', 'ekstrem'];
const FRAKTAL = 2, R_MIN = 0.5, R_MAKS = 2.5, R_MAKS_POLA = 4.0, LOKASI_ATR = 0.35;
const DIJEPIT = new Set(['bos', 'choch', 'momentum']);
const LEVEL_NAMA = ['', 'swing high', 'swing low', 'PDH', 'PDL', 'PWH', 'PWL', 'mother bar', 'level tembus'];
const SESI_URUT = SESI.map(s => s[0]);

function sesiDari(t) { const j = jamUtc(t); for (const [nama, a, b] of SESI) if (a <= j && j < b) return nama; return SESI[SESI.length - 1][0]; }

/** Level periode sebelumnya per bar (PDH/PDL harian, atau PWH/PWL mingguan) + ADR20 + range berjalan periode ini. */
function levelPeriode(D, minggu = false) {
  const t = D.t, h = D.h, l = D.l, n = t.length, nama = minggu ? ['PWH', 'PWL'] : ['PDH', 'PDL'];
  const atas = penuhNaN(n), bawah = penuhNaN(n), kunci = new Int32Array(n), adrA = penuhNaN(n), runH = F64(n), runL = F64(n);
  if (!n) return { atas, bawah, kunci, nama, adr: adrA, run_h: runH, run_l: runL };
  const per = i => { const hr = Math.floor(t[i] / DAY); return minggu ? Math.floor((hr + 3) / 7) : hr; };
  const gh = [], gl = [], awal = [];
  let g = -1, pPrev = null;
  for (let i = 0; i < n; i++) {
    const p = per(i);
    if (p !== pPrev) { g++; awal.push(i); gh.push(h[i]); gl.push(l[i]); pPrev = p; runH[i] = h[i]; runL[i] = l[i]; }
    else { gh[g] = Math.max(gh[g], h[i]); gl[g] = Math.min(gl[g], l[i]); runH[i] = Math.max(runH[i - 1], h[i]); runL[i] = Math.min(runL[i - 1], l[i]); }
    kunci[i] = g;
  }
  const G = gh.length, cs = new Float64Array(G + 1), adrG = penuhNaN(G);
  for (let k = 0; k < G; k++) cs[k + 1] = cs[k] + (gh[k] - gl[k]);
  for (let k = 20; k < G; k++) adrG[k] = (cs[k] - cs[k - 20]) / 20;
  for (let i = 0; i < n; i++) { const k = kunci[i]; if (k > 0) { atas[i] = gh[k - 1]; bawah[i] = gl[k - 1]; } adrA[i] = adrG[k]; }
  return { atas, bawah, kunci, nama, adr: adrA, run_h: runH, run_l: runL };
}

/** D: candle TERTUTUP. A: ATR. Kembalikan [kejadian (bar >= mulai), keadaan akhir (struktur & swing)]. */
function deteksi(D, A, mulai = 0, lv = null, bulat = null) {
  const t = D.t, o = D.o, h = D.h, l = D.l, c = D.c, n = c.length, k = FRAKTAL;
  const sh = [], sl = [];                 // [indeks, harga, tembus, disapu]
  let st = 0, retest = [];
  const dipakai = new Set(), out = [], warm = 6;
  const jarakLevel = (x, d, i) => {
    const cand = (d > 0 ? sl : sh).slice(-3).map(z => z[1]);
    if (lv) cand.push(d > 0 ? lv.bawah[i] : lv.atas[i]);
    if (bulat) cand.push(Math.floor(x / bulat) * bulat, Math.ceil(x / bulat) * bulat);
    let m = 1e18; for (const z of cand) if (z === z) m = Math.min(m, Math.abs(x - z));
    return m;
  };
  for (let i = 2 * k; i < n; i++) {
    const s = i - k;
    let mx = -Infinity, mxL = -Infinity, mn = Infinity, mnL = Infinity;
    for (let j = s - k; j <= i; j++) { if (h[j] > mx) mx = h[j]; if (l[j] < mn) mn = l[j]; }
    for (let j = s - k; j < s; j++) { if (h[j] > mxL) mxL = h[j]; if (l[j] < mnL) mnL = l[j]; }
    if (h[s] >= mx && h[s] > mxL) { sh.push([s, h[s], false, false]); if (sh.length > 8) sh.shift(); }
    if (l[s] <= mn && l[s] < mnL) { sl.push([s, l[s], false, false]); if (sl.length > 8) sl.shift(); }
    const a = A[i - 1];
    if (i < warm || !(a > 0)) continue;
    const st0 = st, oi = o[i], hi = h[i], li = l[i], ci = c[i], rng = hi - li, body = Math.abs(ci - oi);
    const uw = hi - Math.max(oi, ci), lw = Math.min(oi, ci) - li;
    let ev = [];
    const H = (sh.length && !sh[sh.length - 1][2]) ? sh[sh.length - 1] : null;
    const L = (sl.length && !sl[sl.length - 1][2]) ? sl[sl.length - 1] : null;
    // ---- struktur: BOS / CHoCH ----
    if (H && ci > H[1]) {
      H[2] = true;
      const ref = sl.length ? sl[sl.length - 1][1] : li;
      ev.push([st >= 0 ? 'bos' : 'choch', 1, ref - 0.1 * a, 'swing high', H[1]]);
      retest.push([H[1], 1, i, i + 12]); st = 1;
    } else if (L && ci < L[1]) {
      L[2] = true;
      const ref = sh.length ? sh[sh.length - 1][1] : hi;
      ev.push([st <= 0 ? 'bos' : 'choch', -1, ref + 0.1 * a, 'swing low', L[1]]);
      retest.push([L[1], -1, i, i + 12]); st = -1;
    }
    if (rng > 0) {
      // ---- sapu likuiditas swing ----
      if (H && !H[2] && !H[3] && hi > H[1] && ci < H[1] && uw >= 0.35 * rng) { H[3] = true; ev.push(['sweep', -1, hi + 0.1 * a, 'swing high', H[1]]); }
      if (L && !L[2] && !L[3] && li < L[1] && ci > L[1] && lw >= 0.35 * rng) { L[3] = true; ev.push(['sweep', 1, li - 0.1 * a, 'swing low', L[1]]); }
      // ---- sapu level periode (PDH/PDL atau PWH/PWL), sekali per periode ----
      if (lv) {
        let X = lv.atas[i];
        if (X === X && hi > X && ci < X && uw >= 0.35 * rng && !dipakai.has(lv.kunci[i] + '|1')) {
          dipakai.add(lv.kunci[i] + '|1');
          ev = ev.filter(e => !(e[0] === 'sweep' && e[1] === -1));
          ev.push(['sweep', -1, hi + 0.1 * a, lv.nama[0], X]);
        }
        X = lv.bawah[i];
        if (X === X && li < X && ci > X && lw >= 0.35 * rng && !dipakai.has(lv.kunci[i] + '|-1')) {
          dipakai.add(lv.kunci[i] + '|-1');
          ev = ev.filter(e => !(e[0] === 'sweep' && e[1] === 1));
          ev.push(['sweep', 1, li - 0.1 * a, lv.nama[1], X]);
        }
      }
      // ---- pin bar di ekstrem lokal ----
      if (rng >= 0.7 * a) {
        let mn5 = Infinity, mx5 = -Infinity;
        for (let j = i - 5; j < i; j++) { if (l[j] < mn5) mn5 = l[j]; if (h[j] > mx5) mx5 = h[j]; }
        if (lw >= 2 * body && lw >= 0.55 * rng && ci >= li + 0.6 * rng && li <= mn5) ev.push(['pin', 1, li - 0.1 * a, '', null]);
        else if (uw >= 2 * body && uw >= 0.55 * rng && ci <= hi - 0.6 * rng && hi >= mx5) ev.push(['pin', -1, hi + 0.1 * a, '', null]);
      }
    }
    // ---- engulfing di ekstrem lokal ----
    const b1 = Math.abs(c[i - 1] - o[i - 1]);
    if (body >= 0.5 * a && body > b1) {
      let mn4 = Infinity, mx4 = -Infinity;
      for (let j = i - 5; j < i - 1; j++) { if (l[j] < mn4) mn4 = l[j]; if (h[j] > mx4) mx4 = h[j]; }
      if (ci > oi && c[i - 1] < o[i - 1] && ci > o[i - 1] && oi <= c[i - 1] + 0.05 * a && Math.min(li, l[i - 1]) <= mn4)
        ev.push(['engulf', 1, Math.min(li, l[i - 1]) - 0.1 * a, '', null]);
      else if (ci < oi && c[i - 1] > o[i - 1] && ci < o[i - 1] && oi >= c[i - 1] - 0.05 * a && Math.max(hi, h[i - 1]) >= mx4)
        ev.push(['engulf', -1, Math.max(hi, h[i - 1]) + 0.1 * a, '', null]);
    }
    // ---- inside bar breakout ----
    const m = i - 2, ib = i - 1;
    if (h[ib] <= h[m] && l[ib] >= l[m] && (h[m] - l[m]) >= 0.6 * a) {
      if (ci > h[m]) ev.push(['inside', 1, l[ib] - 0.1 * a, 'mother bar', h[m]]);
      else if (ci < l[m]) ev.push(['inside', -1, h[ib] + 0.1 * a, 'mother bar', l[m]]);
    }
    // ---- retest level yang baru ditembus ----
    const sisa = [];
    for (const r of retest) {
      const [X, d, b, kd] = r;
      if (i <= b) { sisa.push(r); continue; }
      if (i > kd) continue;
      if (d > 0) {
        if (ci < X - 0.5 * a) continue;
        if (li <= X + 0.25 * a && ci > X && ci > oi) { ev.push(['retest', 1, Math.min(li, X) - 0.15 * a, 'level tembus', X]); continue; }
      } else {
        if (ci > X + 0.5 * a) continue;
        if (hi >= X - 0.25 * a && ci < X && ci < oi) { ev.push(['retest', -1, Math.max(hi, X) + 0.15 * a, 'level tembus', X]); continue; }
      }
      sisa.push(r);
    }
    retest = sisa.slice(-6);
    // ---- candle momentum ----
    if (body >= 1.8 * a && rng > 0) {
      if (ci > oi && ci >= hi - 0.2 * rng) ev.push(['momentum', 1, (oi + ci) / 2 - 0.1 * a, '', null]);
      else if (ci < oi && ci <= li + 0.2 * rng) ev.push(['momentum', -1, (oi + ci) / 2 + 0.1 * a, '', null]);
    }
    if (i < mulai || !ev.length) continue;
    const seen = new Set();
    for (const [pola, d, slx, lvn, lvh] of ev) {
      if (seen.has(pola + d)) continue;
      seen.add(pola + d);
      const jarak = (ci - slx) * d;
      let R;
      if (DIJEPIT.has(pola)) R = Math.min(Math.max(jarak, R_MIN * a), R_MAKS * a);
      else if (jarak > R_MAKS_POLA * a) continue;
      else R = Math.max(jarak, R_MIN * a);
      const x = d > 0 ? li : hi;
      out.push({ i, t: t[i], pola, arah: d, harga: ci, sl: ci - d * R, r: R, atr: a, level: lvn, level_harga: lvh, struktur: st0 * d,
        lokasi: jarakLevel(x, d, i) <= LOKASI_ATR * a ? 1 : 0 });
    }
  }
  const keadaan = { struktur: st, swing_high: sh.slice(-3).map(z => [t[z[0]], z[1], z[2]]), swing_low: sl.slice(-3).map(z => [t[z[0]], z[1], z[2]]) };
  return [out, keadaan];
}

/** Arah TF atas (close vs EMA50 candle TF atas yang SUDAH tutup) dipetakan ke tiap bar D. */
function arahAtas(P, tf, D) {
  const ta = TF_ATAS[tf], n = D.t.length;
  const nA = n ? Math.trunc((D.t[n - 1] - D.t[0]) / TF_MS[ta]) + 260 : null;
  const [Dh, dh] = arahHt(P, ta, 'ema50', nA);
  if (!Dh.t.length) return penuhNaN(n);
  return petakan(D.t, Dh.t, TF_MS[ta], dh)[0];
}

/** Konteks tiap kejadian: sesi, volatilitas (persentil ATR 500 bar), tren TF atas relatif arah, pemakaian ADR. */
function konteks(D, A, evs, arahTfAtas = null, lv = null) {
  for (const e of evs) {
    const i = e.i;
    e.sesi = sesiDari(e.t);
    const w0 = Math.max(0, i - 500), len = i - w0;
    let pct = 50.0;
    if (len > 50) { let k = 0; const x = A[i - 1]; for (let j = w0; j < i; j++) if (A[j] < x) k++; pct = k / len * 100; }
    e.vol = pct < 25 ? 0 : pct < 75 ? 1 : pct < 92 ? 2 : 3;
    const v = arahTfAtas ? arahTfAtas[i] : NaN;
    e.tren = v === v ? tanda(v) * e.arah : 0;
    e.adr = (lv && lv.adr[i] === lv.adr[i] && lv.adr[i] > 0) ? (lv.run_h[i] - lv.run_l[i]) / lv.adr[i] : null;
  }
  return evs;
}
const adrKode = x => (x == null || x !== x) ? -1 : x < 0.5 ? 0 : x < 0.9 ? 1 : 2;

/** Hasil kejadian di bar i. Entry = open bar i+1, SL tetap, horizon H. sk = skala harga candle (proxy XAU). */
function evaluasiPA(O, Hh, L, C, i, sl, d, H, biaya, sk = 1) {
  const n = C.length, j0 = i + 1;
  if (j0 >= n) return { status: 'menunggu' };
  const e = O[j0] * sk, R = (e - sl) * d;
  if (R <= 0) return { status: 'batal', entry: e };
  let mfe = 0, mae = 0, barMfe = 0, kena = false, rAkhir = null, jx = null;
  const akhir = Math.min(n - 1, i + H);
  for (let j = j0; j <= akhir; j++) {
    const hj = Hh[j] * sk, lj = L[j] * sk, oj = O[j] * sk;
    let f, a;
    if (d > 0) {
      if (lj <= sl) { kena = true; jx = j; rAkhir = oj < sl ? (oj - e) / R : -1.0; break; }
      f = (hj - e) / R; a = (e - lj) / R;
    } else {
      if (hj >= sl) { kena = true; jx = j; rAkhir = oj > sl ? (e - oj) / R : -1.0; break; }
      f = (e - lj) / R; a = (hj - e) / R;
    }
    if (f > mfe) { mfe = f; barMfe = j - i; }
    if (a > mae) mae = a;
  }
  const selesai = kena || (i + H <= n - 1);
  if (selesai && !kena) { jx = i + H; rAkhir = (C[jx] * sk - e) * d / R; }
  return { status: selesai ? 'selesai' : 'berjalan', entry: e, r_awal: R, mfe, mae: kena ? Math.max(mae, 1.0) : mae, kena_sl: kena ? 1 : 0,
    r_akhir: rAkhir, bar_mfe: barMfe, bar_selesai: jx == null ? null : jx - i, biaya_r: biaya * e / R };
}

// ================================================================== gudang kejadian (pengganti tabel pa_kejadian)
const STATUS_PA = ['menunggu', 'berjalan', 'selesai', 'batal', 'kedaluwarsa'];
const ST_KODE = Object.fromEntries(STATUS_PA.map((s, i) => [s, i]));
const PA_F = ['t', 'harga', 'sl', 'r', 'atr', 'level_harga', 'adr', 'skala', 'entry', 'r_awal', 'mfe', 'mae', 'r_akhir', 'biaya_r', 't_selesai'];
const PA_I = ['pola', 'arah', 'level', 'struktur', 'tren', 'lokasi', 'vol', 'sesi', 'sumber', 'status', 'kena_sl', 'bar_mfe', 'bar_selesai', 'disarankan'];
const PA_BARIS = ['t', 'pola', 'arah', 'harga', 'sl', 'r', 'atr', 'level', 'level_harga', 'struktur', 'tren', 'lokasi', 'vol', 'sesi', 'adr', 'skala',
  'status', 'entry', 'r_awal', 'mfe', 'mae', 'kena_sl', 'r_akhir', 'bar_mfe', 'bar_selesai', 'biaya_r', 't_selesai', 'disarankan'];
const nanAtau = x => (x == null ? NaN : x);

class Gudang {
  constructor(sym, tf) {
    this.sym = sym; this.tf = tf; this.n = 0; this.cap = 0;
    for (const k of PA_F) this[k] = new Float64Array(0);
    for (const k of PA_I) this[k] = new Int16Array(0);
    this.kunci = new Set(); this.saran = new Map(); this.nSelesai = 0; this.akhirSelesai = -1; this.ver = 0;
  }
  _pastikan(cap) {
    if (cap <= this.cap) return;
    const c = Math.max(cap, Math.ceil(this.cap * 1.5) + 1024);
    for (const k of PA_F) { const a = new Float64Array(c); a.set(this[k].subarray(0, this.n)); this[k] = a; }
    for (const k of PA_I) { const a = new Int16Array(c); a.set(this[k].subarray(0, this.n)); this[k] = a; }
    this.cap = c;
  }
  /** Tambah kejadian e (+ hasil h). Kembalikan indeks, atau -1 bila sudah ada (INSERT OR IGNORE). */
  tambah(e, h, sumber, skala) {
    const kk = e.t + '|' + e.pola + '|' + e.arah;
    if (this.kunci.has(kk)) return -1;
    this.kunci.add(kk);
    this._pastikan(this.n + 1);
    const i = this.n++;
    this.t[i] = e.t; this.pola[i] = Math.max(0, POLA_URUT.indexOf(e.pola)); this.arah[i] = e.arah;
    this.harga[i] = e.harga; this.sl[i] = e.sl; this.r[i] = e.r; this.atr[i] = e.atr;
    this.level[i] = Math.max(0, LEVEL_NAMA.indexOf(e.level || '')); this.level_harga[i] = nanAtau(e.level_harga);
    this.struktur[i] = e.struktur || 0; this.tren[i] = e.tren || 0; this.lokasi[i] = e.lokasi || 0; this.vol[i] = e.vol || 0;
    this.sesi[i] = Math.max(0, SESI_URUT.indexOf(e.sesi)); this.adr[i] = nanAtau(e.adr); this.skala[i] = skala;
    this.sumber[i] = sumber === 'maju' ? 1 : 0; this.disarankan[i] = 0;
    this.setHasil(i, h || { status: 'menunggu' });
    this.ver++;
    return i;
  }
  setHasil(i, h) {
    const lama = this.status[i], baru = ST_KODE[h.status];
    this.status[i] = baru;
    this.entry[i] = nanAtau(h.entry); this.r_awal[i] = nanAtau(h.r_awal); this.mfe[i] = nanAtau(h.mfe); this.mae[i] = nanAtau(h.mae);
    this.kena_sl[i] = h.kena_sl == null ? -1 : h.kena_sl; this.r_akhir[i] = nanAtau(h.r_akhir);
    this.bar_mfe[i] = h.bar_mfe == null ? -1 : h.bar_mfe; this.bar_selesai[i] = h.bar_selesai == null ? -1 : h.bar_selesai;
    this.biaya_r[i] = nanAtau(h.biaya_r);
    this.t_selesai[i] = (h.status === 'selesai' && h.bar_selesai != null) ? this.t[i] + (h.bar_selesai + 1) * TF_MS[this.tf] : NaN;
    if (baru === 2 && lama !== 2) { this.nSelesai++; this.akhirSelesai = Math.max(this.akhirSelesai, i); }
    this.ver++;
  }
  tambahBaris(row) {
    const o = {}; PA_BARIS.forEach((k, j) => { o[k] = row[j]; });
    const kk = o.t + '|' + POLA_URUT[o.pola] + '|' + o.arah;
    if (this.kunci.has(kk)) return -1;
    this.kunci.add(kk);
    this._pastikan(this.n + 1);
    const i = this.n++;
    for (const k of PA_BARIS) this[k][i] = o[k] == null ? (PA_F.includes(k) ? NaN : -1) : o[k];
    this.sumber[i] = 1;
    if (this.status[i] === 2) { this.nSelesai++; this.akhirSelesai = Math.max(this.akhirSelesai, i); }
    if (row[PA_BARIS.length]) this.saran.set(i, row[PA_BARIS.length]);
    this.ver++;
    return i;
  }
  baris(i) { const r = PA_BARIS.map(k => this[k][i]); r.push(this.saran.get(i) || null); return r; }
  idSelesai() { const out = new Int32Array(this.nSelesai); let m = 0; for (let i = 0; i < this.n; i++) if (this.status[i] === 2) out[m++] = i; return m === out.length ? out : out.slice(0, m); }
  id(i) { return `${this.tf}#${i}`; }
  nul(k, i) { const v = this[k][i]; return PA_F.includes(k) ? (Number.isNaN(v) ? null : v) : (v === -1 && ['kena_sl', 'bar_mfe', 'bar_selesai'].includes(k) ? null : v); }
}
const GUDANG = new Map();
const gudang = (sym, tf) => GUDANG.get(sym + '|' + tf) || null;
const bulanDari = t => { const d = new Date(t); return d.getUTCFullYear() * 100 + d.getUTCMonth() + 1; };
function tandaiPa(G, i) {
  if (G.sumber[i] !== 1) return;
  SIMPAN.paKotor.add(`${G.sym}|${G.tf}|${bulanDari(G.t[i])}`);
}
SIMPAN.paIsi = key => {
  const [sym, tf, bl] = key.split('|'), G = gudang(sym, tf); if (!G) return null;
  const y = Math.floor(+bl / 100), m = +bl % 100, t0 = Date.UTC(y, m - 1, 1), t1 = Date.UTC(y, m, 1);
  const out = [];
  for (let i = cariKiri(G.t, t0, G.n); i < G.n && G.t[i] < t1; i++) if (G.sumber[i] === 1) out.push(G.baris(i));
  return out;
};
SIMPAN.semuaPa = () => { for (const G of GUDANG.values()) for (let i = 0; i < G.n; i++) tandaiPa(G, i); };
// ================================================================== memori belajar price action (belajar.py)
// Setiap candle tertutup M5/M15/H1/H4: pola dicatat bersama konteksnya, hasilnya diikuti sampai SL / target / batas waktu.
// riwayat = dihitung ulang dari candle tersimpan setiap halaman dibuka (sampai batas awal perekaman maju);
// maju    = terdeteksi saat candle baru tutup (out-of-sample), disimpan di IndexedDB.
// Statistik bertingkat arah → pola → tren TF atas → lokasi level, tarikan ke induk (M0), bobot waktu (paruh HALF hari),
// ekspektasi dikurangi biaya nyata. Syarat stabil: positif di paruh lama DAN paruh baru memori.
const VERSI_PA = 2;
const HALF = { '5m': 120, '15m': 180, '1h': 365, '4h': 730 };
const M0 = 40.0, BOBOT_MAJU = 1.25;
const RIWAYAT_HARI = { '5m': 365, '15m': 730, '1h': 1460, '4h': 2920 };
const JENDELA = 700;
const TINGKAT = { '5m': 4, '15m': 4, '1h': 4, '4h': 4 };
const LIPATAN = [[0.40, 0.55], [0.55, 0.70], [0.70, 0.85], [0.85, 1.0]];
const AMBANG_E = 0.05, MIN_NEFF = 30.0, MIN_P1 = 0.50;
const TF_MODE = { scalp: ['5m', '15m'], swing: ['1h', '4h'] };
const DIM = [2, 8, 3, 2, 4, 4, 4];
const NKOL = 2 + 2 * NK + 3;
const biayaSym = sym => SIMBOL[sym].biaya_pct;

function kodeKejadian(G, i) {
  return [G.arah[i] > 0 ? 1 : 0, G.pola[i], G.tren[i] + 1, G.lokasi[i], G.vol[i], G.sesi[i], adrKode(G.adr[i]) + 1];
}
function kunciKonteks(pola, arah, tren = 0, lokasi = 0, vol = 1, sesi = 'Asia', adr = null) {
  return [arah > 0 ? 1 : 0, Math.max(0, POLA_URUT.indexOf(pola)), Math.trunc(tren) + 1, Math.trunc(lokasi), Math.trunc(vol), Math.max(0, SESI_URUT.indexOf(sesi)), adrKode(adr) + 1];
}
function bobotWaktu(G, idx, tf, tRef) {
  const w = new Float64Array(idx.length);
  for (let j = 0; j < idx.length; j++) {
    const i = idx[j], umur = (tRef - G.t[i]) / DAY;
    w[j] = Math.pow(0.5, Math.max(umur, 0) / HALF[tf]) * (G.sumber[i] > 0 ? BOBOT_MAJU : 1.0);
  }
  return w;
}
/** Statistik cukup per awalan konteks: pref[L] = Float64Array(ukuran_L × NKOL) [W, W2, W*hit(k).., W*real(k).., W*biaya, n, n_maju]. */
function agregasi(G, idx, w, tingkat) {
  const pref = [null]; let size = 1;
  for (let L = 1; L <= tingkat; L++) { size *= DIM[L - 1]; pref.push(new Float64Array(size * NKOL)); }
  for (let j = 0; j < idx.length; j++) {
    const i = idx[j], wj = w ? w[j] : 1;
    const mfe = Number.isNaN(G.mfe[i]) ? 0 : G.mfe[i], ra = Number.isNaN(G.r_akhir[i]) ? -1.0 : G.r_akhir[i];
    const br = Number.isNaN(G.biaya_r[i]) ? 0 : G.biaya_r[i], kd = kodeKejadian(G, i), maju = G.sumber[i] > 0 ? 1 : 0;
    let p = 0;
    for (let L = 1; L <= tingkat; L++) {
      p = p * DIM[L - 1] + kd[L - 1];
      const A = pref[L], o = p * NKOL;
      A[o] += wj; A[o + 1] += wj * wj;
      for (let k = 0; k < NK; k++) {
        const hit = mfe >= K_TP[k];
        if (hit) A[o + 2 + k] += wj;
        A[o + 2 + NK + k] += (hit ? K_TP[k] : ra) * wj;
      }
      A[o + 2 + 2 * NK] += br * wj; A[o + 3 + 2 * NK] += 1; A[o + 4 + 2 * NK] += maju;
    }
  }
  return pref;
}
function dariSuff(A, o) {
  const W = A[o], W2 = A[o + 1];
  if (!(W > 0)) return null;
  const P = new Float64Array(NK), E = new Float64Array(NK);
  for (let k = 0; k < NK; k++) { P[k] = A[o + 2 + k] / W; E[k] = A[o + 2 + NK + k] / W; }
  return { P, E, biaya: A[o + 2 + 2 * NK] / W, n: Math.round(A[o + 3 + 2 * NK]), n_maju: Math.round(A[o + 4 + 2 * NK]), n_eff: W2 > 0 ? W * W / W2 : 0 };
}
function tarik(anak, induk) {
  const a = anak.n_eff / (anak.n_eff + M0), P = new Float64Array(NK), E = new Float64Array(NK);
  for (let k = 0; k < NK; k++) { P[k] = a * anak.P[k] + (1 - a) * induk.P[k]; E[k] = a * anak.E[k] + (1 - a) * induk.E[k]; }
  return { ...anak, P, E };
}
/** Rantai tarikan dari tingkat paling umum ke paling spesifik yang punya data. */
function statistikDari(pref, kunci, tingkat) {
  let cur = null, dalam = 0, p = 0;
  for (let L = 1; L <= tingkat && L <= kunci.length; L++) {
    const A = pref[L]; if (!A) break;
    p = p * DIM[L - 1] + kunci[L - 1];
    const st = dariSuff(A, p * NKOL);
    if (!st) break;
    cur = cur ? tarik(st, cur) : st;
    dalam = L;
  }
  return cur ? { ...cur, tingkat: dalam } : null;
}
/** TP1 (aman), TP2 (ekspektasi bersih terbaik), TP3 (lanjutan) dalam R + peluang tersentuh sebelum SL. */
function tangga(P, E, biayaR) {
  const En = Array.from(E, x => x - biayaR);
  let iOpt = 0; for (let j = 1; j < NK; j++) if (En[j] > En[iOpt]) iOpt = j;
  for (let j = 0; j < iOpt; j++) if (En[j] >= En[iOpt] - 0.02) { iOpt = j; break; }
  let i1 = 0; for (let j = 0; j <= iOpt; j++) if (P[j] >= 0.58) i1 = j;
  let i2 = iOpt;
  if (i2 <= i1) { let nx = -1; for (let j = i1 + 1; j < NK; j++) if (P[j] >= 0.40) { nx = j; break; } i2 = nx >= 0 ? nx : Math.min(i1 + 1, NK - 1); }
  let i3 = null;
  for (let j = i2 + 1; j < NK; j++) if (P[j] >= 0.25 && K_TP[j] >= K_TP[i2] + 0.5) i3 = j;
  if (i3 === null) i3 = Math.min(NK - 1, i2 + 2);
  const ii = [i1, i2, i3];
  return { k: ii.map(j => K_TP[j]), p: ii.map(j => P[j]), e_k: ii.map(j => En[j]), e: En[i2], k_opt: K_TP[i2] };
}
/** Aturan sinyal yang SAMA untuk uji walk-forward dan sinyal hidup. [tangga|null, alasan_tolak]. */
function putuskan(st, biayaR, tambah = 0.0, minNeff = MIN_NEFF, paruh = null) {
  if (!st || st.n_eff < minNeff) return [null, `sampel serupa baru ${st ? st.n : 0} (min efektif ${fx(minNeff)})`];
  const tg = tangga(st.P, st.E, biayaR);
  if (tg.p[0] < MIN_P1) return [null, `peluang TP1 ${fx(tg.p[0] * 100)}% < ${fx(MIN_P1 * 100)}%`];
  if (tg.e < AMBANG_E + tambah) return [null, `ekspektasi ${fr(tg.e)} < ${fr(AMBANG_E + tambah)}`];
  if (paruh) {
    const nama = ['lama', 'baru'];
    for (let z = 0; z < 2; z++) {
      const sp = paruh[z];
      if (!sp) return [null, `tidak ada contoh di paruh ${nama[z]} memori`];
      let i2 = 0; for (let k = 1; k < NK; k++) if (Math.abs(K_TP[k] - tg.k[1]) < Math.abs(K_TP[i2] - tg.k[1])) i2 = k;
      const e2 = sp.E[i2] - biayaR;
      if (e2 < 0) return [null, `tidak stabil: paruh ${nama[z]} memori ${fr(e2)}`];
    }
  }
  return [tg, ''];
}
/** Statistik tanpa bobot untuk paruh lama dan paruh baru memori (syarat stabil). */
function paruhPref(G, idx, tingkat) {
  if (!idx.length) return [agregasi(G, [], null, tingkat), agregasi(G, [], null, tingkat)];
  const tm = kuantil(Array.from(idx, i => G.t[i]), 0.5), a = [], b = [];
  for (const i of idx) (G.t[i] < tm ? a : b).push(i);
  return [agregasi(G, a, null, tingkat), agregasi(G, b, null, tingkat)];
}

/** Cache statistik per (sym, tf); dimuat ulang saat ada kejadian baru yang selesai (maks tiap 60 dtk). */
class Memori {
  constructor() { this._c = new Map(); this._cek = new Map(); }
  _token(sym, tf) { const G = gudang(sym, tf); return G ? `${G.nSelesai}|${G.akhirSelesai}|${G.n}` : '0'; }
  pref(sym, tf) {
    const k = sym + '|' + tf, t = now();
    let c = this._c.get(k);
    if (c && t - (this._cek.get(k) || 0) < 60000) return c;
    this._cek.set(k, t);
    const tok = this._token(sym, tf);
    if (c && c.token === tok) return c;
    const G = gudang(sym, tf), idx = G ? G.idSelesai() : new Int32Array(0);
    const w = G ? bobotWaktu(G, idx, tf, now()) : null;
    c = { token: tok, G, idx: idx.length ? idx : null, w, pref: agregasi(G, idx, w, TINGKAT[tf]), paruh: paruhPref(G, idx, TINGKAT[tf]), t: now() };
    this._c.set(k, c);
    return c;
  }
  buang() { this._cek.clear(); }
  statistik(sym, tf, kunci) {
    const c = this.pref(sym, tf), tk = TINGKAT[tf];
    return [statistikDari(c.pref, kunci, tk), c.paruh.map(p => statistikDari(p, kunci, tk))];
  }
  ringkas(sym, tf) {
    const c = this.pref(sym, tf);
    if (!c.idx) return { n: 0, n_maju: 0 };
    const G = c.G; let maju = 0; for (const i of c.idx) maju += G.sumber[i] > 0 ? 1 : 0;
    return { n: c.idx.length, n_maju: maju, dari: G.t[c.idx[0]], sampai: G.t[c.idx[c.idx.length - 1]] };
  }
  /** Pola × arah per TF: peluang TP, target terbaik, ekspektasi bersih, konteks terbaik, perubahan 30 hari. */
  tabel(sym, tfs, nBaris = 12) {
    const out = [];
    for (const tf of tfs) {
      const c = this.pref(sym, tf), pref = c.pref, G = c.G;
      if (!c.idx) continue;
      for (let pi = 0; pi < POLA_URUT.length; pi++) {
        for (const ab of [1, 0]) {
          const base = statistikDari(pref, [ab, pi], 2);
          if (!base || base.n < 30) continue;
          const tg = tangga(base.P, base.E, base.biaya);
          let terbaik = null;
          for (let tr = 0; tr < 3; tr++) {
            for (const kk of [[ab, pi, tr], [ab, pi, tr, 0], [ab, pi, tr, 1]]) {
              const st = statistikDari(pref, kk, kk.length);
              if (!st || st.tingkat < kk.length || st.n_eff < 40) continue;
              const t2 = tangga(st.P, st.E, st.biaya);
              if (!terbaik || t2.e > terbaik[0]) terbaik = [t2.e, kk, st.n];
            }
          }
          const m = [];
          let nMaju = 0, hitMaju = 0;
          for (const i of c.idx) if (G.pola[i] === pi && (G.arah[i] > 0) === !!ab) { m.push(i); if (G.sumber[i] > 0) { nMaju++; if (G.mfe[i] >= 1) hitMaju++; } }
          out.push({ tf, pola: POLA_URUT[pi], nama: POLA[POLA_URUT[pi]], arah: ab ? 1 : -1, n: base.n, n_maju: nMaju, p1r: base.P[2] * 100,
            k: tg.k, p: tg.p, e: tg.e, p_maju_1r: nMaju >= 10 ? hitMaju / nMaju * 100 : null, drift: drift(G, m),
            konteks_terbaik: terbaik && terbaik[0] > tg.e + 0.03 ? teksKonteks(terbaik[1]) : null,
            e_terbaik: terbaik ? terbaik[0] : null, n_terbaik: terbaik ? terbaik[2] : null });
        }
      }
    }
    out.sort((a, b) => b.e - a.e);
    return nBaris ? out.slice(0, nBaris) : out;
  }
  /** Porsi kejadian yang selesai dalam `jam` terakhir dan gagal (kena SL sebelum 1R) vs kebiasaan TF itu. */
  gagalTerkini(sym, tfs, jam = 24) {
    let n = 0, gagal = 0; const harap = [], batas = now() - jam * HOUR;
    for (const tf of tfs) {
      const G = gudang(sym, tf);
      if (G) for (let i = 0; i < G.n; i++) if (G.status[i] === 2 && G.t_selesai[i] >= batas) { n++; if ((G.mfe[i] || 0) < 1.0 && G.kena_sl[i] === 1) gagal++; }
      const pr = this.pref(sym, tf).pref;
      for (const s of [statistikDari(pr, [1], 1), statistikDari(pr, [0], 1)]) if (s) harap.push(1 - s.P[2]);
    }
    return { n, gagal, porsi: n ? gagal / n : null, kebiasaan: harap.length ? rata(harap) : null };
  }
}

/** 30 hari terakhir vs sebelumnya (E kotor target 1R). z <= -2 melemah, >= 2 menguat. */
function drift(G, m) {
  const batas = now() - 30 * DAY, rb = [], rl = [], pb = [], pl = [];
  for (const i of m) {
    const r1 = G.mfe[i] >= 1.0 ? 1.0 : (Number.isNaN(G.r_akhir[i]) ? -1.0 : G.r_akhir[i]);
    if (G.t[i] >= batas) { rb.push(r1); pb.push(G.mfe[i] >= 1 ? 1 : 0); } else { rl.push(r1); pl.push(G.mfe[i] >= 1 ? 1 : 0); }
  }
  if (rb.length < 20 || rl.length < 60) return null;
  const sd = simpangan(rb) || 1.0, z = (rata(rb) - rata(rl)) / (sd / Math.sqrt(rb.length));
  return { status: z <= -2 ? 'melemah' : z >= 2 ? 'menguat' : 'stabil', z, e_baru: rata(rb), e_lama: rata(rl), n_baru: rb.length,
    p1_baru: rata(pb) * 100, p1_lama: rata(pl) * 100 };
}
function teksKonteks(k) {
  const bag = [];
  if (k.length >= 3) bag.push({ 2: 'searah tren TF atas', 0: 'melawan tren TF atas', 1: 'tren TF atas datar' }[k[2]]);
  if (k.length >= 4) bag.push(k[3] ? 'di level kunci' : 'di luar level');
  return bag.join(', ');
}
function teksKonteksBaris(tren, lokasi, vol, sesi, adr) {
  const bag = [{ 1: 'searah tren TF atas', '-1': 'melawan tren TF atas', 0: 'tren TF atas datar' }[Math.trunc(tren)] || '',
    lokasi ? 'di level kunci' : 'di luar level', `volatilitas ${VOL[Math.trunc(vol)]}`];
  if (sesi) bag.push(`sesi ${sesi}`);
  if (adr != null && adr === adr) bag.push(`ADR terpakai ${fx(adr * 100)}%`);
  return bag.filter(Boolean).join(', ');
}

// ------------------------------------------------------------------ pengisian, langkah maju, ikuti hasil
/** Candle TERTUTUP seri sejak `dari` (tanpa skala), difilter jam pasar emas bila proxy PAXG dipakai untuk XAU. */
function barSeri(sym, seri, tf, dari) {
  const D0 = candle(seri, tf, { dari }), ms = TF_MS[tf], T = D0.t, t0 = now(), emas = sym === 'XAUUSDm' && seri === 'PAXGUSDT';
  const idx = []; for (let i = 0; i < T.length; i++) if (T[i] + ms <= t0 && (!emas || pasarEmasBuka(T[i]))) idx.push(i);
  const D = {}; for (const k of KOL) { const a = new Float64Array(idx.length); for (let j = 0; j < idx.length; j++) a[j] = D0[k][idx[j]]; D[k] = a; }
  return D;
}

/** Deteksi + konteks (+ evaluasi untuk riwayat). Kembalikan {evs, hasil, kd, A, lv}. */
function prosesPA(P, sym, tf, D, mulai, nilai) {
  const A = atr(D.h, D.l, D.c), lv = levelPeriode(D, tf === '4h');
  const [evs, kd] = deteksi(D, A, mulai, lv, SIMBOL[sym].bulat_kecil);
  const ar = arahAtas(P, tf, D);
  konteks(D, A, evs, ar, lv);
  const hasil = nilai ? evs.map(e => evaluasiPA(D.o, D.h, D.l, D.c, e.i, e.sl, e.arah, HORIZON[tf], biayaSym(sym))) : null;
  const n = A.length;
  kd.arah_atas = (ar.length && ar[ar.length - 1] === ar[ar.length - 1]) ? ar[ar.length - 1] : 0.0;
  kd.atr = n > 1 ? A[n - 2] : A[n - 1];
  if (n > 60) {
    const w0 = Math.max(0, n - 501), x = A[n - 2]; let k = 0;
    for (let j = w0; j < n - 1; j++) if (A[j] < x) k++;
    const pct = k / (n - 1 - w0) * 100;
    kd.vol = pct < 25 ? 0 : pct < 75 ? 1 : pct < 92 ? 2 : 3; kd.vol_pct = pct;
  }
  const la = lv.adr[n - 1];
  if (n && la === la && la > 0) kd.adr = (lv.run_h[n - 1] - lv.run_l[n - 1]) / la;
  return { evs, hasil, kd, A, lv };
}

/** Analisis candle terakhir yang tutup: ukuran, struktur, pola, posisi terhadap level. */
function gerakCandle(sym, tf, D, A, lv, kd, evs) {
  const i = D.c.length - 1, o = D.o[i], h = D.h[i], l = D.l[i], c = D.c[i];
  const a = (i > 0 && A[i - 1] > 0) ? A[i - 1] : A[i], arah = tanda(c - o), st = kd.struktur || 0;
  const stTxt = { 1: 'naik (higher high / higher low)', '-1': 'turun (lower high / lower low)' }[st] || 'belum jelas';
  const pola = evs.filter(e => e.i === i), cand = [];
  if (lv.atas[i] === lv.atas[i]) cand.push([lv.nama[0], lv.atas[i]]);
  if (lv.bawah[i] === lv.bawah[i]) cand.push([lv.nama[1], lv.bawah[i]]);
  for (const [nm, key] of [['swing high', 'swing_high'], ['swing low', 'swing_low']]) {
    const z = (kd[key] || [])[(kd[key] || []).length - 1];
    if (z) cand.push([nm + (z[2] ? ' (sudah tembus)' : ''), z[1]]);
  }
  const b = SIMBOL[sym].bulat;
  cand.push(['angka bulat', Math.floor(c / b) * b], ['angka bulat', Math.ceil(c / b) * b]);
  const dekat = cand.length ? cand.reduce((x, y) => (Math.abs(y[1] - c) < Math.abs(x[1] - c) ? y : x)) : null;
  const bagian = [`Candle ${tf.toUpperCase()} ${wib(D.t[i] + TF_MS[tf])} WIB ` + ({ 1: 'naik', '-1': 'turun' }[arah] || 'doji') +
    ` ${fmt(Math.abs(c - o) / a, 1)}x ATR (range ${fmt((h - l) / a, 1)}x), close ${fmt(c)}`];
  if (pola.length) bagian.push('pola ' + pola.map(e => `${POLA[e.pola]} ${AB(e.arah)}` + (e.level_harga ? ` (${e.level} ${fmt(e.level_harga)})` : '')).join(', '));
  bagian.push(`struktur ${stTxt}`);
  if (dekat) bagian.push(`terdekat ${dekat[0]} ${fmt(dekat[1])} (${dekat[1] > c ? '+' : ''}${fmt((dekat[1] - c) / a, 1)} ATR)`);
  return { tf, t: D.t[i], o, h, l, c, arah, badan_atr: Math.abs(c - o) / a, range_atr: (h - l) / a, struktur: st, struktur_teks: stTxt,
    pola: pola.map(e => ({ pola: e.pola, nama: POLA[e.pola], arah: e.arah, level: e.level, level_harga: e.level_harga })),
    dekat: dekat ? { nama: dekat[0], harga: dekat[1], atr: (dekat[1] - c) / a } : null, teks: bagian.join('; ') + '.' };
}

class Pembelajar {
  constructor() { this.keadaan = new Map(); this._evalT = new Map(); this.mem = new Memori(); this.siapSym = {}; this.proses = false; }
  siap(sym) { return sym ? !!this.siapSym[sym] : SYMS.every(s => this.siapSym[s]); }

  /** Isi memori satu simbol: kejadian riwayat dihitung ulang dari candle, kejadian maju dimuat dari IndexedDB. */
  async isiRiwayat(feed, sym) {
    const t0 = now(), [seri, skala] = feed.seri(sym), P = new Pasar(sym, seri, skala), ringkas = {};
    const versiLama = kvGet('pa_versi:' + sym);
    let baru = false;
    if (versiLama !== VERSI_PA) {
      for (const tf of TF_BELAJAR) { kvHapus(`pa_maju_awal:${sym}:${tf}`); kvHapus(`pa_kursor:${sym}:${tf}`); }
      if (IDB && PEMIMPIN) {
        for (const tf of TF_BELAJAR) for (const [k] of await idbSemua('pa', `${sym}|${tf}|`)) SIMPAN.paKotor.add(k);
        SIMPAN.paIsiKosong = true;
      }
      kvSet('pa_versi:' + sym, VERSI_PA);
      baru = true;
    }
    for (const tf of TF_BELAJAR) {
      const G = new Gudang(sym, tf), ms = TF_MS[tf];
      const batas = P.now - RIWAYAT_HARI[tf] * DAY;
      let awal = kvGet(`pa_maju_awal:${sym}:${tf}`);
      let D = P.bar(tf);
      const a0 = cariKiri(D.t, batas - 400 * ms);
      if (a0 > 0) { const D2 = {}; for (const k of KOL) D2[k] = D[k].subarray(a0); D = D2; }
      if (D.t.length >= 600) {
        const mulai = cariKiri(D.t, batas);
        const { evs, hasil } = prosesPA(P, sym, tf, D, Math.max(mulai, 30), true);
        const akhirT = D.t[D.t.length - 1];
        if (awal == null) { awal = akhirT; kvSet(`pa_maju_awal:${sym}:${tf}`, awal); baru = true; }
        if (kvGet(`pa_kursor:${sym}:${tf}`) == null) kvSet(`pa_kursor:${sym}:${tf}`, awal);
        let k = 0;
        evs.forEach((e, j) => { if (e.t <= awal) { G.tambah(e, hasil[j], 'riwayat', skala); k++; } });
        ringkas[`${sym} ${tf}`] = k;
      }
      // kejadian maju tersimpan (dibuang bila di luar jendela memori)
      if (IDB && versiLama === VERSI_PA) {
        const batasMaju = now() - RIWAYAT_HARI[tf] * DAY, rows = [];
        for (const [key, list] of await idbSemua('pa', `${sym}|${tf}|`)) {
          let semuaTua = true;
          for (const r of list || []) { if (r[0] >= batasMaju && (awal == null || r[0] > awal)) { rows.push(r); semuaTua = false; } }
          if (semuaTua && PEMIMPIN) SIMPAN.paKotor.add(key);
        }
        rows.sort((x, y) => x[0] - y[0]);
        for (const r of rows) G.tambahBaris(r);
      }
      GUDANG.set(sym + '|' + tf, G);
      this.mem._c.delete(sym + '|' + tf);
      await lega(true);
    }
    const info = { versi: VERSI_PA, t: now(), detik: Math.round((now() - t0) / 100) / 10, kejadian: ringkas };
    kvSet('pa_riwayat:' + sym, info);
    if (baru) pikir(sym, 'belajar', 'Memori price action diisi dari riwayat: ' + Object.entries(ringkas).map(([k, v]) => `${k} ${fmt(v, 0)}`).join(', ') +
      ' kejadian dinilai sampai kena SL / target / batas waktu.');
    this.siapSym[sym] = true;
    if (typeof WAKTU !== 'undefined') WAKTU['memori ' + sym] = now() - T_MULAI;
    return info;
  }

  langkah(feed) {
    for (const sym of SYMS) {
      if (!this.siap(sym) || !feed.siapSym(sym)) continue;
      const [seri, skala] = feed.seri(sym), P = new Pasar(sym, seri, skala);
      for (const tf of TF_BELAJAR) {
        try { this._maju(P, sym, tf, seri, skala, feed.segar_tf.get(seri + '|' + tf) || 0); }
        catch (e) { const k = this.keadaan.get(sym + '|' + tf) || {}; k.galat = teksGalat(e); this.keadaan.set(sym + '|' + tf, k); }
      }
    }
    this.ikuti(feed.segar_tf);
  }
  static belumFinal(tBar, tf, tSegar) { return tSegar != null && tSegar < tBar + TF_MS[tf] + 1000; }

  _maju(P, sym, tf, seri, skala, tSegar) {
    const kunci = `pa_kursor:${sym}:${tf}`, kur = kvGet(kunci), lama = this.keadaan.get(sym + '|' + tf) || {};
    let D = P.bar(tf, JENDELA);
    if (D.t.length < 120) return;
    const tAkhir = D.t[D.t.length - 1];
    if (Pembelajar.belumFinal(tAkhir, tf, tSegar)) return;
    if (kur && tAkhir <= kur && lama.t === tAkhir && lama.seri === seri) return;
    if (kur && D.t[0] > kur) D = P.bar(tf, Math.min(6000, JENDELA + Math.trunc((tAkhir - kur) / TF_MS[tf]) + 10));
    const mulai = kur ? cariKanan(D.t, kur) : D.t.length;
    const { evs, kd, A, lv } = prosesPA(P, sym, tf, D, mulai, false), G = gudang(sym, tf);
    if (G) for (const e of evs) { const i = G.tambah(e, null, 'maju', skala); if (i >= 0) tandaiPa(G, i); }
    if (!kur || tAkhir > kur) kvSet(kunci, tAkhir);
    Object.assign(kd, { t: tAkhir, seri, skala, gerak: gerakCandle(sym, tf, D, A, lv, kd, evs) });
    this.keadaan.set(sym + '|' + tf, kd);
  }

  /** Perbarui hasil kejadian 'menunggu'/'berjalan' (memakai skala harga saat kejadian dideteksi). */
  ikuti(segar = null) {
    const t0 = now();
    for (const G of GUDANG.values()) {
      const sym = G.sym, tf = G.tf, ms = TF_MS[tf], seri = SIMBOL[sym].binance;
      let minT = Infinity; const tunggu = [];
      for (let i = 0; i < G.n; i++) if (G.status[i] <= 1) { tunggu.push(i); if (G.t[i] < minT) minT = G.t[i]; }
      if (!tunggu.length) continue;
      const D = barSeri(sym, seri, tf, minT);
      if (!D.t.length) continue;
      const kunci = sym + '|' + tf, tL = D.t[D.t.length - 1];
      if (this._evalT.get(kunci) === tL && this._evalT.get(kunci + '#n') === tunggu.length) continue;
      if (segar && Pembelajar.belumFinal(tL, tf, segar.get(seri + '|' + tf) || 0)) continue;
      this._evalT.set(kunci, tL); this._evalT.set(kunci + '#n', tunggu.length);
      for (const i of tunggu) {
        const t = G.t[i], j = cariKiri(D.t, t);
        if (j >= D.t.length || D.t[j] !== t) {
          if (t0 - t > 6 * HORIZON[tf] * ms) { G.status[i] = ST_KODE.kedaluwarsa; G.ver++; tandaiPa(G, i); }
          continue;
        }
        const h = evaluasiPA(D.o, D.h, D.l, D.c, j, G.sl[i], G.arah[i], HORIZON[tf], biayaSym(sym), G.skala[i]);
        if (h.status === 'menunggu') continue;
        G.setHasil(i, h);
        tandaiPa(G, i);
      }
    }
  }
}

// ------------------------------------------------------------------ uji walk-forward
/** Uji walk-forward berlapis: tiap lipatan memakai memori dari kejadian yang SELESAI sebelum lipatan dimulai, lalu aturan
 *  sinyal (putuskan + syarat stabil) diterapkan pada kejadian di dalamnya. */
async function validasiPA(sym, tf) {
  const G = gudang(sym, tf), idx = G ? G.idSelesai() : new Int32Array(0);
  if (idx.length < 400) return { status: 'data kurang', n_uji: 0, lipatan: [] };
  const T = Array.from(idx, i => G.t[i]), jeda = HORIZON[tf] * TF_MS[tf], tk = TINGKAT[tf];
  const r1 = i => (G.mfe[i] >= 1.0 ? 1.0 : (Number.isNaN(G.r_akhir[i]) ? -1.0 : G.r_akhir[i])) - (Number.isNaN(G.biaya_r[i]) ? 0 : G.biaya_r[i]);
  const hasil = [], lip = [];
  let nUji = 0;
  for (const [f0, f1] of LIPATAN) {
    const t0 = Math.trunc(kuantil(T, f0)), t1 = Math.trunc(kuantil(T, f1)), tMax = T[T.length - 1];
    const latih = [], uji = [];
    for (let j = 0; j < idx.length; j++) {
      const t = T[j];
      if (t < t0 - jeda) latih.push(idx[j]);
      if (t >= t0 && (f1 < 1.0 ? t < t1 : t <= tMax)) uji.push(idx[j]);
    }
    if (latih.length < 300 || !uji.length) continue;
    const pref = agregasi(G, latih, bobotWaktu(G, latih, tf, t0), tk), par = paruhPref(G, latih, tk);
    await lega();
    const cache = new Map(), rr = [];
    let semua = 0;
    for (const i of uji) {
      semua += r1(i);
      const kd = kodeKejadian(G, i), key = kd.join(',');
      let c = cache.get(key);
      if (!c) { c = [statistikDari(pref, kd, tk), par.map(p => statistikDari(p, kd, tk))]; cache.set(key, c); }
      const biayaR = Number.isNaN(G.biaya_r[i]) ? 0 : G.biaya_r[i];
      const [tg] = putuskan(c[0], biayaR, 0, MIN_NEFF, c[1]);
      if (!tg) continue;
      const mfe = G.mfe[i], ra = Number.isNaN(G.r_akhir[i]) ? -1.0 : G.r_akhir[i];
      const r2 = (mfe >= tg.k[1] ? tg.k[1] : ra) - biayaR;
      rr.push(r2);
      hasil.push([G.pola[i], mfe >= tg.k[0], mfe >= tg.k[1], r2, tg.e]);
    }
    nUji += uji.length;
    lip.push({ dari: t0, sampai: t1, n: rr.length, e: rr.length ? rata(rr) : null, e_semua: semua / uji.length });
    await lega();
  }
  const tLip0 = Math.trunc(kuantil(T, LIPATAN[0][0])), akhir = (T[T.length - 1] - tLip0) / DAY;
  let sm = 0, sp = 0, sn = 0;
  for (let j = 0; j < idx.length; j++) if (T[j] >= tLip0) { const i = idx[j]; sm += r1(i); sp += G.mfe[i] >= 1.0 ? 1 : 0; sn++; }
  const out = { n_uji: nUji, n_lolos: hasil.length, dari: tLip0, sampai: T[T.length - 1], e_semua: sn ? sm / sn : null, p1_semua: sn ? sp / sn * 100 : null, lipatan: lip, t: now() };
  if (hasil.length) {
    const r = hasil.map(h => h[3]);
    let gp = 0, gl = 0; for (const x of r) { if (x > 0) gp += x; else gl -= x; }
    Object.assign(out, { tp1: rata(hasil.map(h => (h[1] ? 1 : 0))) * 100, tp2: rata(hasil.map(h => (h[2] ? 1 : 0))) * 100, e_lolos: rata(r),
      pf_lolos: gl > 0 ? gp / gl : null, e_harap: rata(hasil.map(h => h[4])), total_r: jumlah(r), per_hari: hasil.length / Math.max(1.0, akhir) });
    const per = {};
    for (const [p, , , x] of hasil) (per[POLA_URUT[p]] = per[POLA_URUT[p]] || []).push(x);
    out.pola = {}; for (const [k, v] of Object.entries(per)) out.pola[k] = { n: v.length, e: rata(v) };
  }
  const pos = lip.filter(z => z.n >= 5 && (z.e || 0) > 0).length, terakhir = lip[lip.length - 1] || {};
  const lolos = hasil.length >= 40 && (out.e_lolos || -1) >= 0.02 && pos >= 2 && ((terakhir.n || 0) < 10 || (terakhir.e || 0) > -0.03);
  out.status = lolos ? 'aktif' : (hasil.length < 40 ? 'sedikit' : 'nonaktif');
  out.blokir = Object.entries(out.pola || {}).filter(([, v]) => v.n >= 20 && v.e < -0.10).map(([k]) => k);
  return out;
}

async function validasiSemua(syms) {
  const ringkas = {};
  for (const sym of syms) {
    for (const tf of TF_BELAJAR) {
      const v = await validasiPA(sym, tf), lama = kvGet(`pa_validasi:${sym}:${tf}`) || {};
      kvSet(`pa_validasi:${sym}:${tf}`, v);
      ringkas[`${sym} ${tf}`] = v;
      if (!v.n_uji) continue;
      let isi;
      if (v.n_lolos) isi = `${sym} ${tf.toUpperCase()}: uji walk-forward ${fmt(v.n_uji, 0)} kejadian terbaru (memori hanya dari data sebelumnya). ` +
        `${fmt(v.n_lolos, 0)} lolos aturan sinyal: TP1 ${fmt(v.tp1, 0)}%, TP2 ${fmt(v.tp2, 0)}%, rata-rata ${fr(v.e_lolos)} per transaksi (PF ${fmt(v.pf_lolos)}); ` +
        `semua pola tanpa filter ${fr(v.e_semua)}. Status: ${v.status}.`;
      else isi = `${sym} ${tf.toUpperCase()}: uji walk-forward ${fmt(v.n_uji, 0)} kejadian, tidak ada yang lolos aturan sinyal (semua pola tanpa filter ${fr(v.e_semua)}). Timeframe ini hanya dipantau.`;
      if (v.blokir && v.blokir.length) isi += ' Pola diblokir sementara: ' + v.blokir.map(b => POLA[b]).join(', ') + '.';
      if (lama.status && lama.status !== v.status) isi += ` Status berubah ${lama.status} → ${v.status}.`;
      pikir(sym, 'belajar', isi);
    }
    kvSet('pa_validasi_t:' + sym, now());
  }
  return ringkas;
}

function tandaiSaran(sym, id, data) {
  const [tf, s] = String(id).split('#'), G = gudang(sym, tf), i = +s;
  if (!G || !(i >= 0 && i < G.n) || G.disarankan[i]) return;
  G.disarankan[i] = 1; G.saran.set(i, data); G.ver++;
  tandaiPa(G, i);
}
function sudahDisarankan(sym, id) { const [tf, s] = String(id).split('#'), G = gudang(sym, tf); return !!(G && G.disarankan[+s]); }

/** Sinyal PA yang benar-benar DISARANKAN (maju) dan hasilnya: TP1/TP2 tersentuh, R bersih di TP2. */
function akurasiSaran(sym, tfs, hari = null) {
  let n = 0, h1 = 0, h2 = 0; const rs = [], batas = hari ? now() - hari * DAY : -Infinity;
  for (const tf of tfs) {
    const G = gudang(sym, tf); if (!G) continue;
    for (let i = 0; i < G.n; i++) {
      if (!G.disarankan[i] || G.status[i] !== 2 || G.t[i] < batas) continue;
      const s = G.saran.get(i) || {}, k = s.k || [1.0, 2.0, 3.0], mfe = G.mfe[i] || 0;
      n++; if (mfe >= k[0]) h1++; if (mfe >= k[1]) h2++;
      rs.push((mfe >= k[1] ? k[1] : (Number.isNaN(G.r_akhir[i]) ? -1.0 : G.r_akhir[i])) - (G.biaya_r[i] || 0));
    }
  }
  if (!n) return { n: 0 };
  let gp = 0, gl = 0; for (const x of rs) { if (x > 0) gp += x; else gl -= x; }
  return { n, tp1: h1 / n * 100, tp2: h2 / n * 100, e: rata(rs), total: jumlah(rs), pf: gl > 0 ? gp / gl : null };
}
/** Pola MAJU yang sudah selesai dinilai (terbaru dulu). */
function hasilTerakhir(sym, tfs, n = 8) {
  const out = [];
  for (const tf of tfs) {
    const G = gudang(sym, tf); if (!G) continue;
    for (let i = 0; i < G.n; i++) {
      if (G.sumber[i] !== 1 || G.status[i] !== 2) continue;
      const mfe = G.mfe[i], ra = G.nul('r_akhir', i);
      out.push({ tf, t: G.t[i], pola: POLA_URUT[G.pola[i]], nama: POLA[POLA_URUT[G.pola[i]]], arah: G.arah[i], mfe, kena_sl: G.nul('kena_sl', i),
        r1: (mfe || 0) >= 1.0 ? 1.0 : (ra != null ? ra : -1.0), t_selesai: G.nul('t_selesai', i), disarankan: G.disarankan[i], harga: G.harga[i] });
    }
  }
  return out.sort((a, b) => (b.t_selesai || 0) - (a.t_selesai || 0)).slice(0, n);
}
function progresPA(sym) {
  const out = { riwayat: 0, maju: 0, berjalan: 0, selesai: 0, selesai_hari_ini: 0, kena1r_hari_ini: 0, baru_hari_ini: 0 };
  const hari = Math.floor(now() / DAY) * DAY;
  for (const tf of TF_BELAJAR) {
    const G = gudang(sym, tf); if (!G) continue;
    for (let i = 0; i < G.n; i++) {
      if (G.sumber[i]) out.maju++; else out.riwayat++;
      const s = G.status[i];
      if (s <= 1) out.berjalan++;
      else if (s === 2) {
        out.selesai++;
        if (G.t_selesai[i] >= hari) { out.selesai_hari_ini++; if (G.mfe[i] >= 1) out.kena1r_hari_ini++; }
      }
      if (G.sumber[i] && G.t[i] >= hari) out.baru_hari_ini++;
    }
  }
  return out;
}
// ================================================================== sinyal price action hidup + ketidakpastian (saran.py)
// SINYAL : pola segar di TF yang LOLOS uji walk-forward, konteks lolos aturan → BUY/SELL (entry, SL struktural, TP1-3, lot).
// PANTAU : pola segar ada & memori positif, tapi TF belum terbukti / konteks belum lolos → dipantau, bukan rekomendasi.
// ABAIKAN: menurut memori pola itu di konteks ini rata-rata merugi.  TUNGGU: tidak ada pola segar → daftar level pantau.
const SEGAR = { '5m': 3, '15m': 2, '1h': 2, '4h': 1 };
const EFEK = {        // label: [tambah ambang E, pengali risiko, TP2 maks R, min sampel efektif]
  Rendah: [0.0, 1.0, null, MIN_NEFF], Sedang: [0.02, 1.0, null, MIN_NEFF],
  Tinggi: [0.06, 0.75, 1.5, MIN_NEFF + 15], 'Sangat tinggi': [0.12, 0.5, 1.25, MIN_NEFF * 2],
};

function ketidakpastian(sym, mode, kb, ramalan, keadaan, mem) {
  const rz = (kb || {}).rezim || {}, komp = [];
  const pct = rz.vol_persentil;
  const v = pct != null ? klip((pct - 40) / 55) : 0.5;
  komp.push({ nama: 'Volatilitas', nilai: v, teks: pct != null ? `persentil ${fx(pct)} dari 180 hari` : 'belum ada data' });
  const arah = [];
  for (const tf of TF_BELAJAR) { const k = keadaan.get(sym + '|' + tf) || {}; if ('struktur' in k) arah.push(Math.trunc(k.struktur)); }
  if (rz.arah_1d != null) arah.push(Math.trunc(rz.arah_1d));
  let dis = 0.5;
  if (arah.length) {
    dis = 1 - Math.abs(jumlah(arah)) / arah.length;
    const nu = arah.filter(a => a > 0).length, nd = arah.filter(a => a < 0).length;
    komp.push({ nama: 'Arah antar-timeframe', nilai: dis, teks: `${nu} naik, ${nd} turun, ${arah.length - nu - nd} belum jelas (M5-H4 + harian)` });
  }
  const g = mem.gagalTerkini(sym, TF_MODE[mode]);
  let f = 0.5;
  if (g.n >= 6 && g.kebiasaan) {
    f = klip(0.5 + (g.porsi - g.kebiasaan) / 0.3);
    komp.push({ nama: 'Pola 24 jam terakhir', nilai: f, teks: `${g.gagal} dari ${g.n} gagal sebelum 1R (kebiasaan ${fx(g.kebiasaan * 100)}%)` });
  } else komp.push({ nama: 'Pola 24 jam terakhir', nilai: f, teks: `baru ${g.n} pola selesai (netral)` });
  let pr = 0.5;
  if (ramalan && ramalan.length) {
    const p = ramalan[0].p_naik;
    pr = klip(1 - Math.abs(p - 50) / 15);
    komp.push({ nama: 'Prediksi analog', nilai: pr, teks: `${ramalan[0].label}: naik ${fx(p)}% (dekat 50% = ragu)` });
  }
  let sy = 0.0;
  const g1 = (keadaan.get(sym + '|1h') || {}).gerak || {};
  if (g1.range_atr != null) { sy = klip((g1.range_atr - 1.2) / 1.8); komp.push({ nama: 'Candle H1 terakhir', nilai: sy, teks: `range ${fx(g1.range_atr, 1)}x ATR` }); }
  const skor = 100 * (0.30 * v + 0.25 * dis + 0.22 * f + 0.13 * pr + 0.10 * sy);
  const label = skor < 30 ? 'Rendah' : skor < 50 ? 'Sedang' : skor < 70 ? 'Tinggi' : 'Sangat tinggi';
  const [tambah, pengali, tpMaks, minNeff] = EFEK[label];
  const cara = `Syarat sinyal ekspektasi >= ${fr(AMBANG_E + tambah)}` + (pengali < 1 ? `, risiko dipotong ke ${fx(pengali * 100)}%` : '') +
    (tpMaks ? `, TP2 maksimal ${fg(tpMaks)}R` : '') + (minNeff > MIN_NEFF ? `, butuh >= ${fx(minNeff)} kejadian serupa` : '') + '.';
  return { skor, label, komponen: komp, tambah, pengali, tp_maks: tpMaks, min_neff: minNeff, cara };
}

/** Tarik TP ke depan level lawan bila level itu berada di 60-100% jalan menuju TP. */
function snapTp(entry, d, R, k, P, level, a) {
  const tp = entry + d * k * R;
  let best = null;
  for (const [nama, x] of level) {
    if ((x - entry) * d > 0 && (tp - x) * d > 0 && (x - entry) * d >= 0.6 * (tp - entry) * d) {
      if (!best || (x - entry) * d < (best[1] - entry) * d) best = [nama, x];
    }
  }
  if (!best) return [tp, k, interp(k, K_TP, P), null];
  const tp2 = best[1] - d * 0.05 * a, k2 = (tp2 - entry) * d / R;
  return [tp2, k2, interp(k2, K_TP, P), best[0]];
}
function levelSaran(kb, kd) {
  const lv = ((kb || {}).level || []).filter(x => x.harga).map(x => [x.nama, +x.harga]);
  for (const [nm, key] of [['Swing high', 'swing_high'], ['Swing low', 'swing_low']])
    for (const z of (kd || {})[key] || []) lv.push([`${nm} ${kd.tf_label || ''}`.trim(), +z[1]]);
  return lv;
}
/** Faktor realisasi/harapan dari uji walk-forward (ekspektasi memori cenderung optimis). */
function kalibrasi(val) {
  const e = val.e_lolos, h = val.e_harap;
  if (e == null || !h || h <= 0) return 0.5;
  return klip(e / h, 0.2, 1.0);
}
function ringkasVal(v) {
  const o = {}; for (const k of ['status', 'n_lolos', 'tp1', 'tp2', 'e_lolos', 'pf_lolos', 'e_semua', 'p1_semua', 'blokir', 'per_hari', 'e_harap']) o[k] = v[k] ?? null;
  o.lipatan = (v.lipatan || []).map(z => ({ n: z.n, e: z.e }));
  return o;
}

function sinyalPA(sym, mode, px, kb, ramalan, plan, setelan, mem, keadaan, unc) {
  const t0 = now(), tfs = TF_MODE[mode], rz = (kb || {}).rezim || {}, calon = [];
  for (const tf of tfs) {
    const ms = TF_MS[tf], val = kvGet(`pa_validasi:${sym}:${tf}`) || {}, kd = keadaan.get(sym + '|' + tf) || {}, G = gudang(sym, tf);
    if (!G) continue;
    const batas = t0 - (SEGAR[tf] + 1) * ms;
    for (let i = G.n - 1; i >= 0 && G.t[i] >= batas; i--) {
      if (G.sumber[i] !== 1) continue;
      const t = G.t[i];
      if (t0 - (t + ms) > SEGAR[tf] * ms) continue;
      const pola = POLA_URUT[G.pola[i]], d = G.arah[i], harga = G.harga[i], sl = G.sl[i], R0 = G.r[i], a = G.atr[i];
      const tren = G.tren[i], lok = G.lokasi[i], vol = G.vol[i], sesi = SESI_URUT[G.sesi[i]], adr = G.nul('adr', i);
      const c = { id: G.id(i), tf, t, t_tutup: t + ms, pola, nama: POLA[pola], arah: d, harga, sl, atr: a, level: LEVEL_NAMA[G.level[i]],
        level_harga: G.nul('level_harga', i), validasi: val.status || 'belum diuji', konteks: teksKonteksBaris(tren, lok, vol, sesi, adr), berlaku: t + ms + SEGAR[tf] * ms };
      if (G.kena_sl[i] === 1 || (px - sl) * d <= 0) { calon.push({ ...c, status: 'BATAL', alasan: 'SL pola sudah tersentuh' }); continue; }
      const maju = R0 ? (px - harga) * d / R0 : 0;
      if (maju > 0.6) { calon.push({ ...c, status: 'TERLAMBAT', alasan: `harga sudah lari ${fmt(maju, 1)}R dari close pola` }); continue; }
      const [entry, jenis] = maju > 0.25 ? [harga, d > 0 ? 'Buy limit' : 'Sell limit'] : [px, 'Market'];
      const R = (entry - sl) * d;
      if (R <= 0.25 * a) { calon.push({ ...c, status: 'BATAL', alasan: 'jarak ke SL terlalu sempit untuk biaya' }); continue; }
      const biayaR = biayaSym(sym) * entry / R;
      const [st, paruh] = mem.statistik(sym, tf, kunciKonteks(pola, d, tren, lok, vol, sesi, adr));
      let [tg, tolak] = putuskan(st, biayaR, unc.tambah, unc.min_neff, paruh);
      const blok = (val.blokir || []).includes(pola), aktif = val.status === 'aktif' && !blok;
      Object.assign(c, { entry, jenis_entry: jenis, r: R, biaya_r: biayaR, n: st ? st.n : 0, n_eff: st ? st.n_eff : 0, n_maju: st ? st.n_maju : 0, tingkat: st ? st.tingkat : 0 });
      if (!st) { calon.push({ ...c, status: 'PANTAU', alasan: 'belum ada contoh serupa di memori' }); continue; }
      tg = tg || tangga(st.P, st.E, biayaR);
      tg = { ...tg, k: [...tg.k], p: [...tg.p] };
      if (unc.tp_maks && tg.k[1] > unc.tp_maks) {
        const i2 = cariKanan(K_TP, unc.tp_maks) - 1;
        tg.k[1] = K_TP[i2]; tg.p[1] = st.P[i2]; tg.e = st.E[i2] - biayaR;
        if (tg.k[2] < tg.k[1] + 0.5) { const i3 = Math.min(NK - 1, i2 + 2); tg.k[2] = K_TP[i3]; tg.p[2] = st.P[i3]; }
      }
      const lv = levelSaran(kb, { ...kd, tf_label: tf.toUpperCase() }), tp = [], tk = [], tpP = [], snap = [];
      for (let j = 0; j < 3; j++) {
        let x, k, p, s;
        if (j < 2) [x, k, p, s] = snapTp(entry, d, R, tg.k[j], st.P, lv, a);
        else { x = entry + d * tg.k[2] * R; k = tg.k[2]; p = tg.p[2]; s = null; }
        tp.push(x); tk.push(k); tpP.push(p); snap.push(s);
      }
      const kal = kalibrasi(val);
      let searahPlan = null;
      if (plan && (plan.aksi === 'BUY' || plan.aksi === 'SELL')) searahPlan = (plan.aksi === 'BUY') === (d > 0);
      const searahPred = (ramalan && ramalan.length) ? (ramalan[0].p_naik >= 50) === (d > 0) : null;
      let mutu = 40 + klip(tg.e * kal * 120, -20, 30) + klip(Math.log2(Math.max(st.n_eff, 1) / 30) * 5, 0, 10);
      mutu += tren > 0 ? 8 : tren < 0 ? -6 : 0;
      mutu += searahPlan ? 6 : searahPlan === false ? -6 : 0;
      mutu += searahPred ? 3 : 0;
      mutu += aktif ? 8 : -15;
      mutu -= unc.skor * 0.15;
      mutu = klip(mutu, 0, 100);
      Object.assign(c, { tp, tp_k: tk, tp_p: tpP, tp_level: snap, k_opt: tg.k_opt, e: tg.e, e_kal: tg.e * kal, kalibrasi: kal, mutu,
        searah_plan: searahPlan, searah_pred: searahPred, p_maju_1r: null });
      if (tolak && tg.e <= 0) Object.assign(c, { status: 'ABAIKAN', alasan: `menurut memori pola ini di konteks ini rata-rata ${fr(tg.e)} per transaksi` });
      else if (tolak) Object.assign(c, { status: 'PANTAU', alasan: tolak });
      else if (blok) Object.assign(c, { status: 'PANTAU', alasan: `${POLA[pola]} di ${tf.toUpperCase()} diblokir uji walk-forward (merugi di data baru)` });
      else if (!aktif) Object.assign(c, { status: 'PANTAU', alasan: `timeframe ${tf.toUpperCase()} belum lolos uji walk-forward (${val.status || 'belum diuji'})` });
      else Object.assign(c, { status: 'SINYAL', alasan: '' });
      calon.push(c);
    }
  }
  const urut = { SINYAL: 0, PANTAU: 1, ABAIKAN: 2, TERLAMBAT: 3, BATAL: 4 };
  calon.sort((a, b) => ((urut[a.status] ?? 9) - (urut[b.status] ?? 9)) || ((b.mutu || 0) - (a.mutu || 0)));
  const utama = calon.length && ['SINYAL', 'PANTAU'].includes(calon[0].status) ? calon[0] : null;
  const valAll = {}; for (const tf of tfs) valAll[tf] = ringkasVal(kvGet(`pa_validasi:${sym}:${tf}`) || {});
  const out = { sym, mode, t: t0, harga: px, calon: calon.slice(0, 6), ketidakpastian: unc, validasi: valAll, pantau: pantauPA(sym, mode, px, kb, mem, keadaan, unc) };
  if (!utama) return { ...out, aksi: 'TUNGGU', status: 'TUNGGU' };
  const d = utama.arah, aksi = utama.status === 'SINYAL' ? AB(d) : 'PANTAU';
  const pengali = +(rz.pengali_risiko || 1.0) * unc.pengali;
  const lot = utama.r ? hitungLot(setelan, sym, utama.r, pengali) : null;
  for (const k of ['id', 'tf', 'pola', 'nama', 'arah', 'entry', 'jenis_entry', 'sl', 'r', 'tp', 'tp_k', 'tp_p', 'tp_level', 'e', 'e_kal', 'kalibrasi', 'n', 'n_eff',
    'n_maju', 'mutu', 'konteks', 'berlaku', 'level', 'level_harga', 't_tutup', 'alasan', 'harga', 'atr']) out[k] = utama[k] ?? null;
  Object.assign(out, { aksi, status: utama.status, lot, pengali, yakin: utama.mutu >= 70 ? 'Tinggi' : utama.mutu >= 55 ? 'Sedang' : 'Rendah',
    batal: `Batal bila harga menyentuh ${fmt(utama.sl)} sebelum entry` + (utama.jenis_entry !== 'Market' ? ` atau lewat ${wib(utama.berlaku)} WIB` : ''),
    alasan_teks: alasanSinyal(utama, kvGet(`pa_validasi:${sym}:${utama.tf}`) || {}) });
  if ((aksi === 'BUY' || aksi === 'SELL') && !sudahDisarankan(sym, utama.id)) {
    tandaiSaran(sym, utama.id, { t: t0, mode, entry: utama.entry, sl: utama.sl, k: utama.tp_k, p: utama.tp_p, e: utama.e, jenis: utama.jenis_entry });
    pikir(sym, 'sinyal', `${sym} ${MODE[mode].judul}: sinyal price action ${aksi} ${utama.nama} ${utama.tf.toUpperCase()} entry ${fmt(utama.entry)}, SL ${fmt(utama.sl)}, ` +
      `TP ${utama.tp.map(x => fmt(x)).join(' / ')} (memori ${utama.n} kejadian serupa, ekspektasi terkalibrasi ${fr(utama.e_kal)}). Hasilnya akan dinilai otomatis.`);
  }
  return out;
}

function alasanSinyal(c, val) {
  const out = [], lvl = c.level_harga ? ` (${c.level} ${fmt(c.level_harga)})` : '';
  out.push(`${c.nama} ${AB(c.arah)} di ${c.tf.toUpperCase()}${lvl}, candle tutup ${wib(c.t_tutup)} WIB.`);
  if (c.tp_p) out.push(`Memori ${c.n} kejadian serupa (${c.n_maju} dari pengamatan maju): TP1 ${fx(c.tp_p[0] * 100)}%, TP2 ${fx(c.tp_p[1] * 100)}%, ` +
    `TP3 ${fx(c.tp_p[2] * 100)}% tersentuh sebelum SL; ekspektasi ${fr(c.e)} (terkalibrasi ${fr(c.e_kal)}).`);
  if (val.n_lolos) out.push(`Uji walk-forward ${c.tf.toUpperCase()}: ${val.n_lolos} sinyal, TP1 ${fx(val.tp1 || 0)}%, rata-rata ${fr(val.e_lolos || 0)} per transaksi (status ${val.status}).`);
  if (c.searah_plan === true) out.push('Searah rencana strategi lab.');
  else if (c.searah_plan === false) out.push('Berlawanan dengan rencana strategi lab: kecilkan risiko atau tunggu keduanya searah.');
  const tarikTp = (c.tp_level || []).map((s, j) => (s ? `TP${j + 1} ke depan ${s}` : null)).filter(Boolean);
  if (tarikTp.length) out.push('Target ditarik agar tidak tertahan level lawan: ' + tarikTp.join(', ') + '.');
  if (c.alasan) out.push(`Belum direkomendasikan: ${c.alasan}.`);
  return out;
}

/** Level terdekat di atas & bawah + dua skenario tiap sisi (tolak/pantul vs tembus) dengan pola terbaik menurut memori. */
function pantauPA(sym, mode, px, kb, mem, keadaan, unc) {
  const tf = MODE[mode].tf_utama, kd = keadaan.get(sym + '|' + tf) || {}, a = kd.atr;
  if (!px || !a) return [];
  const val = kvGet(`pa_validasi:${sym}:${tf}`) || {}, kal = kalibrasi(val), lv = levelSaran(kb, { ...kd, tf_label: tf.toUpperCase() });
  const unik = arr => { const m = new Map(); for (const [n, x] of arr) m.set(n + '|' + Math.round(x * 100) / 100, [n, Math.round(x * 100) / 100]); return [...m.values()]; };
  const atas = unik(lv.filter(([, x]) => 0.05 * a < x - px && x - px <= 4 * a)).sort((p, q) => p[1] - q[1]);
  const bawah = unik(lv.filter(([, x]) => 0.05 * a < px - x && px - x <= 4 * a)).sort((p, q) => q[1] - p[1]);
  const tAtas = tanda(kd.arah_atas || 0), vol = Math.trunc(kd.vol ?? 1), sesi = sesiDari(now()), biayaR = biayaSym(sym) * px / a, out = [];
  const daftar = [['atas', atas, [['Tolak', -1, ['pin', 'sweep', 'engulf']], ['Tembus', 1, ['bos', 'inside', 'momentum']]]],
    ['bawah', bawah, [['Pantul', 1, ['pin', 'sweep', 'engulf']], ['Tembus', -1, ['bos', 'inside', 'momentum']]]]];
  for (const [sisi, dl, skenario] of daftar) {
    if (!dl.length) continue;
    const [nama, x] = dl[0];
    for (const [sk, d, polaList] of skenario) {
      let best = null;
      for (const pola of polaList) {
        if ((val.blokir || []).includes(pola)) continue;
        const [st] = mem.statistik(sym, tf, kunciKonteks(pola, d, tAtas * d, 1, vol, sesi, kd.adr));
        if (!st || st.n < 30) continue;
        const tg = tangga(st.P, st.E, biayaR);
        if (!best || tg.e > best.e) {
          best = { sisi, level: nama, harga: x, jarak_atr: (x - px) / a, skenario: sk, arah: d, pola, nama: POLA[pola], p1: tg.p[0], k1: tg.k[0], k2: tg.k[1], p2: tg.p[1],
            e: tg.e * kal, e_memori: tg.e, n: st.n, tf, validasi: val.status || 'belum diuji' };
        }
      }
      if (best) out.push(best);
    }
  }
  return out;
}

function teksOrderPA(sym, s) {
  if (!s || !(s.aksi === 'BUY' || s.aksi === 'SELL') || s.entry == null) return '';
  const dp = SIMBOL[sym].dp, f = v => (+v).toFixed(dp), lot = (s.lot || {}).lot;
  const b = [`${sym} ${s.aksi} (${s.nama} ${s.tf.toUpperCase()}, price action)`, `Entry: ${f(s.entry)} [${s.jenis_entry || ''}]`, `SL: ${f(s.sl)}`];
  s.tp.forEach((x, i) => b.push(`TP${i + 1}: ${f(x)} (${(+s.tp_k[i]).toFixed(2)}R, peluang ${fx(s.tp_p[i] * 100)}%)`));
  if (lot) b.push(`Lot: ${lot}`);
  b.push(s.batal || '');
  return b.filter(Boolean).join('\n');
}

// ================================================================== rekap memori (rekap.py)
// Tiap jam, tiap akhir sesi, dan tiap hari: apa yang terjadi vs kebiasaan pasar + hasil pola dan sinyal.
const SIMPAN_REKAP = { jam: 21, sesi: 180, harian: 3650 };

function jendelaRekap(P, t0, t1) {
  const M = P.bar('5m', 700), a = cariKiri(M.t, t0), b = cariKiri(M.t, t1);
  if (b - a < 3) return null;
  const W = {}; for (const k of KOL) W[k] = M[k].subarray(a, b);
  return W;
}
function ohlcW(W) { let h = -Infinity, l = Infinity; for (let i = 0; i < W.t.length; i++) { h = Math.max(h, W.h[i]); l = Math.min(l, W.l[i]); } return [W.o[0], h, l, W.c[W.c.length - 1]]; }
function polaMaju(sym, t0, t1) {
  const out = [];
  for (const tf of TF_BELAJAR) {
    const G = gudang(sym, tf); if (!G) continue;
    for (let i = cariKiri(G.t, t0, G.n); i < G.n && G.t[i] < t1; i++) {
      if (G.sumber[i] !== 1) continue;
      out.push({ tf, t: G.t[i], pola: POLA_URUT[G.pola[i]], arah: G.arah[i], status: STATUS_PA[G.status[i]], mfe: G.nul('mfe', i), kena_sl: G.nul('kena_sl', i),
        disarankan: G.disarankan[i], saran: G.saran.get(i) || null, r_akhir: G.nul('r_akhir', i), biaya_r: G.nul('biaya_r', i) });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}
function teksPola(evs, maks = 4) {
  if (!evs.length) return '';
  const hit = new Map();
  for (const e of evs) { const k = e.pola + '|' + e.arah + '|' + e.tf; hit.set(k, (hit.get(k) || 0) + 1); }
  const urut = [...hit.entries()].sort((a, b) => b[1] - a[1]);
  const bag = urut.slice(0, maks).map(([k, n]) => { const [p, d, tf] = k.split('|'); return `${POLA[p]} ${AB(+d)} ${tf.toUpperCase()}` + (n > 1 ? ` x${n}` : ''); });
  const lain = hit.size - maks;
  return bag.join(', ') + (lain > 0 ? ` dan ${lain} lainnya` : '');
}
function hasilPola(evs) {
  const sel = evs.filter(e => e.status === 'selesai');
  if (!sel.length) return null;
  const kena = sel.filter(e => (e.mfe || 0) >= 1.0).length, sl = sel.filter(e => e.kena_sl && (e.mfe || 0) < 1.0).length;
  return { n: sel.length, kena_1r: kena, sl, porsi: kena / sel.length * 100 };
}
function sinyalRekap(evs) {
  const s = evs.filter(e => e.disarankan);
  if (!s.length) return null;
  const sel = s.filter(e => e.status === 'selesai');
  let tp1 = 0, tp2 = 0; const rs = [];
  for (const e of sel) {
    const k = (e.saran && e.saran.k) || [1.0, 2.0, 3.0], mfe = e.mfe || 0;
    if (mfe >= k[0]) tp1++; if (mfe >= k[1]) tp2++;
    rs.push((mfe >= k[1] ? k[1] : (e.r_akhir != null ? e.r_akhir : -1.0)) - (e.biaya_r || 0));
  }
  return { n: s.length, selesai: sel.length, tp1, tp2, r: rs.length ? jumlah(rs) : null };
}
function simpanRekap(sym, jenis, t0, t1, judul, isi, data) {
  const i = TBL.rekap.findIndex(r => r.sym === sym && r.jenis === jenis && r.t1 === t1);
  const row = { sym, jenis, t0, t1, judul, isi, data, dibuat: now() };
  if (i >= 0) TBL.rekap[i] = row; else TBL.rekap.push(row);
  TBL_KOTOR.add('rekap');
}

function rekapJam(sym, P, t0, kb) {
  const W = jendelaRekap(P, t0, t0 + HOUR);
  if (!W || W.t.length < 6) return null;
  const [o, h, l, c] = ohlcW(W), jamU = jamUtc(t0);
  const prof = ((kb || {}).jam || []).find(j => j.jam_utc === jamU);
  const x = prof && prof.range ? (h - l) / prof.range : null, evs = polaMaju(sym, t0, t0 + HOUR);
  let isi = `${c > o ? 'Naik' : c < o ? 'Turun' : 'Datar'} ${fs((c / o - 1) * 100, 2, '%')} (${fmt(o)} ke ${fmt(c)}), range ${fmt(h - l)}`;
  if (x != null) { isi += ` = ${fmt(x, 1)}x kebiasaan jam ini`; if (prof.p_naik != null) isi += ` (biasanya naik ${fmt(prof.p_naik, 0)}%)`; }
  isi += '.';
  if (evs.length) isi += ` ${evs.length} pola price action: ${teksPola(evs)}.`;
  const s = sinyalRekap(evs);
  if (s) isi += ` ${s.n} sinyal disarankan.`;
  return [`${wib(t0)}-${wib(t0 + HOUR)} WIB`, isi, { o, h, l, c, kali_kebiasaan: x, n_pola: evs.length }];
}

function rekapSesi(sym, P, nama, t0, t1, kb) {
  const W = jendelaRekap(P, t0, t1);
  if (!W || W.t.length < 12) return null;
  const [o, h, l, c] = ohlcW(W), hb = ((kb || {}).sesi || []).find(s => s.nama === nama);
  const bag = [`${c > o ? 'Naik' : c < o ? 'Turun' : 'Datar'} ${fs((c / o - 1) * 100, 2, '%')} (${fmt(o)} ke ${fmt(c)}), high ${fmt(h)}, low ${fmt(l)}, range ${fmt(h - l)}` +
    (hb && hb.range ? ` = ${fmt((h - l) / hb.range, 1)}x rata-rata sesi ini` : '') + '.'];
  if (hb && hb.p_naik != null) bag.push(`Kebiasaan sesi ${nama}: naik ${fmt(hb.p_naik, 0)}% hari (${((c > o) === (hb.p_naik >= 50)) ? 'sesuai' : 'berbeda dengan'} kebiasaan).`);
  const d0 = Math.floor(t0 / DAY) * DAY;
  if (nama === 'London' || nama === 'New York') {
    const A = jendelaRekap(P, d0, d0 + 7 * HOUR);
    if (A && A.t.length >= 12) {
      const [, ahi, alo] = ohlcW(A);
      let up = -1, dn = -1;
      for (let i = 0; i < W.t.length; i++) { if (up < 0 && W.h[i] > ahi) up = i; if (dn < 0 && W.l[i] < alo) dn = i; }
      if (up >= 0 || dn >= 0) {
        const pertama = (up >= 0 && (dn < 0 || up < dn)) ? 'atas' : 'bawah';
        bag.push(`Range Asia ${fmt(alo)}-${fmt(ahi)} ditembus ke ${pertama} lebih dulu` + (up >= 0 && dn >= 0 ? ', lalu juga ke sisi lain' : '') + '.');
      } else bag.push(`Range Asia ${fmt(alo)}-${fmt(ahi)} tidak ditembus di sesi ini.`);
    }
  }
  const evs = polaMaju(sym, t0, t1);
  if (evs.length) {
    bag.push(`${evs.length} pola: ${teksPola(evs)}.`);
    const hp = hasilPola(evs);
    if (hp) bag.push(`Yang sudah selesai: ${hp.kena_1r} dari ${hp.n} mencapai 1R sebelum SL, ${hp.sl} kena SL.`);
  }
  const s = sinyalRekap(evs);
  if (s) bag.push(`Sinyal disarankan ${s.n}` + (s.selesai ? `, selesai ${s.selesai}: TP1 ${s.tp1}, TP2 ${s.tp2}, total ${fr(s.r)}` : '') + '.');
  return [`Sesi ${nama} ${wib(t0, '%d/%m')} (${wib(t0)}-${wib(t1)} WIB)`, bag.join(' '), { o, h, l, c, n_pola: evs.length, sinyal: s }];
}

function rekapHarian(sym, P, d0, kb, mem) {
  const W = jendelaRekap(P, d0, d0 + DAY);
  if (!W || W.t.length < 24) return null;
  const [o, h, l, c] = ohlcW(W);
  const bag = [`${c > o ? 'Naik' : c < o ? 'Turun' : 'Datar'} ${fs((c / o - 1) * 100, 2, '%')} (${fmt(o)} ke ${fmt(c)}), high ${fmt(h)} / low ${fmt(l)}.`];
  const ad = (kb || {}).adr || {};
  if (ad.adr20) { const x = (h - l) / ad.adr20; bag.push(`Range ${fmt(h - l)} = ${fmt(x * 100, 0)}% ADR20 (${fmt(ad.adr20)})` + (x > 1.3 ? ' — hari lebar' : x < 0.7 ? ' — hari sempit' : '') + '.'); }
  let ih = 0, il = 0; for (let i = 1; i < W.t.length; i++) { if (W.h[i] > W.h[ih]) ih = i; if (W.l[i] < W.l[il]) il = i; }
  bag.push(`High dibuat sesi ${sesiDari(W.t[ih])} (${wib(W.t[ih])} WIB), low sesi ${sesiDari(W.t[il])} (${wib(W.t[il])} WIB).`);
  const re_ = SIMBOL[sym].sesi_preset.range_end, A = jendelaRekap(P, d0, d0 + re_ * HOUR), asia = (kb || {}).asia || {};
  if (A && A.t.length >= 12) {
    const [, ahi, alo] = ohlcW(A), s0 = cariKiri(W.t, d0 + re_ * HOUR);
    if (s0 < W.t.length) {
      let up = -1, dn = -1;
      for (let i = s0; i < W.t.length; i++) { if (up < 0 && W.h[i] > ahi) up = i; if (dn < 0 && W.l[i] < alo) dn = i; }
      if (up >= 0 || dn >= 0) {
        const arah = (up >= 0 && (dn < 0 || up < dn)) ? 1 : -1, lanjut = (arah > 0 && c > ahi) || (arah < 0 && c < alo), kembali = alo <= c && c <= ahi;
        let t = `Range awal hari ${fmt(alo)}-${fmt(ahi)} pecah ke ${arah > 0 ? 'atas' : 'bawah'} lebih dulu dan ` +
          (lanjut ? 'ditutup searah' : kembali ? 'ditutup kembali di dalam range' : 'ditutup di sisi lain');
        if (asia.hari) t += ` (kebiasaan: lanjut ${fmt(asia.p_lanjut, 0)}%, kembali ${fmt(asia.p_palsu, 0)}% dari ${asia.hari} hari)`;
        bag.push(t + '.');
      } else bag.push(`Range awal hari ${fmt(alo)}-${fmt(ahi)} tidak pecah (kebiasaan pecah ${fmt(asia.p_pecah, 0)}% hari).`);
    }
  }
  const evs = polaMaju(sym, d0, d0 + DAY), data = { o, h, l, c, n_pola: evs.length };
  if (evs.length) {
    bag.push(`Memori merekam ${evs.length} pola price action baru: ${teksPola(evs, 5)}.`);
    const hp = hasilPola(evs);
    if (hp) {
      const harap = [];
      for (const tf of TF_BELAJAR) for (const ab of [0, 1]) { const st = statistikDari(mem.pref(sym, tf).pref, [ab], 1); if (st) harap.push(st.P[2]); }
      const hb = harap.length ? ` (kebiasaan ${fmt(rata(harap) * 100, 0)}%)` : '';
      bag.push(`Selesai dinilai ${hp.n}: ${hp.kena_1r} mencapai 1R sebelum SL (${fmt(hp.porsi, 0)}%${hb}), ${hp.sl} kena SL.`);
      data.hasil_pola = hp;
      const per = {};
      for (const e of evs) if (e.status === 'selesai') (per[e.pola] = per[e.pola] || []).push((e.mfe || 0) >= 1.0 ? 1.0 : (e.r_akhir != null ? e.r_akhir : -1.0));
      const kunci = Object.keys(per).filter(k => per[k].length >= 3);
      if (kunci.length) {
        const best = kunci.reduce((x, y) => (rata(per[y]) > rata(per[x]) ? y : x)), worst = kunci.reduce((x, y) => (rata(per[y]) < rata(per[x]) ? y : x));
        bag.push(`Paling berhasil: ${POLA[best]} (${fr(rata(per[best]))} rata-rata target 1R, ${per[best].length} kali)` +
          (worst !== best ? `; paling buruk: ${POLA[worst]} (${fr(rata(per[worst]))}, ${per[worst].length} kali)` : '') + '.');
      }
    }
  }
  const s = sinyalRekap(evs);
  if (s) { bag.push(`Sinyal price action disarankan: ${s.n}` + (s.selesai ? `; selesai ${s.selesai}: TP1 ${s.tp1}, TP2 ${s.tp2}, total ${fr(s.r)}` : '') + '.'); data.sinyal = s; }
  const pr = TBL.prediksi.filter(r => r.sym === sym && r.dievaluasi === 1 && r.t_matang >= d0 && r.t_matang < d0 + DAY + HOUR && r.kena_arah != null);
  if (pr.length) { const k = pr.reduce((s2, r) => s2 + r.kena_arah, 0); bag.push(`Prediksi analog yang jatuh tempo: ${k} dari ${pr.length} arahnya benar (${fmt(k / pr.length * 100, 0)}%).`); data.prediksi = { n: pr.length, benar: k }; }
  const ubah = [];
  for (const tf of TF_BELAJAR) for (const row of mem.tabel(sym, [tf], null)) {
    const dr = row.drift;
    if (dr && dr.status !== 'stabil') ubah.push([Math.abs(dr.z), `${row.nama} ${AB(row.arah)} ${tf.toUpperCase()} ${dr.status} (TP 1R 30 hari ${fmt(dr.p1_baru, 0)}% vs sebelumnya ${fmt(dr.p1_lama, 0)}%)`]);
  }
  if (ubah.length) { ubah.sort((a, b) => b[0] - a[0]); bag.push('Kebiasaan berubah: ' + ubah.slice(0, 3).map(u => u[1]).join('; ') + '.'); data.berubah = ubah.slice(0, 6).map(u => u[1]); }
  bag.push(`Besok: PDH ${fmt(h)}, PDL ${fmt(l)}.`);
  return [`Harian ${HARI[hariKe(d0)]} ${wib(d0, '%d/%m/%Y')}`, bag.join(' '), data];
}

/** Buat rekap yang sudah jatuh tempo. pasarFn(sym) → Pasar; kbMap: {sym: kebiasaan}. */
function periksaRekap(pasarFn, kbMap, mem, siapFn, t = null) {
  t = t || now();
  const dibuat = [];
  for (const sym of SYMS) {
    if (siapFn && !siapFn(sym)) continue;
    let P = null;
    const kb = kbMap[sym] || {};
    // --- jam ---
    let k = `rekap_kursor:jam:${sym}`;
    const tDue = Math.floor((t - 60000) / HOUR) * HOUR;
    let kur = kvGet(k) ?? (tDue - HOUR);
    for (let t1 = Math.max(kur + HOUR, tDue - 6 * HOUR); t1 <= tDue; t1 += HOUR) {
      P = P || pasarFn(sym);
      const r = rekapJam(sym, P, t1 - HOUR, kb);
      if (r) { simpanRekap(sym, 'jam', t1 - HOUR, t1, ...r); dibuat.push([sym, 'jam', t1]); }
      kvSet(k, t1);
    }
    // --- sesi ---
    k = `rekap_kursor:sesi:${sym}`;
    const ujung = [];
    for (const hari of [Math.floor(t / DAY) - 1, Math.floor(t / DAY)]) for (const [nama, a, b] of SESI) {
      const t1 = hari * DAY + b * HOUR;
      if (t1 + 60000 <= t) ujung.push([t1, nama, hari * DAY + a * HOUR]);
    }
    ujung.sort((x, y) => x[0] - y[0]);
    kur = kvGet(k);
    if (kur == null) kur = ujung.length >= 2 ? ujung[ujung.length - 2][0] : 0;
    for (const [t1, nama, t0] of ujung) {
      if (t1 <= kur) continue;
      P = P || pasarFn(sym);
      const r = rekapSesi(sym, P, nama, t0, t1, kb);
      if (r) { simpanRekap(sym, 'sesi', t0, t1, ...r); dibuat.push([sym, 'sesi', t1]); }
      kvSet(k, t1);
    }
    // --- harian ---
    k = `rekap_kursor:harian:${sym}`;
    const dDue = Math.floor((t - 120000) / DAY) * DAY;
    kur = kvGet(k);
    if (kur == null) kur = dDue - DAY;
    for (let d1 = Math.max(kur + DAY, dDue - 2 * DAY); d1 <= dDue; d1 += DAY) {
      P = P || pasarFn(sym);
      const r = rekapHarian(sym, P, d1 - DAY, kb, mem);
      if (r) { simpanRekap(sym, 'harian', d1 - DAY, d1, ...r); dibuat.push([sym, 'harian', d1]); pikir(sym, 'rekap', `${sym} rekap ${r[0]}: ${r[1].slice(0, 400)}`); }
      kvSet(k, d1);
    }
  }
  if (dibuat.length) {
    TBL.rekap = TBL.rekap.filter(r => r.t1 >= t - (SIMPAN_REKAP[r.jenis] || 3650) * DAY);
    TBL_KOTOR.add('rekap');
  }
  return dibuat;
}
function daftarRekap(sym, n = 12, jenis = null) {
  return TBL.rekap.filter(r => r.sym === sym && (!jenis || r.jenis === jenis)).sort((a, b) => (b.t1 - a.t1) || (b.dibuat - a.dibuat)).slice(0, n)
    .map(r => ({ jenis: r.jenis, t0: r.t0, t1: r.t1, judul: r.judul, isi: r.isi }));
}
function rekapTerbaru(sym) {
  const out = {};
  for (const j of ['harian', 'sesi', 'jam']) { const r = daftarRekap(sym, j === 'jam' ? 3 : 1, j); if (r.length) out[j] = r; }
  return out;
}

// ================================================================== analisis tertulis (narasi.py) — deterministik, tanpa angka karangan
const MODE_NAMA = { scalp: 'scalping', swing: 'swing' };
function susunNarasi(sym, mode, st) {
  const dp = 2, px = st.harga, kb = st.kebiasaan || {}, rz = kb.rezim || {}, rc = (st.rencana || {}).utama, out = [];
  let head = `${sym} ${fmt(px, dp)}`;
  if (kb.sesi_kini) head += ` (sesi ${kb.sesi_kini})`;
  head += `. Sumber harga: ${st.sumber || '-'}.`;
  out.push(head);
  if (Object.keys(rz).length) {
    let s = `Kondisi: tren 4H ${rz.tren_4h || '-'}`;
    if (rz.adx_4h != null) s += ` (ADX ${fx(rz.adx_4h)})`;
    s += `, volatilitas ${rz.vol || '-'} (persentil ${fx(rz.vol_persentil || 0)} dari 180 hari).`;
    out.push(s);
  }
  const ad = kb.adr;
  if (ad) out.push(`Range harian rata-rata ${fmt(ad.adr20, dp)}; hari ini ${fmt(ad.range_hari_ini, dp)} (${fx(ad.persen)}% terpakai), proyeksi wajar ${fmt(ad.proyeksi_bawah, dp)} - ${fmt(ad.proyeksi_atas, dp)}.`);
  if (rc) {
    if (rc.aksi === 'TUNGGU') out.push(`Rencana ${MODE_NAMA[mode]}: TUNGGU — ${rc.pemicu || ''}. ` + (rc.alasan || []).slice(0, 2).join(' '));
    else {
      const lot = (rc.lot || {}).lot;
      let s = `Rencana ${MODE_NAMA[mode]} (${rc.nama}, grade ${rc.grade}, keyakinan ${(rc.yakin || '-').toLowerCase()}): ${rc.aksi} ${rc.jenis_entry || ''} di ${fmt(rc.entry, dp)}, SL ${fmt(rc.sl, dp)}, ` +
        `TP1 ${fmt(rc.tp[0], dp)} / TP2 ${fmt(rc.tp[1], dp)} / TP3 ${fmt(rc.tp[2], dp)}`;
      if (lot) s += `, lot ${lot} per layer`;
      out.push(s + '.');
      if (rc.status === 'SIAP') out.push(`Pemicu: ${rc.pemicu}.`);
      const lay = (rc.layer || []).slice(1);
      if (lay.length) out.push('Layer piramida (ditambah hanya saat harga maju, total rugi terburuk tetap ±1R): ' + lay.map(L => `L${L.ke} ${fmt(L.harga, dp)}`).join('; ') + '.');
      const stt = rc.statistik || {}, tp = stt.tp_peluang || {};
      if (stt.pf) {
        let s2 = `Uji balik (${stt.sumber}): PF ${fmt(stt.pf)}`;
        if (stt.n) s2 += `, ${stt.n} transaksi`;
        if (stt.wr != null) s2 += `, menang ${fx(stt.wr)}%`;
        if (Object.keys(tp).length) s2 += `; peluang menyentuh TP1/TP2/TP3 sebelum SL awal ${fx(tp['1R'] || 0)}% / ${fx(tp['2R'] || 0)}% / ${fx(tp['3R'] || 0)}%`;
        out.push(s2 + '.');
      }
      const fw = rc.forward;
      if (fw && fw.n) out.push(`Forward-test nyata strategi ini: ${fw.n} sinyal selesai, menang ${fx(fw.wr)}%, total ${fmt(fw.sum)}R.`);
    }
  }
  if (st.konflik) out.push(st.konflik);
  const ps = st.pa || {};
  if (ps.aksi === 'BUY' || ps.aksi === 'SELL') {
    const tp = ps.tp || [], pp = ps.tp_p || [];
    out.push(`Sinyal price action (${ps.nama} ${String(ps.tf).toUpperCase()}, keyakinan ${String(ps.yakin || '-').toLowerCase()}): ${ps.aksi} ${ps.jenis_entry || ''} di ${fmt(ps.entry, dp)}, SL ${fmt(ps.sl, dp)}, ` +
      tp.map((x, i) => `TP${i + 1} ${fmt(x, dp)} (${fx((pp[i] || 0) * 100)}%)`).join(' / ') + `; ekspektasi terkalibrasi ${fr(ps.e_kal || 0)} per transaksi. ${ps.batal || ''}.`);
  } else if (ps.aksi === 'PANTAU') {
    out.push(`Price action: ${ps.nama} ${String(ps.tf).toUpperCase()} ${(ps.arah || 0) > 0 ? 'BUY' : 'SELL'} terdeteksi di ${fmt(ps.harga, dp)} tetapi belum direkomendasikan (${ps.alasan}).`);
  } else if (Object.keys(ps).length) {
    const pn = ps.pantau || [];
    if (pn.length) out.push('Price action: belum ada pola segar. Pantau: ' + pn.slice(0, 3).map(x =>
      `${x.level} ${fmt(x.harga, dp)} (${x.jarak_atr > 0 ? '+' : ''}${fmt(x.jarak_atr, 1)} ATR): ${x.skenario.toLowerCase()} ${x.nama.toLowerCase()} ${x.arah > 0 ? 'BUY' : 'SELL'} ` +
      `(TP1 ${fx(x.p1 * 100)}%, ${fr(x.e)}, ${x.n} contoh${x.validasi === 'aktif' ? '' : ', belum lolos uji'})`).join('; ') + '.');
  }
  const un = st.ketidakpastian || {};
  if (un.label) {
    const top = [...(un.komponen || [])].sort((a, b) => b.nilai - a.nilai).slice(0, 2);
    out.push(`Ketidakpastian pasar ${un.label.toLowerCase()} (${fx(un.skor)}/100): ` + top.map(z => `${z.nama.toLowerCase()} ${z.teks}`).join('; ') + `. ${un.cara || ''}`);
  }
  const rk = ((st.rekap || {}).jam || [])[0];
  if (rk) out.push(`Rekap ${rk.judul}: ${rk.isi}`);
  const pr = st.prediksi || [];
  if (pr.length) {
    out.push('Prediksi analog: ' + pr.map(p => `${p.label}: peluang naik ${fx(p.p_naik)}% (dasar ${fx(p.p_dasar)}%), rentang 80% ${fmt(p.q10, dp)} - ${fmt(p.q90, dp)}`).join('; ') + '.');
    const a0 = (st.akurasi || {})[pr[0].label];
    if (a0) out.push(`Akurasi historis prediksi ${pr[0].label}: arah ${fx(a0.arah)}% (acak = 50%), rentang 80% tepat ${fx(a0.band80)}%.` +
      (a0.arah < 55 ? ' Keunggulan arah kecil — pakai sebagai konteks, bukan alasan entry.' : ''));
  }
  for (const c of (rz.saran || []).slice(0, 2)) out.push(c);
  for (const c of (kb.catatan || []).slice(0, 2)) out.push(c);
  out.push('Ini perhitungan statistik, bukan kepastian atau nasihat keuangan. Gunakan risiko kecil dan patuhi SL.');
  return out;
}
// ================================================================== mesin (server.py versi Web Worker)
// Penjadwal real-time: harga ±1 dtk per sumber; candle TF ±1,5 dtk setelah tutup + tiap 15/60 dtk; rencana + sinyal
// price action 2 dtk; memori belajar 3 dtk; rekap jam/sesi/harian; jurnal 1 mnt; kebiasaan 2 mnt; prediksi tiap candle
// 15m/1h tutup atau 5 mnt; lab otonom dan uji walk-forward harian / saat diminta. Segarkan = bangunkan semua loop,
// berurutan feed → memori → rencana. Hanya membaca pasar — tidak pernah mengirim order.
const VERSI_WEB = 'd01ba020f4db';
const JEDA_LOOP = { feed: 1.0, hitung: 2.0, berkala: 5.0, belajar: 3.0 };

class Putaran {
  constructor(nama) { this.nama = nama; this.minta = 0; this.dilayani = 0; this.t = 0; this._bangun = null; this._tm = null; this._set = false; }
  awal() { const g = this.minta; return [g, g > this.dilayani]; }
  async akhir(g) {
    this.dilayani = Math.max(this.dilayani, g);
    this.t = now();
    if (this._set) { this._set = false; await tidur(0); return; }
    await new Promise(r => { this._bangun = r; this._tm = setTimeout(r, JEDA_LOOP[this.nama] * 1000); });
    this._bangun = null; this._set = false;
  }
  colek() { if (this._bangun) { clearTimeout(this._tm); const r = this._bangun; this._bangun = null; r(); } else this._set = true; }
  bangun() { this.minta++; this.colek(); return this.minta; }
  async tunggu(g, batasMs) { const akhir = now() + batasMs; while (this.dilayani < g) { if (now() > akhir) return false; await tidur(30); } return true; }
}

class Mesin {
  constructor() {
    this.feed = new Feed();
    this.cache = new Map(); this.hasil = new Map(); this.ramal = new Map(); this.tabel = new Map(); this.lihat = new Map();
    this.kb = {}; for (const s of SYMS) this.kb[s] = (TBL.kebiasaan || {})[s] || null;
    this.fwd = {}; this.progres = {}; this.galat = {};
    this.labJalan = false; this.labProgres = null; this.belajarJalan = false;
    this.pb = new Pembelajar();
    this.putaran = {}; for (const n of Object.keys(JEDA_LOOP)) this.putaran[n] = new Putaran(n);
    this.paksaSym = null; this.hasilFeed = {}; this.segarInfo = {}; this.segarJanji = null;
    this._ramalBar = {}; this._blCache = new Map();
    this.webTerbaru = VERSI_WEB; this.tMulai = now();
    this._jurnalIdx = new Map(); for (const r of TBL.sinyal) this._jurnalIdx.set(r.kunci, r);
    if (!kvGet('mulai_jurnal')) {
      kvSet('mulai_jurnal', now());
      pikir('', 'mulai', 'Trading AI Yulius mulai merekam pasar BTCUSDT dan XAUUSDm di perangkat ini. Jurnal forward-test dimulai sekarang.');
    }
    this.mulaiJurnal = kvGet('mulai_jurnal');
  }

  setelan() {
    const s = { ...RISIKO_DEFAULT }, kurs = kvGet('usd_idr');
    if (kurs) s.usd_idr = +kurs;
    Object.assign(s, kvGet('setelan') || {});
    return s;
  }

  mulai() {
    const loops = [[() => this.loopFeed(), 'loop_feed'], [() => this.loopHitung(), 'loop_hitung'], [() => this.loopBerkala(), 'loop_berkala'],
      [() => this.loopBelajar(), 'loop_belajar'], [() => this.loopVersi(), 'loop_versi']];
    for (const s of BINANCE_SERI) loops.push([() => this.loopHarga(s), 'loop_harga ' + s]);
    for (const [f, nama] of loops) this._aman(f, nama);
    this.feed.saatSiap = () => { for (const n of ['berkala', 'belajar', 'hitung']) this.putaran[n].colek(); };
    this.feed.isiAwal((sym, tf, t, frac) => { this.progres.riwayat = { sym, tf, sampai: t, frac: frac || 0 }; })
      .catch(e => { this.galat.riwayat = teksGalat(e); })
      .finally(() => { delete this.progres.riwayat; simpanKe(true); });
  }
  async _aman(f, nama) {
    for (;;) {
      try { await f(); }
      catch (e) { this.galat[nama] = teksGalat(e).slice(0, 1500); console.error(nama, e); await tidur(5000); }
    }
  }

  // ---------- loop ----------
  async loopHarga(seri) {
    for (;;) {
      const t0 = now(), ok = await this.feed.harga1m(seri);
      await tidur(Math.max(200, (ok ? 1000 : 3000) - (now() - t0)));
    }
  }
  async loopFeed() {
    const L = this.putaran.feed;
    for (;;) {
      const [g, paksa] = L.awal();
      const fut = this.feed.detak(paksa), latar = paksa ? ['spot', 'kurs', 'pangkas'] : [];
      const tunggu = Object.entries(fut).filter(([k]) => !latar.includes(k)).map(([, T]) => T.p);
      if (tunggu.length) await Promise.race([Promise.all(tunggu), tidur(paksa ? 6000 : 3000)]);
      if (paksa) {
        this.hasilFeed = {};
        for (const [k, T] of Object.entries(fut)) {
          if (k === 'kurs' || k === 'pangkas') continue;
          this.hasilFeed[k] = T.selesai ? (T.galat ? teksGalat(T.galat).slice(0, 120) : 'ok') : (latar.includes(k) ? 'latar' : 'berjalan');
        }
      }
      if (Object.entries(fut).some(([k, T]) => TF_MS[k.split(' ').pop()] && T.selesai && !T.galat && T.hasil !== false)) this.putaran.belajar.colek();
      await L.akhir(g);
    }
  }
  async loopHitung() {
    const L = this.putaran.hitung;
    let n = 0;
    for (;;) {
      const [g, paksa] = L.awal(), t = now(), semua = paksa || n % 5 === 0;
      for (const sym of SYMS) {
        if (!this.feed.siapSym(sym)) continue;
        for (const mode of MODES) {
          const key = sym + '|' + mode;
          if (!(semua || t - (this.lihat.get(key) || 0) < 15000)) continue;
          try { this.hitung(sym, mode); } catch (e) { this.galat[`hitung ${sym} ${mode}`] = teksGalat(e); console.error(e); }
          await lega();
        }
      }
      n++;
      await L.akhir(g);
    }
  }
  _ramalKunci() { const t = now() - 5000; return MODES.map(m => Math.floor(t / TF_MS[MODE[m].horizon[0][1]])).join(','); }
  _ramalJatuhTempo(sym) {
    const k = this._ramalKunci(), lama = this._ramalBar[sym];
    if (!lama || k !== lama[0] || now() - lama[1] > 300000) { this._ramalBar[sym] = [k, now()]; return true; }
    return false;
  }
  async loopBerkala() {
    const L = this.putaran.berkala, t = { jurnal: 0, kb: 0, fwd: 0 };
    for (;;) {
      const [g, paksa] = L.awal(), tn = now() / 1000, sudah = new Set(), siap = SYMS.filter(s => this.feed.siapSym(s));
      if (paksa) {
        for (const sym of (this.paksaSym ? [this.paksaSym] : siap)) {
          if (!siap.includes(sym)) continue;
          this.perbaruiKebiasaan(sym); await lega();
          this.hitungRamal(sym); this._ramalBar[sym] = [this._ramalKunci(), now()]; await lega();
          sudah.add(sym);
        }
        t.jurnal = t.fwd = 0;
      }
      const ganti = siap.filter(s => this.kb[s] && this.kb[s].seri !== this.feed.seri(s)[0]);
      if (tn - t.kb > 120 || siap.some(s => !this.kb[s] || !this.kb[s].level) || ganti.length) {
        t.kb = tn;
        for (const sym of siap) if (!sudah.has(sym) || ganti.includes(sym)) { this.perbaruiKebiasaan(sym); await lega(); }
      }
      for (const sym of siap) if (!sudah.has(sym) && this._ramalJatuhTempo(sym)) { this.hitungRamal(sym); await lega(); }
      if (tn - t.jurnal > 60) { t.jurnal = tn; this.sinkronJurnal(); }
      if (tn - t.fwd > 600) { t.fwd = tn; cekForward(this.fwd); }
      this.cekLab();
      await L.akhir(g);
    }
  }
  async loopBelajar() {
    const L = this.putaran.belajar, t = { rekap: 0, tabel: 0 };
    for (;;) {
      const [g, paksa] = L.awal();
      this.cekBelajar();
      if (SYMS.some(s => this.pb.siap(s))) {
        const tanda = () => [...this.pb.keadaan.values()].map(k => k.t).join(',');
        const sebelum = tanda();
        try { this.pb.langkah(this.feed); } catch (e) { this.galat.belajar = teksGalat(e); console.error(e); }
        if (tanda() !== sebelum) this._blCache.clear();
        const tn = now() / 1000;
        if (paksa || tn - t.rekap > 30) {
          t.rekap = tn;
          try { periksaRekap(s => this.pasar(s)[0], this.kb, this.pb.mem, s => this.pb.siap(s) && !!this.kb[s] && this.feed.siapSym(s)); }
          catch (e) { this.galat.rekap = teksGalat(e); console.error(e); }
        }
        if (paksa || tn - t.tabel > 60) {
          t.tabel = tn;
          for (const sym of SYMS) {
            if (!this.pb.siap(sym)) continue;
            for (const mode of MODES) {
              try { this.tabel.set(sym + '|' + mode, this.pb.mem.tabel(sym, TF_MODE[mode], 10)); }
              catch (e) { this.galat[`tabel ${sym} ${mode}`] = teksGalat(e); }
              await lega();
            }
          }
        }
      }
      await L.akhir(g);
    }
  }
  async loopVersi() {
    for (;;) {
      await tidur(120000);
      await this.cekVersi();
    }
  }
  async cekVersi() {
    try {
      const u = new URL('versi.txt', self.location.href);
      u.searchParams.set('t', String(now()));
      const r = await fetch(u.toString(), { cache: 'no-store' });
      if (r.ok) { const v = (await r.text()).trim(); if (/^[0-9a-f]{6,}$/.test(v)) this.webTerbaru = v; }
    } catch (e) { /* luring */ }
  }

  cekBelajar() {
    if (this.belajarJalan) return;
    const minta = kvGet('pa_minta') || 0;
    const perlu = SYMS.filter(s => this.feed.siapSym(s) && !this.pb.siap(s));
    const val = SYMS.filter(s => this.pb.siap(s) && (minta > (kvGet('pa_validasi_t:' + s) || 0) || now() - (kvGet('pa_validasi_t:' + s) || 0) > DAY));
    if (perlu.length || val.length) this.jalankanBelajar(false);
  }
  jalankanBelajar(ulang = false) {
    if (this.belajarJalan) return false;
    this.belajarJalan = true;
    kvSet('pa_status', { jalan: true, mulai: now() });
    (async () => {
      try {
        for (const sym of SYMS) {
          if (!this.feed.siapSym(sym)) continue;
          if (!this.pb.siap(sym) || ulang) {
            if (ulang && PEMIMPIN) await simpanKe();
            await this.pb.isiRiwayat(this.feed, sym);
            this._blCache.clear();
            this.putaran.belajar.colek(); this.putaran.hitung.colek();
          }
        }
        const minta = kvGet('pa_minta') || 0;
        const syms = SYMS.filter(s => this.pb.siap(s) && (ulang || minta > (kvGet('pa_validasi_t:' + s) || 0) || now() - (kvGet('pa_validasi_t:' + s) || 0) > DAY));
        if (syms.length) await validasiSemua(syms);
      } catch (e) { this.galat.belajar = teksGalat(e); console.error(e); pikir('', 'galat', `Memori belajar gagal: ${teksGalat(e)}`); }
      finally { this.belajarJalan = false; kvSet('pa_status', { jalan: false, selesai: now() }); this._blCache.clear(); this.pb.mem.buang(); }
    })();
    return true;
  }

  // ---------- hitung ----------
  pasar(sym) { const [seri, skala, sumber] = this.feed.seri(sym); return [new Pasar(sym, seri, skala), sumber]; }
  harga(sym, P) {
    const h = this.feed.harga[sym];
    if (h && now() - h.t < 120000) return +h.p;
    const f = P.forming('1m');
    return f ? +f.c : null;
  }
  hitung(sym, mode) {
    const [P, sumber] = this.pasar(sym), px = this.harga(sym, P);
    if (px == null) return;
    const key = sym + '|' + mode, aktif = strategiAktif(sym, mode), fwd = (this.fwd[sym] || {})[mode] || {}, setelan = this.setelan();
    const [rc, hasil] = susunRencana(P, sym, mode, aktif, setelan, this.kb[sym], this.ramal.get(key), fwd, px);
    const lama = this.cache.get(key) || {}, c = { rencana: rc, sumber, harga: px, t: now(), pa: lama.pa || null, ketidakpastian: lama.ketidakpastian || null };
    if (this.pb.siap(sym)) {
      try {
        const unc = ketidakpastian(sym, mode, this.kb[sym], this.ramal.get(key), this.pb.keadaan, this.pb.mem);
        c.ketidakpastian = unc;
        c.pa = sinyalPA(sym, mode, px, this.kb[sym], this.ramal.get(key), rc.utama, setelan, this.pb.mem, this.pb.keadaan, unc);
      } catch (e) { this.galat[`pa ${sym} ${mode}`] = teksGalat(e); console.error(e); }
    }
    this.cache.set(key, c);
    this.hasil.set(key, [hasil, aktif]);
  }
  perbaruiKebiasaan(sym) {
    const [P] = this.pasar(sym), lama = this.kb[sym] || {}, k = hitungKebiasaan(P, sym);
    if (!k) return;
    k.seri = P.seri;
    TBL.kebiasaan[sym] = k; TBL_KOTOR.add('kebiasaan');
    this.kb[sym] = k;
    const a = lama.rezim || {}, b = k.rezim || {};
    if (Object.keys(a).length && Object.keys(b).length && a.vol_kode !== b.vol_kode) pikir(sym, 'kebiasaan', `${sym}: volatilitas berubah ${a.vol} → ${b.vol}; pengali risiko ${b.pengali_risiko}.`);
    if (Object.keys(a).length && Object.keys(b).length && a.arah_4h !== b.arah_4h && a.arah_4h !== undefined) pikir(sym, 'kebiasaan', `${sym}: tren 4H berubah ${a.tren_4h} → ${b.tren_4h}.`);
  }
  hitungRamal(sym) {
    const [P] = this.pasar(sym), [seri, skala] = this.feed.seri(sym);
    for (const mode of MODES) { const r = ramal(P, mode); this.ramal.set(sym + '|' + mode, r); catatPrediksi(sym, mode, r); }
    evaluasiPrediksi(sym, seri, skala);
  }

  // ---------- jurnal forward-test ----------
  sinkronJurnal() {
    const mulai = this.mulaiJurnal;
    for (const [key, [hasil, aktif]] of this.hasil) {
      const [sym, mode] = key.split('|'), nama = {};
      for (const a of aktif) nama[a.sid] = a.nama;
      for (const [sid, res] of Object.entries(hasil || {})) {
        if (!res) continue;
        for (const tr of res.trades || []) if (tr.t >= mulai) this._tulis(sym, mode, sid, nama[sid], tr, true);
        let ops = res.open || [];
        if (!Array.isArray(ops)) ops = [ops];
        for (const op of ops) if (op && op.t >= mulai) this._tulis(sym, mode, sid, nama[sid], op, false);
      }
    }
    for (const r of TBL.sinyal) if (r.status === 'terbuka' && r.t_sinyal < now() - 5 * DAY) { r.status = 'kedaluwarsa'; TBL_KOTOR.add('sinyal'); }
    const stats = {};
    for (const r of TBL.sinyal) {
      if (r.r == null) continue;
      ((stats[r.sym] = stats[r.sym] || {})[r.mode] = stats[r.sym][r.mode] || {});
      (stats[r.sym][r.mode][r.strat] = stats[r.sym][r.mode][r.strat] || []).push(r.r);
    }
    const out = {};
    for (const [sym, pm] of Object.entries(stats)) for (const [mode, ps] of Object.entries(pm)) for (const [sid, rs] of Object.entries(ps)) {
      const w = rs.filter(x => x > 0), gl = -jumlah(rs.filter(x => x <= 0));
      ((out[sym] = out[sym] || {})[mode] = out[sym][mode] || {})[sid] = { n: rs.length, wr: w.length / rs.length * 100, sum: jumlah(rs), pf: gl > 0 ? jumlah(w) / gl : (w.length ? 99.0 : null) };
    }
    this.fwd = out;
  }
  _tulis(sym, mode, sid, nama, tr, selesai) {
    const key = `${sid}|${sym}|${mode}|${tr.t}|${tr.d}`, ada = this._jurnalIdx.get(key), e = tr.e != null ? tr.e : tr.fills[0][0];
    if (selesai) {
      if (ada && !['terbuka', 'baru'].includes(ada.status)) return;
      const fav = tr.fav || 0, kena = { tp1: fav >= 1, tp2: fav >= 2, tp3: fav >= 3 }, st = tr.r > 0 ? 'menang' : 'kalah';
      if (ada) Object.assign(ada, { status: st, t_keluar: tr.tx, harga_keluar: tr.x, r: tr.r, kena, layer: { n: tr.layers || 1 } });
      else {
        const row = { kunci: key, sym, mode, strat: sid, nama, arah: tr.d, jenis: String(tr.kind), t_sinyal: tr.t, harga_masuk: e, sl0: null, tp1: null, tp2: null, tp3: null,
          status: st, t_keluar: tr.tx, harga_keluar: tr.x, r: tr.r, kena, layer: { n: tr.layers || 1 }, sumber: 'replay', dibuat: now() };
        TBL.sinyal.push(row); this._jurnalIdx.set(key, row);
        pikir(sym, 'refleksi', `${sym} ${nama || sid} ${AB(tr.d)} selesai ${tr.r > 0 ? 'untung' : 'rugi'} ${tr.r >= 0 ? '+' : ''}${fx(tr.r, 2)}R ` +
          `setelah ${tr.bars} candle (maju maksimal ${fx(tr.fav || 0, 1)}R sebelum SL awal). Statistik forward diperbarui.`);
      }
    } else {
      const R0 = tr.R0 || 0, tp = [1, 2, 3].map(k => e + tr.d * k * R0);
      if (ada) ada.layer = { n: (tr.fills || [1]).length, sl: tr.sl };
      else {
        const row = { kunci: key, sym, mode, strat: sid, nama, arah: tr.d, jenis: String(tr.kind), t_sinyal: tr.t, harga_masuk: e, sl0: tr.sl0, tp1: tp[0], tp2: tp[1], tp3: tp[2],
          status: 'terbuka', t_keluar: null, harga_keluar: null, r: null, kena: null, layer: { n: (tr.fills || [1]).length, sl: tr.sl }, sumber: 'live', dibuat: now() };
        TBL.sinyal.push(row); this._jurnalIdx.set(key, row);
        pikir(sym, 'sinyal', `${sym} ${MODE[mode].judul}: sinyal ${AB(tr.d)} ${nama || sid} di ${fmt(e)} (SL ${fmt(tr.sl0)}). Dicatat ke jurnal forward-test.`);
      }
    }
    TBL_KOTOR.add('sinyal');
  }
  jurnal(sym, mode, n = 40) {
    return TBL.sinyal.filter(r => r.sym === sym && r.mode === mode).sort((a, b) => b.t_sinyal - a.t_sinyal).slice(0, n)
      .map(r => ({ nama: r.nama, sid: r.strat, arah: r.arah, t: r.t_sinyal, masuk: r.harga_masuk, sl0: r.sl0, tp1: r.tp1, tp2: r.tp2, tp3: r.tp3, status: r.status,
        t_keluar: r.t_keluar, keluar: r.harga_keluar, r: r.r, kena: r.kena, layer: r.layer }));
  }

  // ---------- lab ----------
  cekLab() {
    if (this.labJalan || this.belajarJalan || !this.feed.siap) return;
    if (!SYMS.every(s => this.pb.siap(s))) return;           // memori price action dulu, lab sesudahnya
    const st = kvGet('lab_status') || {}, terakhir = st.selesai || 0, minta = kvGet('lab_minta') || 0;
    if (!TBL.strategi.length || minta > terakhir || now() - terakhir > DAY) this.jalankanLab();
  }
  jalankanLab() {
    if (this.labJalan) return false;
    this.labJalan = true;
    const run = now();
    kvSet('lab_status', { jalan: true, mulai: run });
    (async () => {
      const out = {};
      try {
        for (const sym of SYMS) {
          if (!this.feed.siapSym(sym)) continue;
          out[sym] = await labSimbol(this.feed, sym, run, (s, m, sid, i, n) => { this.labProgres = { sym: s, mode: m, sid, i, n, t: now() }; });
        }
      } catch (e) { this.galat.lab = teksGalat(e); console.error(e); pikir('', 'galat', `Lab gagal: ${teksGalat(e)}`); }
      finally { this.labProgres = null; kvSet('lab_status', { jalan: false, mulai: run, selesai: now(), ringkas: out }); this.labJalan = false; }
    })();
    return true;
  }

  // ---------- Segarkan ----------
  async segarkan(sym = null) {
    if (this.segarJanji) return this.segarJanji;
    if (now() - (this.segarInfo.t || 0) < 1500) return { ...this.segarInfo, gabung: true };
    if (!this.feed.siapSym(SIMBOL[sym] ? sym : 'XAUUSDm')) return { ok: false, detik: 0, t: now(), pesan: 'Riwayat pasar masih diunduh; coba lagi sebentar.' };
    this.segarJanji = (async () => {
      const t0 = now(), langkah = {};
      this.paksaSym = SIMBOL[sym] ? sym : null;
      const tahap = async (nama, loops, batas) => {
        const ta = now(), gs = loops.map(n => [n, this.putaran[n].bangun()]);
        const ok = (await Promise.all(gs.map(([n, g]) => this.putaran[n].tunggu(g, batas)))).every(Boolean);
        langkah[nama] = { ok, detik: Math.round((now() - ta) / 10) / 100 };
      };
      this.cekVersi();
      await tahap('data', ['feed'], 12000);
      await tahap('memori', ['berkala', 'belajar'], 20000);
      this._blCache.clear(); this.pb.mem.buang();
      await tahap('rencana', ['hitung'], 10000);
      const hf = this.hasilFeed, gagal = {}, lambat = [];
      for (const [k, v] of Object.entries(hf)) { if (!['ok', 'berjalan', 'latar'].includes(v)) gagal[k] = v; if (v === 'berjalan') lambat.push(k); }
      const tfBin = Object.keys(hf).filter(k => BINANCE_SERI.includes(k.split(' ')[0])), tfBuruk = tfBin.filter(k => hf[k] !== 'ok'), catatan = [];
      if (tfBin.length && tfBuruk.length * 2 >= tfBin.length) {
        const h = this.feed.harga[this.paksaSym || 'XAUUSDm'] || {}, umur = h.t ? (now() - h.t) / 1000 : null;
        catatan.push('Binance tidak menjawab (cek koneksi internet); angka memakai data terakhir' + (umur && umur > 5 ? `, harga ${fx(umur)} dtk lalu` : ''));
      } else {
        if (Object.keys(gagal).length) catatan.push(`${Object.keys(gagal).length} sumber gagal (${Object.keys(gagal).slice(0, 3).join(', ')})`);
        if (lambat.length) catatan.push(`${lambat.length} masih diunduh (${lambat.slice(0, 3).join(', ')})`);
      }
      const hasil = { ok: Object.values(langkah).every(v => v.ok) && !Object.keys(gagal).length && !tfBuruk.length, detik: Math.round((now() - t0) / 10) / 100,
        t: now(), sym: this.paksaSym, langkah, feed: hf, gagal, catatan: catatan.join('; ') };
      this.segarInfo = hasil;
      simpanKe();
      return hasil;
    })();
    try { return await this.segarJanji; } finally { this.segarJanji = null; }
  }

  // ---------- keluaran ----------
  denyut() {
    const f = this.feed, harga = {};
    for (const s of SYMS) { const h = f.harga[s] || {}; harga[s] = { p: h.p ?? null, t: h.t ?? null, sumber: h.sumber ?? null }; }
    const putaran = {}; for (const [n, L] of Object.entries(this.putaran)) putaran[n] = L.t;
    return { now: now(), putaran, web: this.webTerbaru, harga, binance: f.status.binance, mt5_ok: false, segar: Object.keys(this.segarInfo).length ? this.segarInfo : null,
      belajar: this.belajarJalan, pemimpin: PEMIMPIN };
  }
  perubahan24j(sym) {
    const [seri, skala] = this.feed.seri(sym), D = candle(seri, '1h', { n: 26 }), h = this.feed.harga[sym];
    if (D.c.length < 25 || !h) return null;
    return (h.p / (D.c[D.c.length - 25] * skala) - 1) * 100;
  }
  state(sym, mode) {
    this.lihat.set(sym + '|' + mode, now());
    const key = sym + '|' + mode, c = this.cache.get(key) || {}, kb = this.kb[sym] || {}, cfg = SIMBOL[sym];
    const lab = { ...(kvGet('lab_status') || {}), progres: this.labProgres, proses: this.labJalan };
    const st = {
      sym, mode, cfg: { nama: cfg.nama, judul: cfg.judul, tv: cfg.tv, dp: cfg.dp, kontrak: cfg.kontrak },
      harga: c.harga || (this.feed.harga[sym] || {}).p || null, sumber: c.sumber || null, chg24: this.perubahan24j(sym), rencana: c.rencana || null, t_rencana: c.t || null,
      prediksi: this.ramal.get(key) || [], akurasi: kvGet(`akurasi:${sym}:${mode}`) || {}, akurasi_nyata: rekapPrediksi(sym, mode),
      kebiasaan: kb, strategi: semuaStrategi(sym), pikiran: daftarPikiran(40, sym), jurnal: this.jurnal(sym, mode, 40), forward: (this.fwd[sym] || {})[mode] || {},
      lab, setelan: this.setelan(), feed: this.statusFeed(), mode_info: MODE[mode], now: now(), riwayat: this.feed.siapSym(sym) ? null : (this.progres.riwayat || null),
      siap: this.feed.siapSym(sym),
    };
    st.offset_exness = null;
    const lain = mode === 'scalp' ? 'swing' : 'scalp', u = (st.rencana || {}).utama || {}, v = ((this.cache.get(sym + '|' + lain) || {}).rencana || {}).utama || {};
    st.konflik = null;
    if ((u.aksi === 'BUY' || u.aksi === 'SELL') && (v.aksi === 'BUY' || v.aksi === 'SELL') && u.aksi !== v.aksi) {
      st.konflik = `Rencana ${MODE[mode].judul.toLowerCase()} ${u.aksi} berlawanan dengan ${MODE[lain].judul.toLowerCase()} ${v.aksi} (${(v.status || '').toLowerCase()}, ${v.nama}). ` +
        'Posisi melawan arah TF besar: pakai risiko lebih kecil dan ambil TP lebih cepat, atau tunggu keduanya searah.';
    }
    st.pa = c.pa || null;
    st.ketidakpastian = c.ketidakpastian || null;
    st.belajar = this.infoBelajar(sym, mode);
    st.rekap = rekapTerbaru(sym);
    st.gerak = TF_MODE[mode].map(tf => ((this.pb.keadaan.get(sym + '|' + tf) || {}).gerak) || null);
    st.putaran = this.denyut().putaran;
    st.segar = Object.keys(this.segarInfo).length ? this.segarInfo : null;
    st.web = this.webTerbaru;
    st.narasi = susunNarasi(sym, mode, st);
    st.order_teks = teksOrder(sym, (st.rencana || {}).utama);
    st.order_teks_pa = teksOrderPA(sym, st.pa);
    return st;
  }
  infoBelajar(sym, mode) {
    const tfs = TF_MODE[mode], key = sym + '|' + tfs.join(',');
    let c = this._blCache.get(key);
    if (!c || now() - c[0] > 20000) {
      c = [now(), { progres: progresPA(sym), akurasi: akurasiSaran(sym, tfs), akurasi_7h: akurasiSaran(sym, tfs, 7), terakhir: hasilTerakhir(sym, tfs) }];
      this._blCache.set(key, c);
    }
    const b = c[1], val = {}, mem = {};
    for (const tf of tfs) { val[tf] = kvGet(`pa_validasi:${sym}:${tf}`); mem[tf] = this.pb.siap(sym) ? this.pb.mem.ringkas(sym, tf) : { n: 0, n_maju: 0 }; }
    const galat = {};
    for (const [k, v] of Object.entries(this.galat)) if (k === 'belajar' || k === 'rekap' || k.startsWith('pa ') || k.startsWith('tabel')) galat[k] = String(v).slice(-300);
    return { siap: this.pb.siap(sym), proses: this.belajarJalan || (this.feed.siapSym(sym) && !this.pb.siap(sym)), riwayat: kvGet('pa_riwayat:' + sym),
      progres: b.progres, tabel: this.tabel.get(sym + '|' + mode) || [], validasi: val, t_validasi: kvGet('pa_validasi_t:' + sym),
      akurasi: b.akurasi, akurasi_7h: b.akurasi_7h, terakhir: b.terakhir, memori: mem, status: kvGet('pa_status') || {}, galat };
  }
  statusFeed() {
    const f = this.feed, mg = {};
    for (const [k, v] of Object.entries(this.galat)) mg[k] = String(v).slice(-300);
    return { binance: f.status.binance, binance_host: binanceHost()[1].split('/')[2], spot: f.status.spot, mt5: null, mt5_ok: false, exness_btc: null,
      rasio_xau: f.rasio, galat: Object.fromEntries(Object.entries(f.status.galat).slice(-6)), mesin_galat: mg, pemimpin: PEMIMPIN,
      waktu_mulai: typeof WAKTU !== 'undefined' ? WAKTU : null };
  }
  ringkas() {
    const out = {};
    for (const sym of SYMS) {
      const h = this.feed.harga[sym] || {}, o = { harga: h.p ?? null, chg24: this.perubahan24j(sym), sumber: h.sumber ?? null, mode: {} };
      for (const mode of MODES) {
        const c = this.cache.get(sym + '|' + mode) || {}, u = (c.rencana || {}).utama || {}, m = {};
        for (const k of ['aksi', 'status', 'entry', 'sl', 'nama', 'yakin', 'grade', 'jenis_entry']) m[k] = u[k] ?? null;
        m.tp = u.tp || null;
        const s = c.pa || {}; m.pa = {};
        for (const k of ['aksi', 'status', 'nama', 'tf', 'entry', 'sl', 'tp', 'tp_p', 'yakin', 'e_kal']) m.pa[k] = s[k] ?? null;
        const u2 = c.ketidakpastian || {}; m.ketidakpastian = { skor: u2.skor ?? null, label: u2.label ?? null };
        o.mode[mode] = m;
      }
      out[sym] = o;
    }
    return out;
  }
  teks(sym, mode) {
    const st = this.state(sym, mode), bag = [st.narasi.join('\n')];
    if (st.order_teks) bag.push('Rencana strategi:\n' + st.order_teks);
    if (st.order_teks_pa) bag.push('Sinyal price action:\n' + st.order_teks_pa);
    return bag.join('\n\n');
  }
  /** Candle TF; candle yang sedang berjalan dilengkapi dari candle 1m (±1 dtk) agar peta bergerak real-time. */
  candleHidup(seri, tf, n) {
    const D = salinD(candle(seri, tf, { n }));
    if (tf === '1m' || !D.t.length) return D;
    const ms = TF_MS[tf], b0 = Math.floor(now() / ms) * ms, L = D.t.length - 1;
    if (D.t[L] > b0 || (this.feed.segar_tf.get(seri + '|1m') || 0) <= (this.feed.segar_tf.get(seri + '|' + tf) || 0)) return D;
    const M = candle(seri, '1m', { dari: b0 });
    if (!M.t.length) return D;
    let hi = -Infinity, lo = Infinity, vol = 0;
    for (let i = 0; i < M.t.length; i++) { hi = Math.max(hi, M.h[i]); lo = Math.min(lo, M.l[i]); vol += M.v[i]; }
    const c = M.c[M.c.length - 1];
    if (D.t[L] === b0) { D.h[L] = Math.max(D.h[L], hi); D.l[L] = Math.min(D.l[L], lo); D.c[L] = c; return D; }
    const baru = { t: b0, o: M.o[0], h: hi, l: lo, c, v: vol }, out = {};
    for (const k of KOL) { const a = new Float64Array(D[k].length + 1); a.set(D[k]); a[a.length - 1] = baru[k]; out[k] = a.slice(-n); }
    return out;
  }
  peta(sym, tf, n) {
    if (!TF_MS[tf]) throw new Error('tf');
    const [seri, skala] = this.feed.seri(sym), emas = sym === 'XAUUSDm' && tf !== '1m';
    let D = this.candleHidup(seri, tf, emas ? Math.ceil(n * 1.45) + 10 : n);
    if (emas) {
      const keep = []; for (let i = 0; i < D.t.length; i++) if (tf === '1d' ? hariKerja(D.t[i]) : pasarEmasBuka(D.t[i])) keep.push(i);
      const ks = keep.slice(-n), D2 = {}; for (const k of KOL) D2[k] = Float64Array.from(ks, i => D[k][i]); D = D2;
    }
    const sk = a => Array.from(a, x => x * skala);
    const out = { t: Array.from(D.t), o: sk(D.o), h: sk(D.h), l: sk(D.l), c: sk(D.c), pola: [], tf };
    const G = gudang(sym, tf);
    if (D.t.length && G) {
      for (let i = cariKiri(G.t, D.t[0], G.n); i < G.n; i++) {
        const p = POLA_URUT[G.pola[i]];
        out.pola.push({ t: G.t[i], pola: p, kode: SINGKAT[p], nama: POLA[p], arah: G.arah[i], status: STATUS_PA[G.status[i]], mfe: G.nul('mfe', i), kena_sl: G.nul('kena_sl', i),
          disarankan: G.disarankan[i], sumber: G.sumber[i] ? 'maju' : 'riwayat', harga: G.harga[i], sl: G.sl[i] });
      }
    }
    const kd = this.pb.keadaan.get(sym + '|' + tf) || {};
    out.swing = { high: kd.swing_high || [], low: kd.swing_low || [] };
    out.struktur = kd.struktur ?? null;
    return out;
  }
  simpanSetelan(body) {
    let s = { ...(kvGet('setelan') || {}) };
    for (const k of ['saldo', 'risiko_pct', 'usd_idr']) {
      if (k in body && body[k] !== null && body[k] !== '') {
        const v = parseFloat(body[k]);
        if (!Number.isFinite(v)) throw new Error(`${k} tidak valid`);
        if (k === 'risiko_pct' && !(v >= 0.05 && v <= 10)) throw new Error('risiko 0,05-10%');
        if (v <= 0) throw new Error(`${k} harus > 0`);
        s[k] = v;
      }
    }
    if (body.mata_uang === 'IDR' || body.mata_uang === 'USD') s.mata_uang = body.mata_uang;
    if (body.reset) s = {};
    kvSet('setelan', s);
    for (const mode of MODES) for (const sym of SYMS) if (this.feed.siapSym(sym)) { try { this.hitung(sym, mode); } catch (e) { /* abaikan */ } }
    return { ok: true, setelan: this.setelan() };
  }
}

// ================================================================== Web Worker: jembatan ke halaman
let MESIN = null;
const T_MULAI = now(), WAKTU = {};
const SIAP = (async () => {
  try { await idbBuka(); } catch (e) { console.warn('IndexedDB tidak tersedia, data hanya di memori', e); }
  try { await muatSemua(); } catch (e) { console.warn('memuat data tersimpan gagal', e); }
  WAKTU.idb = now() - T_MULAI;
  kunciPemimpin(() => { if (now() - T_MULAI > 8000) tandaiSemuaKotor(); });
  MESIN = new Mesin();
  MESIN.mulai();
  setInterval(() => simpanKe(), 3000);
})();

async function rute(path, q, body, metode) {
  if (path === 'simpan') { await simpanKe(true); return { ok: true }; }
  const sym = q.sym || 'XAUUSDm', mode = q.mode || 'scalp';
  if (!SIMBOL[sym] || !MODE[mode]) throw new Error('simbol/mode tidak dikenal');
  const M = MESIN;
  if (metode === 'POST') {
    if (path === '/api/setelan') return M.simpanSetelan(body || {});
    if (path === '/api/segarkan') return M.segarkan((body || {}).sym);
    if (path === '/api/lab') {
      kvSet('lab_minta', now());
      const ok = M.jalankanLab();
      pikir('', 'lab', 'Lab otonom dijalankan atas permintaan Yulius.');
      return { ok: true, dimulai: ok };
    }
    if (path === '/api/belajar') {
      kvSet('pa_minta', now());
      const ok = M.jalankanBelajar(!!(body || {}).ulang);
      pikir('', 'belajar', 'Uji walk-forward memori price action dijalankan ulang atas permintaan Yulius.' + ((body || {}).ulang ? ' Memori riwayat diisi ulang dari awal.' : ''));
      return { ok: true, dimulai: ok };
    }
    throw new Error('tidak ada');
  }
  switch (path) {
    case '/api/state': return M.state(sym, mode);
    case '/api/ringkas': return M.ringkas();
    case '/api/denyut': return M.denyut();
    case '/api/teks': return M.teks(sym, mode);
    case '/api/peta': return M.peta(sym, q.tf || '15m', Math.min(+(q.n || 160), 600));
    case '/api/jurnal': return M.jurnal(sym, mode, +(q.n || 100));
    case '/api/pikiran': return daftarPikiran(+(q.n || 100));
    case '/api/lab': return { status: kvGet('lab_status'), strategi: semuaStrategi(sym) };
    case '/api/rekap': return daftarRekap(sym, Math.min(+(q.n || 40), 200), q.jenis || null);
    case '/api/debug': {
      const out = { waktu: WAKTU, pemimpin: PEMIMPIN, galat: M.galat, kv: {}, gudang: {}, keadaan: {}, segar: Object.fromEntries(M.feed.segar_tf), data: {} };
      for (const [k, v] of KV) if (/^pa_(kursor|maju_awal|versi|validasi_t)|^rekap_kursor|^lab_status|^mulai_jurnal/.test(k)) out.kv[k] = v;
      for (const [k, G] of GUDANG) { let maju = 0, tunggu = 0; for (let i = 0; i < G.n; i++) { maju += G.sumber[i]; tunggu += G.status[i] <= 1 ? 1 : 0; } out.gudang[k] = { n: G.n, maju, tunggu, akhir: G.n ? G.t[G.n - 1] : null }; }
      for (const [k, v] of M.pb.keadaan) out.keadaan[k] = { t: v.t, struktur: v.struktur, galat: v.galat || null };
      for (const [k, S] of DATA) out.data[k] = { n: S.n, akhir: S.n ? S.t[S.n - 1] : null };
      return out;
    }
    case '/api/belajar': return { tabel: M.pb.siap(sym) ? M.pb.mem.tabel(sym, q.semua ? TF_BELAJAR : TF_MODE[mode], null) : [], info: M.infoBelajar(sym, mode) };
    default: throw new Error('tidak ada');
  }
}

if (typeof self !== 'undefined' && typeof self.postMessage === 'function' && typeof window === 'undefined') {
  self.onmessage = async ev => {
    const { id, path, q, body, metode } = ev.data || {};
    try {
      await SIAP;
      const hasil = await rute(path, q || {}, body, metode || 'GET');
      self.postMessage({ id, ok: true, hasil });
    } catch (e) {
      self.postMessage({ id, ok: false, galat: teksGalat(e) });
    }
  };
}
