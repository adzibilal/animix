// Runs Claude Code headless (your subscription) for the Video Studio UI:
//   writeScript(prompt, format) → a new project with title + second-by-second scenes, status "script-ready"
//   buildProject(slug, opts)   → queued; Claude renders the scenes that have no clip yet, then the studio stitches final.mp4
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { newVoice, getSettings } from './lib/settings.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const BUILD = path.resolve(ROOT, '..');
const PROJECTS = path.join(ROOT, 'projects');
// Which agent CLI does the work (Settings → AI agent), like Mochi Studio: Claude Code or Cursor, each on its own subscription login.
export const AGENTS = {
  claude: { name: 'Claude Code', bin: 'claude', login: 'claude auth login' },
  cursor: { name: 'Cursor', bin: 'cursor-agent', login: 'cursor-agent login' },
};
/** { agent, name, bin, script, build }: models '' = the account's default. For Claude the env VS_SCRIPT_MODEL / VS_BUILD_MODEL still win. */
function ai() {
  const s = getSettings().ai, agent = AGENTS[s.agent] ? s.agent : 'claude', m = s[agent] || {};
  return agent === 'claude'
    ? { agent, ...AGENTS.claude, script: process.env.VS_SCRIPT_MODEL ?? m.script ?? '', build: process.env.VS_BUILD_MODEL ?? m.build ?? 'opus' }
    : { agent, ...AGENTS.cursor, script: m.script || '', build: m.build || '' };
}
const modelFlag = (m) => (m ? ['--model', m] : []);
const now = () => new Date().toISOString();
const pfile = (slug) => path.join(PROJECTS, slug, 'project.json');
export const load = (slug) => JSON.parse(fs.readFileSync(pfile(slug), 'utf8'));
export const save = (p) => { fs.mkdirSync(path.join(PROJECTS, p.slug), { recursive: true }); const f = pfile(p.slug), t = f + '.tmp'; p.updatedAt = now(); fs.writeFileSync(t, JSON.stringify(p, null, 2)); fs.renameSync(t, f); return p; };
const update = (slug, fn) => { const p = load(slug); fn(p); return save(p); };
const logTo = (slug, text) => update(slug, (p) => { p.log.push({ at: now(), text }); if (p.log.length > 400) p.log.splice(0, p.log.length - 400); });

const running = new Map(); // slug -> child process
export const isRunning = (slug) => running.has(slug);

function emptyMcp() {
  const f = path.join(ROOT, '.empty-mcp.json');
  if (!fs.existsSync(f)) fs.writeFileSync(f, '{"mcpServers":{}}');
  return f;
}

function catalogSummary() {
  const c = JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog.json'), 'utf8'));
  return c.tools.map((t) => `- ${t.id} (${t.name}): ${t.what} Speed: ${t.speed || '?'}. Styles: ${t.styles.map((s) => `${t.id}/${s.id} = ${s.name}`).join('; ')}`).join('\n');
}

const MUSIC = { type: 'string', enum: ['lofi', 'ambient', 'upbeat', 'epic', 'none'] };
const SCENES = { type: 'array', items: { type: 'object', additionalProperties: false, required: ['n', 'start', 'end', 'tool', 'visual', 'narration', 'onscreen', 'sound'],
  properties: { n: { type: 'integer' }, start: { type: 'number' }, end: { type: 'number' }, tool: { type: 'string' }, visual: { type: 'string' }, narration: { type: 'string' }, onscreen: { type: 'string' }, sound: { type: 'string' } } } };
const SCENE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['title', 'slug', 'format', 'scenes'],
  properties: { title: { type: 'string' }, slug: { type: 'string' }, format: { type: 'string', enum: ['9:16', '16:9', '1:1'] }, music: MUSIC, scenes: SCENES },
};
const IDEAS_SCHEMA = { type: 'object', additionalProperties: false, required: ['ideas'], properties: { ideas: { type: 'array', items: {
  type: 'object', additionalProperties: false, required: ['title', 'logline', 'hook'], properties: { title: { type: 'string' }, logline: { type: 'string' }, hook: { type: 'string' } } } } } };
const SERIES_SCHEMA = { type: 'object', additionalProperties: false, required: ['bible', 'parts'], properties: {
  bible: { type: 'object', additionalProperties: false, required: ['logline', 'characters', 'rules', 'motifs'], properties: { logline: { type: 'string' }, characters: { type: 'string' }, rules: { type: 'string' }, motifs: { type: 'string' } } },
  parts: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['title', 'music', 'scenes'], properties: { title: { type: 'string' }, music: MUSIC, scenes: SCENES } } } } };
const SOCIAL_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['title', 'description', 'hashtags', 'tags', 'firstComment', 'topic'],
  properties: {
    title: { type: 'string' },
    description: { type: 'string' },
    hashtags: { type: 'array', items: { type: 'string' } },
    tags: { type: 'array', items: { type: 'string' } },
    firstComment: { type: 'string' },
    topic: { type: 'string' },
  },
};
const LANG = { id: 'Bahasa Indonesia (casual, natural, spoken)', en: 'English' };

/** Run an agent CLI (claude or cursor-agent) that prints JSON lines; resolves with its "result" event. */
function spawnAgent(bin, args, input, { cwd, onEvent }) {
  const NAME = bin === 'claude' ? 'Claude Code' : 'Cursor';
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'], env: { ...cleanEnv(), NO_OPEN_BROWSER: '1', TVHEAD_STUDIO: path.join(BUILD, 'studio'), HYPERFRAMES_NO_TELEMETRY: '1', DO_NOT_TRACK: '1' } });
    let buf = '', result = null, err = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      buf += d; let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line) continue;
        try { const ev = JSON.parse(line); if (ev.type === 'result') result = ev; else onEvent?.(ev); } catch { /* not json */ }
      }
    });
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => reject(new Error(`could not start ${NAME}: ` + e.message)));
    child.on('close', () => {
      if (!result && buf.trim()) { try { result = JSON.parse(buf.trim()); } catch {} }
      if (!result) return reject(new Error(`${NAME} stopped without a result. ` + err.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').slice(-400)));
      if (result.is_error) return reject(new Error(`${NAME}: ` + result.result));
      resolve(result);
    });
    child.stdin.end(input);
    resolve.child = child;
    onEvent?.({ type: '_spawned', child });
  });
}

// like Mochi Studio: always the local CLI login (subscription), never an API key that happens to be in the env
function cleanEnv() {
  const e = { ...process.env };
  for (const k of Object.keys(e)) if (/^(CLAUDECODE|CLAUDE_CODE_|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CURSOR_API_KEY)/.test(k)) delete e[k];
  return e;
}

// ---------- Settings → AI agent: login status + model lists ----------
// ponytail: Claude Code has no "list models" command, so Claude gets its documented aliases (always the newest) + current full ids; Cursor's list is fetched live.
const CLAUDE_MODELS = [['', 'Account default'], ['opus', 'Opus (newest)'], ['sonnet', 'Sonnet (newest)'], ['haiku', 'Haiku (newest)'],
  ['claude-opus-5-5', 'Claude Opus 5.5'], ['claude-sonnet-5-5', 'Claude Sonnet 5.5'], ['claude-haiku-5-5', 'Claude Haiku 5.5'], ['claude-fable-5-2', 'Claude Fable 5.2']].map(([id, name]) => ({ id, name }));
const execOut = (bin, args) => new Promise((resolve, reject) => execFile(bin, args, { timeout: 45000, cwd: os.tmpdir(), env: { ...cleanEnv(), NO_OPEN_BROWSER: '1' }, maxBuffer: 4 << 20 },
  (e, stdout) => (e ? reject(e) : resolve(String(stdout).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/[​-‍]/g, '')))));
let cursorModels = null; // { at, list }
export async function agentInfo(refresh = false) {
  const fail = (e) => ({ installed: e.code !== 'ENOENT', loggedIn: false, detail: e.code === 'ENOENT' ? 'Not installed' : 'Could not read the login status' });
  const claude = execOut('claude', ['auth', 'status']).then((o) => { const j = JSON.parse(o); // only the plan is passed on, never the account e-mail
    return { installed: true, loggedIn: !!j.loggedIn, detail: j.loggedIn ? `${j.authMethod === 'claude.ai' ? 'Subscription login' : j.authMethod}${j.subscriptionType ? ` · ${j.subscriptionType} plan` : ''}` : 'Not logged in' }; }, fail);
  const cursor = execOut('cursor-agent', ['status']).then((o) => { const ok = /Logged in/i.test(o), team = o.match(/Team: ([^(\n]+)/)?.[1]?.trim();
    return { installed: true, loggedIn: ok, detail: ok ? `Subscription login${team ? ` · team ${team}` : ''}` : 'Not logged in' }; }, fail);
  const [c, k] = await Promise.all([claude, cursor]);
  let list = cursorModels?.list, error;
  if (k.loggedIn && (refresh || !list || Date.now() - cursorModels.at > 10 * 60e3)) {
    try {
      list = (await execOut('cursor-agent', ['models'])).split('\n').map((l) => l.match(/^(\S+) - (.+)$/)).filter(Boolean).map((m) => ({ id: m[1], name: m[2].trim() }));
      cursorModels = { at: Date.now(), list };
    } catch (e) { error = 'Could not fetch the models: ' + String(e.message).slice(0, 160); }
  }
  return {
    claude: { ...AGENTS.claude, ...c, models: CLAUDE_MODELS, fetched: false },
    cursor: { ...AGENTS.cursor, ...k, models: [{ id: '', name: 'Account default' }, ...(list || []).filter((m) => m.id !== '')], fetched: !!list, error },
  };
}
const leanFlags =() => ['--no-session-persistence', '--strict-mcp-config', '--mcp-config', emptyMcp(), '--setting-sources', '', '--disable-slash-commands'];

function styleInfo(style) {
  const c = JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog.json'), 'utf8'));
  const [tid, sid] = String(style || '').split('/');
  const tool = c.tools.find((t) => t.id === tid), st = tool?.styles.find((s) => s.id === sid);
  if (!st) throw new Error('Pick a style on the left first');
  return { tool, styleName: st.name === tool.name ? tool.name : `${st.name} (${tool.name})` };
}
const slugBase = (text) => String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30).replace(/-$/, '') || 'video';
const freeSlug = (base, taken = () => false) => { let s = base, k = 2; while (fs.existsSync(pfile(s)) || taken(s)) s = `${base}-${k++}`; return s; };
/** One structured answer (ideas, scripts, captions). Claude: --json-schema, no tools. Cursor: read-only "ask" mode in an empty folder, schema in the prompt, JSON cut out of the answer (one retry). */
async function run(system, input, schema) {
  const a = ai();
  if (a.agent === 'claude') {
    const r = await spawnAgent('claude', ['-p', ...modelFlag(a.script), '--output-format', 'json', '--tools', '', '--system-prompt', system, '--json-schema', JSON.stringify(schema), ...leanFlags()], input, { cwd: ROOT });
    return r.structured_output || JSON.parse(r.result);
  }
  const cwd = path.join(ROOT, '.cache', 'agent-empty'); fs.mkdirSync(cwd, { recursive: true });
  const ask = `${system}\n\n${input}\n\nAnswer with ONLY one JSON object (no prose, no code fences) that matches this JSON Schema:\n${JSON.stringify(schema)}`;
  for (const extra of ['', '\n\nYour previous answer was not a valid JSON object for that schema. Return only the JSON object.']) {
    const r = await spawnAgent('cursor-agent', ['-p', ask + extra, '--output-format', 'json', '--trust', '--mode', 'ask', ...modelFlag(a.script)], '', { cwd });
    try { const t = String(r.result), d = JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1)); if (schema.required.every((k) => k in d)) return d; } catch {}
  }
  throw new Error('Cursor did not return the JSON that was asked for');
}

// a transcript of another video the user likes (a "preset"): Claude copies its FORMAT, never its topic or lines
const cleanRef = (t) => String(t || '').replace(/\[[^\]]*\]\s*/g, '').replace(/\s+/g, ' ').trim().slice(0, 12000);
const refBlock = (ref) => !ref ? '' : `\n\nFORMAT REFERENCE, the transcript of another video the user likes:\n\"\"\"${ref}\"\"\"\nCopy its format: the kind of hook, the point of view and how it talks to the viewer, the beat-by-beat structure, sentence length and rhythm, recurring phrases and the way it ends. Do NOT copy its topic, facts or sentences.\n`;

/** Title ideas for a new video (synchronous, ~10-30 s). */
export async function ideas({ topic = '', style, lang = 'id', count = 5, avoid = [], reference = '' }) {
  const { tool, styleName } = styleInfo(style), ref = cleanRef(reference);
  const seen = [...fs.readdirSync(PROJECTS).filter((d) => fs.existsSync(pfile(d))).map((d) => load(d).series?.title || load(d).title), ...avoid];
  const input = `Give ${count} different ideas for a short vertical video${topic ? ` about: """${topic}"""` : ` (any topic that fits ${ref ? 'the format reference below and ' : ''}the style)`}.
Visual style: ${styleName}. ${tool.what}
Write everything in ${LANG[lang] || lang}.
- title: short and catchy (max 7 words), no "(Part N)".
- logline: one sentence, what happens.
- hook: the first spoken line, it must stop the scroll in 2 seconds.
Make the ideas clearly different from each other${seen.length ? ` and from these existing titles: ${[...new Set(seen)].slice(0, 40).join(' | ')}` : ''}.${ref ? ' Every idea must fit the format of the reference (same kind of title and hook), on a new topic.' : ''}${refBlock(ref)}`;
  return (await run('You are a short-form video creator who writes viral, original ideas. Return only the JSON requested.', input, IDEAS_SCHEMA)).ideas.slice(0, count);
}

/**
 * The wizard's "Generate script": one project per part. Series bible + all parts are written in ONE run so they stay consistent (like Mochi Studio).
 * Returns the slugs right away; the parts move from "writing-script" to "script-ready" (or "error").
 */
export function writeSeries({ title, logline = '', topic = '', style, lang = 'id', parts = 1, seconds = 0, format = '9:16', voice = {}, music = 'auto', reference = '', referenceName = '', folder }) {
  title = String(title || '').trim(); if (!title) throw new Error('Pick or write a title');
  const { tool, styleName } = styleInfo(style), n = Math.max(1, Math.min(10, Math.round(+parts) || 1));
  const base = slugBase(title), slugs = [];
  for (let i = 1; i <= n; i++) slugs.push(freeSlug(n > 1 ? `${base}-part-${i}` : base, (s) => slugs.includes(s)));
  const vo = { ...newVoice(), ...voice, lang }, ref = cleanRef(reference);
  const targetSeconds = Math.max(0, Math.min(900, Math.round(+seconds) || 0));
  folder = String(folder ?? (n > 1 ? title : '')).trim().slice(0, 60); // the parts of a series land in their own folder
  slugs.forEach((slug, i) => save({ slug, title: n > 1 ? `${title} (Part ${i + 1})` : title, idea: [logline, topic].filter(Boolean).join('\n\n'), folder, style, styleName, format, ...(targetSeconds ? { targetSeconds } : {}), voice: vo,
    music: music === 'auto' ? 'lofi' : music, ...(n > 1 && { series: { id: slugs[0], title, part: i + 1, of: n, slugs } }), ...(ref && { reference: { name: String(referenceName || 'Reference').slice(0, 80), text: ref } }), status: 'writing-script', scenes: [], notes: [],
    log: [{ at: now(), text: `${ai().name} is writing ${n > 1 ? `part ${i + 1} of ${n}` : 'the script'} in ${styleName}…` }], final: null, createdAt: now() }));
  const len = targetSeconds ? `about ${targetSeconds} s (±10 s)` : ref ? `close to the reference (about ${Math.round(ref.split(' ').length / 2.6)} s)` : '20-45 s';
  const sceneLen = targetSeconds >= 100 ? '4-10 s' : '2-6 s';
  const next = lang === 'id' ? '"Lanjut part 2…"' : '"Part 2 next…"';
  const input = `Write ${n > 1 ? `a ${n}-part series` : 'one short video'} titled "${title}".${logline ? `\nLogline: ${logline}` : ''}${topic ? `\nThe user's brief: """${topic}"""` : ''}
Format: ${format}. Visual style for every scene: ${styleName}, tool id "${style}". About it: ${tool.what}
Design every scene for what this style does well.${refBlock(ref)}
Language: all narration and on-screen text in ${LANG[lang] || lang}. visual and sound descriptions in English.

First the bible (logline, characters, world rules, recurring motifs) so everything stays consistent. Then parts: exactly ${n}, in order.
Each part:
- title: ${n > 1 ? `"${title} (Part N)"` : `"${title}"`}. music: lofi/ambient/upbeat/epic/none.
- length ${len}; scenes of ${sceneLen}, contiguous from 0, one picture each.
- a strong hook in the first 2 s (a question, a shock or a promise).
${n > 1 ? `- every part except the last ends on a cliffhanger and a short line teasing the next part (like ${next}); the last part pays everything off and ends the story. Later parts may open with a one-line recap at most.\n` : ''}- visual: exactly what we see (subject, action, framing), concrete enough to animate.
- narration: what the voice says, at most 2.4 words per second of the scene ("" for a silent beat).
- onscreen: text burned into the picture ("" if none). sound: the sound moment. tool: always "${style}".`;
  (async () => {
    try {
      const d = await run('You are a short-form video director and serial storyteller. You turn an idea into scripts told scene by scene, second by second. Return only the JSON requested.', input, SERIES_SCHEMA);
      if (d.parts.length < n) throw new Error(`Claude wrote ${d.parts.length} of ${n} parts`);
      slugs.forEach((slug, i) => update(slug, (p) => {
        const x = d.parts[i];
        if (n > 1) { p.title = x.title || p.title; p.series.bible = d.bible; }
        if (music === 'auto') p.music = x.music || 'lofi';
        p.scenes = x.scenes.map((s, k) => ({ ...s, tool: style, n: k + 1, notes: '' })); p.status = 'script-ready';
        p.log.push({ at: now(), text: `Script ready: ${p.scenes.length} scenes. Review it, then validate to generate the video.` });
      }));
    } catch (e) { for (const slug of slugs) update(slug, (p) => { p.status = 'error'; p.log.push({ at: now(), text: 'Script failed: ' + e.message }); }); }
  })();
  return slugs;
}

export async function writeScript(prompt, format = '9:16', style = null) {
  const { tool, styleName } = styleInfo(style);
  const slug = freeSlug(slugBase(prompt));
  save({ slug, title: prompt.slice(0, 60), idea: prompt, style, styleName, format, voice: newVoice(), music: 'lofi', status: 'writing-script', scenes: [], notes: [], log: [{ at: now(), text: `${ai().name} is writing the script in ${styleName}…` }], final: null, createdAt: now() });
  const system = 'You are a short-form video director. You turn an idea into a script told scene by scene, second by second, and pick the best available animation tool for each scene. Return only the JSON requested.';
  const input = `The user's idea:\n"""${prompt}"""\n\nFormat: ${format}.\n\nThe user chose ONE style for the whole video: ${styleName}, tool id "${style}". About it: ${tool.what}\nEvery scene uses this style and only this style. Design every scene for what this style does well.\n\nWrite the video:
- title (short), slug (lowercase-with-hyphens), music (lofi/ambient/upbeat/epic/none).
- scenes: one picture each, 2-6 s, contiguous from 0, total 20-45 s unless the idea asks for another length.
- visual: exactly what we see (subject, action, framing), concrete enough to animate.
- narration: what the voice says in that scene, at most 2.4 words per second of the scene ("" for a silent beat).
- onscreen: text burned into the picture ("" if none). sound: the sound moment.
- tool: always "${style}".
- narration and onscreen in the same language as the idea.`;
  (async () => {
    try {
      const d = await run(system, input, SCENE_SCHEMA);
      update(slug, (p) => { p.title = d.title; p.format = d.format || format; p.music = d.music || getSettings().music || 'lofi'; p.scenes = d.scenes.map((s, i) => ({ ...s, tool: style, n: i + 1, notes: '' })); p.status = 'script-ready'; p.log.push({ at: now(), text: `Script ready: ${d.scenes.length} scenes. Edit anything, then validate to generate the video.` }); });
    } catch (e) { update(slug, (p) => { p.status = 'error'; p.log.push({ at: now(), text: 'Script failed: ' + e.message }); }); }
  })();
  return slug;
}

/** Regenerate the scene-by-scene script for an existing project (e.g. after a script error or to rewrite). */
export function regenerateScript(slug, { seconds } = {}) {
  const cur = load(slug);
  if (['writing-script', 'building', 'queued'].includes(cur.status)) {
    throw new Error(`Project is currently ${cur.status}`);
  }
  const style = cur.style || cur.scenes?.find((s) => s.tool)?.tool || getSettings().style || 'tvhead/prehistoric';
  const { tool, styleName } = styleInfo(style);
  const lang = cur.voice?.lang || getSettings().lang || 'id';
  const format = cur.format || '9:16';
  const ref = cleanRef(cur.reference?.text || '');
  const title = cur.title && cur.title !== cur.slug ? cur.title : cur.slug;
  const sr = cur.series;
  const targetSeconds = Math.max(0, Math.min(900, Math.round(+(seconds !== undefined ? seconds : cur.targetSeconds) || 0)));
  const len = targetSeconds
    ? `about ${targetSeconds} s (±10 s)`
    : ref
      ? `20-60 s (or the duration specified in the format reference)`
      : '20-45 s';
  const sceneLen = targetSeconds >= 100 ? '4-10 s' : '2-6 s';

  const updated = update(slug, (p) => {
    p.style = style;
    p.styleName = styleName;
    if (targetSeconds) p.targetSeconds = targetSeconds;
    else delete p.targetSeconds;
    p.status = 'writing-script';
    p.scenes = [];
    p.final = null;
    p.savedPath = null;
    p.log ||= [];
    p.log.push({ at: now(), text: `${ai().name} is regenerating the script${targetSeconds ? ` (~${targetSeconds}s)` : ''} in ${styleName}…` });
  });

  const system = 'You are a short-form video director. You turn an idea into a script told scene by scene, second by second. Return only the JSON requested.';
  const seriesNote = sr
    ? `\nThis is Part ${sr.part} of ${sr.of} in the series "${sr.title}".${sr.bible ? `\nSeries bible: ${JSON.stringify(sr.bible)}` : ''}${sr.part < sr.of ? ' End on a cliffhanger teasing the next part.' : ' Pay off the story and conclude it.'}`
    : '';
  const input = `Write the scene-by-scene script for "${title}".${cur.idea ? `\nConcept / brief:\n"""${cur.idea}"""` : ''}${seriesNote}
Format: ${format}. Visual style for every scene: ${styleName}, tool id "${style}". About it: ${tool.what}
Design every scene for what this style does well.${refBlock(ref)}
Language: all narration and on-screen text in ${LANG[lang] || lang}. visual and sound descriptions in English.

Write the video:
- title: keep "${title}", slug: "${slug}", format: "${format}", music: lofi/ambient/upbeat/epic/none.
- length ${len}; scenes of ${sceneLen}, contiguous from 0, one picture each.
- a strong hook in the first 2 s (a question, a shock or a promise).
- visual: exactly what we see (subject, action, framing), concrete enough to animate.
- narration: what the voice says, at most 2.4 words per second of the scene ("" for a silent beat).
- onscreen: text burned into the picture ("" if none). sound: the sound moment.
- tool: always "${style}".`;

  (async () => {
    try {
      const d = await run(system, input, SCENE_SCHEMA);
      if (!Array.isArray(d.scenes) || !d.scenes.length) throw new Error('AI returned 0 scenes');
      update(slug, (p) => {
        if (!p.title || p.title === p.slug) p.title = d.title || p.title;
        if (!p.music || p.music === 'auto') p.music = d.music || getSettings().music || 'lofi';
        p.scenes = d.scenes.map((s, i) => ({ ...s, tool: style, n: i + 1, notes: '' }));
        p.status = 'script-ready';
        p.log.push({ at: now(), text: `Script ready: ${p.scenes.length} scenes. Review it, then validate to generate the video.` });
      });
    } catch (e) {
      update(slug, (p) => {
        p.status = 'error';
        p.log.push({ at: now(), text: 'Script failed: ' + e.message });
      });
    }
  })();

  return updated;
}

/**
 * Add a new part to an existing project (promoting standalone projects to a series if needed),
 * using the user's direction (e.g., winning audience choice) and previous part context.
 */
export function addPart(slug, { direction = '', title = '', seconds, isEnding = false } = {}) {
  const cur = load(slug);
  if (cur.status === 'writing-script') {
    throw new Error('Wait until the current script finishes writing');
  }
  direction = String(direction || '').trim();
  if (!direction) throw new Error('Describe what happens in the next part');

  const style = cur.style || cur.scenes?.find((s) => s.tool)?.tool || getSettings().style || 'tvhead/prehistoric';
  const { tool, styleName } = styleInfo(style);
  const lang = cur.voice?.lang || getSettings().lang || 'id';
  const format = cur.format || '9:16';
  const ref = cleanRef(cur.reference?.text || '');
  const targetSeconds = Math.max(0, Math.min(900, Math.round(+(seconds !== undefined && seconds !== '' && seconds !== null ? seconds : cur.targetSeconds) || 0)));
  const len = targetSeconds
    ? `about ${targetSeconds} s (±10 s)`
    : ref
      ? `20-60 s (or the duration specified in the format reference)`
      : '20-45 s';
  const sceneLen = targetSeconds >= 100 ? '4-10 s' : '2-6 s';

  const seriesId = cur.series?.id || cur.slug;
  const seriesTitle = (cur.series?.title || (cur.title && cur.title !== cur.slug ? cur.title : cur.slug))
    .replace(/\s*\(Part\s*\d+\)\s*$/i, '').trim() || seriesId;
  const existingSlugs = (cur.series?.slugs?.length ? cur.series.slugs : [cur.slug]).filter((s) => fs.existsSync(pfile(s)));
  if (!existingSlugs.includes(cur.slug)) existingSlugs.push(cur.slug);

  const nextPart = existingSlugs.length + 1;
  const newSlug = freeSlug(`${slugBase(seriesId)}-part-${nextPart}`);
  const allSlugs = [...existingSlugs, newSlug];
  const partTitle = String(title || '').trim() || `${seriesTitle} (Part ${nextPart})`;
  const bible = cur.series?.bible || null;

  existingSlugs.forEach((s, idx) => {
    update(s, (p) => {
      p.series = {
        ...(p.series || {}),
        id: seriesId,
        title: seriesTitle,
        part: p.series?.part || (idx + 1),
        of: nextPart,
        slugs: allSlugs,
        ...(bible ? { bible } : {}),
      };
    });
  });

  const vo = { ...newVoice(), ...(cur.voice || {}), lang };
  delete vo.used;

  save({
    slug: newSlug,
    title: partTitle,
    idea: direction,
    folder: cur.folder || '',
    style,
    styleName,
    format,
    ...(targetSeconds ? { targetSeconds } : {}),
    voice: vo,
    music: cur.music && cur.music !== 'auto' ? cur.music : 'lofi',
    series: {
      id: seriesId,
      title: seriesTitle,
      part: nextPart,
      of: nextPart,
      slugs: allSlugs,
      ...(bible ? { bible } : {}),
    },
    ...(cur.reference?.text ? { reference: { name: String(cur.reference.name || 'Reference').slice(0, 80), text: cur.reference.text } } : {}),
    status: 'writing-script',
    scenes: [],
    notes: [],
    log: [{ at: now(), text: `${ai().name} is writing Part ${nextPart} in ${styleName}…` }],
    final: null,
    createdAt: now(),
  });

  const prevScenes = (cur.scenes || []).slice(-12).map((s) =>
    `Scene ${s.n} (${s.start}-${s.end}s): [Visual] ${s.visual || ''} | [Narration] ${s.narration || ''} | [Onscreen] ${s.onscreen || ''}`
  ).join('\n');

  const system = 'You are a short-form video director and serial storyteller. You continue an interactive/multi-part story scene by scene, second by second, preserving continuity and format. Return only the JSON requested.';
  const endingRule = isEnding
    ? 'This is the final part of the story: pay off the journey and conclude it cleanly.'
    : 'Continue seamlessly from the previous part\'s outcome/choice, and end with a new dilemma, cliffhanger, or audience choice (matching the format reference if provided).';

  const input = `Write Part ${nextPart} of the series "${seriesTitle}".
${bible ? `\nSeries bible:\n${JSON.stringify(bible)}\n` : ''}
Previous part ("${cur.title || cur.slug}"):
${cur.idea ? `Concept / brief: """${cur.idea}"""\n` : ''}${prevScenes ? `Previous scenes:\n${prevScenes}\n` : ''}
Direction / what must happen in Part ${nextPart} (audience choice / story continuation):
"""${direction}"""

${endingRule}
Format: ${format}. Visual style for every scene: ${styleName}, tool id "${style}". About it: ${tool.what}
Design every scene for what this style does well.${refBlock(ref)}
Language: all narration and on-screen text in ${LANG[lang] || lang}. visual and sound descriptions in English.

Write the video:
- title: keep "${partTitle}", slug: "${newSlug}", format: "${format}", music: lofi/ambient/upbeat/epic/none.
- length ${len}; scenes of ${sceneLen}, contiguous from 0, one picture each.
- a strong hook in the first 2 s (directly showing the consequence/recap of the previous choice if applicable).
- visual: exactly what we see (subject, action, framing), concrete enough to animate.
- narration: what the voice says, at most 2.4 words per second of the scene ("" for a silent beat).
- onscreen: text burned into the picture ("" if none). sound: the sound moment.
- tool: always "${style}".`;

  (async () => {
    try {
      const d = await run(system, input, SCENE_SCHEMA);
      if (!Array.isArray(d.scenes) || !d.scenes.length) throw new Error('AI returned 0 scenes');
      update(newSlug, (p) => {
        if (!p.title || p.title === p.slug) p.title = d.title || p.title;
        if (d.music && (!cur.music || cur.music === 'auto')) p.music = d.music;
        p.scenes = d.scenes.map((s, i) => ({ ...s, tool: style, n: i + 1, notes: '' }));
        p.status = 'script-ready';
        p.log.push({ at: now(), text: `Script ready: ${p.scenes.length} scenes. Review it, then validate to generate the video.` });
      });
    } catch (e) {
      update(newSlug, (p) => {
        p.status = 'error';
        p.log.push({ at: now(), text: 'Script failed: ' + e.message });
      });
    }
  })();

  return newSlug;
}

// ---------- builds: one at a time from a queue; finished clips are kept; the studio stitches, not the agent ----------
// ponytail: one global queue (renders share one GPU); per-tool queues if that ever matters.
const queue = []; // { slug, stitchOnly, only, fresh }
let pumping = false;
export const queuePos = (slug) => queue.findIndex((q) => q.slug === slug);
const clipOk = (slug, s) => !!s.clip && fs.existsSync(path.join(PROJECTS, slug, s.clip));
const killTree = (c) => { try { if (process.platform === 'win32') spawn('taskkill', ['/pid', String(c.pid), '/T', '/F']); else process.kill(-c.pid, 'SIGTERM'); } catch { try { c.kill(); } catch {} } };
/** On server exit: stop every agent and render it started (they run in their own process group). */
export function killAll() { for (const c of running.values()) { c.stopped = true; killTree(c); } }

/**
 * Queue a build. only: scene numbers to (re)render; fresh: re-render every scene; stitchOnly: just stitch the clips.
 * Without options, scenes that already have a clip (and were not edited since) are kept.
 */
export function buildProject(slug, { only = null, fresh = false, stitchOnly = false } = {}) {
  if (running.has(slug) || queuePos(slug) >= 0) return false;
  queue.push({ slug, only: Array.isArray(only) && only.length ? only.map(Number) : null, fresh: !!fresh, stitchOnly: !!stitchOnly });
  update(slug, (p) => { p.status = 'queued'; p.log.push({ at: now(), text: stitchOnly ? 'Queued: stitch the final video' : `Queued for building${queue.length > 1 ? ` (${queue.length - 1} ahead)` : ''}` }); });
  pump();
  return true;
}
function pump() {
  if (pumping || !queue.length) return;
  pumping = true;
  const job = queue.shift();
  (job.stitchOnly ? (lockSeriesVoice(job.slug), stitchJob(job.slug)) : runBuild(job)) // a stitch makes the voice-over too, so it keeps the series narrator
    .catch((e) => update(job.slug, (p) => { p.status = 'error'; p.log.push({ at: now(), text: 'Build failed: ' + e.message }); }))
    .finally(() => { pumping = false; pump(); });
}

/** A series part with provider "auto" takes the voice an earlier part was really made with, so the narrator never changes mid-series. */
function lockSeriesVoice(slug) {
  const p = load(slug), v = p.voice || {};
  if (!p.series?.slugs || v.on !== true || v.provider !== 'auto') return;
  for (const s of [slug, ...p.series.slugs]) { // its own last voice first, else the earliest part's
    if (!fs.existsSync(pfile(s))) continue;
    const u = load(s).voice?.used;
    if (u?.provider && u.voice) {
      update(slug, (x) => { x.voice = { ...x.voice, provider: u.provider, voice: u.voice }; x.log.push({ at: now(), text: `Voice locked to ${u.provider} · ${u.voice}${s === slug ? ' (its last build)' : `, as in ${s}`}` }); });
      return;
    }
  }
}
/** The closest earlier part of the series that has a work folder: the agent reuses its cast and world. */
function previousWork(p) {
  const sr = p.series; if (!sr?.slugs) return null;
  const parts = sr.slugs.map((s) => fs.existsSync(pfile(s)) && load(s)).filter((x) => x && x.slug !== p.slug && (x.series?.part || 0) < (sr.part || 0));
  for (const x of parts.sort((a, b) => b.series.part - a.series.part)) {
    const w = path.join(PROJECTS, x.slug, 'work');
    if (fs.existsSync(w) && fs.readdirSync(w).some((f) => fs.statSync(path.join(w, f)).isDirectory())) return { slug: x.slug, part: x.series.part, dir: w };
  }
  return null;
}

async function runBuild({ slug, only, fresh }) {
  const a = ai();
  lockSeriesVoice(slug);
  const p = update(slug, (x) => {
    x.status = 'building'; x.final = null; x.savedPath = null;
    for (const s of x.scenes) {
      if (fresh || s.stale || !clipOk(slug, s) || only?.includes(s.n)) { delete s.clip; delete s.stale; s.status = 'pending'; } else s.status = 'done';
    }
  });
  const todo = p.scenes.filter((s) => !s.clip).map((s) => s.n), keep = p.scenes.filter((s) => s.clip).map((s) => s.n);
  if (!todo.length) return stitchJob(slug);
  logTo(slug, `${a.name}${a.build ? ` (${a.build})` : ''} started building ${keep.length ? `scene${todo.length > 1 ? 's' : ''} ${todo.join(', ')} (${keep.length} finished clip${keep.length > 1 ? 's' : ''} kept)` : 'the video'}`);
  const skill = path.join(BUILD, '.claude', 'skills', 'video-studio', 'SKILL.md'), dir = path.join(PROJECTS, slug), prev = previousWork(p);
  const vs = `node "${path.join(ROOT, 'vs.mjs')}"`;
  const input = `Build the Video Studio project "${slug}". The user already validated its script: the scenes in ${pfile(slug)} are the contract (tool, timing, visual, narration, on-screen text, sound, notes).
Render these scenes now: ${todo.join(', ')}.${keep.length ? `\nScenes ${keep.join(', ')} already have finished clips (see "clip" in the project file): do not re-render or touch them. If ${path.join(dir, 'work')} already holds this video's setup, reuse it so the new scenes match the finished ones.` : ''}${prev ? `
This is part ${p.series.part} of the series "${p.series.title}". Part ${prev.part} was built in ${prev.dir}: copy what you need from there (cast, world, components, render scripts) into this project's work folder and keep every recurring character, costume, colour, prop and location identical to that part.` : ''}${p.series?.bible ? `\nSeries bible: ${JSON.stringify(p.series.bible)}` : ''}
Read ${skill} first (sections 4 "Build", "Tool notes" and "Rules") and ${path.join(ROOT, 'catalog.json')}, then render each of those scenes and register each clip as soon as it exists with ${vs} progress ${slug} "…" --scene N --clip clips/scene-NN.mp4. Check every clip you made (a contact sheet) and fix real problems.
Do NOT run tools/stitch.mjs and do NOT run vs.mjs done: when you exit, the studio stitches final.mp4 itself (voice-over, music, captions).
Report short progress lines with ${vs} progress ${slug} "…" as you go. Work only inside ${dir} (copy templates from ${path.join(BUILD, 'demos')} there). Do not ask questions: decide and build.`;
  // secrets stay out of reach: Claude gets deny rules, Cursor reads <kit>/.cursor/cli.json (deny .env / .keys.json); both may run any other command, as a build needs
  const args = a.agent === 'claude'
    ? ['-p', ...modelFlag(a.build), '--output-format', 'stream-json', '--verbose', '--tools', 'Bash,Read,Write,Edit,Glob,Grep', '--allowedTools', 'Bash,Read,Write,Edit,Glob,Grep',
      '--disallowedTools', 'Read(./.env)', 'Read(./.env.*)', 'Read(./.keys.json)', 'Edit(./.env)', 'Edit(./.keys.json)', '--add-dir', BUILD, ...leanFlags()]
    : ['-p', input, '--output-format', 'stream-json', '--trust', '--force', '--workspace', BUILD, ...modelFlag(a.build)];
  let lastLog = 0, child = null, error = '';
  const tell = (what) => { if (what && !/vs\.mjs/.test(what) && Date.now() - lastLog > 1500) { logTo(slug, `${a.agent === 'claude' ? 'Claude' : 'Cursor'} · ${what}`); lastLog = Date.now(); } };
  await spawnAgent(a.bin, args, a.agent === 'claude' ? input : '', {
    cwd: BUILD,
    onEvent: (ev) => {
      if (ev.type === '_spawned') { child = ev.child; running.set(slug, ev.child); return; }
      if (ev.type === 'tool_call' && ev.subtype === 'started') { // Cursor
        const [name, v] = Object.entries(ev.tool_call ?? {})[0] ?? ['tool', {}], i = v?.args ?? {};
        return tell(i.command ? String(i.command).slice(0, 110) : `${name.replace(/ToolCall$/, '').toLowerCase()} ${path.basename(String(i.path || i.pattern || ''))}`);
      }
      if (ev.type !== 'assistant') return;
      for (const c of ev.message?.content ?? []) {
        if (c.type !== 'tool_use') continue;
        const i = c.input ?? {};
        tell(c.name === 'Bash' ? String(i.description || i.command || '').slice(0, 110) : `${c.name.toLowerCase()} ${path.basename(String(i.path || i.pattern || ''))}`);
      }
    },
  }).catch((e) => { error = e.message.replace(/\s+/g, ' ').trim(); });
  running.delete(slug);
  if (child?.stopped) return; // the user pressed Stop: stopBuild already said so
  // whatever the agent said at the end, the clips decide: all there → stitch; some missing → say which, keep the rest
  const x = load(slug);
  if (x.status === 'done') return; // an agent that stitched anyway
  const missing = x.scenes.filter((s) => !clipOk(slug, s)).map((s) => s.n);
  if (!missing.length) { if (error) logTo(slug, `${a.name} ended with an error after every clip was made (${error.slice(0, 200)}); stitching anyway`); return stitchJob(slug); }
  update(slug, (y) => { y.status = 'error'; y.log.push({ at: now(), text: `${error ? 'Build failed: ' + error + ' · ' : `${a.name} stopped before every scene was rendered. `}Scene${missing.length > 1 ? 's' : ''} ${missing.join(', ')} still ha${missing.length > 1 ? 've' : 's'} no clip. Press Continue to render only ${missing.length > 1 ? 'those' : 'that one'}: finished clips are kept.` }); });
}

/** CA bundle for Node's fetch when the network inspects TLS (the voice-over providers otherwise fail with "fetch failed"). */
function caEnv() {
  const env = { ...process.env };
  if (!env.NODE_EXTRA_CA_CERTS) { const ca = ['/etc/ssl/certs/ca-certificates.crt', '/etc/ssl/cert.pem', '/etc/pki/tls/certs/ca-bundle.crt'].find((f) => fs.existsSync(f)); if (ca) env.NODE_EXTRA_CA_CERTS = ca; }
  return env;
}
/** stitch.mjs → vs.mjs done. Deterministic, so the studio runs it instead of asking the agent to. */
function stitchJob(slug) {
  update(slug, (p) => { p.status = 'building'; p.final = null; p.savedPath = null; p.log.push({ at: now(), text: 'Stitching the final video (voice-over, music, captions)…' }); });
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'tools', 'stitch.mjs'), slug], { cwd: ROOT, env: caEnv(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
    running.set(slug, child);
    let out = '';
    child.stdout.on('data', (d) => (out += d)); child.stderr.on('data', (d) => (out += d));
    child.on('error', (e) => (out += e.message));
    child.on('close', (code) => {
      running.delete(slug);
      if (child.stopped) return resolve();
      const lines = out.split('\n').map((l) => l.trim()).filter(Boolean);
      for (const w of lines.filter((l) => /run over|skipped|placeholder/.test(l))) logTo(slug, 'Stitch: ' + w);
      if (code === 0) {
        const r = spawnSync(process.execPath, [path.join(ROOT, 'vs.mjs'), 'done', slug, 'final.mp4'], { cwd: ROOT, encoding: 'utf8' });
        if (r.status !== 0) update(slug, (p) => { p.status = 'error'; p.log.push({ at: now(), text: 'Could not finish: ' + (r.stderr || '').slice(-300) }); });
        else logTo(slug, lines.at(-1) || 'final.mp4 ready');
      } else update(slug, (p) => { p.status = 'error'; p.log.push({ at: now(), text: 'Stitch failed: ' + lines.slice(-4).join(' · ').slice(-600) + ' · Every clip is kept: press Stitch again once it is fixed.' }); });
      resolve();
    });
  });
}

export function stopBuild(slug) {
  const qi = queuePos(slug);
  if (qi >= 0) { queue.splice(qi, 1); update(slug, (p) => { p.status = 'script-ready'; p.log.push({ at: now(), text: 'Removed from the queue' }); }); return true; }
  const c = running.get(slug); if (!c) return false;
  c.stopped = true; killTree(c);
  running.delete(slug); update(slug, (p) => { p.status = 'script-ready'; p.log.push({ at: now(), text: 'Build stopped. Finished clips are kept.' }); });
  return true;
}

/** Generate social media metadata (title, caption, hashtags, tags, firstComment, topic) from the finished project. */
export async function generateSocialMetadata(slug) {
  const p = load(slug);
  const lang = p.voice?.lang || getSettings().lang || 'id';
  const scriptLines = (p.scenes || [])
    .map((s) => `${s.start}-${s.end}s: ${[s.narration, s.onscreen ? `[text: ${s.onscreen}]` : ''].filter(Boolean).join(' ')}`)
    .filter(Boolean)
    .join('\n');
  const system = 'You are a social media strategist for short-form video (YouTube Shorts, TikTok, Instagram Reels, Threads, Facebook). Return only the JSON requested.';
  const input = `Create social media posting metadata for this finished video in ${LANG[lang] || lang}.

Video title: ${p.title || slug}
Format: ${p.format || '9:16'}
Style: ${p.styleName || p.style || ''}
Concept: ${p.idea || ''}
Script & on-screen text:
${scriptLines || '(no narration)'}

Requirements:
- title: catchy, curiosity-driven title under 85 characters (good for YouTube Shorts, Facebook video, Pinterest).
- description: engaging caption in 2 short paragraphs (a scroll-stopping hook + short takeaway/CTA), under 380 characters so it fits Threads too. Do NOT include hashtags in description.
- hashtags: 5-8 relevant hashtags (lowercase words without #).
- tags: 8-12 YouTube search keywords/phrases (no #).
- firstComment: a short engaging question or bonus fact to pin as the first comment, under 140 characters (must fit TikTok's 150-char limit).
- topic: 1-3 word Threads topic tag (e.g. "Fakta Unik" or "Everyday Science").`;

  const d = await run(system, input, SOCIAL_SCHEMA);
  const cleanTags = (arr) => [...new Set((arr || []).map((x) => String(x || '').trim().replace(/^#+/, '')).filter(Boolean))];
  const social = {
    title: String(d.title || p.title || '').trim().slice(0, 100),
    description: String(d.description || '').trim(),
    hashtags: cleanTags(d.hashtags),
    tags: cleanTags(d.tags),
    firstComment: String(d.firstComment || '').trim(),
    topic: String(d.topic || '').trim(),
    generatedAt: now(),
  };
  return update(slug, (x) => {
    x.social = social;
    x.log.push({ at: now(), text: 'Social media metadata generated by Claude' });
  });
}
