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
