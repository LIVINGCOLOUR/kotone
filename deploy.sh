#!/bin/sh
# Web 版（https://kotonemusic.pages.dev）へデプロイする。公開するのはトップページ・アプリ・マニュアル・紹介動画だけ
#   /            トップページ（site/index.html）
#   /app/        アプリ（index.html）とマニュアル（manual.html）
#   /sing.mp4 /intro.mp4  紹介動画（ブラウザでそのまま再生できるように）
set -e
cd "$(dirname "$0")"
rm -rf dist
mkdir -p dist/app
cp site/index.html site/_redirects dist/
cp index.html manual.html dist/app/
cp media/kotone-intro.mp4 dist/intro.mp4
cp media/kotone-sing.mp4 dist/sing.mp4
cp media/kotone-intro-thumb.jpg dist/intro-thumb.jpg
cp media/kotone-sing-thumb.jpg dist/sing-thumb.jpg
[ "$1" = "--build-only" ] && exit 0
npx wrangler pages deploy dist --project-name kotonemusic --branch main
