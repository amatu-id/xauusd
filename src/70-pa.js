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
