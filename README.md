# Trading AI Yulius · XAUUSD (web)

Salinan lengkap menu **Trading** AI Yulius sebagai situs web: https://amatu-id.github.io/xauusd/

Satu layar tiga kolom: chart TradingView + peta sinyal AI + gerak candle · keputusan gabungan, ketidakpastian,
sinyal price action, rencana strategi, prediksi analog · memori kebiasaan pasar, belajar price action, rekap
memori, aktivitas AI. XAUUSDm dan BTCUSDT, mode Scalping dan Swing, LIVE + Segarkan (⌘R), keterangan saat mouse
diarahkan, jendela Lab / Jurnal / Semua pola / Level kunci / Analisis / Setelan.

Tanpa server dan tanpa Mac: seluruh mesin AI Yulius (port dari `offline-agent/files/trading`, Python) berjalan di
Web Worker browser — data langsung dari Binance (BTCUSDT, PAXGUSDT) dan harga spot emas (gold-api.com), memori dan
riwayat tersimpan di IndexedDB perangkat. XAUUSDm = PAXGUSDT × rasio spot emas (candle di luar jam pasar emas
dibuang), karena MT5 hanya bisa dibaca dari Mac. Hanya membaca pasar — tidak pernah mengirim order.

- `src/*.js` → `./build.sh` → `mesin.js` (+ cap versi di `index.html`, `versi.txt`)
- `trading.js`, `trading.css`, `index.src.html` = tampilan (salinan web AI Yulius 1.11.2)

Perhitungan statistik dari data historis dan real-time, bukan kepastian atau nasihat keuangan.
