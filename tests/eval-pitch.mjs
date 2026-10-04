// 音の高さの補正を、正解つきの歌のデータで採点する。
//   node tests/eval-pitch.mjs            … 方式ごとの正解率を表で出す
// データ：Dai, Mauch & Dixon (2015)。アマチュア中心の39人が伴奏なしで歌った 21,762 音（置き場所は tests/README.md）
// 採点：補正して出た半音が、楽譜の音（歌い手のキーへ移した上で）と合っている割合。上がり下がりの形が合っている割合も出す
import { chromium } from '../video/node_modules/playwright-core/index.mjs';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const CSV = path.join(ROOT, 'songs/testdata/dai2015/tsom-intonation.csv');
if (!fs.existsSync(CSV)) { console.error('データがありません：' + CSV + '\n取り方は tests/README.md を見てください。'); process.exit(1); }
const [head, ...body] = fs.readFileSync(CSV, 'utf8').trim().split('\n').map(l => l.split(','));
const col = n => head.indexOf(n);
const rows = body.map(r => ({ singer: +r[col('SingerNo')], piece: +r[col('Piece')], run: +r[col('Run')], nom: +r[col('NominalPitch')],
  m: +r[col('SungPitch')], t0: +r[col('Onset')], d: +r[col('Duration')] })).filter(r => isFinite(r.m) && isFinite(r.t0));

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
page.on('pageerror', e => console.error('page error:', e.message));
await page.goto('file://' + path.join(ROOT, 'index.html'));
const extra = process.argv[2] ? JSON.parse(process.argv[2]) : null;       // 例：'{"kPrior":0.2}' で v2 の設定を変えて試す

const out = await page.evaluate(({ rows, extra }) => {
  // 乱数（毎回同じ結果になるように）
  let seed = 12345;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const recs = new Map();
  for (const r of rows) { const k = r.singer + '-' + r.piece; if (!recs.has(k)) recs.set(k, []); recs.get(k).push(r); }
  // 楽譜のキー（主音, 長短）：Edelweiss B♭、Do-Re-Mi C、My Favourite Things Em
  const TRUE_KEY = { 1: [10, 'major'], 2: [0, 'major'], 3: [4, 'minor'] };
  // 崩し方：歌った高さに、研究でわかっている崩れを足す
  const CONDS = {
    'そのまま': null,
    '幅が縮む(0.69倍)': { k: 0.69 },
    '縮む＋ばらつき(0.5半音)': { k: 0.69, noise: 0.5 },
    '縮む＋ばらつき＋流れ(2半音)': { k: 0.69, noise: 0.5, drift: 2 },
    'ばらつきだけ(0.5半音)': { noise: 0.5 },
  };
  const METHODS = {
    '丸めるだけ': { pitch: 'round' },
    'v1': { pitch: 'v1' }, 'v1＋音階': { pitch: 'v1', snapKey: true },
    'v2': { pitch: 'v2' }, 'v2＋音階': { pitch: 'v2', snapKey: true },
  };
  const res = {};
  for (const [cname, cond] of Object.entries(CONDS)) {
    seed = 12345;
    // 崩した高さは、方式によらず同じものを使う
    const data = [...recs.entries()].map(([key, notes]) => {
      notes = [...notes].sort((a, b) => a.t0 - b.t0);
      const center = medOf(notes.map(n => n.m));
      // このデータは最初の音をもらって歌っているので、高さがピアノの音に合っている。自由に歌うときは合わないので、録音ごとに半音未満のずれを足す
      const off = rnd() - 0.5;
      return { key, piece: notes[0].piece, notes: notes.map((n, i) => {
        let m = n.m + off;
        if (cond) m = center + (cond.k || 1) * (m - center) + (cond.noise ? cond.noise * gauss() : 0) + (cond.drift ? cond.drift * i / notes.length : 0);
        return { t0: n.t0, t1: n.t0 + n.d, m, nom: n.nom };
      }) };
    });
    res[cname] = {};
    for (const [mname, opts] of Object.entries(METHODS)) {
      let dev = 0, ok = 0, tot = 0, cOk = 0, cTot = 0, keyOk = 0, keyRel = 0, exp = [];
      const perSinger = {};
      for (const rec of data) {
        // 行：0.3秒以上の切れ目で分ける（アプリのフレーズ分けと同じ）
        const lines = [];
        rec.notes.forEach((n, i) => { if (!i || n.t0 - rec.notes[i - 1].t1 > 0.3) lines.push({ notes: [] }); lines[lines.length - 1].notes.push({ t0: n.t0, t1: n.t1, m: n.m, nom: n.nom }); });
        let key = null;
        if (opts.pitch === 'round') for (const l of lines) for (const n of l.notes) n.p = Math.round(n.m);
        else {
          key = pitchStage(lines, { octave: 0, ...opts, v2: extra || undefined });
          if (opts.pitch === 'v1' && opts.snapKey) { const sc = scaleOfKey(key); for (const l of lines) for (const n of l.notes) n.p = snapNoteToScale(n.p, sc); }
        }
        const ns = lines.flatMap(l => l.notes);
        // 歌い手のキーへの移し方：いちばん多く合うずらし方（どの方式にも同じように有利）
        const cnt = {};
        for (const n of ns) cnt[n.p - n.nom] = (cnt[n.p - n.nom] || 0) + 1;
        const shift = +Object.entries(cnt).sort((a, b) => b[1] - a[1])[0][0];
        const good = ns.filter(n => n.p - n.nom === shift).length;
        ok += good; tot += ns.length;
        for (const n of ns) dev += Math.abs(n.p - n.nom - shift);
        const s = rec.key.split('-')[0];
        perSinger[s] = perSinger[s] || [0, 0]; perSinger[s][0] += good; perSinger[s][1] += ns.length;
        for (let i = 1; i < ns.length; i++) { cTot++; if (Math.sign(ns[i].p - ns[i - 1].p) === Math.sign(ns[i].nom - ns[i - 1].nom)) cOk++; }
        if (key) {
          const [tk, tm] = TRUE_KEY[rec.piece], est = ((key.k - shift) % 12 + 12) % 12;
          if (est === tk && key.mode === tm) keyOk++;
          const rel = tm === 'major' ? [(tk + 9) % 12, 'minor'] : [(tk + 3) % 12, 'major'];
          if ((est === tk && key.mode === tm) || (est === rel[0] && key.mode === rel[1])) keyRel++;
          if (key.expand) exp.push(key.expand);
        }
      }
      const accs = Object.values(perSinger).map(([a, b]) => a / b).sort((a, b) => a - b);
      res[cname][mname] = { dev: dev / tot, acc: ok / tot, contour: cOk / cTot, worst10: accs.slice(0, 10).reduce((a, b) => a + b, 0) / 10,
        key: key => 0, keyOk: keyOk / data.length, keyRel: keyRel / data.length, expand: exp.length ? medOf(exp) : null };
    }
  }
  return res;
}, { rows, extra });
await browser.close();

if (process.argv[3] === 'short') {                       // 設定を比べるとき用：v2 の行だけを1行で
  console.log((process.argv[2] || '').padEnd(46) + Object.entries(out).map(([c, ms]) => ['v2', 'v2＋音階'].map(m => (ms[m].acc * 100).toFixed(1)).join('/') + ' ' + ms['v2＋音階'].dev.toFixed(2) + ' key' + (ms['v2＋音階'].keyOk * 100).toFixed(0) + ' k' + (ms.v2.expand || 1).toFixed(2)).join('  |  '));
  process.exit(0);
}
const pct = x => (x * 100).toFixed(1).padStart(5) + '%';
for (const [cname, ms] of Object.entries(out)) {
  console.log(`\n■ ${cname}`);
  console.log('  方式          音が合う  平均のずれ  形が合う  下位10人  キー(平行調も可)  広げた倍率');
  for (const [m, r] of Object.entries(ms))
    console.log('  ' + m.padEnd(10, '　') + pct(r.acc) + '   ' + r.dev.toFixed(2).padStart(5) + '半音   ' + pct(r.contour) + '   ' + pct(r.worst10) + '   ' + (r.keyRel || m !== '丸めるだけ' ? pct(r.keyOk) + ' (' + pct(r.keyRel).trim() + ')' : '      —        ') + '   ' + (r.expand ? r.expand.toFixed(2) : '—'));
}
