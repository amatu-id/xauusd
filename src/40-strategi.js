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
