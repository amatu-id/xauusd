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
