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
