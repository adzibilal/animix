// Voice-over router for Video Studio: provider choice, key rotation (keys.mjs), one provider per video, a cache per line.
//   synthProject(scenes, voiceCfg, dir) → { lines: [{ n, start, end, file }], used: { provider, voice, key } }
// voiceCfg without "provider" = an old project: Kokoro at speed 1.0, exactly as stitch.mjs did before.
// Providers ported from sandekala workspace/scripts/tts.mjs (same endpoints, voices and models).
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { withKey, keysFor, lastKey } from './keys.mjs';
import { getSettings } from './settings.mjs';

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const KOKORO = path.join(KIT, 'studio', 'tts');
const KPY = path.join(KOKORO, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');

export const NAMES = { gemini: 'Gemini', elevenlabs: 'ElevenLabs', fish: 'Fish Audio', edge: 'Edge TTS', kokoro: 'Kokoro' };
export const KEYENV = { gemini: 'GEMINI_API_KEY', elevenlabs: 'ELEVENLABS_API_KEY', fish: 'FISH_API_KEY', edge: 'EDGE_TTS_KEY' };
export const available = (p) => (p === 'kokoro' ? fs.existsSync(KPY) : !!KEYENV[p] && keysFor(KEYENV[p]).length > 0);
export const supports = (p, lang) => p !== 'kokoro' || lang === 'en'; // Kokoro here only has English voices

const v = (id, name = id) => ({ id, name });
const GEMINI = ['Charon', 'Kore', 'Puck', 'Fenrir', 'Aoede', 'Leda', 'Orus', 'Zephyr', 'Iapetus', 'Enceladus', 'Algenib', 'Sulafat'].map((x) => v(x));
const STATIC = {
  gemini: { id: GEMINI, en: GEMINI },
  elevenlabs: { id: [v('TX3LPaxmHKxFdv7VOQHJ', 'Liam')], en: [v('TX3LPaxmHKxFdv7VOQHJ', 'Liam')] },
  fish: { id: [v('1e19ed6473594e06b847175f59fa8b33', 'Utama'), v('b8d594e696694b499aa12e32d0c1b618', 'Prabowo'), v('bdb838c0b3fe4782acac358b10500594', 'Slax')],
    en: [v('bf322df2096a46f18c579d0baa36f41d', 'Adrian')] },
  edge: { id: [v('id-ID-ArdiNeural', 'Ardi (male)'), v('id-ID-GadisNeural', 'Gadis (female)')],
    en: [v('en-US-GuyNeural', 'Guy (US)'), v('en-US-JennyNeural', 'Jenny (US)'), v('en-GB-RyanNeural', 'Ryan (UK)')] },
  kokoro: { id: [], en: [v('am_michael', 'Michael'), v('am_adam', 'Adam'), v('bm_george', 'George (UK)'), v('am_onyx', 'Onyx')] },
};
/** Voices for the UI: the static list, plus the account's own voices when a key exists (best effort). */
export async function listVoices(p, lang) {
  const list = [...(STATIC[p]?.[lang] ?? STATIC[p]?.en ?? [])], key = KEYENV[p] && keysFor(KEYENV[p])[0];
  try {
    if (p === 'elevenlabs' && key) {
      const j = await (await fetch('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': key }, signal: AbortSignal.timeout(8000) })).json();
      for (const x of j.voices ?? []) if (!list.some((y) => y.id === x.voice_id)) list.push(v(x.voice_id, x.name));
    }
    if (p === 'fish' && key) {
      const j = await (await fetch('https://api.fish.audio/model?self=true&page_size=50', { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8000) })).json();
      for (const x of j.items ?? []) if (!list.some((y) => y.id === x._id)) list.push(v(x._id, x.title));
    }
  } catch { /* offline or bad key: the static list is enough */ }
  return list;
}

const clean = (t) => t.replace(/\[[^\]]*\]|<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const TIMEOUT = () => AbortSignal.timeout(90_000);
const GEMINI_MODEL = process.env.TTS_MODEL ?? 'gemini-3.8-flash-tts', GEMINI_LITE = 'gemini-3.8-flash-lite-tts';

/** Each provider: (text, voice, speed) → { buf, inFmt?: ffmpeg input args, tempo?: true = apply speed with atempo } */
const SYNTH = {
  async gemini(text, voice) {
    let first;
    for (const model of [GEMINI_MODEL, GEMINI_LITE]) { // daily quota of the main model gone → lite, so the voice stays Google's
      try {
        const res = await withKey(KEYENV.gemini, model, (key) => fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
          method: 'POST', signal: TIMEOUT(), headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: `## Transcript:\n${clean(text)}` }] }],
            generationConfig: { temperature: 1, responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } } }),
        }));
        const d = (await res.json()).candidates?.[0]?.content?.parts?.[0]?.inlineData;
        if (!d?.data) throw new Error('gemini returned no audio');
        const rate = d.mimeType?.match(/rate=(\d+)/)?.[1];
        // ponytail: whole WAV per sandekala; raw PCM (audio/L16;rate=24000) handled too
        return { buf: Buffer.from(d.data, 'base64'), inFmt: /L16|pcm/i.test(d.mimeType || '') ? ['-f', 's16le', '-ar', rate || '24000', '-ac', '1'] : [], tempo: true };
      } catch (e) { first ??= e; }
    }
    throw first;
  },
  async elevenlabs(text, voice, speed) {
    const res = await withKey(KEYENV.elevenlabs, 'eleven', (key) => fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_128`, {
      method: 'POST', signal: TIMEOUT(), headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: clean(text), model_id: 'eleven_multilingual_v2', voice_settings: { stability: 0.4, similarity_boost: 0.8, style: 0.3, speed: Math.min(1.2, Math.max(0.7, speed)) } }),
    }));
    return { buf: Buffer.from(await res.arrayBuffer()) };
  },
  async fish(text, voice, speed) {
    const res = await withKey(KEYENV.fish, 'fish', (key) => fetch('https://api.fish.audio/v1/tts', {
      method: 'POST', signal: TIMEOUT(), headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', model: 's2.1-pro-free' },
      body: JSON.stringify({ text: clean(text), reference_id: voice, format: 'mp3', prosody: { speed } }),
    }));
    return { buf: Buffer.from(await res.arrayBuffer()) };
  },
  async edge(text, voice, speed) {
    const res = await withKey(KEYENV.edge, 'edge', (key) => fetch('https://ai.adzibilal.my.id/v1/audio/speech', {
      method: 'POST', signal: TIMEOUT(), headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: `edge-tts/${voice}`, input: clean(text), ...(speed !== 1 ? { speed } : {}) }),
    }));
    return { buf: Buffer.from(await res.arrayBuffer()) };
  },
};

function kokoro(text, voice, speed, out) { // same call as the old stitch.mjs: speak.py writes the mp3 itself (byte-identical)
  const r = spawnSync(KPY, [path.join(KOKORO, 'speak.py'), out, voice, speed === 1 ? '1.0' : String(speed)], { input: text, encoding: 'utf8' });
  if (r.status !== 0 || !fs.existsSync(out)) throw new Error(`kokoro failed ${String(r.stderr || '').slice(-300)}`);
}

async function synthLine(p, text, voice, lang, speed, dir) {
  const file = path.join(dir, createHash('sha1').update([p, voice, lang, speed, text].join('|')).digest('hex') + '.mp3');
  if (fs.existsSync(file)) return file;
  fs.mkdirSync(dir, { recursive: true });
  const tmp = file + '.part.mp3';
  if (p === 'kokoro') kokoro(text, voice, speed, tmp);
  else {
    const { buf, inFmt = [], tempo } = await SYNTH[p](text, voice, speed);
    const raw = file + '.raw'; fs.writeFileSync(raw, buf);
    const af = tempo && speed !== 1 ? ['-af', `atempo=${speed}`] : [];
    const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...inFmt, '-i', raw, ...af, '-c:a', 'libmp3lame', '-q:a', '2', tmp], { encoding: 'utf8' });
    fs.rmSync(raw, { force: true });
    if (r.status !== 0) throw new Error(`${p}: audio could not be decoded (${String(r.stderr).slice(-200)})`);
  }
  fs.renameSync(tmp, file);
  return file;
}

/** Which providers to try, in order, for a voice config. */
export function chainFor(cfg, s = getSettings()) {
  if (!cfg.provider) return ['kokoro']; // old project
  const lang = cfg.lang || s.lang, want = cfg.provider === 'auto' ? s.priority : [cfg.provider];
  return want.filter((p) => NAMES[p] && supports(p, lang) && available(p));
}

export async function synthProject(scenes, cfg = {}, dir, log = console.log) {
  const s = getSettings(), legacy = !cfg.provider;
  const lang = legacy ? 'en' : cfg.lang || s.lang, speed = legacy ? 1 : +cfg.speed || 1;
  const todo = scenes.filter((x) => (x.narration || '').trim());
  const chain = chainFor(cfg, s);
  if (!chain.length) throw new Error(`no voice-over provider can be used for "${cfg.provider}" in ${lang} (add a key in Settings → API Keys)`);
  for (const [i, p] of chain.entries()) {
    const voice = legacy ? cfg.voice || 'am_michael'
      : cfg.provider === p && cfg.voice ? cfg.voice : s.voices[lang]?.[p] ?? s.voices.en?.[p];
    try {
      delete lastKey[KEYENV[p]];
      const lines = [];
      for (const x of todo) {
        try { lines.push({ n: x.n, start: x.start, end: x.end, file: await synthLine(p, x.narration.trim(), voice, lang, speed, dir) }); }
        catch (e) { if (p !== 'kokoro') throw e; console.warn(`scene ${x.n}: voice failed ${e.message}`); } // Kokoro: skip the line, as before
      }
      const key = lastKey[KEYENV[p]];
      return { lines, used: { provider: p, voice, lang, speed, key: key ? '••••' + key.slice(-4) : null } };
    } catch (e) {
      // one provider per video: any failed line → every line again with the next provider
      log(`voice: ${NAMES[p]} failed (${String(e.message).slice(0, 160)})${chain[i + 1] ? `, switching to ${NAMES[chain[i + 1]]}` : ''}`);
    }
  }
  throw new Error('no voice-over provider worked');
}
