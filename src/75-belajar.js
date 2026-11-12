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
