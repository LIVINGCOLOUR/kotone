#!/bin/sh
# Web 版（https://kotonemusic.pages.dev）へデプロイする。公開するのはアプリとマニュアルだけ
set -e
cd "$(dirname "$0")"
rm -rf dist
mkdir dist
cp index.html manual.html dist/
npx wrangler pages deploy dist --project-name kotonemusic --branch main
