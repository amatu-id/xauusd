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
