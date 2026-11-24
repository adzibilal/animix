// Self-check for key rotation + provider fallback (mock fetch, temp .env). Run: node video-studio/lib/tts.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-tts-'));
process.env.VS_ENV_FILE = path.join(T, '.env'); process.env.VS_KEYS_FILE = path.join(T, '.keys.json');
fs.writeFileSync(process.env.VS_ENV_FILE, 'OTHER=1\nGEMINI_API_KEY=g1\nGEMINI_API_KEY_2=g2\nGEMINI_API_KEY_3=g1\nELEVENLABS_API_KEY=e1\n');
const { synthProject } = await import('./tts.mjs');
const keys = await import('./keys.mjs');

const wav = execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=d=0.3', '-f', 'wav', '-']);
const mp3 = execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=d=0.3', '-f', 'mp3', '-']);
const geminiOk = () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/wav', data: wav.toString('base64') } }] } }] }));
const err = (status, body = '{}') => new Response(body, { status });
let calls = [], plan;
globalThis.fetch = async (url, o) => { const k = o.headers['x-goog-api-key'] ?? o.headers['xi-api-key']; calls.push(k); return plan(k, url); };
const scenes = [{ n: 1, start: 0, end: 3, narration: 'satu' }, { n: 2, start: 3, end: 6, narration: 'dua' }];
const cfg = { on: true, provider: 'auto', lang: 'id', voice: '', speed: 1 };

// 1. g1 daily quota gone (429, long wait) → g2 serves every line; g1 tried once, its duplicate never
plan = (k) => (k === 'g1' ? err(429, '{"error":{"details":[{"retryDelay":"3600s"}]}}') : geminiOk());
let r = await synthProject(scenes, cfg, path.join(T, 'a'), () => {});
assert.equal(r.used.provider, 'gemini'); assert.equal(r.used.key, '••••g2');
assert.deepEqual(calls, ['g1', 'g2', 'g2']);

// 2. every Gemini key out (402), both models → ElevenLabs redoes ALL lines (one provider per video)
fs.writeFileSync(process.env.VS_KEYS_FILE, '{}'); calls = []; const logs = [];
plan = (k) => (k === 'e1' ? new Response(mp3) : err(402));
r = await synthProject(scenes, cfg, path.join(T, 'b'), (m) => logs.push(m));
assert.equal(r.used.provider, 'elevenlabs'); assert.equal(r.lines.length, 2);
assert.deepEqual(calls, ['g1', 'g2', 'g1', 'g2', 'e1', 'e1']); // one try per key per model, no retries
assert.match(logs[0], /Gemini failed .*switching to ElevenLabs/);

// 3. 401 → key marked invalid; Gemini mid-video failure → no mixing: provider 2 voices every line
fs.writeFileSync(process.env.VS_KEYS_FILE, '{}'); calls = []; let n = 0;
plan = (k) => (k === 'e1' ? new Response(mp3) : k === 'g1' ? err(401, 'bad g1') : n++ ? err(500) : geminiOk());
r = await synthProject(scenes, cfg, path.join(T, 'c'), () => {});
assert.equal(r.used.provider, 'elevenlabs'); assert.equal(r.lines.length, 2);
const st = keys.listKeys().find((p) => p.env === 'GEMINI_API_KEY').keys;
assert.match(st[0].error, /401/); assert.equal(st[2].duplicate, true);
assert.ok(!st[0].error.includes('g1'), 'key scrubbed from provider errors');

// 4. per-minute limit (429, 1 s) → wait, don't spend the key
fs.writeFileSync(process.env.VS_KEYS_FILE, '{}'); fs.writeFileSync(process.env.VS_ENV_FILE, 'GEMINI_API_KEY=g1\n'); calls = []; n = 0;
plan = () => (n++ ? geminiOk() : err(429, '{"error":{"details":[{"retryDelay":"0s"}]}}'));
r = await synthProject([scenes[0]], { ...cfg, provider: 'gemini' }, path.join(T, 'd'), () => {});
assert.deepEqual(calls, ['g1', 'g1']); assert.equal(keys.isSpent('g1', 'gemini-3.8-flash-tts'), false);

// 5. env file: other lines untouched, add/reorder/remove, import dedups
fs.writeFileSync(process.env.VS_ENV_FILE, 'OTHER=1\nGEMINI_API_KEY=g1\n');
keys.addKey('GEMINI_API_KEY', 'g2'); assert.throws(() => keys.addKey('FISH_API_KEY', 'g2'));
const [a, b] = keys.listKeys()[0].keys.map((k) => k.id); keys.reorderKeys('GEMINI_API_KEY', [b, a]);
assert.equal(fs.readFileSync(process.env.VS_ENV_FILE, 'utf8'), 'OTHER=1\nGEMINI_API_KEY=g2\nGEMINI_API_KEY_2=g1\n');
fs.writeFileSync(path.join(T, 'other.env'), 'GEMINI_API_KEY=g1\nFISH_API_KEY=f1\nNOT_A_SECRET=x\n');
assert.deepEqual(keys.importFrom(path.join(T, 'other.env')), { added: 1, skipped: 1 });
keys.removeKey('GEMINI_API_KEY', a);
assert.equal(fs.readFileSync(process.env.VS_ENV_FILE, 'utf8'), 'OTHER=1\nGEMINI_API_KEY=g2\nFISH_API_KEY=f1\n');
assert.equal(fs.statSync(process.env.VS_ENV_FILE).mode & 0o777, 0o600);

fs.rmSync(T, { recursive: true });
console.log('tts + keys: ok');
