// ================================================================== mesin (server.py versi Web Worker)
// Penjadwal real-time: harga ±1 dtk per sumber; candle TF ±1,5 dtk setelah tutup + tiap 15/60 dtk; rencana + sinyal
// price action 2 dtk; memori belajar 3 dtk; rekap jam/sesi/harian; jurnal 1 mnt; kebiasaan 2 mnt; prediksi tiap candle
// 15m/1h tutup atau 5 mnt; lab otonom dan uji walk-forward harian / saat diminta. Segarkan = bangunkan semua loop,
// berurutan feed → memori → rencana. Hanya membaca pasar — tidak pernah mengirim order.
const VERSI_WEB = '%%VERSI%%';
const JEDA_LOOP = { feed: 1.0, hitung: 2.0, berkala: 5.0, belajar: 3.0 };

class Putaran {
  constructor(nama) { this.nama = nama; this.minta = 0; this.dilayani = 0; this.t = 0; this._bangun = null; this._tm = null; this._set = false; }
  awal() { const g = this.minta; return [g, g > this.dilayani]; }
  async akhir(g) {
    this.dilayani = Math.max(this.dilayani, g);
    this.t = now();
    if (this._set) { this._set = false; await tidur(0); return; }
    await new Promise(r => { this._bangun = r; this._tm = setTimeout(r, JEDA_LOOP[this.nama] * 1000); });
    this._bangun = null; this._set = false;
  }
  colek() { if (this._bangun) { clearTimeout(this._tm); const r = this._bangun; this._bangun = null; r(); } else this._set = true; }
  bangun() { this.minta++; this.colek(); return this.minta; }
  async tunggu(g, batasMs) { const akhir = now() + batasMs; while (this.dilayani < g) { if (now() > akhir) return false; await tidur(30); } return true; }
}

class Mesin {
  constructor() {
    this.feed = new Feed();
    this.cache = new Map(); this.hasil = new Map(); this.ramal = new Map(); this.tabel = new Map(); this.lihat = new Map();
    this.kb = {}; for (const s of SYMS) this.kb[s] = (TBL.kebiasaan || {})[s] || null;
    this.fwd = {}; this.progres = {}; this.galat = {};
    this.labJalan = false; this.labProgres = null; this.belajarJalan = false;
    this.pb = new Pembelajar();
    this.putaran = {}; for (const n of Object.keys(JEDA_LOOP)) this.putaran[n] = new Putaran(n);
    this.paksaSym = null; this.hasilFeed = {}; this.segarInfo = {}; this.segarJanji = null;
    this._ramalBar = {}; this._blCache = new Map();
    this.webTerbaru = VERSI_WEB; this.tMulai = now();
    this._jurnalIdx = new Map(); for (const r of TBL.sinyal) this._jurnalIdx.set(r.kunci, r);
    if (!kvGet('mulai_jurnal')) {
      kvSet('mulai_jurnal', now());
      pikir('', 'mulai', 'Trading AI Yulius mulai merekam pasar BTCUSDT dan XAUUSDm di perangkat ini. Jurnal forward-test dimulai sekarang.');
    }
    this.mulaiJurnal = kvGet('mulai_jurnal');
  }

  setelan() {
    const s = { ...RISIKO_DEFAULT }, kurs = kvGet('usd_idr');
    if (kurs) s.usd_idr = +kurs;
    Object.assign(s, kvGet('setelan') || {});
    return s;
  }

  mulai() {
    const loops = [[() => this.loopFeed(), 'loop_feed'], [() => this.loopHitung(), 'loop_hitung'], [() => this.loopBerkala(), 'loop_berkala'],
      [() => this.loopBelajar(), 'loop_belajar'], [() => this.loopVersi(), 'loop_versi']];
    for (const s of BINANCE_SERI) loops.push([() => this.loopHarga(s), 'loop_harga ' + s]);
    for (const [f, nama] of loops) this._aman(f, nama);
    this.feed.saatSiap = () => { for (const n of ['berkala', 'belajar', 'hitung']) this.putaran[n].colek(); };
    this.feed.isiAwal((sym, tf, t, frac) => { this.progres.riwayat = { sym, tf, sampai: t, frac: frac || 0 }; })
      .catch(e => { this.galat.riwayat = teksGalat(e); })
      .finally(() => { delete this.progres.riwayat; simpanKe(true); });
  }
  async _aman(f, nama) {
    for (;;) {
      try { await f(); }
      catch (e) { this.galat[nama] = teksGalat(e).slice(0, 1500); console.error(nama, e); await tidur(5000); }
    }
  }

  // ---------- loop ----------
  async loopHarga(seri) {
    for (;;) {
      const t0 = now(), ok = await this.feed.harga1m(seri);
      await tidur(Math.max(200, (ok ? 1000 : 3000) - (now() - t0)));
    }
  }
  async loopFeed() {
    const L = this.putaran.feed;
    for (;;) {
      const [g, paksa] = L.awal();
      const fut = this.feed.detak(paksa), latar = paksa ? ['spot', 'kurs', 'pangkas'] : [];
      const tunggu = Object.entries(fut).filter(([k]) => !latar.includes(k)).map(([, T]) => T.p);
      if (tunggu.length) await Promise.race([Promise.all(tunggu), tidur(paksa ? 6000 : 3000)]);
      if (paksa) {
        this.hasilFeed = {};
        for (const [k, T] of Object.entries(fut)) {
          if (k === 'kurs' || k === 'pangkas') continue;
          this.hasilFeed[k] = T.selesai ? (T.galat ? teksGalat(T.galat).slice(0, 120) : 'ok') : (latar.includes(k) ? 'latar' : 'berjalan');
        }
      }
      if (Object.entries(fut).some(([k, T]) => TF_MS[k.split(' ').pop()] && T.selesai && !T.galat && T.hasil !== false)) this.putaran.belajar.colek();
      await L.akhir(g);
    }
  }
  async loopHitung() {
    const L = this.putaran.hitung;
    let n = 0;
    for (;;) {
      const [g, paksa] = L.awal(), t = now(), semua = paksa || n % 5 === 0;
      for (const sym of SYMS) {
        if (!this.feed.siapSym(sym)) continue;
        for (const mode of MODES) {
          const key = sym + '|' + mode;
          if (!(semua || t - (this.lihat.get(key) || 0) < 15000)) continue;
          try { this.hitung(sym, mode); } catch (e) { this.galat[`hitung ${sym} ${mode}`] = teksGalat(e); console.error(e); }
          await lega();
        }
      }
      n++;
      await L.akhir(g);
    }
  }
  _ramalKunci() { const t = now() - 5000; return MODES.map(m => Math.floor(t / TF_MS[MODE[m].horizon[0][1]])).join(','); }
  _ramalJatuhTempo(sym) {
    const k = this._ramalKunci(), lama = this._ramalBar[sym];
    if (!lama || k !== lama[0] || now() - lama[1] > 300000) { this._ramalBar[sym] = [k, now()]; return true; }
    return false;
  }
  async loopBerkala() {
    const L = this.putaran.berkala, t = { jurnal: 0, kb: 0, fwd: 0 };
    for (;;) {
      const [g, paksa] = L.awal(), tn = now() / 1000, sudah = new Set(), siap = SYMS.filter(s => this.feed.siapSym(s));
      if (paksa) {
        for (const sym of (this.paksaSym ? [this.paksaSym] : siap)) {
          if (!siap.includes(sym)) continue;
          this.perbaruiKebiasaan(sym); await lega();
          this.hitungRamal(sym); this._ramalBar[sym] = [this._ramalKunci(), now()]; await lega();
          sudah.add(sym);
        }
        t.jurnal = t.fwd = 0;
      }
      const ganti = siap.filter(s => this.kb[s] && this.kb[s].seri !== this.feed.seri(s)[0]);
      if (tn - t.kb > 120 || siap.some(s => !this.kb[s] || !this.kb[s].level) || ganti.length) {
        t.kb = tn;
        for (const sym of siap) if (!sudah.has(sym) || ganti.includes(sym)) { this.perbaruiKebiasaan(sym); await lega(); }
      }
      for (const sym of siap) if (!sudah.has(sym) && this._ramalJatuhTempo(sym)) { this.hitungRamal(sym); await lega(); }
      if (tn - t.jurnal > 60) { t.jurnal = tn; this.sinkronJurnal(); }
      if (tn - t.fwd > 600) { t.fwd = tn; cekForward(this.fwd); }
      this.cekLab();
      await L.akhir(g);
    }
  }
  async loopBelajar() {
    const L = this.putaran.belajar, t = { rekap: 0, tabel: 0 };
    for (;;) {
      const [g, paksa] = L.awal();
      this.cekBelajar();
      if (SYMS.some(s => this.pb.siap(s))) {
        const tanda = () => [...this.pb.keadaan.values()].map(k => k.t).join(',');
        const sebelum = tanda();
        try { this.pb.langkah(this.feed); } catch (e) { this.galat.belajar = teksGalat(e); console.error(e); }
        if (tanda() !== sebelum) this._blCache.clear();
        const tn = now() / 1000;
        if (paksa || tn - t.rekap > 30) {
          t.rekap = tn;
          try { periksaRekap(s => this.pasar(s)[0], this.kb, this.pb.mem, s => this.pb.siap(s) && !!this.kb[s] && this.feed.siapSym(s)); }
          catch (e) { this.galat.rekap = teksGalat(e); console.error(e); }
        }
        if (paksa || tn - t.tabel > 60) {
          t.tabel = tn;
          for (const sym of SYMS) {
            if (!this.pb.siap(sym)) continue;
            for (const mode of MODES) {
              try { this.tabel.set(sym + '|' + mode, this.pb.mem.tabel(sym, TF_MODE[mode], 10)); }
              catch (e) { this.galat[`tabel ${sym} ${mode}`] = teksGalat(e); }
              await lega();
            }
          }
        }
      }
      await L.akhir(g);
    }
  }
  async loopVersi() {
    for (;;) {
      await tidur(120000);
      await this.cekVersi();
    }
  }
  async cekVersi() {
    try {
      const u = new URL('versi.txt', self.location.href);
      u.searchParams.set('t', String(now()));
      const r = await fetch(u.toString(), { cache: 'no-store' });
      if (r.ok) { const v = (await r.text()).trim(); if (/^[0-9a-f]{6,}$/.test(v)) this.webTerbaru = v; }
    } catch (e) { /* luring */ }
  }

  cekBelajar() {
    if (this.belajarJalan) return;
    const minta = kvGet('pa_minta') || 0;
    const perlu = SYMS.filter(s => this.feed.siapSym(s) && !this.pb.siap(s));
    const val = SYMS.filter(s => this.pb.siap(s) && (minta > (kvGet('pa_validasi_t:' + s) || 0) || now() - (kvGet('pa_validasi_t:' + s) || 0) > DAY));
    if (perlu.length || val.length) this.jalankanBelajar(false);
  }
  jalankanBelajar(ulang = false) {
    if (this.belajarJalan) return false;
    this.belajarJalan = true;
    kvSet('pa_status', { jalan: true, mulai: now() });
    (async () => {
      try {
        for (const sym of SYMS) {
          if (!this.feed.siapSym(sym)) continue;
          if (!this.pb.siap(sym) || ulang) {
            if (ulang && PEMIMPIN) await simpanKe();
            await this.pb.isiRiwayat(this.feed, sym);
            this._blCache.clear();
            this.putaran.belajar.colek(); this.putaran.hitung.colek();
          }
        }
        const minta = kvGet('pa_minta') || 0;
        const syms = SYMS.filter(s => this.pb.siap(s) && (ulang || minta > (kvGet('pa_validasi_t:' + s) || 0) || now() - (kvGet('pa_validasi_t:' + s) || 0) > DAY));
        if (syms.length) await validasiSemua(syms);
      } catch (e) { this.galat.belajar = teksGalat(e); console.error(e); pikir('', 'galat', `Memori belajar gagal: ${teksGalat(e)}`); }
      finally { this.belajarJalan = false; kvSet('pa_status', { jalan: false, selesai: now() }); this._blCache.clear(); this.pb.mem.buang(); }
    })();
    return true;
  }

  // ---------- hitung ----------
  pasar(sym) { const [seri, skala, sumber] = this.feed.seri(sym); return [new Pasar(sym, seri, skala), sumber]; }
  harga(sym, P) {
    const h = this.feed.harga[sym];
    if (h && now() - h.t < 120000) return +h.p;
    const f = P.forming('1m');
    return f ? +f.c : null;
  }
  hitung(sym, mode) {
    const [P, sumber] = this.pasar(sym), px = this.harga(sym, P);
    if (px == null) return;
    const key = sym + '|' + mode, aktif = strategiAktif(sym, mode), fwd = (this.fwd[sym] || {})[mode] || {}, setelan = this.setelan();
    const [rc, hasil] = susunRencana(P, sym, mode, aktif, setelan, this.kb[sym], this.ramal.get(key), fwd, px);
    const lama = this.cache.get(key) || {}, c = { rencana: rc, sumber, harga: px, t: now(), pa: lama.pa || null, ketidakpastian: lama.ketidakpastian || null };
    if (this.pb.siap(sym)) {
      try {
        const unc = ketidakpastian(sym, mode, this.kb[sym], this.ramal.get(key), this.pb.keadaan, this.pb.mem);
        c.ketidakpastian = unc;
        c.pa = sinyalPA(sym, mode, px, this.kb[sym], this.ramal.get(key), rc.utama, setelan, this.pb.mem, this.pb.keadaan, unc);
      } catch (e) { this.galat[`pa ${sym} ${mode}`] = teksGalat(e); console.error(e); }
    }
    this.cache.set(key, c);
    this.hasil.set(key, [hasil, aktif]);
  }
  perbaruiKebiasaan(sym) {
    const [P] = this.pasar(sym), lama = this.kb[sym] || {}, k = hitungKebiasaan(P, sym);
    if (!k) return;
    k.seri = P.seri;
    TBL.kebiasaan[sym] = k; TBL_KOTOR.add('kebiasaan');
    this.kb[sym] = k;
    const a = lama.rezim || {}, b = k.rezim || {};
    if (Object.keys(a).length && Object.keys(b).length && a.vol_kode !== b.vol_kode) pikir(sym, 'kebiasaan', `${sym}: volatilitas berubah ${a.vol} → ${b.vol}; pengali risiko ${b.pengali_risiko}.`);
    if (Object.keys(a).length && Object.keys(b).length && a.arah_4h !== b.arah_4h && a.arah_4h !== undefined) pikir(sym, 'kebiasaan', `${sym}: tren 4H berubah ${a.tren_4h} → ${b.tren_4h}.`);
  }
  hitungRamal(sym) {
    const [P] = this.pasar(sym), [seri, skala] = this.feed.seri(sym);
    for (const mode of MODES) { const r = ramal(P, mode); this.ramal.set(sym + '|' + mode, r); catatPrediksi(sym, mode, r); }
    evaluasiPrediksi(sym, seri, skala);
  }

  // ---------- jurnal forward-test ----------
  sinkronJurnal() {
    const mulai = this.mulaiJurnal;
    for (const [key, [hasil, aktif]] of this.hasil) {
      const [sym, mode] = key.split('|'), nama = {};
      for (const a of aktif) nama[a.sid] = a.nama;
      for (const [sid, res] of Object.entries(hasil || {})) {
        if (!res) continue;
        for (const tr of res.trades || []) if (tr.t >= mulai) this._tulis(sym, mode, sid, nama[sid], tr, true);
        let ops = res.open || [];
        if (!Array.isArray(ops)) ops = [ops];
        for (const op of ops) if (op && op.t >= mulai) this._tulis(sym, mode, sid, nama[sid], op, false);
      }
    }
    for (const r of TBL.sinyal) if (r.status === 'terbuka' && r.t_sinyal < now() - 5 * DAY) { r.status = 'kedaluwarsa'; TBL_KOTOR.add('sinyal'); }
    const stats = {};
    for (const r of TBL.sinyal) {
      if (r.r == null) continue;
      ((stats[r.sym] = stats[r.sym] || {})[r.mode] = stats[r.sym][r.mode] || {});
      (stats[r.sym][r.mode][r.strat] = stats[r.sym][r.mode][r.strat] || []).push(r.r);
    }
    const out = {};
    for (const [sym, pm] of Object.entries(stats)) for (const [mode, ps] of Object.entries(pm)) for (const [sid, rs] of Object.entries(ps)) {
      const w = rs.filter(x => x > 0), gl = -jumlah(rs.filter(x => x <= 0));
      ((out[sym] = out[sym] || {})[mode] = out[sym][mode] || {})[sid] = { n: rs.length, wr: w.length / rs.length * 100, sum: jumlah(rs), pf: gl > 0 ? jumlah(w) / gl : (w.length ? 99.0 : null) };
    }
    this.fwd = out;
  }
  _tulis(sym, mode, sid, nama, tr, selesai) {
    const key = `${sid}|${sym}|${mode}|${tr.t}|${tr.d}`, ada = this._jurnalIdx.get(key), e = tr.e != null ? tr.e : tr.fills[0][0];
    if (selesai) {
      if (ada && !['terbuka', 'baru'].includes(ada.status)) return;
      const fav = tr.fav || 0, kena = { tp1: fav >= 1, tp2: fav >= 2, tp3: fav >= 3 }, st = tr.r > 0 ? 'menang' : 'kalah';
      if (ada) Object.assign(ada, { status: st, t_keluar: tr.tx, harga_keluar: tr.x, r: tr.r, kena, layer: { n: tr.layers || 1 } });
      else {
        const row = { kunci: key, sym, mode, strat: sid, nama, arah: tr.d, jenis: String(tr.kind), t_sinyal: tr.t, harga_masuk: e, sl0: null, tp1: null, tp2: null, tp3: null,
          status: st, t_keluar: tr.tx, harga_keluar: tr.x, r: tr.r, kena, layer: { n: tr.layers || 1 }, sumber: 'replay', dibuat: now() };
        TBL.sinyal.push(row); this._jurnalIdx.set(key, row);
        pikir(sym, 'refleksi', `${sym} ${nama || sid} ${AB(tr.d)} selesai ${tr.r > 0 ? 'untung' : 'rugi'} ${tr.r >= 0 ? '+' : ''}${fx(tr.r, 2)}R ` +
          `setelah ${tr.bars} candle (maju maksimal ${fx(tr.fav || 0, 1)}R sebelum SL awal). Statistik forward diperbarui.`);
      }
    } else {
      const R0 = tr.R0 || 0, tp = [1, 2, 3].map(k => e + tr.d * k * R0);
      if (ada) ada.layer = { n: (tr.fills || [1]).length, sl: tr.sl };
      else {
        const row = { kunci: key, sym, mode, strat: sid, nama, arah: tr.d, jenis: String(tr.kind), t_sinyal: tr.t, harga_masuk: e, sl0: tr.sl0, tp1: tp[0], tp2: tp[1], tp3: tp[2],
          status: 'terbuka', t_keluar: null, harga_keluar: null, r: null, kena: null, layer: { n: (tr.fills || [1]).length, sl: tr.sl }, sumber: 'live', dibuat: now() };
        TBL.sinyal.push(row); this._jurnalIdx.set(key, row);
        pikir(sym, 'sinyal', `${sym} ${MODE[mode].judul}: sinyal ${AB(tr.d)} ${nama || sid} di ${fmt(e)} (SL ${fmt(tr.sl0)}). Dicatat ke jurnal forward-test.`);
      }
    }
    TBL_KOTOR.add('sinyal');
  }
  jurnal(sym, mode, n = 40) {
    return TBL.sinyal.filter(r => r.sym === sym && r.mode === mode).sort((a, b) => b.t_sinyal - a.t_sinyal).slice(0, n)
      .map(r => ({ nama: r.nama, sid: r.strat, arah: r.arah, t: r.t_sinyal, masuk: r.harga_masuk, sl0: r.sl0, tp1: r.tp1, tp2: r.tp2, tp3: r.tp3, status: r.status,
        t_keluar: r.t_keluar, keluar: r.harga_keluar, r: r.r, kena: r.kena, layer: r.layer }));
  }

  // ---------- lab ----------
  cekLab() {
    if (this.labJalan || this.belajarJalan || !this.feed.siap) return;
    if (!SYMS.every(s => this.pb.siap(s))) return;           // memori price action dulu, lab sesudahnya
    const st = kvGet('lab_status') || {}, terakhir = st.selesai || 0, minta = kvGet('lab_minta') || 0;
    if (!TBL.strategi.length || minta > terakhir || now() - terakhir > DAY) this.jalankanLab();
  }
  jalankanLab() {
    if (this.labJalan) return false;
    this.labJalan = true;
    const run = now();
    kvSet('lab_status', { jalan: true, mulai: run });
    (async () => {
      const out = {};
      try {
        for (const sym of SYMS) {
          if (!this.feed.siapSym(sym)) continue;
          out[sym] = await labSimbol(this.feed, sym, run, (s, m, sid, i, n) => { this.labProgres = { sym: s, mode: m, sid, i, n, t: now() }; });
        }
      } catch (e) { this.galat.lab = teksGalat(e); console.error(e); pikir('', 'galat', `Lab gagal: ${teksGalat(e)}`); }
      finally { this.labProgres = null; kvSet('lab_status', { jalan: false, mulai: run, selesai: now(), ringkas: out }); this.labJalan = false; }
    })();
    return true;
  }

  // ---------- Segarkan ----------
  async segarkan(sym = null) {
    if (this.segarJanji) return this.segarJanji;
    if (now() - (this.segarInfo.t || 0) < 1500) return { ...this.segarInfo, gabung: true };
    if (!this.feed.siapSym(SIMBOL[sym] ? sym : 'XAUUSDm')) return { ok: false, detik: 0, t: now(), pesan: 'Riwayat pasar masih diunduh; coba lagi sebentar.' };
    this.segarJanji = (async () => {
      const t0 = now(), langkah = {};
      this.paksaSym = SIMBOL[sym] ? sym : null;
      const tahap = async (nama, loops, batas) => {
        const ta = now(), gs = loops.map(n => [n, this.putaran[n].bangun()]);
        const ok = (await Promise.all(gs.map(([n, g]) => this.putaran[n].tunggu(g, batas)))).every(Boolean);
        langkah[nama] = { ok, detik: Math.round((now() - ta) / 10) / 100 };
      };
      this.cekVersi();
      await tahap('data', ['feed'], 12000);
      await tahap('memori', ['berkala', 'belajar'], 20000);
      this._blCache.clear(); this.pb.mem.buang();
      await tahap('rencana', ['hitung'], 10000);
      const hf = this.hasilFeed, gagal = {}, lambat = [];
      for (const [k, v] of Object.entries(hf)) { if (!['ok', 'berjalan', 'latar'].includes(v)) gagal[k] = v; if (v === 'berjalan') lambat.push(k); }
      const tfBin = Object.keys(hf).filter(k => BINANCE_SERI.includes(k.split(' ')[0])), tfBuruk = tfBin.filter(k => hf[k] !== 'ok'), catatan = [];
      if (tfBin.length && tfBuruk.length * 2 >= tfBin.length) {
        const h = this.feed.harga[this.paksaSym || 'XAUUSDm'] || {}, umur = h.t ? (now() - h.t) / 1000 : null;
        catatan.push('Binance tidak menjawab (cek koneksi internet); angka memakai data terakhir' + (umur && umur > 5 ? `, harga ${fx(umur)} dtk lalu` : ''));
      } else {
        if (Object.keys(gagal).length) catatan.push(`${Object.keys(gagal).length} sumber gagal (${Object.keys(gagal).slice(0, 3).join(', ')})`);
        if (lambat.length) catatan.push(`${lambat.length} masih diunduh (${lambat.slice(0, 3).join(', ')})`);
      }
      const hasil = { ok: Object.values(langkah).every(v => v.ok) && !Object.keys(gagal).length && !tfBuruk.length, detik: Math.round((now() - t0) / 10) / 100,
        t: now(), sym: this.paksaSym, langkah, feed: hf, gagal, catatan: catatan.join('; ') };
      this.segarInfo = hasil;
      simpanKe();
      return hasil;
    })();
    try { return await this.segarJanji; } finally { this.segarJanji = null; }
  }

  // ---------- keluaran ----------
  denyut() {
    const f = this.feed, harga = {};
    for (const s of SYMS) { const h = f.harga[s] || {}; harga[s] = { p: h.p ?? null, t: h.t ?? null, sumber: h.sumber ?? null }; }
    const putaran = {}; for (const [n, L] of Object.entries(this.putaran)) putaran[n] = L.t;
    return { now: now(), putaran, web: this.webTerbaru, harga, binance: f.status.binance, mt5_ok: false, segar: Object.keys(this.segarInfo).length ? this.segarInfo : null,
      belajar: this.belajarJalan, pemimpin: PEMIMPIN };
  }
  perubahan24j(sym) {
    const [seri, skala] = this.feed.seri(sym), D = candle(seri, '1h', { n: 26 }), h = this.feed.harga[sym];
    if (D.c.length < 25 || !h) return null;
    return (h.p / (D.c[D.c.length - 25] * skala) - 1) * 100;
  }
  state(sym, mode) {
    this.lihat.set(sym + '|' + mode, now());
    const key = sym + '|' + mode, c = this.cache.get(key) || {}, kb = this.kb[sym] || {}, cfg = SIMBOL[sym];
    const lab = { ...(kvGet('lab_status') || {}), progres: this.labProgres, proses: this.labJalan };
    const st = {
      sym, mode, cfg: { nama: cfg.nama, judul: cfg.judul, tv: cfg.tv, dp: cfg.dp, kontrak: cfg.kontrak },
      harga: c.harga || (this.feed.harga[sym] || {}).p || null, sumber: c.sumber || null, chg24: this.perubahan24j(sym), rencana: c.rencana || null, t_rencana: c.t || null,
      prediksi: this.ramal.get(key) || [], akurasi: kvGet(`akurasi:${sym}:${mode}`) || {}, akurasi_nyata: rekapPrediksi(sym, mode),
      kebiasaan: kb, strategi: semuaStrategi(sym), pikiran: daftarPikiran(40, sym), jurnal: this.jurnal(sym, mode, 40), forward: (this.fwd[sym] || {})[mode] || {},
      lab, setelan: this.setelan(), feed: this.statusFeed(), mode_info: MODE[mode], now: now(), riwayat: this.feed.siapSym(sym) ? null : (this.progres.riwayat || null),
      siap: this.feed.siapSym(sym),
    };
    st.offset_exness = null;
    const lain = mode === 'scalp' ? 'swing' : 'scalp', u = (st.rencana || {}).utama || {}, v = ((this.cache.get(sym + '|' + lain) || {}).rencana || {}).utama || {};
    st.konflik = null;
    if ((u.aksi === 'BUY' || u.aksi === 'SELL') && (v.aksi === 'BUY' || v.aksi === 'SELL') && u.aksi !== v.aksi) {
      st.konflik = `Rencana ${MODE[mode].judul.toLowerCase()} ${u.aksi} berlawanan dengan ${MODE[lain].judul.toLowerCase()} ${v.aksi} (${(v.status || '').toLowerCase()}, ${v.nama}). ` +
        'Posisi melawan arah TF besar: pakai risiko lebih kecil dan ambil TP lebih cepat, atau tunggu keduanya searah.';
    }
    st.pa = c.pa || null;
    st.ketidakpastian = c.ketidakpastian || null;
    st.belajar = this.infoBelajar(sym, mode);
    st.rekap = rekapTerbaru(sym);
    st.gerak = TF_MODE[mode].map(tf => ((this.pb.keadaan.get(sym + '|' + tf) || {}).gerak) || null);
    st.putaran = this.denyut().putaran;
    st.segar = Object.keys(this.segarInfo).length ? this.segarInfo : null;
    st.web = this.webTerbaru;
    st.narasi = susunNarasi(sym, mode, st);
    st.order_teks = teksOrder(sym, (st.rencana || {}).utama);
    st.order_teks_pa = teksOrderPA(sym, st.pa);
    return st;
  }
  infoBelajar(sym, mode) {
    const tfs = TF_MODE[mode], key = sym + '|' + tfs.join(',');
    let c = this._blCache.get(key);
    if (!c || now() - c[0] > 20000) {
      c = [now(), { progres: progresPA(sym), akurasi: akurasiSaran(sym, tfs), akurasi_7h: akurasiSaran(sym, tfs, 7), terakhir: hasilTerakhir(sym, tfs) }];
      this._blCache.set(key, c);
    }
    const b = c[1], val = {}, mem = {};
    for (const tf of tfs) { val[tf] = kvGet(`pa_validasi:${sym}:${tf}`); mem[tf] = this.pb.siap(sym) ? this.pb.mem.ringkas(sym, tf) : { n: 0, n_maju: 0 }; }
    const galat = {};
    for (const [k, v] of Object.entries(this.galat)) if (k === 'belajar' || k === 'rekap' || k.startsWith('pa ') || k.startsWith('tabel')) galat[k] = String(v).slice(-300);
    return { siap: this.pb.siap(sym), proses: this.belajarJalan || (this.feed.siapSym(sym) && !this.pb.siap(sym)), riwayat: kvGet('pa_riwayat:' + sym),
      progres: b.progres, tabel: this.tabel.get(sym + '|' + mode) || [], validasi: val, t_validasi: kvGet('pa_validasi_t:' + sym),
      akurasi: b.akurasi, akurasi_7h: b.akurasi_7h, terakhir: b.terakhir, memori: mem, status: kvGet('pa_status') || {}, galat };
  }
  statusFeed() {
    const f = this.feed, mg = {};
    for (const [k, v] of Object.entries(this.galat)) mg[k] = String(v).slice(-300);
    return { binance: f.status.binance, binance_host: binanceHost()[1].split('/')[2], spot: f.status.spot, mt5: null, mt5_ok: false, exness_btc: null,
      rasio_xau: f.rasio, galat: Object.fromEntries(Object.entries(f.status.galat).slice(-6)), mesin_galat: mg, pemimpin: PEMIMPIN,
      waktu_mulai: typeof WAKTU !== 'undefined' ? WAKTU : null };
  }
  ringkas() {
    const out = {};
    for (const sym of SYMS) {
      const h = this.feed.harga[sym] || {}, o = { harga: h.p ?? null, chg24: this.perubahan24j(sym), sumber: h.sumber ?? null, mode: {} };
      for (const mode of MODES) {
        const c = this.cache.get(sym + '|' + mode) || {}, u = (c.rencana || {}).utama || {}, m = {};
        for (const k of ['aksi', 'status', 'entry', 'sl', 'nama', 'yakin', 'grade', 'jenis_entry']) m[k] = u[k] ?? null;
        m.tp = u.tp || null;
        const s = c.pa || {}; m.pa = {};
        for (const k of ['aksi', 'status', 'nama', 'tf', 'entry', 'sl', 'tp', 'tp_p', 'yakin', 'e_kal']) m.pa[k] = s[k] ?? null;
        const u2 = c.ketidakpastian || {}; m.ketidakpastian = { skor: u2.skor ?? null, label: u2.label ?? null };
        o.mode[mode] = m;
      }
      out[sym] = o;
    }
    return out;
  }
  teks(sym, mode) {
    const st = this.state(sym, mode), bag = [st.narasi.join('\n')];
    if (st.order_teks) bag.push('Rencana strategi:\n' + st.order_teks);
    if (st.order_teks_pa) bag.push('Sinyal price action:\n' + st.order_teks_pa);
    return bag.join('\n\n');
  }
  /** Candle TF; candle yang sedang berjalan dilengkapi dari candle 1m (±1 dtk) agar peta bergerak real-time. */
  candleHidup(seri, tf, n) {
    const D = salinD(candle(seri, tf, { n }));
    if (tf === '1m' || !D.t.length) return D;
    const ms = TF_MS[tf], b0 = Math.floor(now() / ms) * ms, L = D.t.length - 1;
    if (D.t[L] > b0 || (this.feed.segar_tf.get(seri + '|1m') || 0) <= (this.feed.segar_tf.get(seri + '|' + tf) || 0)) return D;
    const M = candle(seri, '1m', { dari: b0 });
    if (!M.t.length) return D;
    let hi = -Infinity, lo = Infinity, vol = 0;
    for (let i = 0; i < M.t.length; i++) { hi = Math.max(hi, M.h[i]); lo = Math.min(lo, M.l[i]); vol += M.v[i]; }
    const c = M.c[M.c.length - 1];
    if (D.t[L] === b0) { D.h[L] = Math.max(D.h[L], hi); D.l[L] = Math.min(D.l[L], lo); D.c[L] = c; return D; }
    const baru = { t: b0, o: M.o[0], h: hi, l: lo, c, v: vol }, out = {};
    for (const k of KOL) { const a = new Float64Array(D[k].length + 1); a.set(D[k]); a[a.length - 1] = baru[k]; out[k] = a.slice(-n); }
    return out;
  }
  peta(sym, tf, n) {
    if (!TF_MS[tf]) throw new Error('tf');
    const [seri, skala] = this.feed.seri(sym), emas = sym === 'XAUUSDm' && tf !== '1m';
    let D = this.candleHidup(seri, tf, emas ? Math.ceil(n * 1.45) + 10 : n);
    if (emas) {
      const keep = []; for (let i = 0; i < D.t.length; i++) if (tf === '1d' ? hariKerja(D.t[i]) : pasarEmasBuka(D.t[i])) keep.push(i);
      const ks = keep.slice(-n), D2 = {}; for (const k of KOL) D2[k] = Float64Array.from(ks, i => D[k][i]); D = D2;
    }
    const sk = a => Array.from(a, x => x * skala);
    const out = { t: Array.from(D.t), o: sk(D.o), h: sk(D.h), l: sk(D.l), c: sk(D.c), pola: [], tf };
    const G = gudang(sym, tf);
    if (D.t.length && G) {
      for (let i = cariKiri(G.t, D.t[0], G.n); i < G.n; i++) {
        const p = POLA_URUT[G.pola[i]];
        out.pola.push({ t: G.t[i], pola: p, kode: SINGKAT[p], nama: POLA[p], arah: G.arah[i], status: STATUS_PA[G.status[i]], mfe: G.nul('mfe', i), kena_sl: G.nul('kena_sl', i),
          disarankan: G.disarankan[i], sumber: G.sumber[i] ? 'maju' : 'riwayat', harga: G.harga[i], sl: G.sl[i] });
      }
    }
    const kd = this.pb.keadaan.get(sym + '|' + tf) || {};
    out.swing = { high: kd.swing_high || [], low: kd.swing_low || [] };
    out.struktur = kd.struktur ?? null;
    return out;
  }
  simpanSetelan(body) {
    let s = { ...(kvGet('setelan') || {}) };
    for (const k of ['saldo', 'risiko_pct', 'usd_idr']) {
      if (k in body && body[k] !== null && body[k] !== '') {
        const v = parseFloat(body[k]);
        if (!Number.isFinite(v)) throw new Error(`${k} tidak valid`);
        if (k === 'risiko_pct' && !(v >= 0.05 && v <= 10)) throw new Error('risiko 0,05-10%');
        if (v <= 0) throw new Error(`${k} harus > 0`);
        s[k] = v;
      }
    }
    if (body.mata_uang === 'IDR' || body.mata_uang === 'USD') s.mata_uang = body.mata_uang;
    if (body.reset) s = {};
    kvSet('setelan', s);
    for (const mode of MODES) for (const sym of SYMS) if (this.feed.siapSym(sym)) { try { this.hitung(sym, mode); } catch (e) { /* abaikan */ } }
    return { ok: true, setelan: this.setelan() };
  }
}

