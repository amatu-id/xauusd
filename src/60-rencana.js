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

/** Keadaan basket yang SUDAH berjalan, aturan sama dengan uji balik (lot sama per layer, 1R = jarak SL awal satu layer):
 *  layer terisi, harga rata-rata, hasil basket sekarang & bila SL kena (R, sudah dikurangi biaya), SL sudah digeser trailing
 *  atau belum, harga terbaik sejak masuk, dan layer berikutnya + SL basket barunya (rencana.py _posisi).
 *  Posisi berjalan BUKAN sinyal entry baru: SL-nya bisa sudah melewati entry (untung terkunci). */
function posisiBerjalan(o, px, p, biayaPct, stepBawaan = 1.0) {
  const d = Math.trunc(o.d), R0 = +o.R0, sl = +o.sl, sl0 = +o.sl0, fills = o.fills.map(f => +f[0]), n = fills.length;
  const biaya = jumlah(fills.map(f => biayaPct * f)) / R0;
  const out = { terisi: n, avg: jumlah(fills) / n, sejak: o.t, sl_awal: sl0,
    r_kini: jumlah(fills.map(f => (px - f) * d)) / R0 - biaya, r_sl: jumlah(fills.map(f => (sl - f) * d)) / R0 - biaya,
    sl_geser: (sl - sl0) * d > 1e-9 * Math.max(1, Math.abs(sl0)), kena_sl: (px - sl) * d <= 0, tutup: o.batas ?? null };
  out.kunci = out.r_sl > 0;
  if (o.ext != null) { out.terbaik = +o.ext; out.r_terbaik = (o.ext - fills[0]) * d / R0; }
  if (n < Math.trunc(ambil(p, 'layers', 1))) {
    const step = +ambil(p, 'add_step', stepBawaan), lock = +ambil(p, 'lock_r', 1.0), gap = +ambil(p, 'add_gap', 1.0), a0 = +o.atr;
    const lvl = fills[n - 1] + d * step * a0, V2 = n + 1, sreq = (jumlah(fills) + lvl) / V2 - d * lock * R0 / V2;
    const snew = d > 0 ? Math.max(sl, sreq) : Math.min(sl, sreq);
    out.berikut = { ke: n + 1, harga: lvl, jenis: d > 0 ? 'Buy stop' : 'Sell stop', sl_basket: snew, ok: (lvl - snew) * d >= gap * a0 };
  }
  return out;
}
/** Layer posisi berjalan: yang terisi + layer berikutnya (bila ada) dengan SL basket setelah ia terisi. */
function layerBerjalan(ps, fills, lot) {
  const out = fills.map((f, i) => ({ ke: i + 1, harga: f, lot, jenis: 'Terisi', sl_basket: null })), b = ps.berikut;
  if (b) out.push({ ke: b.ke, harga: b.harga, lot, jenis: b.ok ? 'Tambah berikutnya' : 'Tambah (menunggu ruang SL)', sl_basket: b.sl_basket });
  return out;
}

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
    const fills = op.fills.map(f => f[0]), ps = posisiBerjalan(op, px, p, SIMBOL[sym].biaya_pct);
    const layer = layerBerjalan(ps, fills, lotOf(lt));
    alasan.push(`Posisi berjalan sejak ${wib(op.t, '%d/%m %H:%M')} WIB; ` + (ps.sl_geser ? `SL sudah digeser trailing ke ${fmt(op.sl)}.` : `SL masih di posisi awal ${fmt(op.sl)}.`));
    return [{ ...base, status: 'AKTIF', arah: d, entry: e0, sl: op.sl, sl_awal: op.sl0, r0: R0, tp: tpDari(e0, d, R0), layer, lot: lt,
      maju_r: (px - e0) * d / R0, t_sinyal: op.t, posisi: ps, pemicu: 'Sudah masuk (sinyal sebelumnya)', jenis_entry: 'berjalan',
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
    const fills = o.fills.map(f => f[0]), ps = posisiBerjalan(o, px, p, SIMBOL[sym].biaya_pct, 2.0);
    const layer = layerBerjalan(ps, fills, lotOf(lt));
    alasan.push(`Basket ${AB(d)} berjalan sejak ${wib(o.t)} WIB, ${fills.length} layer terisi.`);
    return [{ ...base, status: 'AKTIF', arah: d, entry: e0, sl: o.sl, sl_awal: o.sl0, r0: R0, tp: tpDari(e0, d, R0), layer, lot: lt,
      maju_r: (px - e0) * d / R0, t_sinyal: o.t, posisi: ps, pemicu: 'Sudah masuk', jenis_entry: 'berjalan',
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
    return [{ ...base, status: 'AKTIF', arah: d, entry: op.e, sl: op.sl, sl_awal: op.sl0, r0: op.R0, tp: [op.e + d * op.R0, op.tp, op.tp + d * op.R0], lot: lt, t_sinyal: op.t,
      posisi: posisiBerjalan({ ...op, atr: op.atr ?? 0 }, px, { layers: 1 }, SIMBOL[sym].biaya_pct),
      layer: [{ ke: 1, harga: op.e, lot: lotOf(lt), jenis: 'Terisi', sl_basket: null }], maju_r: (px - op.e) * d / op.R0, pemicu: 'Sudah masuk',
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
    const ps = k.posisi;
    if (ps && k.lot) {         // uang per 1R per layer = rugi SL awal satu layer dengan lot rencana
      ps.uang_kini = ps.r_kini * k.lot.rugi_sl; ps.uang_sl = ps.r_sl * k.lot.rugi_sl; ps.mata_uang = k.lot.mata_uang;
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
  if (k.status === 'AKTIF' && k.posisi) return teksKelola(sym, k);
  const dp = SIMBOL[sym].dp, f = v => (+v).toFixed(dp), lot = (k.lot || {}).lot;
  const b = [`${sym} ${k.aksi} (${k.nama}, ${k.status})`, `Entry: ${f(k.entry)} [${k.jenis_entry || ''}]`, `SL: ${f(k.sl)}`];
  (k.tp || []).forEach((t, i) => b.push(`TP${i + 1}: ${f(t)}`));
  for (const L of (k.layer || []).slice(1)) b.push(`Layer ${L.ke}: ${f(L.harga)}` + (L.lot ? ` lot ${L.lot}` : '') + (L.sl_basket ? ` (SL basket ${f(L.sl_basket)})` : ''));
  if (lot) b.push(`Lot per layer: ${lot}`);
  if (k.trailing) b.push(`Trailing: ${k.trailing}`);
  return b.join('\n');
}
/** Posisi strategi yang SUDAH berjalan: teks kelola posisi (bukan order baru). Entry lama tidak bisa dipasang lagi dan SL
 *  trailing-nya bisa sudah melewati entry, jadi yang belum punya posisi diminta menunggu sinyal berikutnya (rencana.teks_kelola). */
function teksKelola(sym, k) {
  const dp = SIMBOL[sym].dp, f = v => (+v).toFixed(dp), ps = k.posisi, lot = (k.lot || {}).lot, mu = ps.mata_uang || '';
  const hasil = fr(ps.r_sl) + (ps.uang_sl != null ? ` ≈ ${fs(ps.uang_sl, 0)} ${mu}` : '');
  const b = [`${sym} ${k.aksi} — POSISI BERJALAN, bukan order baru (${k.nama})`,
    `Masuk ${wib(ps.sejak, '%d/%m %H:%M')} WIB · ${ps.terisi} layer terisi · rata-rata ${f(ps.avg)}`];
  for (const L of k.layer || []) if (L.jenis === 'Terisi') b.push(`L${L.ke} terisi: ${f(L.harga)}` + (L.lot ? ` lot ${L.lot}` : ''));
  b.push(`SL semua layer: ${f(k.sl)} (${ps.sl_geser ? 'trailing' : 'awal'}; bila kena ${hasil}${ps.kunci ? ', untung terkunci' : ''})`);
  if (ps.sl_geser && ps.sl_awal != null) b.push(`SL awal: ${f(ps.sl_awal)} (1R ${f(k.r0)})`);
  (k.tp || []).forEach((t, i) => b.push(`TP${i + 1} (${i + 1}R): ${f(t)}` + (ps.terbaik != null && (ps.terbaik - t) * k.arah >= 0 ? ' (sudah tersentuh)' : '')));
  const nx = ps.berikut;
  if (nx) b.push(`L${nx.ke} berikutnya: ${nx.jenis} ${f(nx.harga)}` + (lot ? ` lot ${lot}` : '') + `, lalu SL semua layer ${f(nx.sl_basket)}` + (nx.ok ? '' : ' (menunggu ruang SL)'));
  if (k.trailing) b.push(`Trailing: ${k.trailing}`);
  if (ps.kena_sl) b.push('Harga sudah menyentuh SL: posisi strategi selesai begitu candle ini tutup.');
  b.push('Belum punya posisi ini? Jangan kejar harga — tunggu sinyal berikutnya.');
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
