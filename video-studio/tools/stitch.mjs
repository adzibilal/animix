#!/usr/bin/env node
// Stitch a Video Studio project: clips (one per scene) → fitted to each scene's length and the format → narration per
// scene (provider from the project's voice settings) placed at the scene's start → optional generated music under it → final.mp4 at -14 LUFS.
//   node tools/stitch.mjs <slug> [--music lofi|ambient|upbeat|epic|none] [--no-voice]
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { synthProject, NAMES } from '../lib/tts.mjs';
import { getSettings } from '../lib/settings.mjs';
import { isCartoon3d, writeAssForLines, assFilterArg } from '../lib/captions.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = path.resolve(ROOT, '..');
const slug = process.argv[2];
const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const dir = path.join(ROOT, 'projects', slug), P = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8'));
const work = path.join(dir, 'stitch'); fs.mkdirSync(work, { recursive: true });
const SIZE = { '9:16': [1080, 1920], '16:9': [1920, 1080], '1:1': [1080, 1080] }[P.format || '9:16'];
const run = (cmd, args) => { const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 26 }); if (r.status !== 0) { console.error(r.stderr?.slice(-1500)); throw new Error(`${cmd} failed`); } return r.stdout; };
const ff = (args) => run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
const dur = (f) => +run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).trim();

// 1. every scene clip → exact length, format, 30 fps (freeze the last frame if a clip is short; fit inside with a dark pad)
const parts = [];
for (const s of P.scenes) {
  const len = +(s.end - s.start).toFixed(3);
  if (!(len > 0)) continue;
  const src = s.clip ? path.join(dir, s.clip) : null;
  const out = path.join(work, `part-${String(s.n).padStart(2, '0')}.mp4`);
  const [W, H] = SIZE;
  const fit = `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=0x101018,fps=30,format=yuv420p,setsar=1`;
  if (src && fs.existsSync(src)) {
    const have = dur(src);
    const vf = have < len ? `${fit},tpad=stop_mode=clone:stop_duration=${(len - have + 0.1).toFixed(2)}` : fit;
    ff(['-i', src, '-t', String(len), '-vf', vf, '-an', '-c:v', 'libx264', '-crf', '18', '-preset', 'fast', out]);
  } else {
    console.warn(`scene ${s.n}: no clip, using a placeholder card`);
    ff(['-f', 'lavfi', '-i', `color=c=0x101018:s=${W}x${H}:r=30:d=${len}`, '-vf', `drawtext=text='scene ${s.n}':fontcolor=white:fontsize=60:x=(w-tw)/2:y=(h-th)/2`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', out]);
  }
  parts.push(out);
}
const list = path.join(work, 'list.txt'); fs.writeFileSync(list, parts.map((p) => `file '${p.replace(/\\/g, '/')}'`).join('\n'));
const video = path.join(work, 'video.mp4'); ff(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', video]);
const total = dur(video);

// 2. narration: one line per scene from ONE provider (lib/tts.mjs: Gemini/ElevenLabs/Fish/Edge/Kokoro, key rotation, cache per line),
//    placed at the scene's start. A project without voice.provider is an old one: Kokoro at speed 1.0, as before.
// voice-over is opt-in: only when the user turned it on in the studio (voice.on === true)
const useVoice = !process.argv.includes('--no-voice') && P.voice?.on === true && (P.voice?.voice || 'am_michael') !== 'none';
const lines = []; let used = null;
if (useVoice) {
  const r = await synthProject(P.scenes, P.voice, path.join(dir, 'voice'));
  used = r.used;
  const textOf = new Map(P.scenes.map((s) => [s.n, s.narration || '']));
  for (const l of r.lines) {
    const d = dur(l.file), room = l.end - l.start;
    if (d > room + 0.05) console.warn(`scene ${l.n}: narration is ${d.toFixed(1)} s for a ${room.toFixed(1)} s scene (it will run over)`);
    lines.push({ f: l.file, file: l.file, at: l.start + 0.15, tempo: 1, text: textOf.get(l.n) || '' });
  }
  if (P.voice.provider) { // record what was really used (old Kokoro projects stay untouched)
    const cur = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8'));
    cur.voice = { ...cur.voice, used };
    (cur.log ||= []).push({ at: new Date().toISOString(), text: `VO: ${NAMES[used.provider]} (${used.voice}), ${lines.length} line(s)${used.key ? ', key ' + used.key : ''}` });
    const t = path.join(dir, 'project.json.tmp'); fs.writeFileSync(t, JSON.stringify(cur, null, 2)); fs.renameSync(t, path.join(dir, 'project.json'));
  }
}

// 3. music from tvhead's free generator (optional)
let music = null; const preset = arg('--music', P.music && P.music !== 'auto' ? P.music : 'lofi');
if (preset !== 'none') {
  try {
    const { renderMusic } = await import(pathToFileURL(path.join(BUILD, 'studio', 'lib', 'music.mjs')).href);
    music = path.join(work, 'music.mp3');
    await renderMusic({ preset, duration: total + 0.5, seed: 7 }, music);
  } catch (e) { console.warn('music skipped: ' + e.message); music = null; }
}

// 3b. word-by-word (1-3 words) bold white + black stroke captions for cartoon-3d-short (or --captions)
const wantCaptions = !process.argv.includes('--no-captions') && (process.argv.includes('--captions') || isCartoon3d(P));
const cap = wantCaptions && lines.length ? writeAssForLines(lines, SIZE, path.join(work, 'captions.ass')) : null;
const vOut = cap
  ? ['-vf', assFilterArg(cap.assPath), '-c:v', 'libx264', '-crf', '18', '-preset', 'fast', '-pix_fmt', 'yuv420p']
  : ['-c:v', 'copy'];

// 4. mix and mux
const inputs = ['-i', video]; const filters = []; const mixIn = [];
lines.forEach((l, i) => { inputs.push('-i', l.f); filters.push(`[${i + 1}:a]adelay=${Math.round(l.at * 1000)}|${Math.round(l.at * 1000)},aresample=48000[v${i}]`); mixIn.push(`[v${i}]`); });
const S = getSettings(), musicVol = lines.length ? P.audio?.musicVolume ?? S.musicVolume : 0.6;
if (music && fs.existsSync(music)) {
  const k = lines.length + 1; inputs.push('-i', music); filters.push(`[${k}:a]volume=${musicVol},aresample=48000[m]`);
  if (S.ducking && lines.length) { // music ducks under the voice (off by default so old mixes stay identical)
    filters.push(`${mixIn.join('')}amix=inputs=${mixIn.length}:normalize=0:duration=longest,asplit=2[vo][sc]`, '[m][sc]sidechaincompress=threshold=0.05:ratio=8:attack=20:release=400[md]');
    mixIn.length = 0; mixIn.push('[vo]', '[md]');
  } else mixIn.push('[m]');
}
const final = path.join(dir, 'final.mp4');
if (mixIn.length) {
  filters.push(`${mixIn.join('')}amix=inputs=${mixIn.length}:normalize=0:duration=longest,loudnorm=I=-14:TP=-1.5:LRA=11[a]`);
  ff([...inputs, '-filter_complex', filters.join(';'), '-map', '0:v', '-map', '[a]', '-t', String(total), ...vOut, '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', final]);
} else ff(['-i', video, ...vOut, '-movflags', '+faststart', final]);
// 5. loudness: one-pass loudnorm lands 1-2 LU short of -14 on a one-minute mix, so measure the result and correct it once (linear: the dynamics stay)
const measure = (f) => { const r = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', f, '-vn', '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json', '-f', 'null', '-'], { encoding: 'utf8' }); const m = (r.stderr || '').match(/\{[^{}]*"input_i"[^{}]*\}/); return m ? JSON.parse(m[0]) : null; };
let lufs = null;
if (mixIn.length) {
  const m = measure(final); lufs = m ? +m.input_i : null;
  if (Number.isFinite(lufs) && Math.abs(lufs + 14) > 0.5) {
    const tmp = path.join(work, 'final-loud.mp4');
    ff(['-i', final, '-map', '0', '-c:v', 'copy', '-af', `loudnorm=I=-14:TP=-1.5:LRA=11:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`, '-ar', '48000', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', tmp]);
    fs.renameSync(tmp, final); lufs = +(measure(final)?.input_i ?? lufs);
  }
}
// 6. the per-scene parts, the silent cut and the music bed are all inside final.mp4 now: free the space (often ~1 GB per video)
for (const f of fs.readdirSync(work)) if (/^(part-\d+\.mp4|video\.mp4|list\.txt|music\.mp3)$/.test(f)) fs.rmSync(path.join(work, f), { force: true });
console.log(`final.mp4: ${total.toFixed(2)} s, ${SIZE.join('x')}, ${lines.length} narration line(s), music: ${music ? preset : 'none'}${cap ? `, captions: ${cap.count} events` : ''}${Number.isFinite(lufs) ? `, ${lufs.toFixed(1)} LUFS` : ''}`);
