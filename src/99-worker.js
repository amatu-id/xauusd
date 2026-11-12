// ================================================================== Web Worker: jembatan ke halaman
let MESIN = null;
const T_MULAI = now(), WAKTU = {};
const SIAP = (async () => {
  try { await idbBuka(); } catch (e) { console.warn('IndexedDB tidak tersedia, data hanya di memori', e); }
  try { await muatSemua(); } catch (e) { console.warn('memuat data tersimpan gagal', e); }
  WAKTU.idb = now() - T_MULAI;
  kunciPemimpin(() => { if (now() - T_MULAI > 8000) tandaiSemuaKotor(); });
  MESIN = new Mesin();
  MESIN.mulai();
  setInterval(() => simpanKe(), 3000);
})();

async function rute(path, q, body, metode) {
  if (path === 'simpan') { await simpanKe(true); return { ok: true }; }
  const sym = q.sym || 'XAUUSDm', mode = q.mode || 'scalp';
  if (!SIMBOL[sym] || !MODE[mode]) throw new Error('simbol/mode tidak dikenal');
  const M = MESIN;
  if (metode === 'POST') {
    if (path === '/api/setelan') return M.simpanSetelan(body || {});
    if (path === '/api/segarkan') return M.segarkan((body || {}).sym);
    if (path === '/api/lab') {
      kvSet('lab_minta', now());
      const ok = M.jalankanLab();
      pikir('', 'lab', 'Lab otonom dijalankan atas permintaan Yulius.');
      return { ok: true, dimulai: ok };
    }
    if (path === '/api/belajar') {
      kvSet('pa_minta', now());
      const ok = M.jalankanBelajar(!!(body || {}).ulang);
      pikir('', 'belajar', 'Uji walk-forward memori price action dijalankan ulang atas permintaan Yulius.' + ((body || {}).ulang ? ' Memori riwayat diisi ulang dari awal.' : ''));
      return { ok: true, dimulai: ok };
    }
    throw new Error('tidak ada');
  }
  switch (path) {
    case '/api/state': return M.state(sym, mode);
    case '/api/ringkas': return M.ringkas();
    case '/api/denyut': return M.denyut();
    case '/api/teks': return M.teks(sym, mode);
    case '/api/peta': return M.peta(sym, q.tf || '15m', Math.min(+(q.n || 160), 600));
    case '/api/jurnal': return M.jurnal(sym, mode, +(q.n || 100));
    case '/api/pikiran': return daftarPikiran(+(q.n || 100));
    case '/api/lab': return { status: kvGet('lab_status'), strategi: semuaStrategi(sym) };
    case '/api/rekap': return daftarRekap(sym, Math.min(+(q.n || 40), 200), q.jenis || null);
    case '/api/debug': {
      const out = { waktu: WAKTU, pemimpin: PEMIMPIN, galat: M.galat, kv: {}, gudang: {}, keadaan: {}, segar: Object.fromEntries(M.feed.segar_tf), data: {} };
      for (const [k, v] of KV) if (/^pa_(kursor|maju_awal|versi|validasi_t)|^rekap_kursor|^lab_status|^mulai_jurnal/.test(k)) out.kv[k] = v;
      for (const [k, G] of GUDANG) { let maju = 0, tunggu = 0; for (let i = 0; i < G.n; i++) { maju += G.sumber[i]; tunggu += G.status[i] <= 1 ? 1 : 0; } out.gudang[k] = { n: G.n, maju, tunggu, akhir: G.n ? G.t[G.n - 1] : null }; }
      for (const [k, v] of M.pb.keadaan) out.keadaan[k] = { t: v.t, struktur: v.struktur, galat: v.galat || null };
      for (const [k, S] of DATA) out.data[k] = { n: S.n, akhir: S.n ? S.t[S.n - 1] : null };
      return out;
    }
    case '/api/belajar': return { tabel: M.pb.siap(sym) ? M.pb.mem.tabel(sym, q.semua ? TF_BELAJAR : TF_MODE[mode], null) : [], info: M.infoBelajar(sym, mode) };
    default: throw new Error('tidak ada');
  }
}

if (typeof self !== 'undefined' && typeof self.postMessage === 'function' && typeof window === 'undefined') {
  self.onmessage = async ev => {
    const { id, path, q, body, metode } = ev.data || {};
    try {
      await SIAP;
      const hasil = await rute(path, q || {}, body, metode || 'GET');
      self.postMessage({ id, ok: true, hasil });
    } catch (e) {
      self.postMessage({ id, ok: false, galat: teksGalat(e) });
    }
  };
}
