// API key stacks per provider, same format as sandekala (keys can be copied between projects):
//   <kit>/.env       → <ENV>, <ENV>_2, <ENV>_3 ... (number order = priority)
//   <kit>/.keys.json → { <id>: { label, disabled, day, used, spent[], until, error } }, id = first 12 hex of sha256(key). Never the key itself.
// Keys are read from the .env FILE when needed and never put in process.env, so they don't leak into the child `claude` env (agent.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const ENV_FILE = process.env.VS_ENV_FILE || path.join(KIT, '.env');
const STATE = process.env.VS_KEYS_FILE || path.join(KIT, '.keys.json');

export const PROVIDERS = [
  { env: 'GEMINI_API_KEY', name: 'Google Gemini', use: 'Main TTS (Charon voice)', url: 'https://aistudio.google.com/apikey',
    test: (k) => fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', { headers: { 'x-goog-api-key': k } }) },
  { env: 'ELEVENLABS_API_KEY', name: 'ElevenLabs', use: 'Backup TTS', url: 'https://elevenlabs.io/app/settings/api-keys',
    test: (k) => fetch('https://api.elevenlabs.io/v1/user', { headers: { 'xi-api-key': k } }) },
  { env: 'FISH_API_KEY', name: 'Fish Audio', use: 'Backup TTS', url: 'https://fish.audio/app/api-keys',
    test: (k) => fetch('https://api.fish.audio/model?page_size=1&self=true', { headers: { Authorization: `Bearer ${k}` } }) },
  { env: 'EDGE_TTS_KEY', name: 'Edge TTS (ai.adzibilal.my.id)', use: 'Backup TTS',
    test: (k) => fetch('https://ai.adzibilal.my.id/v1/models', { headers: { Authorization: `Bearer ${k}` } }) },
  { env: 'REPLIZ_ACCESS_KEY', name: 'Repliz Access Key', use: 'Social media scheduling', url: 'https://docs.repliz.com/api/quick-start.html',
    test: (k) => { const s = keysFor('REPLIZ_SECRET_KEY')[0]; return s ? fetch('https://api.repliz.com/public/account?page=1&limit=1', { headers: { Authorization: `Basic ${Buffer.from(`${k}:${s}`).toString('base64')}` } }) : { ok: false, skipSave: true, msg: 'Add REPLIZ_SECRET_KEY first to test' }; } },
  { env: 'REPLIZ_SECRET_KEY', name: 'Repliz Secret Key', use: 'Social media scheduling', url: 'https://docs.repliz.com/api/quick-start.html',
    test: (k) => { const a = keysFor('REPLIZ_ACCESS_KEY')[0]; return a ? fetch('https://api.repliz.com/public/account?page=1&limit=1', { headers: { Authorization: `Basic ${Buffer.from(`${a}:${k}`).toString('base64')}` } }) : { ok: false, skipSave: true, msg: 'Add REPLIZ_ACCESS_KEY first to test' }; } },
];

export const keyId = (key) => createHash('sha256').update(key).digest('hex').slice(0, 12);
// ponytail: one reset time for every provider (midnight Pacific = Gemini's daily quota reset), same as sandekala.
export const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
const loadState = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return {}; } };
const saveState = (s) => fs.writeFileSync(STATE, JSON.stringify(s, null, 1) + '\n', { mode: 0o600 });

const LINE = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;
const unquote = (v) => v.trim().replace(/^(['"])(.*)\1$/, '$2');
const readEnv = (file = ENV_FILE) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/) : []);
const baseOf = (name) => name.replace(/_\d+$/, '');
const numOf = (name) => +(name.match(/_(\d+)$/)?.[1] ?? 1);
const inStack = (name, env) => baseOf(name) === env && (name === env || /_\d+$/.test(name));

/** All key values of one provider (duplicates and disabled ones included), priority order. Server/stitch only. */
function values(env, file) {
  return readEnv(file).map((l) => l.match(LINE)).filter((m) => m && inStack(m[1], env) && unquote(m[2]))
    .sort((a, b) => numOf(a[1]) - numOf(b[1])).map((m) => unquote(m[2]));
}

/** Rewrite one provider's stack as ENV, ENV_2, ... without touching any other line. */
function writeStack(env, vals) {
  const kept = []; let at = -1;
  for (const l of readEnv()) { const m = l.match(LINE); if (m && inStack(m[1], env)) { if (at < 0) at = kept.length; continue; } kept.push(l); }
  const block = vals.map((v, i) => `${i ? `${env}_${i + 1}` : env}=${v}`);
  if (at < 0) { while (kept.length && kept.at(-1) === '') kept.pop(); kept.push(...block, ''); } else kept.splice(at, 0, ...block);
  fs.writeFileSync(ENV_FILE, kept.join('\n'), { mode: 0o600 }); fs.chmodSync(ENV_FILE, 0o600);
}

/** Active keys of one provider, priority order; duplicates and disabled keys skipped. */
export function keysFor(env) {
  const st = loadState();
  return values(env).filter((v, i, all) => all.indexOf(v) === i && !st[keyId(v)]?.disabled);
}

/** Record use of a key. spent = scope (e.g. a model) whose daily quota is gone; until = ms when a per-minute limit ends. */
export function note(key, { used = 0, spent, until, error } = {}) {
  const st = loadState(), id = keyId(key), day = today();
  const e = st[id]?.day === day ? st[id] : { label: st[id]?.label, disabled: st[id]?.disabled, day, used: 0, spent: [] };
  e.used += used;
  if (spent && !e.spent.includes(spent)) e.spent.push(spent);
  if (until) e.until = until;
  if (error !== undefined) e.error = error || undefined;
  st[id] = e; saveState(st);
}
export const isSpent = (key, scope) => { const e = loadState()[keyId(key)]; return e?.day === today() && !!e.spent?.includes(scope); };
export const scrub = (text, key) => String(text).split(key).join('••••').replace(/\s+/g, ' ').slice(0, 200);
const retryDelay = (res, text) => { // seconds, from Gemini's error.details[].retryDelay or a Retry-After header
  const m = text.match(/"retryDelay"\s*:\s*"([\d.]+)s"/); if (m) return +m[1];
  const h = res.headers.get('retry-after'); return h && /^\d+$/.test(h) ? +h : null;
};
export const lastKey = {}; // env → last key that worked (only its tail is ever shown)

/**
 * One request with key rotation: fn(key) → Response. One attempt per key, then the next key:
 *   401/403 (or 400 "API key not valid") → key marked invalid;  402, or 429 with a long/unknown wait → quota spent for today (scope);
 *   429 with retryDelay ≤ 120 s → per-minute limit: key waits (other keys go first; if all wait, sleep until the first is free);
 *   anything else → stop (not the key's fault).
 */
export async function withKey(env, scope, fn) {
  let last; const out = new Set();
  for (let guard = 0; guard < 60; guard++) {
    const st = loadState(), until = (k) => st[keyId(k)]?.until ?? 0;
    const live = keysFor(env).filter((k) => !out.has(k) && !isSpent(k, scope)).sort((a, b) => until(a) - until(b));
    if (!live.length) break;
    const key = live[0], wait = until(key) - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const res = await fn(key);
    if (res.ok) { note(key, { used: 1, error: '' }); lastKey[env] = key; return res; }
    const text = await res.text(); last = `${env} ${res.status}: ${scrub(text, key)}`;
    const d = res.status === 429 ? retryDelay(res, text) : null;
    if (d !== null && d <= 120) { note(key, { until: Date.now() + (d + 1) * 1000 }); continue; }
    const invalid = res.status === 401 || res.status === 403 || (res.status === 400 && /api[_ ]?key/i.test(text));
    if (!invalid && ![402, 429].includes(res.status)) break;
    note(key, invalid ? { error: last } : { spent: scope }); out.add(key);
  }
  throw new Error(last ?? `no usable ${env} key`);
}

// ---------- for the Settings UI: never returns a key value (only the last 4 characters) ----------
export function listKeys() {
  const st = loadState(), day = today();
  const envs = new Set(PROVIDERS.map((p) => p.env));
  for (const l of readEnv()) { const m = l.match(LINE); if (m && /(_API_KEY|_KEY|_TOKEN)(_\d+)?$/.test(m[1])) envs.add(baseOf(m[1])); }
  return [...envs].map((env) => {
    const p = PROVIDERS.find((x) => x.env === env), vals = values(env);
    return { env, name: p?.name ?? env, use: p?.use ?? 'Other', url: p?.url, testable: !!p?.test,
      keys: vals.map((v, i) => { const id = keyId(v), e = st[id] ?? {}, fresh = e.day === day;
        return { id, tail: v.slice(-4), label: e.label ?? '', disabled: !!e.disabled, used: fresh ? e.used ?? 0 : 0, spent: fresh ? e.spent ?? [] : [],
          limitedUntil: e.until && e.until > Date.now() ? e.until : undefined, error: e.error, duplicate: vals.indexOf(v) !== i }; }) };
  });
}
const valid = (env) => { if (!/^[A-Z][A-Z0-9_]*$/.test(env || '') || /_\d+$/.test(env)) throw new Error('Variable name: capitals, digits and _ (no _2 suffix)'); };
const allIds = () => new Set(listKeys().flatMap((p) => p.keys.map((k) => k.id)));

export function addKey(env, value, label = '') {
  valid(env); value = String(value || '').trim();
  if (!value || /\s/.test(value)) throw new Error('The key is empty or has spaces');
  const id = keyId(value);
  const owner = listKeys().find((p) => p.keys.some((k) => k.id === id)); if (owner) throw new Error(`This key is already in ${owner.name}`);
  writeStack(env, [...values(env), value]);
  const st = loadState(); st[id] = { ...st[id], label: String(label).trim() || undefined }; saveState(st);
}
export function removeKey(env, id) {
  valid(env); writeStack(env, values(env).filter((v) => keyId(v) !== id));
  const st = loadState(); delete st[id]; saveState(st);
}
export function reorderKeys(env, ids) {
  valid(env); const vals = values(env);
  const sorted = ids.map((id) => vals.find((v) => keyId(v) === id)).filter(Boolean);
  if (sorted.length !== vals.length) throw new Error('The key list changed, reload the page');
  writeStack(env, sorted);
}
export function updateKey(id, patch = {}) {
  const st = loadState(), e = { ...st[id] };
  if (patch.label !== undefined) e.label = String(patch.label).trim() || undefined;
  if (patch.disabled !== undefined) e.disabled = !!patch.disabled || undefined;
  if (patch.reset) { e.spent = []; e.until = undefined; e.error = undefined; }
  st[id] = e; saveState(st);
}
export async function testKey(env, id) {
  const p = PROVIDERS.find((x) => x.env === env), v = values(env).find((x) => keyId(x) === id);
  if (!p?.test || !v) throw new Error('This key cannot be tested');
  let r;
  try { r = await p.test(v); } catch (e) { return { ok: false, msg: `could not reach ${p.name} (${scrub(e.message, v)}). The key was not checked.` }; } // network trouble says nothing about the key
  if (r && typeof r.text !== 'function') {
    const ok = !!r.ok, msg = r.msg || (ok ? 'Key works' : 'Cannot test');
    if (!r.skipSave) { const st = loadState(); st[id] = { ...st[id], error: ok ? undefined : msg }; saveState(st); }
    return { ok, msg };
  }
  const text = r.ok ? '' : await r.text();
  // a key limited to some scopes (e.g. ElevenLabs TTS-only) is still a working key: the provider recognised it
  const limited = !r.ok && /missing_permissions/.test(text);
  const ok = r.ok || limited, msg = r.ok ? 'Key works' : limited ? 'Key works (limited permissions)' : `${r.status}: ${scrub(text, v)}`;
  const st = loadState(); st[id] = { ...st[id], error: ok ? undefined : msg };
  if (ok && (env === 'REPLIZ_ACCESS_KEY' || env === 'REPLIZ_SECRET_KEY')) {
    const pairEnv = env === 'REPLIZ_ACCESS_KEY' ? 'REPLIZ_SECRET_KEY' : 'REPLIZ_ACCESS_KEY';
    const pair = keysFor(pairEnv)[0];
    if (pair && st[keyId(pair)]?.error) st[keyId(pair)] = { ...st[keyId(pair)], error: undefined };
  }
  saveState(st);
  return { ok, msg };
}
/** Copy keys from another .env (e.g. sandekala's) that are not here yet. Returns counts only. */
export function importFrom(file) {
  file = String(file || '').replace(/^~(?=\/)/, process.env.HOME || '~');
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error('File not found: ' + file);
  const have = allIds(); let added = 0, skipped = 0;
  const envs = new Set(readEnv(file).map((l) => l.match(LINE)).filter((m) => m && /(_API_KEY|_KEY|_TOKEN)(_\d+)?$/.test(m[1])).map((m) => baseOf(m[1])));
  for (const env of envs) for (const v of values(env, file)) {
    if (have.has(keyId(v)) || /\s/.test(v)) { skipped++; continue; }
    writeStack(env, [...values(env), v]); have.add(keyId(v)); added++;
  }
  return { added, skipped };
}
