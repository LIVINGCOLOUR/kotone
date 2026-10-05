// 「歌って作る」紹介動画のための、短い歌（歌詞・メロディ）と、合成した歌声。
// 歌声は、歌詞の1音につき1つの音を、母音「あ」に近い音色で鳴らしたもの。実際に自由に歌ったときのように、
//   ・フレーズの後ろほど速くなる（走る）　・途中だけ急に速くなる所がある　・行の間の休みがばらばら
//   ・全体がピアノの音から少しずれている　・音ごとに少しずつ高さがずれる　・1音だけ、はっきり外す
// ようにしてある。
import fs from 'node:fs';

export const LYRICS = `[Aメロ]
小(ちい)さな声(こえ)で　歌(うた)ってみた
言葉(ことば)がそっと　動(うご)き出(だ)した
間違(まちが)えたって　かまわないよ
君(きみ)の歌(うた)は　君(きみ)のもの

[サビ]
ラララ　歌(うた)えば
世界(せかい)が　広(ひろ)がる
ラララ　今日(きょう)から
この歌(うた)　わたしの歌(うた)`;

// 行ごとの、歌う音（MIDI ノート番号）。配列2つは、歌詞の空白で分けた前半・後半
export const TUNE = [
  [[64, 64, 67, 67, 69, 67, 64], [62, 64, 67, 64, 62]],
  [[64, 64, 67, 67, 69, 67], [62, 64, 65, 64, 62, 60]],
  [[67, 67, 69, 69, 72, 69], [67, 69, 67, 64, 62, 64]],
  [[65, 65, 64, 64, 62, 62], [64, 62, 60, 62, 60]],
  [[72, 72, 72], [69, 67, 69, 72]],
  [[74, 72, 69, 67], [69, 72, 69, 67]],
  [[72, 72, 72], [69, 67, 69, 72]],
  [[74, 72, 69, 67], [64, 67, 69, 67, 62, 60]],
];
export const WRONG = { line: 3, part: 1, i: 3, sung: 65 };   // 4行目「きみのもの」の「も」を、3半音高く外す
const GAPS = [1.2, 0.9, 1.4, 1.7, 1.1, 0.9, 1.2, 0];         // 行のあとの休み（秒）
const BURST = { line: 2, part: 0, from: 2, to: 4 };          // 3行目の前半の途中だけ、急に速くなる

// 乱数（毎回同じ声になるように）
let seed = 20261005;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };

// 歌う音の一覧 [{ t0, t1, hz }]（秒）
export function performance() {
  const notes = [];
  let t = 0.6;
  TUNE.forEach((parts, li) => {
    parts.forEach((ms, pi) => {
      ms.forEach((m, i) => {
        let d = 0.27 * (1 - 0.28 * i / Math.max(1, ms.length - 1));              // 後ろほど速く
        if (BURST.line === li && BURST.part === pi && i >= BURST.from && i <= BURST.to) d = 0.16;
        if (i === ms.length - 1) d = pi === parts.length - 1 ? 0.5 : 0.34;         // まとまりの最後は少し伸ばす
        const sung = WRONG.line === li && WRONG.part === pi && WRONG.i === i ? WRONG.sung : m;
        const cents = 30 + (rnd() - 0.5) * 50;                                     // 全体が30セント高く、音ごとに±25セント
        notes.push({ t0: t, t1: t + d - 0.045, hz: 440 * 2 ** ((sung - 69) / 12 + cents / 1200) });
        t += d;
      });
      if (pi < parts.length - 1) t += 0.42;                                        // 歌詞の空白の所の、短い休み
    });
    t += GAPS[li];
  });
  return { notes, length: t + 0.8 };
}

// 合成した歌声を WAV（48kHz・モノラル）で書き出す
export function writeVoice(file) {
  const SR = 48000, { notes, length } = performance();
  const x = new Float32Array(Math.ceil(length * SR));
  const FORMANTS = [[780, 110, 1], [1180, 130, 0.7], [2650, 180, 0.35]];           // 母音「あ」に近い音色
  const gain = f => 0.04 + FORMANTS.reduce((a, [c, w, g]) => a + g * Math.exp(-((f - c) ** 2) / (2 * w * w)), 0);
  for (const n of notes) {
    const i0 = Math.floor(n.t0 * SR), i1 = Math.floor(n.t1 * SR), len = i1 - i0;
    const phase = new Float64Array(24);
    for (let i = 0; i < len; i++) {
      const t = i / SR;
      const scoop = -70 * Math.exp(-t / 0.035);                                    // 歌い出しで、下からすくい上げる
      const vib = t > 0.16 ? 14 * Math.sin(2 * Math.PI * 5.5 * (t - 0.16)) : 0;     // 伸ばした所で、少し揺れる
      const f0 = n.hz * 2 ** ((scoop + vib) / 1200);
      const env = Math.min(1, t / 0.025) * Math.min(1, (len - i) / SR / 0.04);
      let s = 0;
      for (let k = 1; k <= 24; k++) {
        const f = f0 * k;
        if (f > 9000) break;
        phase[k - 1] += 2 * Math.PI * f / SR;
        s += Math.sin(phase[k - 1]) * gain(f) / k ** 0.6;
      }
      x[i0 + i] += s * env * 0.16 + (rnd() - 0.5) * 0.004 * env;                    // 息の音を少し
    }
  }
  const buf = Buffer.alloc(44 + x.length * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + x.length * 2, 4); buf.write('WAVEfmt ', 8); buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 2, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(x.length * 2, 40);
  for (let i = 0; i < x.length; i++) buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, x[i])) * 32767), 44 + i * 2);
  fs.writeFileSync(file, buf);
  return { seconds: length, notes: notes.length };
}
