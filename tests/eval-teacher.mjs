// 「歌詞で組む」を、人が同じ録音から仕上げた曲（教師データ）と突き合わせて採点する。
//   node tests/eval-teacher.mjs
// 必要なもの（どれも Git の管理外）：songs/naite-memo.m4a（録音）、songs/naite.json（仕上げた曲）、
//   songs/naite-before-restructure.json（読み込みに使った歌詞を取り出す）。ローカルのサーバー（http://localhost:8766）も要る
// 採点：歌う音の位置（行の頭からの拍）が、仕上げた曲と同じ割合。コピーで作ったセクションと、歌詞を書き換えた行は除く
import { chromium } from '../video/node_modules/playwright-core/index.mjs';
import fs from 'node:fs';
import path from 'node:path';
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const need = ['songs/naite-memo.m4a', 'songs/naite.json', 'songs/naite-before-restructure.json'].map(f => path.join(ROOT, f));
if (!need.every(f => fs.existsSync(f))) { console.error('教師データがありません（songs/ は Git の管理外です）。'); process.exit(1); }
const final = JSON.parse(fs.readFileSync(need[1], 'utf8'));
const lyrics = JSON.parse(fs.readFileSync(need[2], 'utf8')).importInfo?.lyrics;
const COPIED = ['盛り上げ2', 'ラスサビ'];                 // ほかのセクションのメロディを写したもの
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage();
page.on('pageerror', e => console.error('page error:', e.message));
await page.goto('http://localhost:8766/index.html'); await page.waitForTimeout(500);
const out = await page.evaluate(async ({ b64, lyrics, final, COPIED }) => {
  const bin = atob(b64), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  const res = await analyzeVoice(new File([u], 'memo.m4a', { type: 'audio/mp4' }), lyrics, { barsPerLine: 2, grid: 0.5, octave: 0, snapKey: true }, () => {});
  const norm = t => t.replace(/[\s　]/g, '');
  const raw = res.lines.map(l => ({ text: norm(l.text), notes: l.notes.map(n => ({ t: n.t0, d: n.t1 - n.t0, m: n.p, tie: !!n.tie })) }));
  song = final;
  const used = {}, rows = [];
  for (const sec of song.sections) {
    const spans = lineSpans(sec), texts = verseText(sec, 0).split('\n').filter(t => parseLyrics(t, song.lyrExt).all.length);
    spans.forEach((sp, li) => {
      const text = norm(texts[li] || ''), cands = raw.filter(r => r.text === text), k = used[text] = (used[text] ?? -1) + 1;
      if (COPIED.includes(sec.name) || !cands.length) return;
      const human = sec.melody.filter(n => !n.tie && n.t >= sp.s && n.t < sp.e).map(n => n.t - sp.s).sort((a, b) => a - b);
      const src = cands[Math.min(k, cands.length - 1)].notes;
      if (src.filter(n => !n.tie).length !== human.length) return;
      const fit = pos => (pos ? pos.filter((p, i) => p === human[i]).length : 0);
      const grid = moraGrid(src, { s: 0, e: sp.e - sp.s, mora: sp.mora, parts: sp.parts }, 0.5);
      rows.push({ name: sec.name + '#' + (li + 1), n: human.length, grid: fit(grid && grid.filter(n => !n.tie).map(n => n.t)), plain: fit(human.map((_, i) => i * 0.5)) });
    });
  }
  return rows;
}, { b64: fs.readFileSync(need[0]).toString('base64'), lyrics, final, COPIED });
await browser.close();
const tot = out.reduce((a, r) => a + r.n, 0);
console.log(`教師にした行 ${out.length}・歌う音 ${tot}`);
console.log(`歌詞で組む　　　　　　　：位置が同じ音 ${(out.reduce((a, r) => a + r.grid, 0) / tot * 100).toFixed(1)}%・全部同じ行 ${out.filter(r => r.grid === r.n).length}/${out.length}`);
console.log(`8分音符で並べるだけ　　：位置が同じ音 ${(out.reduce((a, r) => a + r.plain, 0) / tot * 100).toFixed(1)}%・全部同じ行 ${out.filter(r => r.plain === r.n).length}/${out.length}`);
console.log(out.map(r => `${r.name} ${r.grid}/${r.n}`).join('  '));
