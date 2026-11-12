#!/bin/bash
# Bangun mesin.js dari src/*.js dan cap versi (cache GitHub Pages ±10 menit → ?v=<hash>).
set -e
cd "$(dirname "$0")"
cat src/*.js > .mesin.tmp
H=$(cat .mesin.tmp trading.js trading.css index.src.html | shasum | cut -c1-12)
sed "s/%%VERSI%%/$H/g" .mesin.tmp > mesin.js
rm -f .mesin.tmp
sed "s/%%VERSI%%/$H/g" index.src.html > index.html
echo "$H" > versi.txt
node --check mesin.js
node --check trading.js
echo "versi $H"
