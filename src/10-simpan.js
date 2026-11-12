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
