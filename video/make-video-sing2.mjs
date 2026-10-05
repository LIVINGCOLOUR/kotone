// Kotone の紹介動画「歌って作る」短い版（約50秒）を作る。
// 歌詞を入れ、歌い、下書きのメロディができ、人が直して完成、歌詞カードと楽譜を出すまでを、Chrome を自動操作して撮る。
// 曲は、先に用意した曲（songs/cand/。Git の管理外）を人が歌った録音。画面に映る読み込み結果は、その録音をアプリが実際に読み取ったもの。
// 直す場面は、正解のメロディとの実際の違いから2〜3音を選んで見せ、残りは字幕を出して場面を切り替える。
// 歌声は、songs/video/my-voice.m4a（人が歌った録音。Git の管理外）があればそれを、なければ合成した声（sing-song.mjs）を使う。
// 撮り方は make-video.mjs と同じ（画面は CDP の画面キャプチャ、音は録画中の記録から録画後に作り直す）。
//   使い方: cd video && node make-video-sing2.mjs   （出力: out-sing2/kotone-sing-short.mp4）
//   別のURLで撮る: KOTONE_URL=https://kotonemusic.pages.dev/ node make-video-sing2.mjs
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { LYRICS, WRONG, TUNE, writeVoice } from './sing-song.mjs';

const URL = process.env.KOTONE_URL || 'http://localhost:8766/';
const OUT = path.resolve('out-sing2');
const FRAMES = path.join(OUT, 'frames');
const W = 1440, H = 810, DPR = 4 / 3; // 画面は 1440×810、撮影は 1920×1080

const sleep = ms => new Promise(r => setTimeout(r, ms));
const marks = {};
const mark = name => { marks[name] = Date.now() / 1000; };

// ---- ページに重ねる表示（字幕・章・タイトル・カーソル・枠・押したキー） ----
const OVERLAY = () => {
  const css = `
  .ov { position: fixed; pointer-events: none; z-index: 2147483000; font-family: "Hiragino Sans", "Noto Sans JP", system-ui, sans-serif; }
  #ov-cap { left: 50%; bottom: 186px; transform: translate(-50%, 12px); max-width: 82%; padding: 14px 28px; border-radius: 14px;
    background: rgba(24, 24, 28, .88); color: #fff; font-size: 26px; font-weight: 700; line-height: 1.5; text-align: center;
    opacity: 0; transition: opacity .35s, transform .35s; box-shadow: 0 10px 30px rgba(0,0,0,.25); }
  #ov-cap.on { opacity: 1; transform: translate(-50%, 0); }
  #ov-chap { left: 24px; bottom: 186px; padding: 8px 16px; border-radius: 999px; background: #d9485f; color: #fff;
    font-size: 18px; font-weight: 800; opacity: 0; transition: opacity .35s; }
  #ov-chap.on { opacity: 1; }
  #ov-card { inset: 0; display: grid; place-items: center; background: radial-gradient(circle at 30% 20%, #3a2230, #16171a 70%);
    color: #fff; opacity: 0; transition: opacity .6s; text-align: center; }
  #ov-card.on { opacity: 1; }
  #ov-card .logo { font-size: 110px; font-weight: 800; letter-spacing: .06em; color: #ff6b81; }
  #ov-card .sub { font-size: 34px; font-weight: 700; margin-top: 18px; }
  #ov-card .small { font-size: 22px; color: #c9c9cf; margin-top: 26px; }
  #ov-card .flow { display: flex; gap: 18px; justify-content: center; align-items: center; margin-top: 34px; font-size: 30px; font-weight: 800; }
  #ov-card .flow span.p { padding: 10px 26px; border-radius: 999px; border: 3px solid #ff6b81; }
  #ov-card .url { font-size: 40px; font-weight: 800; margin-top: 30px; color: #fff; }
  #ov-cursor { width: 30px; height: 30px; left: -60px; top: -60px; transition: left .55s cubic-bezier(.4,0,.2,1), top .55s cubic-bezier(.4,0,.2,1); z-index: 2147483600; }
  #ov-ripple { width: 46px; height: 46px; margin: -23px 0 0 -23px; border-radius: 50%; border: 4px solid #d9485f; opacity: 0; z-index: 2147483500; }
  #ov-ripple.go { animation: ovr .5s ease-out; }
  @keyframes ovr { from { opacity: .9; transform: scale(.3); } to { opacity: 0; transform: scale(1.6); } }
  #ov-spot { border: 4px solid #d9485f; border-radius: 12px; box-shadow: 0 0 0 6px rgba(217,72,95,.22), 0 0 24px rgba(217,72,95,.5);
    opacity: 0; transition: opacity .3s, left .3s, top .3s, width .3s, height .3s; }
  #ov-spot.on { opacity: 1; }
  #ov-keys { right: 28px; bottom: 186px; display: flex; gap: 10px; align-items: center; opacity: 0; transition: opacity .3s; }
  #ov-keys.on { opacity: 1; }
  #ov-keys .k { min-width: 64px; height: 64px; padding: 0 12px; border-radius: 12px; display: grid; place-items: center;
    background: #fff; color: #222; font: 800 30px ui-monospace, monospace; border: 2px solid #aaa; border-bottom-width: 6px; transition: transform .06s, background .06s; }
  #ov-keys .k.down { background: #ffd166; transform: translateY(3px); border-bottom-width: 3px; }
  #ov-keys .lbl { color: #fff; background: rgba(24,24,28,.85); padding: 8px 14px; border-radius: 10px; font-size: 18px; font-weight: 700; }
  #ov-ff { right: 28px; top: 112px; padding: 8px 16px; border-radius: 10px; background: #1f2328; color: #fff; font-size: 20px; font-weight: 800; opacity: 0; transition: opacity .3s; }
  #ov-ff.on { opacity: 1; }`;
  const st = document.createElement('style'); st.textContent = css; document.head.append(st);
  const mk = (id, html = '') => { const d = document.createElement('div'); d.id = id; d.className = 'ov'; d.innerHTML = html; document.body.append(d); return d; };
  mk('ov-spot'); mk('ov-cap'); mk('ov-chap'); mk('ov-card'); mk('ov-ff', '▶▶ 早送り');
  mk('ov-keys', '<span class="lbl">押したキー</span><span class="k" id="ov-k">Z</span>');
  mk('ov-ripple');
  mk('ov-cursor', '<svg viewBox="0 0 24 24" width="30" height="30"><path d="M3 2l7 19 2.5-7.5L20 11z" fill="#fff" stroke="#111" stroke-width="1.6" stroke-linejoin="round"/></svg>');
  const $o = id => document.getElementById(id);
  window.__ov = {
    cap(t) { const c = $o('ov-cap'); if (t) { c.innerHTML = t; c.classList.add('on'); } else c.classList.remove('on'); },
    chap(t) { const c = $o('ov-chap'); if (t) { c.textContent = t; c.classList.add('on'); } else c.classList.remove('on'); },
    card(html) { const c = $o('ov-card'); if (html) { c.innerHTML = html; c.classList.add('on'); } else c.classList.remove('on'); },
    ff(on) { $o('ov-ff').classList.toggle('on', on); },
    keys(on) { $o('ov-keys').classList.toggle('on', on); },
    cursor(x, y) { const c = $o('ov-cursor'); c.style.left = x - 4 + 'px'; c.style.top = y - 2 + 'px'; },
    cursorFast(x, y) { const c = $o('ov-cursor'); c.style.transition = 'none'; this.cursor(x, y); c.offsetWidth; c.style.transition = ''; },
    ripple(x, y) { const r = $o('ov-ripple'); r.style.left = x + 'px'; r.style.top = y + 'px'; r.classList.remove('go'); r.offsetWidth; r.classList.add('go'); },
    spot(sel, pad = 6) {
      const s = $o('ov-spot');
      if (!sel) { s.classList.remove('on'); return; }
      const b = document.querySelector(sel).getBoundingClientRect();
      Object.assign(s.style, { left: b.left - pad + 'px', top: b.top - pad + 'px', width: b.width + pad * 2 + 'px', height: b.height + pad * 2 + 'px' });
      s.classList.add('on');
    },
  };
  // 押したキーを大きく表示（Shift だけの押下は出さない）
  addEventListener('keydown', e => {
    if (e.key === 'Shift') return;
    const k = $o('ov-k');
    k.textContent = (e.shiftKey ? 'Shift+' : '') + (e.code === 'Space' ? 'Space' : keyLabel(e.code));
    k.classList.add('down');
  }, true);
  addEventListener('keyup', () => $o('ov-k').classList.remove('down'), true);
};


// ================= 撮影 =================
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(FRAMES, { recursive: true });
const SONG = JSON.parse(fs.readFileSync(path.resolve('../songs/cand/候補4_言葉が音に変わるまで.json'), 'utf8'));   // 正解の曲（Aメロだけ使う）
const TSEC = SONG.sections[0], LYR = TSEC.verses[0];
const REAL_VOICE = path.resolve('../songs/cand/voice4-take1.m4a');
const VOICE = path.join(OUT, 'voice.wav');                 // マイクの代わりに Chrome へ流す歌声
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', REAL_VOICE, '-af', 'highpass=f=70,loudnorm=I=-18:TP=-2:LRA=11', '-ar', '48000', '-ac', '1', VOICE]);
const voiceSec = +execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', VOICE]).toString();

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required',
  '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--use-file-for-fake-audio-capture=' + VOICE] });
const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: DPR, acceptDownloads: true, colorScheme: 'light', locale: 'ja-JP', permissions: ['microphone'] });
const page = await context.newPage();
page.on('dialog', d => d.accept());
page.on('pageerror', e => console.error('page error:', e.message));
await page.goto(URL, { waitUntil: 'networkidle' });
await page.evaluate(() => { localStorage.clear(); });
await page.reload({ waitUntil: 'networkidle' });
await page.evaluate(OVERLAY);

// 準備（録画前）：音源の読み込み、アプリの音を録るレコーダー
await page.evaluate(async () => {
  audio();
  for (const id of ['piano', 'electric']) { loadBank(id); for (let i = 0; i < 150 && banks[id]?.state !== 'ready'; i++) await new Promise(r => setTimeout(r, 200)); }
  window.__ev = []; window.__cuts = new Map(); window.__clock = []; window.__live = ctx;
  const ids = new WeakMap(); let next = 1;
  const oid = o => o === master ? 0 : (ids.has(o) ? ids.get(o) : (ids.set(o, next), next++));
  window.__origNote = note;
  note = function (out, m, t, dur, vel) {
    if (ctx !== __live) return __origNote(out, m, t, dur, vel);
    const ev = { k: 'n', o: oid(out), m, t, dur, vel, inst: song.instrument };
    __ev.push(ev);
    const rel = __origNote(out, m, t, dur, vel);
    return () => { ev.dur = Math.max(0.02, ctx.currentTime - t); rel(); };
  };
  window.__origDrum = {};
  for (const n of Object.keys(DRUM)) {
    const f = __origDrum[n] = DRUM[n];
    DRUM[n] = (out, t, v) => { if (ctx === __live) __ev.push({ k: 'd', o: oid(out), n, t, v }); f(out, t, v); };
  }
  const mk = __live.createBufferSource.bind(__live);
  __live.createBufferSource = function () {
    const s = mk(), st = s.start.bind(s);
    s.start = (when = 0, off = 0, dur) => {
      if (guide.buffer && s.buffer === guide.buffer) __ev.push({ k: 'g', o: playback ? oid(playback.out) : 0, t: when, off, dur });
      return dur === undefined ? st(when, off) : st(when, off, dur);
    };
    return s;
  };
  const origStop = stop;
  stop = function () { if (playback) __cuts.set(oid(playback.out), ctx.currentTime); return origStop(); };
  setInterval(() => __clock.push([ctx.currentTime, Date.now() / 1000]), 200);
});

const frames = [];
const cdp = await context.newCDPSession(page);
cdp.on('Page.screencastFrame', async f => {
  const file = path.join(FRAMES, `f${String(frames.length).padStart(6, '0')}.jpg`);
  fs.writeFileSync(file, Buffer.from(f.data, 'base64'));
  frames.push({ file, ts: f.metadata.timestamp });
  try { await cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }); } catch { /* 終了間際 */ }
});
await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92 });

// ---- 操作の部品 ----
const ov = (fn, ...args) => page.evaluate(([fn, args]) => __ov[fn](...args), [fn, args]);
const cap = t => ov('cap', t);
const chap = t => ov('chap', t);
const spot = (sel, pad) => ov('spot', sel, pad);
async function pointAt(x, y, wait = 550) { await ov('cursor', x, y); await sleep(wait); }
async function clickAt(x, y, wait = 550) { await pointAt(x, y, wait); await ov('ripple', x, y); await page.mouse.click(x, y); }
async function clickLoc(loc, wait) { const b = await loc.boundingBox(); await clickAt(b.x + b.width / 2, b.y + b.height / 2, wait); }
const click = (sel, wait) => clickLoc(page.locator(sel).first(), wait);
const guideBtn = text => page.locator('#vguide button', { hasText: text }).first();
const panelBtn = text => page.locator('#inspector button', { hasText: text }).first();
async function showPopup(open, sel, title, note, ms, crop = 1.414) {
  const [pop] = await Promise.all([context.waitForEvent('page'), open()]);
  await pop.waitForSelector(sel, { timeout: 60000 });
  await pop.addStyleTag({ content: '.bar { display: none !important; } body { background: #fff !important; } .page, .pg { margin: 0 auto !important; box-shadow: none !important; }' });
  await pop.waitForTimeout(600);
  const b = await pop.locator(sel).first().boundingBox();
  const img = (await pop.screenshot({ type: 'jpeg', quality: 90, fullPage: true, clip: { x: b.x, y: b.y, width: b.width, height: Math.min(b.height, b.width * crop) } })).toString('base64');
  await pop.close();
  await ov('cursorFast', -80, -80);
  await ov('card', `<div style="display:flex;gap:56px;align-items:center;justify-content:center"><img src="data:image/jpeg;base64,${img}" style="height:${H - 70}px;border-radius:10px;box-shadow:0 20px 60px rgba(0,0,0,.5)"><div style="text-align:left;max-width:400px"><div class="sub">${title}</div><div class="small">${note}</div></div></div>`);
  await sleep(ms);
  await ov('card', '');
  await sleep(500);
}
await ov('cursorFast', -80, -80);

// ---- タイトル ----
await ov('card', '<div><div class="logo">Kotone</div><div class="sub">歌うと、曲の下書きができる。</div><div class="small">歌詞を見ながら歌った声を、メロディとコードにします</div></div>');
await sleep(3200);
await ov('card', '');
await ov('cursor', W * 0.6, H * 0.5);
await sleep(500);

// ---- ① 歌詞を入れる ----
mark('lyrics');
await chap('① 歌詞を入れる');
await cap('まず、右上の「歌から作る」を押します');
await spot('#voiceBtn', 4);
await sleep(2200);
await spot(null);
await click('#voiceBtn', 800);
await sleep(1500);
await cap('歌う歌詞を、ここに入れます');
await spot('#impLyrics', 2);
await sleep(1500);
await page.fill('#impLyrics', LYR);
await page.evaluate(() => { impRec.dirty = true; renderImpCheck(); });
await sleep(3000);
await cap('間をあけて歌いたい所には、空白を入れておきます');
await sleep(3200);
await spot(null);

// ---- ② 歌って録音する ----
await chap('② 歌う');
await cap('「録音する」を押して、歌詞を見ながら歌います。伴奏は鳴りません');
await spot('#impRec', 4);
await sleep(2600);
await spot(null);
await click('#impRec', 800);
mark('rec');
const FF_AT = 5.2;                                         // 録音を始めてから、早送りに入るまでの秒数（1行目を歌い終わる所）
await sleep(FF_AT * 1000);
mark('ff');
await cap('このあとも、最後まで歌います');
await ov('ff', true);
await page.evaluate(async total => {
  const steps = 30, left = total * 1000 - (performance.now() - impRec.t0);
  for (let i = 0; i < steps; i++) { impRec.t0 -= left / steps; await new Promise(r => setTimeout(r, 50)); }
}, voiceSec);
await sleep(200);
await ov('ff', false);
await cap('歌い終わったら、もう一度押して、録音を止めます');
await sleep(1600);
await click('#impRec', 800);
await sleep(1500);
// 読み込むのは、歌った録音の元のファイル（調べたときと同じ読み取り結果になるように。撮影中は処理が重く、マイクの録音は途切れることがある）
await page.evaluate(async b64 => {
  const bin = atob(b64), u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  impRec.file = new File([u], '新しい歌.m4a', { type: 'audio/mp4' });
  $('#impAudio').src = URL.createObjectURL(impRec.file);
  impRecRender();
}, fs.readFileSync(REAL_VOICE).toString('base64'));
await sleep(800);

// ---- ③ 音符になる ----
await chap('③ 音符になる');
await cap('右下の「読み込む」を押すと、声の高さを読み取って、音符にします');
await spot('#impRun', 4);
await sleep(2600);
await spot(null);
await click('#impRun', 800);
await page.waitForFunction(() => /できました/.test(document.querySelector('#impMsg').textContent), null, { timeout: 180000 });
const imported = await page.evaluate(() => { song.title = '言葉が音に変わるまで'; song.drums = false; song.loop = false; changed(); return { key: keyInfo(song.tonic, song.mode).name, bpm: song.bpm, gain: song.guideGain || 1, mel: song.sections[0].melody.map(n => [n.t, n.d, n.m, n.tie ? 1 : 0]) }; });
console.log('imported:', imported.key, 'BPM', imported.bpm, '音', imported.mel.length);
// 調べたときの読み取り結果と同じかを確かめる（違えば、直す場面が合わなくなる）
if (process.env.EXPECT) {
  const exp = JSON.parse(fs.readFileSync(process.env.EXPECT, 'utf8')).sections[0].melody.map(n => [n.t, n.d, n.m, n.tie ? 1 : 0]);
  const same = JSON.stringify(exp) === JSON.stringify(imported.mel);
  console.log('調べたときの読み取り結果と同じ:', same);
  if (!same) { console.error('読み取り結果が違うので、撮影をやめます'); await browser.close(); process.exit(1); }
}
// 読み込みの画面が閉じてから、できた音符を見せる（画面が残っていると、枠が重なってしまう）
await page.waitForFunction(() => document.querySelector('#impModal').hidden, null, { timeout: 20000 }).catch(() => page.evaluate(() => closeImport()));
await sleep(600);
await cap('歌った声から、メロディの下書きができました');
await spot('#rollbox', 2);
await sleep(3400);
await spot('#lane', 2);
await cap('歌詞が、音符に1音ずつ付いています');
await sleep(3200);
await spot('#track', 2);
await cap('コードも、メロディに合わせて自動で付きます');
await sleep(3200);
await spot(null);

// ---- ④ 整える（アプリの道具で、リズムと音程をまとめて整える） ----
await chap('④ 整える');
await cap('上の案内の赤いボタンが、次にすること。「リズムを整える」を押します');
await spot('#vguide', 2);
await sleep(3000);
await spot(null);
await clickLoc(guideBtn('リズムを整える'), 800);
await sleep(1800);
await cap('「歌詞で組む」を選ぶと、歌詞の音を順に並べ直して、拍をそろえます');
await clickLoc(panelBtn('歌詞で組む'), 800);
await sleep(1200);
await spot('#rollbox', 2);
await cap('緑が、整えたあとの音です');
await sleep(3200);
await spot(null);
await cap('「曲全体に適用」を押して、決定します');
await clickLoc(panelBtn('曲全体に適用'), 900);
await sleep(2200);
if (await page.evaluate(() => song.mode === 'minor')) {
  await cap('暗い響きに読み取られたので、「整える」の中の「明るくする」で長調に直します');
  await click('#toolMenu summary', 900);
  await sleep(700);
  await spot('#modeBtn', 3);
  await sleep(2600);
  await spot(null);
  await click('#modeBtn', 500);
  await sleep(2400);
}
await cap('次は「音程を整える」。コードとぶつかる音を見つけます');
await clickLoc(guideBtn('音程を整える'), 900);
await sleep(1200);
await spot('#rollbox', 2);
await sleep(3000);
await spot(null);
await cap('「曲全体に適用」を押して、まとめて直します');
if (await panelBtn('曲全体に適用').isEnabled()) await clickLoc(panelBtn('曲全体に適用'), 900);
await sleep(2200);
console.log('整えた後:', await page.evaluate(TM => { const ns = song.sections[0].melody.filter(n => !n.tie).sort((a, b) => a.t - b.t);
  return `${keyInfo(song.tonic, song.mode).name}・歌詞の付く音 ${ns.length}・高さが正解 ${ns.filter((n, i) => n.m === TM[i]?.m).length}・位置が正解 ${ns.filter((n, i) => Math.abs(n.t - TM[i]?.t) < 1e-6).length}・両方 ${ns.filter((n, i) => n.m === TM[i]?.m && Math.abs(n.t - TM[i]?.t) < 1e-6).length}`; }, [...TSEC.melody].sort((a, b) => a.t - b.t)));
// ---- ⑤ 聴き比べる（整えたあとで）----
await chap('⑤ 聴き比べる');
await cap('元の歌と、整えたメロディを聴き比べます。まず、元の歌');
await click('#vguide .seg button:nth-child(2)', 400);
await sleep(300);
await click('#playSec', 400);
await sleep(3300);
await click('#playSec', 200);
await sleep(300);
await cap('こちらが、整えたメロディ。まだ、歌とは違う所があります');
await click('#vguide .seg button:nth-child(1)', 400);
await sleep(300);
await click('#playSec', 400);
await sleep(3300);
await click('#playSec', 200);
await sleep(400);

// ---- ⑥ 人が直す ----
await chap('⑥ 直す');
// 位置は合っていて、高さだけ違う音を、正解のメロディとの違いから選ぶ（2行目の3音）
const TM = [...TSEC.melody].sort((a, b) => a.t - b.t);
const fixes = await page.evaluate(TM => {
  const ns = song.sections[0].melody.filter(n => !n.tie).sort((a, b) => a.t - b.t);
  return ns.map((n, i) => ({ t: n.t, d: n.d, m: n.m, want: TM[i].m, okT: Math.abs(n.t - TM[i].t) < 1e-6 })).filter(x => x.okT && x.m !== x.want && Math.abs(x.m - x.want) <= 4 && x.d >= 0.5);
}, TM);
console.log('直して見せる音:', JSON.stringify(fixes));
await cap('まだ違う音は、音符を上下に動かして直します');
let first = true;
for (const fx of fixes.slice(0, 2)) {
  const p = await page.evaluate(fx => {
    const g = rollGeom(), box = document.querySelector('#rollbox');
    box.scrollTop = Math.max(0, (g.hi - (fx.m + fx.want) / 2 + 0.5) * g.rowH - box.clientHeight / 2);
    const n = song.sections[0].melody.find(x => !x.tie && x.t === fx.t);
    const r = document.querySelector('#roll').getBoundingClientRect();
    return { x: r.left + (n.t + Math.min(n.d, 0.5) / 2) * g.ppb, y: r.top + (g.hi - n.m + 0.5) * g.rowH, row: g.rowH };
  }, fx);
  await sleep(200);
  await pointAt(p.x, p.y, first ? 900 : 600);
  first = false;
  const rows = fx.m - fx.want;
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) { await page.mouse.move(p.x, p.y + p.row * rows * i / 10); await ov('cursor', p.x, p.y + p.row * rows * i / 10); await sleep(60); }
  await page.mouse.up();
  await sleep(900);
  console.log('fixed:', fx.t, fx.m, '→', await page.evaluate(t => song.sections[0].melody.find(x => !x.tie && x.t === t)?.m, fx.t), 'want', fx.want);
}
await cap('のこりの音も、同じように直します。速い歌は、直す音が多くなります');
console.log('直した後:', await page.evaluate(TM => { const ns = song.sections[0].melody.filter(n => !n.tie).sort((a, b) => a.t - b.t); return `両方正解 ${ns.filter((n, i) => n.m === TM[i]?.m && Math.abs(n.t - TM[i]?.t) < 1e-6).length} ／ ${TM.length}`; }, TM));
await sleep(2600);
await ov('cursorFast', -80, -80);
await ov('card', '<div><div class="sub">のこりの音とコードも、同じように直して…</div></div>');
// 直し終わった状態にする（正解のメロディとコード）。サビは歌っていないので、用意してあるメロディをそのまま足す（字幕でそう伝える）
await page.evaluate(S => {
  const a = song.sections[0], T = S.sections[0];
  a.melody = T.melody.map(n => ({ ...n })); a.chords = T.chords.map(c => ({ ...c }));
  const b = JSON.parse(JSON.stringify(S.sections[1])); b.id = 's2'; b.guide = [];
  song.sections = [a, b]; song.arrangement = [a.id, b.id]; song.current = a.id;
  song.tonic = S.tonic; song.mode = S.mode; song.bpm = S.bpm; song.instrument = S.instrument; song.drums = true; song.drumKit = 'rock';
  song.guideOn = false; song.guideOnly = false;
  ui.sel = -1; ui.note = -1; ui.fix = null; ui.rhy = null; document.querySelector('#rollbox').scrollTop = 0; ui.rollCentered = null;
  changed();
}, SONG);
await sleep(1800);
await ov('card', '');
await sleep(400);

// ---- ⑦ 完成 ----
await chap('⑦ 完成');
await cap('できあがり。伴奏とドラムを付けて、サビまで通して聴きます（サビは、あらかじめ用意したメロディです）');
const songSec = await page.evaluate(() => buildPlan(song.arrangement).total * 60 / song.bpm);
await ov('cursor', W * 0.6, H * 0.5);
await click('#playSong', 500);
mark('song');
await sleep(4200);
await cap('');
await sleep(songSec * 1000 - 4000);
await click('#playSong', 200);
await sleep(500);

// ---- ⑧ 持ち帰る ----
await chap('⑧ 持ち帰る');
await cap('歌詞カードと楽譜を出せます');
await showPopup(() => clickLoc(guideBtn('歌詞カード')), '.page', 'コード付きの歌詞カード', '印刷して PDF にできます', 2600, 0.82);
await showPopup(() => clickLoc(guideBtn('ピアノ譜')), '.pg', 'ピアノ譜', 'メロディ・歌詞・コードと、左手の和音', 2800);
await chap('');
await cap('');
await ov('cursorFast', -80, -80);
// 歌詞なしでも作れることを、ひとこと伝える
await ov('card', '<div><div class="sub">歌詞がなくても、声だけで作れます</div><div class="small">鼻歌やハミングを録音すれば、同じようにメロディとコードの下書きができます</div></div>');
await sleep(3200);
await ov('card', '<div><div class="logo">Kotone</div><div class="sub">歌うと、曲の下書きができる。</div><div class="url">kotonemusic.pages.dev</div><div class="small">PC の Chrome でどうぞ</div></div>');
await sleep(2800);
// ---- 撮影終了：音を取り出す ----
await cdp.send('Page.stopScreencast');
const endTs = Date.now() / 1000;
const t0 = frames[0].ts;
const rendered = await page.evaluate(async ({ t0, endTs, recAt, ffAt, vg }) => {
  const SR = 48000;
  const raw = __clock, H = 5;
  const diffs = raw.map(([c, w]) => w - c);
  const clk = raw.map(([c], i) => {
    const win = diffs.slice(Math.max(0, i - H), i + H + 1).sort((a, b) => a - b);
    return [c, c + win[win.length >> 1]];
  });
  const toWall = c => {
    let i = clk.findIndex(p => p[0] >= c);
    if (i <= 0) i = i === 0 ? 1 : clk.length - 1;
    const [c0, w0] = clk[i - 1], [c1, w1] = clk[i];
    return w0 + (c - c0) * (c1 > c0 ? (w1 - w0) / (c1 - c0) : 1);
  };
  const len = endTs - t0;
  const off = new OfflineAudioContext(2, Math.ceil(len * SR), SR);
  const saved = { ctx, master };
  ctx = off;
  master = off.createGain(); master.gain.value = 0.7;
  master.connect(off.createDynamicsCompressor()).connect(off.destination);
  const voiceAt = (at, offset, dur, gain, fade = 0) => {   // 歌声（録音の場面と、元の歌の再生）
    const s = off.createBufferSource(), g = off.createGain();
    s.buffer = guide.buffer; g.gain.value = gain;
    if (fade) { g.gain.setValueAtTime(gain, at + dur - fade); g.gain.linearRampToValueAtTime(0, at + dur); }
    s.connect(g).connect(off.destination);
    if (dur === undefined) s.start(at, offset); else s.start(at, offset, dur);
  };
  voiceAt(recAt - t0 + 0.25, 0, ffAt - recAt + 0.4, 0.9 * vg, 0.6);   // 録音の場面：歌っている声を、早送りに入る所まで聞かせる
  let used = 0;
  for (const e of __ev) {
    const cut = e.o ? __cuts.get(e.o) : undefined;
    if (cut !== undefined && e.t >= cut) continue;
    const at = toWall(e.t) - t0;
    if (at < 0 || at > len) continue;
    if (e.k === 'n') {
      const d = cut !== undefined ? Math.min(e.dur, cut - e.t) : e.dur;
      song.instrument = e.inst || 'piano';
      __origNote(master, e.m, at, Math.max(0.02, d), e.vel);
    } else if (e.k === 'g') {
      const d = cut !== undefined ? Math.min(e.dur ?? 99, cut - e.t) : e.dur;
      if (d > 0.02) voiceAt(at, e.off, d, 0.9 * vg);
    } else __origDrum[e.n](master, at, e.v);
    used++;
  }
  const buf = await off.startRendering();
  ctx = saved.ctx; master = saved.master;
  const L = buf.getChannelData(0), R = buf.getChannelData(1), n = buf.length;
  const wav = new DataView(new ArrayBuffer(44 + n * 4));
  const str = (o, s) => [...s].forEach((ch, i) => wav.setUint8(o + i, ch.charCodeAt(0)));
  str(0, 'RIFF'); wav.setUint32(4, 36 + n * 4, true); str(8, 'WAVEfmt '); wav.setUint32(16, 16, true);
  wav.setUint16(20, 1, true); wav.setUint16(22, 2, true); wav.setUint32(24, SR, true); wav.setUint32(28, SR * 4, true);
  wav.setUint16(32, 4, true); wav.setUint16(34, 16, true); str(36, 'data'); wav.setUint32(40, n * 4, true);
  const clip = x => Math.max(-1, Math.min(1, x)) * 32767;
  for (let i = 0; i < n; i++) { wav.setInt16(44 + i * 4, clip(L[i]), true); wav.setInt16(46 + i * 4, clip(R[i]), true); }
  window.__wav = new Uint8Array(wav.buffer);
  return { events: __ev.length, used, guide: __ev.filter(e => e.k === 'g').length, cuts: __cuts.size, bytes: __wav.length };
}, { t0, endTs, recAt: marks.rec, ffAt: marks.ff, vg: Math.min(6, imported.gain) });
console.log('rendered audio:', JSON.stringify(rendered));
// WAV は大きいので、少しずつ受け取る
const parts = [];
for (let i = 0; i < rendered.bytes; i += 4 << 20) {
  parts.push(Buffer.from(await page.evaluate(([i, n]) => {
    const b = __wav.subarray(i, i + n);
    let s = '';
    for (let j = 0; j < b.length; j += 0x8000) s += String.fromCharCode(...b.subarray(j, j + 0x8000));
    return btoa(s);
  }, [i, 4 << 20]), 'base64'));
}
fs.writeFileSync(path.join(OUT, 'audio.wav'), Buffer.concat(parts));
await browser.close();

// ================= 合成 =================
const list = frames.map((f, i) => `file '${f.file}'\nduration ${Math.max(0.001, ((frames[i + 1]?.ts ?? endTs) - f.ts)).toFixed(4)}`).join('\n') + `\nfile '${frames[frames.length - 1].file}'\n`;
fs.writeFileSync(path.join(OUT, 'frames.txt'), list);
const total = endTs - t0;
console.log(`frames=${frames.length} duration=${total.toFixed(1)}s`);
execFileSync('ffmpeg', ['-y', '-loglevel', 'error',
  '-f', 'concat', '-safe', '0', '-i', path.join(OUT, 'frames.txt'),
  '-i', path.join(OUT, 'audio.wav'),
  '-filter_complex', `[1:a]loudnorm=I=-16:TP=-1.5:LRA=11[a]`,
  '-map', '0:v', '-map', '[a]',
  '-vf', 'scale=1920:1080:flags=lanczos,fps=30,format=yuv420p',
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
  '-t', total.toFixed(2), '-movflags', '+faststart',
  path.join(OUT, 'kotone-sing-short.mp4')], { stdio: 'inherit' });
console.log('done:', path.join(OUT, 'kotone-sing-short.mp4'));
