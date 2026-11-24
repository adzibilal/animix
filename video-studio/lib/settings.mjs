// Non-secret defaults for Video Studio (video-studio/settings.json, gitignored). Keys live in .env, never here.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'settings.json');
export const DEFAULTS = {
  priority: ['gemini', 'elevenlabs', 'fish', 'edge', 'kokoro'], // order for provider "auto"
  provider: 'auto', lang: 'id', speed: 1,
  voices: { // default voice per language per provider
    id: { gemini: 'Charon', elevenlabs: 'TX3LPaxmHKxFdv7VOQHJ', fish: '1e19ed6473594e06b847175f59fa8b33', edge: 'id-ID-ArdiNeural' },
    en: { gemini: 'Charon', elevenlabs: 'TX3LPaxmHKxFdv7VOQHJ', fish: 'bf322df2096a46f18c579d0baa36f41d', edge: 'en-US-GuyNeural', kokoro: 'am_michael' },
  },
  musicVolume: 0.22, ducking: false, format: '9:16', style: null, music: 'lofi',
  folders: [], // dashboard folder names, in order (a project's own folder is project.json → folder)
  presets: [], // format references for new videos: [{ id, name, transcript }] (a transcript of a video whose format you like)
  // the agent CLI that writes (ideas, scripts) and builds the video, like Mochi Studio; models '' = the account's default
  ai: { agent: 'claude', claude: { script: '', build: 'opus' }, cursor: { script: '', build: '' } },
};
/** voice block for a new project, from the defaults (voice-over stays off until the user turns it on). */
export const newVoice = (s = getSettings()) => ({ on: false, provider: s.provider, lang: s.lang, voice: '', speed: s.speed });
export function getSettings() {
  let s = {}; try { s = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch {}
  const voices = { ...DEFAULTS.voices }; for (const [l, v] of Object.entries(s.voices || {})) voices[l] = { ...voices[l], ...v };
  const ai = { ...DEFAULTS.ai, ...s.ai }; for (const a of ['claude', 'cursor']) ai[a] = { ...DEFAULTS.ai[a], ...s.ai?.[a] };
  if (s.scriptModel && !s.ai) ai.claude.script = s.scriptModel; // the older single setting
  return { ...DEFAULTS, ...s, voices, ai };
}
const MODEL = /^(?!-)[\w.:\[\]=,-]{0,80}$/; // model ids go to the CLI as an argument: never let one look like a flag
export function putSettings(patch) {
  if (patch.ai) {
    const a = patch.ai; if (!['claude', 'cursor'].includes(a.agent)) throw new Error('Unknown agent');
    for (const k of ['claude', 'cursor']) for (const m of ['script', 'build']) if (!MODEL.test(String(a[k]?.[m] ?? ''))) throw new Error('That model name is not valid');
  }
  const s = { ...getSettings(), ...patch };
  for (const k of Object.keys(s)) if (!(k in DEFAULTS)) delete s[k];
  fs.writeFileSync(FILE, JSON.stringify(s, null, 2) + '\n');
  return getSettings();
}
