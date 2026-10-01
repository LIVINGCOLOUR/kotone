#!/bin/sh
# Web 版（https://kotonemusic.pages.dev）へデプロイする。公開するのはアプリ・マニュアル・紹介動画だけ
set -e
cd "$(dirname "$0")"
rm -rf dist
mkdir dist
cp index.html manual.html dist/
cp media/kotone-intro.mp4 dist/intro.mp4   # 紹介動画（ブラウザでそのまま再生できるように）
npx wrangler pages deploy dist --project-name kotonemusic --branch main
