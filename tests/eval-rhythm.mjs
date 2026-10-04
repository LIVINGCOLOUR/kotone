// 拍へのあてはめ（リズムの読み取り）を、正解つきの歌のデータで採点する。
//   node tests/eval-rhythm.mjs
// データのうち、4拍子で、1行が2小節の曲（Do-Re-Mi）だけを使う（Kotone は 4拍子で、歌詞1行を決まった小節数に入れるため）。
// 採点：音の始まりの位置（行の頭からの拍）が、楽譜と同じ割合。自由に歌ったときの崩れ（行の間の休み・行ごとのテンポ・音ごとのゆれ）を足した条件でも測る
import { chromium } from '../video/node_modules/playwright-core/index.mjs';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const CSV = path.join(ROOT, 'songs/testdata/dai2015/tsom-intonation.csv');
if (!fs.existsSync(CSV)) { console.error('データがありません：' + CSV + '\n取り方は tests/README.md を見てください。'); process.exit(1); }
const [head, ...body] = fs.readFileSync(CSV, 'utf8').trim().split('\n').map(l => l.split(','));
const col = n => head.indexOf(n);
const rows = body.map(r => ({ singer: +r[col('SingerNo')], piece: +r[col('Piece')], run: +r[col('Run')], nd: +r[col('NominalDuration')],
  t0: +r[col('Onset')], d: +r[col('Duration')] })).filter(r => r.piece === 2 && isFinite(r.t0));
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
page.on('pageerror', e => console.error('page error:', e.message));
await page.goto('file://' + path.join(ROOT, 'index.html'));
const extra = process.argv[2] ? JSON.parse(process.argv[2]) : null;

const out = await page.evaluate(({ rows, extra }) => {
  let seed = 4242;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  // 回（歌い手×何回目）ごとに、行に分ける。行の頭は、歌詞の行の最初の音（Doe / Ray / Me / Far / Sew / La / Tea / That will…）
  const STARTS = [0, 7, 14, 21, 28, 35, 42, 49];
  const runs = new Map();
  for (const r of rows) { const k = r.singer + '-' + r.run; if (!runs.has(k)) runs.set(k, []); runs.get(k).push(r); }
  const base = [...runs.values()].map(notes => {
    notes.sort((a, b) => a.t0 - b.t0);
    const lines = [];
    let beat = 0;
    notes.forEach((n, i) => {
      if (STARTS.includes(i)) lines.push({ start: beat, notes: [] });
      const l = lines[lines.length - 1];
      l.notes.push({ t0: n.t0, t1: n.t0 + n.d, truth: beat - l.start });
      beat += n.nd / 0.5;
    });
    return lines;
  });
  const CONDS = {
    'そのまま（拍に合わせて歌った録音）': {},
    '行の間の休みがばらばら(0〜1.5秒)': { pause: 1.5 },
    '休み＋行ごとにテンポが変わる(0.75〜1.35倍)': { pause: 1.5, tempo: true },
    '休み＋テンポ＋音ごとのゆれ(0.05秒)': { pause: 1.5, tempo: true, jitter: 0.05 },
    '休み＋テンポ＋音ごとのゆれ(0.1秒)': { pause: 1.5, tempo: true, jitter: 0.1 },
  };
  const res = {};
  for (const [cname, c] of Object.entries(CONDS)) {
    seed = 4242;
    const data = base.map(lines => {
      let shift = 0;
      return lines.map(l => {
        const f = c.tempo ? 0.75 + 0.6 * rnd() : 1, s0 = l.notes[0].t0;
        const ns = l.notes.map(n => { const j = c.jitter ? c.jitter * gauss() : 0; return { t0: s0 + (n.t0 - s0) * f + shift + j, t1: s0 + (n.t1 - s0) * f + shift + j, truth: n.truth }; });
        for (let i = 1; i < ns.length; i++) if (ns[i].t0 < ns[i - 1].t0 + 0.03) ns[i].t0 = ns[i - 1].t0 + 0.03;   // 順番は入れ替えない
        shift += (l.notes[l.notes.length - 1].t1 - s0) * (f - 1) + (c.pause ? c.pause * rnd() : 0);
        return { notes: ns };
      });
    });
    res[cname] = {};
    for (const method of ['v1', 'v2']) {
      let ok = 0, near = 0, tot = 0, ioiOk = 0, ioiTot = 0, bpms = [];
      for (const lines of data) {
        const ls = lines.map(l => ({ notes: l.notes.map(n => ({ ...n })) }));
        bpms.push(rhythmStage(ls, { barsPerLine: 2, grid: 0.5, rhythm: method, r2: extra || undefined }));
        ls.slice(0, -1).forEach(l => {                     // 最後の行は楽譜で2小節を超えるので、採点しない
          l.notes.forEach((n, i) => {
            tot++; if (n.b === n.truth) ok++; if (Math.abs(n.b - n.truth) <= 0.5) near++;
            if (i) { ioiTot++; if (n.b - l.notes[i - 1].b === n.truth - l.notes[i - 1].truth) ioiOk++; }
          });
        });
      }
      res[cname][method] = { ok: ok / tot, near: near / tot, ioi: ioiOk / ioiTot, bpm: medOf(bpms) };
    }
  }
  return res;
}, { rows, extra });
await browser.close();
const pct = x => (x * 100).toFixed(1).padStart(5) + '%';
if (process.argv[3] === 'short') { console.log((process.argv[2] || '').padEnd(34) + Object.values(out).map(m => (m[process.argv[4] || 'v2'].ok * 100).toFixed(1)).join(' | ')); process.exit(0); }
console.log('  （元の録音は 120 BPM）');
for (const [cname, ms] of Object.entries(out)) {
  console.log(`\n■ ${cname}`);
  console.log('  方式  位置が合う  8分以内  音の間隔が合う  テンポ');
  for (const [m, r] of Object.entries(ms)) console.log('  ' + m.padEnd(3) + '  ' + pct(r.ok) + '    ' + pct(r.near) + '    ' + pct(r.ioi) + '       ' + r.bpm);
}
