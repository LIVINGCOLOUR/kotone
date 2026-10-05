// Kotone の紹介動画「歌って作る」（約3分）を作る。
// 歌詞を入れ、マイクに向かって歌い（動画では合成した声を使う）、できたメロディを整えて、書き出すまでを、Chrome を自動操作して撮る。
// 撮り方は make-video.mjs と同じ（画面は CDP の画面キャプチャ、音は録画中の記録から録画後に作り直す）。
//   使い方: cd video && node make-video-sing.mjs   （出力: out-sing/kotone-sing.mp4）
//   別のURLで撮る: KOTONE_URL=http://localhost:8766/ node make-video-sing.mjs
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { LYRICS, WRONG, TUNE, writeVoice } from './sing-song.mjs';

const URL = process.env.KOTONE_URL || 'https://kotonemusic.pages.dev/';
const OUT = path.resolve('out-sing');
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
const VOICE = path.join(OUT, 'voice.wav');
const voice = writeVoice(VOICE);                           // 合成した歌声（マイクの代わりに Chrome へ流す）
console.log('voice:', JSON.stringify(voice));

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required',
  '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--use-file-for-fake-audio-capture=' + VOICE] });
const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: DPR, acceptDownloads: true, colorScheme: 'light', locale: 'ja-JP', permissions: ['microphone'] });
const page = await context.newPage();
page.on('dialog', d => d.accept());
page.on('pageerror', e => console.error('page error:', e.message));
await page.goto(URL, { waitUntil: 'networkidle' });
await page.evaluate(OVERLAY);

// 準備（録画前）：ピアノ音源の読み込み、アプリの音を録るレコーダー
await page.evaluate(async () => {
  audio();
  for (let i = 0; i < 100 && banks.piano?.state !== 'ready'; i++) await new Promise(r => setTimeout(r, 200));
  // すべての音は note()（楽器）と DRUM[...]（ドラム）を通るので、そこで「いつ・どの音を」を記録する。元の歌の再生も記録する。
  // 記録するのは、画面で鳴らした音だけ（MP3 の書き出しは、別の音の作り場で note() を使うので、記録しない）
  window.__ev = []; window.__cuts = new Map(); window.__clock = []; window.__live = ctx;
  const ids = new WeakMap(); let next = 1;
  const oid = o => o === master ? 0 : (ids.has(o) ? ids.get(o) : (ids.set(o, next), next++));
  window.__origNote = note;
  note = function (out, m, t, dur, vel) {
    if (ctx !== __live) return __origNote(out, m, t, dur, vel);
    const ev = { k: 'n', o: oid(out), m, t, dur, vel };
    __ev.push(ev);
    const rel = __origNote(out, m, t, dur, vel);
    return () => { ev.dur = Math.max(0.02, ctx.currentTime - t); rel(); };
  };
  window.__origDrum = {};
  for (const n of Object.keys(DRUM)) {
    const f = __origDrum[n] = DRUM[n];
    DRUM[n] = (out, t, v) => { if (ctx === __live) __ev.push({ k: 'd', o: oid(out), n, t, v }); f(out, t, v); };
  }
  // 元の歌：再生のたびに作られる音源のうち、読み込んだ歌の音だけを記録する
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
async function pointAt(x, y, wait = 650) { await ov('cursor', x, y); await sleep(wait); }
async function clickAt(x, y, wait = 650) {
  await pointAt(x, y, wait);
  await ov('ripple', x, y);
  await page.mouse.click(x, y);
}
async function clickLoc(loc, wait) {
  const b = await loc.boundingBox();
  await clickAt(b.x + b.width / 2, b.y + b.height / 2, wait);
}
const click = (sel, wait) => clickLoc(page.locator(sel).first(), wait);
const clickTab = name => clickLoc(page.locator('#tabs .tab > button:first-child', { hasText: name }));
// 手順の案内（画面の上の帯）の中のボタン
const guideBtn = text => page.locator('#vguide button', { hasText: text }).first();
// 下の欄（整える道具のパネル）の中のボタン
const panelBtn = text => page.locator('#inspector button', { hasText: text }).first();
// 別のタブに開いた歌詞カード・楽譜を、画像にして画面に重ねて見せる
async function showPopup(open, sel, title, note, ms, crop = 1.414) {
  const [pop] = await Promise.all([context.waitForEvent('page'), open()]);
  await pop.waitForSelector(sel, { timeout: 60000 });
  await pop.addStyleTag({ content: '.bar { display: none !important; } body { background: #fff !important; } .page, .pg { margin: 0 auto !important; box-shadow: none !important; }' });
  await pop.waitForTimeout(600);
  // 紙の上から、幅×crop の高さだけを切り取る（歌詞カードは上半分に中身があるので、そこを大きく見せる）
  const b = await pop.locator(sel).first().boundingBox();
  const img = (await pop.screenshot({ type: 'jpeg', quality: 90, fullPage: true, clip: { x: b.x, y: b.y, width: b.width, height: Math.min(b.height, b.width * crop) } })).toString('base64');
  await pop.close();
  await ov('cursorFast', -80, -80);
  await ov('card', `<div style="display:flex;gap:56px;align-items:center;justify-content:center"><img src="data:image/jpeg;base64,${img}" style="height:${H - 70}px;border-radius:10px;box-shadow:0 20px 60px rgba(0,0,0,.5)"><div style="text-align:left;max-width:400px"><div class="sub">${title}</div><div class="small">${note}</div></div></div>`);
  await sleep(ms);
  await ov('card', '');
  await sleep(700);
}

await ov('cursorFast', -80, -80);

// ---- 0:00 タイトル ----
await ov('card', '<div><div class="logo">Kotone</div><div class="sub">歌うだけで、曲になる。</div><div class="small">歌詞を見ながら歌った声から、メロディとコードを作ります</div></div>');
await sleep(6500);
await ov('card', '<div><div class="sub">この3分で、歌から1曲を作ります</div><div class="flow"><span class="p">① 歌詞</span>→<span class="p">② 歌う</span>→<span class="p">③ 整える</span>→<span class="p">④ 聴く・書き出す</span></div><div class="small">楽器も、楽譜も、使いません</div></div>');
await sleep(6000);
await ov('card', '');
await ov('cursor', W * 0.6, H * 0.5);
await sleep(900);

// ---- ① 歌詞 ----
mark('lyrics');
await chap('① 歌詞を入れる');
await cap('「歌から作る」を開いて、歌う歌詞を入れます');
await click('#voiceBtn');
await sleep(1300);
await pointAt(W * 0.4, H * 0.5);
await page.fill('#impLyrics', LYRICS);
await page.evaluate(() => { impRec.dirty = true; renderImpCheck(); });
await sleep(2600);
await spot('#impLyrics', 2);
await cap('間をあけて歌いたい所には、空白を入れておきます');
await sleep(4200);
await spot(null);

// ---- ② 歌う ----
await chap('② 歌う');
await cap('「録音する」を押して、歌詞を見ながら歌います');
await click('#impRec', 900);
mark('rec');
await sleep(2500);
await cap('伴奏もメトロノームもありません。好きな速さで歌えます');
await spot('.imp-rec', 4);
await sleep(7000);
await spot(null);
await cap('途中で速くなっても、音を外しても、大丈夫。あとで整えられます');
await sleep(9000);
await cap('（この動画では、合成した声を使っています）');
await sleep(Math.max(1000, voice.seconds * 1000 - 18500 - 900));
await cap('歌い終わったら、録音を止めて「読み込む」');
await click('#impRec', 500);
await sleep(1200);
// 読み込むのは、マイクから録った音ではなく、同じ歌声の元のファイル（撮影中は処理が重く、録音が途切れることがあるため）
await page.evaluate(async b64 => {
  const bin = atob(b64), u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  impRec.file = new File([u], '新しい歌.wav', { type: 'audio/wav' });
  $('#impAudio').src = URL.createObjectURL(impRec.file);
  impRecRender();
}, fs.readFileSync(VOICE).toString('base64'));
await sleep(1500);
await click('#impRun');
await cap('声の高さを読み取って、音符にしています…');
await page.waitForFunction(() => /できました/.test(document.querySelector('#impMsg').textContent), null, { timeout: 180000 });
await page.evaluate(() => { song.title = 'はじめての歌'; song.drums = false; song.loop = false; changed(); });   // 動画では、ドラムとくり返しを切っておく
await cap('メロディとコードができました');
await sleep(3200);
const got = await page.evaluate(() => song.sections.map(s => [...s.melody].filter(n => !n.tie).sort((a, b) => a.t - b.t).map(n => n.m)).flat());
const want = TUNE.flat(2).map((m, i) => m);
console.log('imported notes:', got.length, 'expected:', want.length, 'key/bpm:', await page.evaluate(() => keyInfo(song.tonic, song.mode).name + ' ' + song.bpm));

// ---- ③ 整える ----
await chap('③ 整える');
await spot('#lane', 2);
await cap('歌詞が、音符に1音ずつ付いています');
await sleep(3800);
await spot('#track', 2);
await cap('コードも、メロディに合わせて自動で付きます');
await sleep(3600);
await spot('#vguide', 2);
await cap('上の案内に、次にすることが並びます');
await sleep(3800);
await spot(null);
// 聴き比べ：元の歌 → できた曲
await cap('まず、元の歌を聴いてみます');
await click('#vguide .seg button:nth-child(2)');
await sleep(500);
await click('#playSec');
await sleep(8200);
await click('#playSec', 300);
await sleep(500);
await cap('こちらが、できた曲。歌ったままなので、リズムが詰まったり走ったりしています');
await click('#vguide .seg button:nth-child(1)');
await sleep(500);
await click('#playSec');
await sleep(9500);
await click('#playSec', 300);
await sleep(600);
// リズムを整える（歌詞で組む）
await cap('「リズムを整える」で、拍を組み直します');
await clickLoc(guideBtn('リズムを整える'));
await sleep(1500);
await clickLoc(panelBtn('歌詞で組む'));
await sleep(800);
await spot('#rollbox', 2);
await cap('「歌詞で組む」：歌った時間ではなく、歌詞の音を順に並べ直します。緑が整えた後');
await sleep(5200);
await spot(null);
await cap('歌詞の空白の所で、間をあけて入り直します');
await sleep(3200);
await clickLoc(panelBtn('曲全体に適用'));
await sleep(1200);
await cap('拍がそろいました。音の高さは、歌ったままです');
await click('#playSec');
await sleep(9500);
await click('#playSec', 300);
await sleep(500);
// 外した1音を、ドラッグで直す（4行目の後半の「も」）
const fix = await page.evaluate(({ WRONG, TUNE }) => {
  const sec = song.sections[0], sp = lineSpans(sec)[WRONG.line];
  const k = TUNE[WRONG.line].slice(0, WRONG.part).reduce((a, p) => a + p.length, 0) + WRONG.i;
  const n = sec.melody.filter(x => !x.tie && x.t >= sp.s && x.t < sp.e).sort((a, b) => a.t - b.t)[k];
  const box = document.querySelector('#scroller');
  const g = rollGeom();
  box.scrollLeft = Math.max(0, n.t * g.ppb - box.clientWidth * 0.6);
  const r = document.querySelector('#roll').getBoundingClientRect();
  return { x: r.left + (n.t + n.d / 2) * g.ppb, y: r.top + (g.hi - n.m + 0.5) * g.rowH, row: g.rowH, m: n.m, t: n.t, want: TUNE[WRONG.line][WRONG.part][WRONG.i] };
}, { WRONG, TUNE });
await pointAt(fix.x, fix.y, 900);
await cap('外してしまった音は、音符を上下に動かして直せます');
await sleep(2600);
const rows = fix.m - fix.want;
await page.mouse.move(fix.x, fix.y);
await page.mouse.down();
for (let i = 1; i <= 12; i++) {
  await page.mouse.move(fix.x, fix.y + fix.row * rows * i / 12);
  await ov('cursor', fix.x, fix.y + fix.row * rows * i / 12);
  await sleep(70);
}
await page.mouse.up();
await sleep(2000);
console.log('fixed note:', await page.evaluate(t => song.sections[0].melody.find(x => x.t === t)?.m, fix.t), 'want', fix.want);
// 全体の高さ
await spot('#xpose', 6);
await cap('全体の高さは「高さ ▲▼」で、歌いやすい所に合わせられます');
await sleep(1800);
await click('#xpose button[data-d="1"]');
await sleep(900);
await click('#xpose button[data-d="1"]');
await sleep(2200);
await spot(null);
await cap('');

// ---- ④ 通して聴く ----
await chap('④ 通して聴く');
await clickTab('Aメロ');
await sleep(500);
await cap('できた曲を、通して聴いてみましょう');
const songSec = await page.evaluate(() => buildPlan(song.arrangement).total * 60 / song.bpm);
await click('#playSong');
mark('song');
await sleep(2500);
await cap('');
await sleep(songSec * 1000 - 2300);
await click('#playSong', 300);
await sleep(900);

// ---- ⑤ 書き出す ----
await chap('⑤ 書き出す');
await spot('#vguide .step:nth-last-child(3)', 4);
await cap('音声（MP3）、歌詞カード、ピアノ譜を書き出せます');
await sleep(3000);
await spot(null);
{
  const dl = page.waitForEvent('download', { timeout: 120000 });
  await clickLoc(guideBtn('MP3'));
  await (await dl).saveAs(path.join(OUT, 'hajimete-no-uta.mp3'));
}
await sleep(1500);
await cap('');
await showPopup(() => clickLoc(guideBtn('歌詞カード')), '.page', 'コード付きの歌詞カード', 'ひらがなにしたり、印刷して PDF にしたりできます', 5500, 0.82);
await showPopup(() => clickLoc(guideBtn('ピアノ譜')), '.pg', 'ピアノ譜', 'メロディ・歌詞・コードと、左手の和音。ピアノを弾いて一緒に歌えます', 6000);
await chap('');
await ov('cursorFast', -80, -80);
await ov('card', '<div><div class="logo">Kotone</div><div class="sub">歌うだけで、曲になる。</div><div class="url">kotonemusic.pages.dev</div><div class="small">PC の Chrome でどうぞ</div><div class="small">歌う人は、歌うだけ。操作は、となりの人が手伝えます</div></div>');
await sleep(7500);

// ---- 撮影終了：音を取り出す ----
await cdp.send('Page.stopScreencast');
const endTs = Date.now() / 1000;
const t0 = frames[0].ts;
const rendered = await page.evaluate(async ({ t0, endTs, recAt }) => {
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
  const voiceAt = (at, offset, dur, gain) => {            // 歌声（録音の場面と、元の歌の再生）
    const s = off.createBufferSource(), g = off.createGain();
    s.buffer = guide.buffer; g.gain.value = gain;
    s.connect(g).connect(off.destination);
    if (dur === undefined) s.start(at, offset); else s.start(at, offset, dur);
  };
  voiceAt(recAt - t0 + 0.25, 0, undefined, 0.9);          // 録音の場面：歌っている声を聞かせる
  let used = 0;
  for (const e of __ev) {
    const cut = e.o ? __cuts.get(e.o) : undefined;
    if (cut !== undefined && e.t >= cut) continue;
    const at = toWall(e.t) - t0;
    if (at < 0 || at > len) continue;
    if (e.k === 'n') {
      const d = cut !== undefined ? Math.min(e.dur, cut - e.t) : e.dur;
      __origNote(master, e.m, at, Math.max(0.02, d), e.vel);
    } else if (e.k === 'g') {
      const d = cut !== undefined ? Math.min(e.dur ?? 99, cut - e.t) : e.dur;
      if (d > 0.02) voiceAt(at, e.off, d, 0.9);
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
}, { t0, endTs, recAt: marks.rec });
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
const bgmFrom = marks.song - t0;                 // 音の中で、曲全体の再生が始まる位置
const bgmLen = marks.lyrics - t0;                 // タイトルの間だけ、できた曲を小さく流す
execFileSync('ffmpeg', ['-y', '-loglevel', 'error',
  '-f', 'concat', '-safe', '0', '-i', path.join(OUT, 'frames.txt'),
  '-i', path.join(OUT, 'audio.wav'),
  '-ss', bgmFrom.toFixed(3), '-t', bgmLen.toFixed(3), '-i', path.join(OUT, 'audio.wav'),
  '-filter_complex',
  `[1:a]anull[main];` +
  `[2:a]volume=0.45,afade=t=in:d=1.5,afade=t=out:st=${Math.max(0, bgmLen - 3).toFixed(2)}:d=3[bgm];` +
  `[main][bgm]amix=inputs=2:duration=first:normalize=0,loudnorm=I=-16:TP=-1.5:LRA=11[a]`,
  '-map', '0:v', '-map', '[a]',
  '-vf', 'scale=1920:1080:flags=lanczos,fps=30,format=yuv420p',
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
  '-t', total.toFixed(2), '-movflags', '+faststart',
  path.join(OUT, 'kotone-sing.mp4')], { stdio: 'inherit' });
console.log('done:', path.join(OUT, 'kotone-sing.mp4'));
