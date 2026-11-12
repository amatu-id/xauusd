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
