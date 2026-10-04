// コード付けを、正解つきの歌のデータで採点する。
//   node tests/eval-chords.mjs
// 基準：楽譜どおりのメロディに、同じ仕組みで付けたコード。崩れた歌から付けたコードが、どれだけ基準と同じになるかを見る。
// あわせて、付けたコードで「音程を整える（理論チェック・中）」をかけたあとの、音が合う割合も出す
import { chromium } from '../video/node_modules/playwright-core/index.mjs';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const CSV = path.join(ROOT, 'songs/testdata/dai2015/tsom-intonation.csv');
if (!fs.existsSync(CSV)) { console.error('データがありません：' + CSV + '\n取り方は tests/README.md を見てください。'); process.exit(1); }
const [head, ...body] = fs.readFileSync(CSV, 'utf8').trim().split('\n').map(l => l.split(','));
const col = n => head.indexOf(n);
const rows = body.map(r => ({ singer: +r[col('SingerNo')], piece: +r[col('Piece')], run: +r[col('Run')], nom: +r[col('NominalPitch')], nd: +r[col('NominalDuration')],
  m: +r[col('SungPitch')], t0: +r[col('Onset')], d: +r[col('Duration')] })).filter(r => isFinite(r.m) && isFinite(r.t0));
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
page.on('pageerror', e => console.error('page error:', e.message));
await page.goto('file://' + path.join(ROOT, 'index.html'));
const softs = [0];

const out = await page.evaluate(({ rows, softs }) => {
  let seed = 12345;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const recs = new Map();
  for (const r of rows) { const k = r.singer + '-' + r.piece; if (!recs.has(k)) recs.set(k, []); recs.get(k).push(r); }
  const TRUE_KEY = { 1: [10, 'major'], 2: [0, 'major'], 3: [4, 'minor'] };
  const BEAT = { 1: 0.75, 2: 0.5, 3: 60 / 132 }, PER_BAR = { 1: 3, 2: 4, 3: 3 };       // 1拍の秒数と、1小節の拍数
  const CONDS = { 'そのまま': null, '幅が縮む(0.69倍)': { k: 0.69 }, '縮む＋ばらつき(0.5半音)': { k: 0.69, noise: 0.5 }, 'ばらつきだけ(0.5半音)': { noise: 0.5 } };
  const mkSecFrom = notes => ({ id: 's1', name: 'T', shift: 0, chords: [], melody: notes, verses: [] });
  const chordsOf = (notes, tonic, mode, soft) => {
    song.tonic = tonic; song.mode = mode;
    const sec = mkSecFrom(notes);
    song.sections = [sec]; song.arrangement = [sec.id]; song.current = sec.id;
    const bars = Math.max(1, Math.ceil(Math.max(...notes.map(n => n.t + n.d)) / 4 - 1e-9));
    harmonize(sec, bars);
    return sec;
  };
  const res = {};
  for (const [cname, cond] of Object.entries(CONDS)) {
    seed = 12345;
    res[cname] = {};
    const data = [...recs.entries()].map(([key, notes]) => {
      notes = [...notes].sort((a, b) => a.t0 - b.t0);
      const center = medOf(notes.map(n => n.m)), off = rnd() - 0.5, piece = notes[0].piece;
      // 楽譜の上での位置（拍）：回ごとに、楽譜の長さを足していく。1小節を4に直す
      let beat = 0, run = notes[0].run;
      return { piece, notes: notes.map((n, i) => {
        if (n.run !== run) { run = n.run; beat = Math.ceil(beat / 4 - 1e-9) * 4; }
        const d = n.nd / BEAT[piece] * 4 / PER_BAR[piece], t = beat;
        beat += d;
        let m = n.m + off;
        if (cond) m = center + (cond.k || 1) * (m - center) + (cond.noise ? cond.noise * gauss() : 0);
        return { t0: n.t0, t1: n.t0 + n.d, m, nom: n.nom, t, d };
      }) };
    });
    for (const soft of softs) {
      let agree = 0, bars = 0, ok0 = 0, ok1 = 0, tot = 0;
      const lvChanged = {}, lvBroke = {}, lvFixed = {};
      for (const rec of data) {
        const [tk, tm] = TRUE_KEY[rec.piece];
        const ref = chordsOf(rec.notes.map(n => ({ t: n.t, d: n.d, m: n.nom })), tk, tm, 0);
        const refPcs = ref.chords.map(c => chordInfo(c, secKey(ref)).pcs.slice().sort().join());
        const lines = [];
        rec.notes.forEach((n, i) => { if (!i || n.t0 - rec.notes[i - 1].t1 > 0.3) lines.push({ notes: [] }); lines[lines.length - 1].notes.push({ ...n }); });
        const key = pitchStage(lines, { octave: 0, pitch: 'v2', snapKey: true });
        const ns = lines.flatMap(l => l.notes);
        const cnt = {};
        for (const n of ns) cnt[n.p - n.nom] = (cnt[n.p - n.nom] || 0) + 1;
        const shift = +Object.entries(cnt).sort((a, b) => b[1] - a[1])[0][0];
        const sec = chordsOf(ns.map(n => ({ t: n.t, d: n.d, m: n.p, nom: n.nom })), key.k, key.mode, soft);
        sec.chords.forEach((c, b) => {
          const pcs = chordInfo(c, secKey(sec)).pcs.map(p => ((p - shift) % 12 + 12) % 12).sort().join();
          bars++; if (pcs === refPcs[b]) agree++;
        });
        tot += ns.length;
        ok0 += sec.melody.filter(n => n.m - n.nom === shift).length;
        // 理論チェックの強さごと：直した音の数と、直したあとに合っている音の数（毎回、直す前の状態から）
        const base = sec.melody.map(n => n.m);
        for (const lv of [1, 2, 3]) {
          const fx = theoryFixes(sec, lv);
          lvChanged[lv] = (lvChanged[lv] || 0) + fx.length;
          for (const f of fx) { const wasOk = base[f.i] - sec.melody[f.i].nom === shift, nowOk = f.to - sec.melody[f.i].nom === shift; if (wasOk && !nowOk) lvBroke[lv] = (lvBroke[lv] || 0) + 1; if (!wasOk && nowOk) lvFixed[lv] = (lvFixed[lv] || 0) + 1; }
        }
        for (const f of theoryFixes(sec, 2)) sec.melody[f.i].m = f.to;
        ok1 += sec.melody.filter(n => n.m - n.nom === shift).length;
      }
      res[cname][soft] = { agree: agree / bars, before: ok0 / tot, after: ok1 / tot, tot, lvChanged, lvBroke, lvFixed };
    }
  }
  return res;
}, { rows, softs });
await browser.close();
const pct = x => (x * 100).toFixed(1).padStart(5) + '%';
for (const [cname, ms] of Object.entries(out)) {
  console.log(`\n■ ${cname}`);
  for (const [soft, r] of Object.entries(ms)) {
    if (!+soft) for (const lv of [1, 2, 3]) console.log(`    理論チェック ${['', '弱', '中', '強'][lv]}：動かした音 ${(r.lvChanged[lv] / r.tot * 100).toFixed(1)}%（合っていた音を外した ${((r.lvBroke[lv] || 0) / r.tot * 100).toFixed(1)}% ／ 外れていた音を合わせた ${((r.lvFixed[lv] || 0) / r.tot * 100).toFixed(1)}%）`);
    console.log('  基準と同じコード ' + pct(r.agree) + ' ／ 音が合う ' + pct(r.before) + '（理論チェック・中のあと ' + pct(r.after) + '）');
  }
}
