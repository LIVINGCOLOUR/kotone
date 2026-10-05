// Kotone の紹介動画（約3分）を作る。
// Chrome を自動操作して実際に1曲を作り、その画面（CDP の画面キャプチャ）を録る。
// 音は録画中に鳴らした音の記録（いつ・どの音を・どれだけ）から、録画後に OfflineAudioContext で作り直す
// （録画中は画面の撮影で処理が重く、そのまま録音すると音が途切れたりずれたりするため）。最後に ffmpeg で MP4 にまとめる。
//   使い方: cd video && node make-video.mjs   （出力: out/kotone-intro.mp4）
//   別のURLで撮る: KOTONE_URL=http://localhost:8766/ node make-video.mjs
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const URL = process.env.KOTONE_URL || 'https://kotonemusic.pages.dev/';
const OUT = path.resolve('out');
const FRAMES = path.join(OUT, 'frames');
const W = 1440, H = 810, DPR = 4 / 3; // 画面は 1440×810、撮影は 1920×1080

const sleep = ms => new Promise(r => setTimeout(r, ms));
const marks = {};
const mark = name => { marks[name] = Date.now() / 1000; };

// ---- 動画用の歌詞とメロディ（C メジャー、各セクション4小節） ----
const LYRICS = `窓(まど)をあけたら
朝(あさ)の匂(にお)いがした

まだ言葉(ことば)にならない
想(おも)いを連(つ)れて

歌(うた)にしよう 今(いま)のきもち
君(きみ)に届(とど)くように`;

const N = { C4: 60, D4: 62, E4: 64, F4: 65, G4: 67, A4: 69, B4: 71, C5: 72, D5: 74, E5: 76, F5: 77, G5: 79, A5: 81 };
// [拍, 長さ, 音]
const MELODY = {
  // F G Em Am。10拍目の F4 はわざと Em とぶつかる音（オレンジ）にしておき、動画の中でドラッグして E4 に直す
  'Aメロ': [[0, .5, 'C5'], [.5, .5, 'C5'], [1, 1, 'A4'], [2, .5, 'G4'], [2.5, .5, 'A4'], [3, .5, 'C5'], [3.5, 2.5, 'D5'],
    [7.5, .5, 'B4'], [8, .5, 'B4'], [8.5, .5, 'C5'], [9, .5, 'B4'], [9.5, .5, 'A4'], [10, 1, 'F4'], [11, .5, 'G4'], [11.5, .5, 'A4'], [12, 3, 'A4']],
  // Dm Em F G
  'Bメロ': [[0, .5, 'A4'], [.5, .5, 'A4'], [1, .5, 'A4'], [1.5, .5, 'C5'], [2, 1, 'D5'], [3, .5, 'C5'], [3.5, .5, 'D5'], [4, .5, 'E5'], [4.5, .5, 'D5'], [5, 2, 'B4'],
    [8, .5, 'C5'], [8.5, .5, 'D5'], [9, 1, 'E5'], [10, 1, 'F5'], [11, .5, 'E5'], [11.5, .5, 'D5'], [12, 3, 'D5']],
  // Am F G C（小室進行）
  'サビ': [[0, .5, 'E5'], [.5, .5, 'E5'], [1, .5, 'D5'], [1.5, .5, 'C5'], [2, .5, 'D5'], [2.5, 1, 'E5'], [3.5, .5, 'G5'], [4, .5, 'A5'], [4.5, .5, 'G5'], [5, .5, 'F5'], [5.5, .5, 'E5'], [6, 1.5, 'F5'],
    [8, .5, 'D5'], [8.5, .5, 'D5'], [9, .5, 'E5'], [9.5, .5, 'F5'], [10, 1, 'G5'], [11, .5, 'F5'], [11.5, .5, 'E5'], [12, .5, 'D5'], [12.5, 3.5, 'C5']],
};
// 「音階だけ」モード（C メジャー、下の段の始まり C4）での、音 → PCのキー
const ROW_LOW = ['KeyZ', 'KeyX', 'KeyC', 'KeyV', 'KeyB', 'KeyN', 'KeyM', 'Comma', 'Period', 'Slash'];
const ROW_HIGH = ['KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyT', 'KeyY', 'KeyU', 'KeyI', 'KeyO', 'KeyP'];
const DEG = [0, 2, 4, 5, 7, 9, 11];
function codeFor(m) {
  const rel = m - 60, oct = Math.floor(rel / 12), deg = DEG.indexOf(rel % 12) + 7 * oct;
  return m >= 72 ? ROW_HIGH[deg - 7] : ROW_LOW[deg];
}

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

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: DPR, acceptDownloads: true, colorScheme: 'light', locale: 'ja-JP' });
const page = await context.newPage();
page.on('dialog', d => d.accept());
page.on('pageerror', e => console.error('page error:', e.message));
await page.goto(URL, { waitUntil: 'networkidle' });
await page.evaluate(OVERLAY);

// 準備（録画前）：曲名、ピアノ音源の読み込み、アプリの音を録るレコーダー
await page.fill('#title', '朝のうた');
await page.evaluate(() => document.activeElement.blur());
await page.evaluate(async () => {
  audio();
  for (let i = 0; i < 100 && banks.piano?.state !== 'ready'; i++) await new Promise(r => setTimeout(r, 200));
  // すべての音は note()（楽器）と DRUM[...]（ドラム）を通るので、そこで「いつ・どの音を」を記録する。
  // 出力先（再生ごとの out）も覚えておき、再生を止めた時刻以降の音は作り直しのときに鳴らさない
  window.__ev = []; window.__cuts = new Map(); window.__clock = [];
  const ids = new WeakMap(); let next = 1;
  const oid = o => o === master ? 0 : (ids.has(o) ? ids.get(o) : (ids.set(o, next), next++));
  window.__origNote = note;
  note = function (out, m, t, dur, vel) {
    const ev = { k: 'n', o: oid(out), m, t, dur, vel };
    __ev.push(ev);
    const rel = __origNote(out, m, t, dur, vel);
    return () => { ev.dur = Math.max(0.02, ctx.currentTime - t); rel(); }; // 手弾きの音は離した時刻で長さが決まる
  };
  window.__origDrum = {};
  for (const n of Object.keys(DRUM)) {
    const f = __origDrum[n] = DRUM[n];
    DRUM[n] = (out, t, v) => { __ev.push({ k: 'd', o: oid(out), n, t, v }); f(out, t, v); };
  }
  const origStop = stop;
  stop = function () { if (playback) __cuts.set(oid(playback.out), ctx.currentTime); return origStop(); };
  // アプリの時計（ctx.currentTime）と実際の時刻の対応を記録する（処理が重いと音の時計が遅れることがあるため、細かく取る）
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
async function clickCand(name) {
  const i = await page.evaluate(n => [...document.querySelectorAll('#cands .cand')].findIndex(c => c.querySelector('.name').textContent === n), name);
  if (i < 0) throw new Error(`候補に ${name} がありません`);
  await clickLoc(page.locator('#cands .cand .name').nth(i));
}
const clickTab = name => clickLoc(page.locator('#tabs .tab > button:first-child', { hasText: name }));

await ov('cursorFast', -80, -80);

// ---- 0:00 タイトル ----
await ov('card', '<div><div class="logo">Kotone</div><div class="sub">コード・メロディ・歌詞を、ひとつの画面で。</div><div class="small">J-POP向けの作曲ツール</div></div>');
await sleep(7000);
await ov('card', '<div><div class="sub">この3分で、短い1曲を作ります</div><div class="flow"><span class="p">Aメロ</span>→<span class="p">Bメロ</span>→<span class="p">サビ</span></div><div class="small">① 歌詞 → ② コード → ③ メロディ → ④ 通して聴く</div></div>');
await sleep(6500);
await ov('card', '');
await ov('cursor', W * 0.6, H * 0.55);
await sleep(900);

// ---- ① 歌詞 ----
await chap('① 歌詞を入れる');
await cap('まずは、1曲分の歌詞を貼り付けます');
await click('#tabLyrics');
await sleep(900);
await click('#songLyrBtn');
await sleep(1200);
await pointAt(W * 0.35, H * 0.4);
await page.fill('#songLyrics', LYRICS);
await sleep(2200);
await cap('「自動で割り当て」で、Aメロ・Bメロ・サビに分かれます');
await click('#lyrAuto');
await sleep(800);
await spot('#lyrBlocks');
await sleep(3800);
await spot(null);
await cap('反映すると、セクションと曲の並びができあがります');
await click('#lyrApply');
await sleep(900);
await spot('#arrange', 4);
await sleep(3200);
await spot(null);
await cap('');

// ---- ② コード ----
mark('chords');
await chap('② コードを決める');
await click('#tabCands');
await cap('コードを1つ選ぶと、次に合うコードを提案します');
await sleep(1500);
await clickCand('F');
await sleep(1600);
await spot('#cands');
await cap('％はよく使われる度合い。タグはそのコードの雰囲気です');
await sleep(3500);
await spot(null);
await clickCand('G');
await sleep(1300);
await clickCand('Em');
await sleep(1300);
await clickCand('Am');
await sleep(900);
await spot('#famous', 4);
await cap('定番の「王道進行」の流れに乗ると、教えてくれます');
await sleep(3200);
await spot(null);
await cap('Bメロも、選んでいくだけ');
await clickTab('Bメロ');
await sleep(1200);
for (const c of ['Dm', 'Em', 'F', 'G']) { await clickCand(c); await sleep(1100); }
await cap('サビは、定番の進行から始めることもできます');
await clickTab('サビ');
await sleep(1000);
{ // 選択欄はクリックすると一覧が開いたままになるので、カーソルを合わせてから値を選ぶ
  const b = await page.locator('#preset').boundingBox();
  await pointAt(b.x + b.width / 2, b.y + b.height / 2, 900);
  await page.selectOption('#preset', { label: '小室進行' });
}
await sleep(1500);
await cap('作ったコードは、ピアノの音ですぐに確かめられます');
await click('#playSec');
await sleep(9000);
await click('#playSec', 400);
await sleep(600);
await cap('');

// ---- ③ メロディ ----
await chap('③ メロディを作る');
await clickTab('Aメロ');
await sleep(700);
await click('#tabLyrics');
await sleep(600);
await spot('#lane', 2);
await cap('歌詞は「歌詞」の行に並び、置いた音符に1音ずつ付きます');
await sleep(3800);
await spot('.dock', 0);
await cap('鍵盤は「音階だけ」モード。PCのキーを押すだけで、キーから外れた音は出ません');
await sleep(4200);
await spot(null);
await cap('Shift+R で録音。コードを聴きながら、歌詞に合わせて弾きます');
await ov('keys', true);
await page.evaluate(() => document.activeElement.blur());
await sleep(1200);
// 録音の再生が始まったら、メロディの拍に合わせてキーを押す（キー入力はアプリが受け取って記録する）
async function recordSection(name) {
await page.keyboard.press('Shift+KeyR');
const notesA = MELODY[name].map(([t, d, n]) => ({ t, d, code: codeFor(N[n]) }));
await page.evaluate(async notes => {
  for (let i = 0; i < 50 && !(playback && playback.passes.length); i++) await new Promise(r => setTimeout(r, 20));
  const p = playback.passes[0], beat = p.beat;
  const at = t => (p.t0 + t * beat - ctx.currentTime) * 1000;
  const fire = (type, code) => dispatchEvent(new KeyboardEvent(type, { code, key: code.replace(/^Key/, '').toLowerCase(), bubbles: true }));
  for (const n of notes) {
    setTimeout(() => fire('keydown', n.code), at(n.t) + 15);
    setTimeout(() => fire('keyup', n.code), at(n.t + n.d) - 30);
  }
  await new Promise(r => setTimeout(r, at(16) + 150));
}, notesA);
await page.keyboard.press('Shift+KeyR');
await sleep(500);
await page.keyboard.press('Space');
await ov('keys', false);
const recorded = await page.evaluate(() => curSec().melody.map(n => [n.t, n.d, n.m]).sort((a, b) => a[0] - b[0]));
const expectedA = MELODY[name].map(([t, d, n]) => [t, d, N[n]]);
console.log(`recorded ${name} matches:`, JSON.stringify(recorded) === JSON.stringify(expectedA));
if (JSON.stringify(recorded) !== JSON.stringify(expectedA)) {
  console.log('recorded:', JSON.stringify(recorded));
  // 万一ずれたら、意図したメロディに置き換えて続ける（以降の場面がくずれないように）
  await page.evaluate(m => { curSec().melody = m.map(([t, d, mm]) => ({ t, d, m: mm })); changed(); }, expectedA);
}
}
await recordSection('Aメロ');
await cap('歌詞が音符に付いていきます');
await sleep(3000);

// オレンジの音（Em とぶつかる F4）をドラッグで E4 に直す
const fix = await page.evaluate(() => {
  const g = rollGeom(), r = document.querySelector('#roll').getBoundingClientRect();
  const n = curSec().melody.find(x => x.t === 10);
  return { x: r.left + (n.t + 0.35) * g.ppb, y: r.top + (g.hi - n.m + 0.5) * g.rowH, row: g.rowH, w: g.ppb };
});
await pointAt(fix.x, fix.y, 900);
await cap('オレンジの音は、コードとぶつかりやすい音の合図。ドラッグで直します');
await sleep(2600);
await page.mouse.move(fix.x, fix.y);
await page.mouse.down();
for (let i = 1; i <= 8; i++) {
  await page.mouse.move(fix.x, fix.y + fix.row * i / 8);
  await ov('cursor', fix.x, fix.y + fix.row * i / 8);
  await sleep(60);
}
await page.mouse.up();
await sleep(2200);
console.log('fixed note:', await page.evaluate(() => curSec().melody.find(x => x.t === 10)?.m));

await cap('Bメロも、歌詞の行を見ながら録音します');
await clickTab('Bメロ');
await sleep(1500);
await ov('keys', true);
await page.evaluate(() => document.activeElement.blur());
await recordSection('Bメロ');
await ov('keys', false);
await sleep(1800);
await cap('サビも同じように（ここは早送り）');
await ov('ff', true);
await clickTab('サビ');
await sleep(600);
await page.evaluate(m => { curSec().melody = m.map(([t, d, mm]) => ({ t, d, m: mm })); changed(); }, MELODY['サビ'].map(([t, d, n]) => [t, d, N[n]]));
await sleep(2400);
await ov('ff', false);
await cap('');

// ---- ④ 通して聴く ----
await chap('④ 通して聴く');
await clickTab('Aメロ');
await sleep(400);
await cap('できた曲を、通して聴いてみましょう');
const songSec = await page.evaluate(() => buildPlan(song.arrangement).total * 60 / song.bpm);
await click('#playSong');
mark('song');
await sleep(2500);
await cap('');
await sleep(songSec * 1000 - 2300);
await click('#playSong', 300);
await sleep(800);

// ---- ⑤ 書き出し・締め ----
await chap('⑤ 書き出す');
await cap('MIDIで書き出せば、DAWで仕上げられます（コード・ベース・メロディ・ドラム・歌詞）');
await click('#fileMenu summary');
await sleep(900);
const dl = page.waitForEvent('download');
await click('#midi');
const download = await dl;
await download.saveAs(path.join(OUT, 'asa-no-uta.mid'));
await sleep(3600);
// 「ファイル」メニューをもう一度開いて、ほかの書き出しも見せる
await click('#fileMenu summary');
await sleep(500);
await spot('#fileMenu .menu-body', 4);
await cap('音声（MP3）、コード付きの歌詞カード、ピアノ譜も作れます');
await sleep(4600);
await spot(null);
await click('#fileMenu summary', 300);
await sleep(400);
await cap('');
await chap('');
await ov('cursorFast', -80, -80);
await ov('card', '<div><div class="logo">Kotone</div><div class="sub">歌詞から、コード、メロディまで。</div><div class="url">kotonemusic.pages.dev</div><div class="small">PC の Chrome でどうぞ（MIDIキーボードにも対応）</div><div class="small">鍵盤を使わず、歌って作る方法は、別の動画で紹介します</div></div>');
await sleep(7000);

// ---- 撮影終了：音を取り出す ----
await cdp.send('Page.stopScreencast');
const endTs = Date.now() / 1000;
const t0 = frames[0].ts;
const rendered = await page.evaluate(async ({ t0, endTs }) => {
  const SR = 48000;
  // アプリの時計 → 実際の時刻。対応（実際の時刻 − アプリの時計）を前後2秒ほどの中央値でならし、間を直線でつなぐ
  // （記録した瞬間の揺れで、音のタイミングが揺れないように）
  const raw = __clock, H = 5;
  const diffs = raw.map(([c, w]) => w - c);
  const clk = raw.map(([c], i) => {
    const win = diffs.slice(Math.max(0, i - H), i + H + 1).sort((a, b) => a - b);
    return [c, c + win[win.length >> 1]];
  });
  window.__clockSmoothed = clk;
  const toWall = c => {
    let i = clk.findIndex(p => p[0] >= c);
    if (i <= 0) i = i === 0 ? 1 : clk.length - 1;
    const [c0, w0] = clk[i - 1], [c1, w1] = clk[i];
    return w0 + (c - c0) * (c1 > c0 ? (w1 - w0) / (c1 - c0) : 1);
  };
  const len = endTs - t0;
  const off = new OfflineAudioContext(2, Math.ceil(len * SR), SR);
  const saved = { ctx, master };
  ctx = off;                                  // アプリの音作り（note・DRUM）を、そのままオフラインの側で使う
  master = off.createGain(); master.gain.value = 0.7;
  master.connect(off.createDynamicsCompressor()).connect(off.destination);
  let used = 0;
  for (const e of __ev) {
    const cut = e.o ? __cuts.get(e.o) : undefined;
    if (cut !== undefined && e.t >= cut) continue;           // 止めた後に予定されていた音は鳴らさない
    const at = toWall(e.t) - t0;
    if (at < 0 || at > len) continue;
    if (e.k === 'n') {
      const d = cut !== undefined ? Math.min(e.dur, cut - e.t) : e.dur;
      __origNote(master, e.m, at, Math.max(0.02, d), e.vel);
    } else __origDrum[e.n](master, at, e.v);
    used++;
  }
  const buf = await off.startRendering();
  ctx = saved.ctx; master = saved.master;
  // 16bit の WAV にする
  const L = buf.getChannelData(0), R = buf.getChannelData(1), n = buf.length;
  const wav = new DataView(new ArrayBuffer(44 + n * 4));
  const str = (o, s) => [...s].forEach((ch, i) => wav.setUint8(o + i, ch.charCodeAt(0)));
  str(0, 'RIFF'); wav.setUint32(4, 36 + n * 4, true); str(8, 'WAVEfmt '); wav.setUint32(16, 16, true);
  wav.setUint16(20, 1, true); wav.setUint16(22, 2, true); wav.setUint32(24, SR, true); wav.setUint32(28, SR * 4, true);
  wav.setUint16(32, 4, true); wav.setUint16(34, 16, true); str(36, 'data'); wav.setUint32(40, n * 4, true);
  const clip = x => Math.max(-1, Math.min(1, x)) * 32767;
  for (let i = 0; i < n; i++) { wav.setInt16(44 + i * 4, clip(L[i]), true); wav.setInt16(46 + i * 4, clip(R[i]), true); }
  window.__wav = new Uint8Array(wav.buffer);
  return { events: __ev.length, used, cuts: __cuts.size, bytes: __wav.length };
}, { t0, endTs });
console.log('rendered audio:', JSON.stringify(rendered));
fs.writeFileSync(path.join(OUT, 'clock.json'), JSON.stringify(await page.evaluate(() => ({ raw: __clock, smoothed: __clockSmoothed }))));
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
// 画面キャプチャは変化があったときだけ届くので、各コマの表示時間を次のコマまでの差で決める
const list = frames.map((f, i) => `file '${f.file}'\nduration ${Math.max(0.001, ((frames[i + 1]?.ts ?? endTs) - f.ts)).toFixed(4)}`).join('\n') + `\nfile '${frames[frames.length - 1].file}'\n`;
fs.writeFileSync(path.join(OUT, 'frames.txt'), list);
const total = endTs - t0;
console.log(`frames=${frames.length} duration=${total.toFixed(1)}s`);
const bgmFrom = marks.song - t0;                 // 音の中で、曲全体の再生が始まる位置
const bgmLen = marks.chords - t0;                 // 動画の冒頭から、コードの場面に入るまで
console.log(`bgm: from ${bgmFrom.toFixed(1)}s, length ${bgmLen.toFixed(1)}s`);
execFileSync('ffmpeg', ['-y', '-loglevel', 'error',
  '-f', 'concat', '-safe', '0', '-i', path.join(OUT, 'frames.txt'),
  '-i', path.join(OUT, 'audio.wav'),
  '-ss', bgmFrom.toFixed(3), '-t', bgmLen.toFixed(3), '-i', path.join(OUT, 'audio.wav'),
  '-filter_complex',
  `[1:a]anull[main];` +
  `[2:a]volume=0.45,afade=t=in:d=1.5,afade=t=out:st=${Math.max(0, bgmLen - 4).toFixed(2)}:d=4[bgm];` +
  `[main][bgm]amix=inputs=2:duration=first:normalize=0,loudnorm=I=-16:TP=-1.5:LRA=11[a]`,
  '-map', '0:v', '-map', '[a]',
  '-vf', 'scale=1920:1080:flags=lanczos,fps=30,format=yuv420p',
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
  '-t', total.toFixed(2), '-movflags', '+faststart',
  path.join(OUT, 'kotone-intro.mp4')], { stdio: 'inherit' });
console.log('done:', path.join(OUT, 'kotone-intro.mp4'));
