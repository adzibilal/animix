#!/usr/bin/env node
// Video Studio: a tiny local server for the UI, plus the commands Claude uses to talk to it.
//   node vs.mjs serve [--port 4790]                 start the UI (http://localhost:4790)
//   node vs.mjs new <slug> <project.json>           create/replace a project from a file
//   node vs.mjs wait <slug> [--timeout 3600]        block until the user presses Build or sends a note; prints JSON
//   node vs.mjs progress <slug> "text" [--scene N] [--clip path] [--status building|done|error]
//   node vs.mjs done <slug> <final.mp4>             mark the project finished and show the video in the UI
//   node vs.mjs reply <slug> "text"                 a message from Claude, shown in the UI chat
//   node vs.mjs show <slug>                          print the project JSON
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { agentInfo, writeScript, writeSeries, regenerateScript, addPart, ideas, buildProject, stopBuild, queuePos, killAll, generateSocialMetadata } from './agent.mjs';
import * as keys from './lib/keys.mjs';
import * as repliz from './lib/repliz.mjs';
import * as compress from './lib/compress.mjs';
import { getSettings, putSettings, newVoice } from './lib/settings.mjs';
import { synthProject, listVoices, available, supports, NAMES, KEYENV } from './lib/tts.mjs';
const MANUAL = process.env.VS_MANUAL === '1'; // 1 = an interactive Claude session builds (vs.mjs wait)

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PROJECTS = path.join(ROOT, 'projects');
fs.mkdirSync(PROJECTS, { recursive: true });
const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const now = () => new Date().toISOString();
const slugOk = (s) => /^[a-z0-9][a-z0-9-]{0,60}$/.test(s || '');
const pfile = (slug) => path.join(PROJECTS, slug, 'project.json');
const load = (slug) => JSON.parse(fs.readFileSync(pfile(slug), 'utf8'));
const save = (p) => { fs.mkdirSync(path.join(PROJECTS, p.slug), { recursive: true }); const f = pfile(p.slug), t = f + '.tmp'; p.updatedAt = now(); fs.writeFileSync(t, JSON.stringify(p, null, 2)); fs.renameSync(t, f); return p; };
// finished videos are also copied to <build>/outputs/<title>.mp4 so they are easy to find
const OUTPUTS = path.resolve(ROOT, '..', 'outputs');
function publishFinal(p) {
  const src = path.join(PROJECTS, p.slug, p.final || 'final.mp4'); if (!fs.existsSync(src)) return null;
  fs.mkdirSync(OUTPUTS, { recursive: true });
  const name = `${String(p.title || p.slug).replace(/[\/:*?"<>|]+/g, '').trim() || p.slug}.mp4`, dst = path.join(OUTPUTS, name);
  if (!fs.existsSync(dst) || fs.statSync(dst).mtimeMs < fs.statSync(src).mtimeMs) fs.copyFileSync(src, dst);
  return dst;
}
const blank = (slug) => ({ slug, title: slug, idea: '', format: getSettings().format, voice: newVoice(), music: 'auto', status: 'draft', scenes: [], notes: [], log: [], final: null, createdAt: now() });

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.mp4': 'video/mp4', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };

function sendFile(req, res, file) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end('not found'); }
  const size = fs.statSync(file).size, type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const m = (req.headers.range || '').match(/bytes=(\d*)-(\d*)/);
  if (m) {
    const start = m[1] ? +m[1] : 0, end = m[2] ? Math.min(+m[2], size - 1) : size - 1;
    res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Cache-Control': 'no-store' });
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}
const json = (res, code, data) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
const body = (req) => new Promise((ok) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => { try { ok(b ? JSON.parse(b) : {}); } catch { ok({}); } }); });
const inside = (base, p) => { const f = path.resolve(base, p); return f.startsWith(path.resolve(base) + path.sep) ? f : null; };

// Writes only from this UI: a page on another site (or a DNS-rebound host) can't change keys or start builds.
// ---------- thumbnails (jpg, cached in .cache/thumbs, at most 3 ffmpeg at a time) ----------
const THUMBS = path.join(ROOT, '.cache', 'thumbs');
let slots = 3; const waiting = [], making = new Map();
async function makeThumb(src, out) {
  if (fs.existsSync(out) && fs.statSync(out).mtimeMs >= fs.statSync(src).mtimeMs) return out;
  if (making.has(out)) return making.get(out);
  const job = (async () => {
    while (slots <= 0) await new Promise((r) => waiting.push(r));
    slots--;
    try {
      fs.mkdirSync(path.dirname(out), { recursive: true });
      const grab = (at) => new Promise((r) => spawn('ffmpeg', ['-y', '-v', 'error', '-ss', String(at), '-i', src, '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '4', out], { stdio: 'ignore' }).on('close', r).on('error', r));
      await grab(1.5); if (!fs.existsSync(out)) await grab(0); // clips shorter than 1.5 s
      return fs.existsSync(out) ? out : null;
    } finally { slots++; waiting.shift()?.(); making.delete(out); }
  })();
  making.set(out, job); return job;
}
function styleExample(tool, style) {
  const c = JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog.json'), 'utf8'));
  const ex = c.tools.find((t) => t.id === tool)?.styles.find((s) => s.id === style)?.example;
  return ex && fs.existsSync(path.join(ROOT, ex)) ? path.join(ROOT, ex) : null;
}
/** the picture for a project: its final video, else its first rendered clip, else its style's example */
function projectSource(x) {
  const dir = path.join(PROJECTS, x.slug);
  for (const f of [x.final, ...x.scenes.map((s) => s.clip)]) if (f && fs.existsSync(path.join(dir, f))) return path.join(dir, f);
  const [t, s] = String(x.style || x.scenes.find((s) => s.tool)?.tool || '').split('/');
  return t ? styleExample(t, s) : null;
}
async function sendThumb(req, res, src, out) {
  const f = src && await makeThumb(src, out);
  if (!f) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-cache' }); fs.createReadStream(f).pipe(res);
}
const duration = (x) => Math.max(0, ...x.scenes.map((s) => +s.end || 0));
// folders: a project's folder is p.folder ('' = none); settings.folders keeps the order and the empty ones
const folderList = () => [...new Set([...(getSettings().folders || []), ...fs.readdirSync(PROJECTS).filter((d) => fs.existsSync(pfile(d))).map((d) => load(d).folder).filter(Boolean)])];
const putQuiet = (p) => { const f = pfile(p.slug), t = f + '.tmp'; fs.writeFileSync(t, JSON.stringify(p, null, 2)); fs.renameSync(t, f); }; // a move is not an edit: updatedAt stays
function folderOp({ op, name, to }) {
  name = String(name || '').trim().slice(0, 60); to = String(to || '').trim().slice(0, 60);
  if (!name) throw new Error('Folder name?');
  let list = folderList();
  if (op === 'create') { if (!list.includes(name)) list.push(name); }
  else if (op === 'rename' || op === 'delete') {
    if (op === 'rename' && (!to || (to !== name && list.includes(to)))) throw new Error(to ? 'A folder with that name exists' : 'New name?');
    for (const d of fs.readdirSync(PROJECTS)) if (fs.existsSync(pfile(d))) { const x = load(d); if (x.folder === name) { x.folder = op === 'rename' ? to : ''; putQuiet(x); } }
    list = op === 'rename' ? list.map((f) => (f === name ? to : f)) : list.filter((f) => f !== name);
  } else throw new Error('unknown folder op');
  putSettings({ folders: list }); return folderList();
}

// a scene whose picture changed after its clip was rendered: the clip stays playable, the next build re-renders it
function markStale(before, after) {
  const old = new Map(before.filter((s) => s.clip).map((s) => [s.clip, s])), len = (s) => +((+s.end || 0) - (+s.start || 0)).toFixed(2);
  for (const s of after) {
    const o = s.clip && old.get(s.clip); if (!o) continue;
    if (['visual', 'onscreen', 'tool', 'notes'].some((k) => (s[k] || '') !== (o[k] || '')) || len(s) !== len(o)) s.stale = true;
  }
}
const SCRATCH = /^(part-\d+\.mp4|video\.mp4|list\.txt|music\.mp3)$/;
function scratchFiles() {
  const out = [];
  for (const d of fs.readdirSync(PROJECTS)) {
    if (!fs.existsSync(pfile(d))) continue;
    const x = load(d), w = path.join(PROJECTS, d, 'stitch');
    if (x.status !== 'done' || !x.final || !fs.existsSync(path.join(PROJECTS, d, x.final)) || !fs.existsSync(w)) continue;
    for (const f of fs.readdirSync(w)) if (SCRATCH.test(f)) out.push(path.join(w, f));
  }
  return out;
}

let PORT = 4790;
function sameOrigin(req) {
  const ok = [`localhost:${PORT}`, `127.0.0.1:${PORT}`];
  if (!ok.includes(req.headers.host)) return false;
  const o = req.headers.origin; return !o || ok.some((h) => o === `http://${h}`);
}

const activeCompress = new Map();
const fmtMb = (bytes) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
function attachVideoInfo(slug, cur) {
  if (!cur?.final) return cur;
  const videoPath = path.join(PROJECTS, slug, cur.final);
  const cached = fs.existsSync(videoPath)
    ? compress.listCachedCompressed(videoPath, path.join(PROJECTS, slug, 'work'))
    : null;
  if (!cached && !activeCompress.has(slug)) return cur;
  return {
    ...cur,
    videoInfo: {
      size: cached?.originalSize || 0,
      autoThreshold: compress.AUTO_THRESHOLD_BYTES,
      presets: cached?.presets || {},
      compressing: activeCompress.get(slug) || null,
    },
  };
}

async function handle(req, res) {
  const u = new URL(req.url, 'http://x'), p = decodeURIComponent(u.pathname);
  if (req.method !== 'GET' && req.method !== 'HEAD' && !sameOrigin(req)) return json(res, 403, { error: 'forbidden origin' });
  if (p.startsWith('/api/keys') || p.startsWith('/api/settings') || p.startsWith('/api/voice') || p === '/api/providers') {
    try { return await settingsApi(req, res, p, u); } catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (p === '/' ) return sendFile(req, res, path.join(ROOT, 'ui', 'index.html'));
  if (p === '/favicon.ico') return sendFile(req, res, path.join(ROOT, 'ui', 'favicon.svg'));
  if (p === '/dashboard' || p === '/dashboard/') return sendFile(req, res, path.join(ROOT, 'ui', 'dashboard.html'));
  let tm = p.match(/^\/thumb\/style\/([a-z0-9_-]+)\/([a-z0-9_-]+)\.jpg$/);
  if (tm) return sendThumb(req, res, styleExample(tm[1], tm[2]), path.join(THUMBS, 'style', `${tm[1]}--${tm[2]}.jpg`));
  tm = p.match(/^\/thumb\/project\/([a-z0-9-]+)\.jpg$/);
  if (tm) { if (!fs.existsSync(pfile(tm[1]))) return json(res, 404, {}); const src = projectSource(load(tm[1])); return sendThumb(req, res, src, path.join(THUMBS, 'project', `${tm[1]}--${src ? path.basename(src, '.mp4') : 'none'}.jpg`)); }
  if (p === '/api/folders' && req.method === 'GET') return json(res, 200, folderList());
  if (p === '/api/folders' && req.method === 'POST') { try { return json(res, 200, folderOp(await body(req))); } catch (e) { return json(res, 400, { error: e.message }); } }
  if (p.startsWith('/ui/')) { const f = inside(path.join(ROOT, 'ui'), p.slice(4)); return f ? sendFile(req, res, f) : json(res, 403, {}); }
  if (p.startsWith('/examples/')) { const f = inside(path.join(ROOT, 'examples'), p.slice(10)); return f ? sendFile(req, res, f) : json(res, 403, {}); }
  if (p.startsWith('/files/')) { const f = inside(PROJECTS, p.slice(7)); return f ? sendFile(req, res, f) : json(res, 403, {}); }
  if (p === '/api/catalog') { // only styles whose example clip exists (previews appear as they finish rendering)
    const c = JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog.json'), 'utf8'));
    // lemo lists all 66 styles (a missing clip shows "preview rendering"); other tools only show styles with a clip
    for (const t of c.tools) t.styles = t.styles.map((s) => ({ ...s, example: s.example && fs.existsSync(path.join(ROOT, s.example)) ? s.example : null })).filter((s) => s.example || t.id === 'lemo');
    c.tools = c.tools.filter((t) => t.styles.length);
    return json(res, 200, c);
  }
  if (p === '/api/projects') {
    const list = fs.readdirSync(PROJECTS).filter((d) => fs.existsSync(pfile(d))).map((d) => { const x = load(d); return { slug: x.slug, title: x.title, status: x.status, updatedAt: x.updatedAt, createdAt: x.createdAt, folder: x.folder || '', styleName: x.styleName || '', format: x.format, final: x.final || null, scenes: x.scenes.length, done: x.scenes.filter((s) => s.clip).length, seconds: duration(x), queue: queuePos(x.slug), stale: x.scenes.filter((s) => s.stale).length, idea: String(x.idea || '').slice(0, 200), series: x.series && { id: x.series.id, title: x.series.title, part: x.series.part, of: x.series.of } }; });
    return json(res, 200, list.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '')));
  }
  if (p === '/api/cleanup') { // stitch intermediates of finished videos (final.mp4 has everything they held)
    const files = scratchFiles(), bytes = files.reduce((a, f) => a + fs.statSync(f).size, 0);
    if (req.method === 'POST') for (const f of files) fs.rmSync(f, { force: true });
    return json(res, 200, { files: files.length, bytes, removed: req.method === 'POST' });
  }
  if (p === '/api/script' && req.method === 'POST') {
    const b = await body(req); const prompt = String(b.prompt || '').trim();
    if (!prompt) return json(res, 400, { error: 'write a prompt' });
    try { return json(res, 200, { slug: await writeScript(prompt, b.format || '9:16', b.style) }); } catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (p === '/api/ideas' && req.method === 'POST') {
    const b = await body(req);
    try { return json(res, 200, { ideas: await ideas({ topic: String(b.topic || '').slice(0, 2000), style: b.style, lang: b.lang, avoid: Array.isArray(b.avoid) ? b.avoid.map(String) : [], reference: b.reference }) }); } catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (p === '/api/series' && req.method === 'POST') {
    const b = await body(req);
    try { return json(res, 200, { slugs: writeSeries(b) }); } catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (p === '/api/repliz/accounts' && req.method === 'GET') {
    if (!repliz.isConfigured()) return json(res, 200, { configured: false, accounts: [] });
    try { return json(res, 200, { configured: true, accounts: await repliz.listAccounts() }); }
    catch (e) { return json(res, 400, { configured: true, error: e.message }); }
  }
  if (p === '/api/repliz/pinterest-boards' && req.method === 'GET') {
    const accountId = u.searchParams.get('accountId');
    if (!accountId) return json(res, 400, { error: 'accountId required' });
    try { return json(res, 200, { boards: await repliz.listPinterestBoards(accountId) }); }
    catch (e) { return json(res, 400, { error: e.message }); }
  }
  const pm = p.match(/^\/api\/project\/([a-z0-9-]+)((?:\/[a-z-]+)*)$/);
  if (pm) {
    const slug = pm[1], action = pm[2];
    if (!fs.existsSync(pfile(slug))) { if (req.method === 'PUT') save(blank(slug)); else return json(res, 404, { error: 'no such project' }); }
    const cur = load(slug);
    if (!action && req.method === 'GET') { if (cur.final && !cur.savedPath) { cur.savedPath = publishFinal(cur); save(cur); } return json(res, 200, { ...attachVideoInfo(slug, cur), queue: queuePos(slug) }); }
    if (action === '/reveal' && req.method === 'POST') {
      const f = publishFinal(cur); if (!f) return json(res, 404, { error: 'no final video yet' });
      cur.savedPath = f; save(cur);
      const [cmd, args] = process.platform === 'win32' ? ['explorer.exe', [`/select,${f}`]] : process.platform === 'darwin' ? ['open', ['-R', f]] : ['xdg-open', [path.dirname(f)]];
      spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
      return json(res, 200, { path: f });
    }
    if (!action && req.method === 'DELETE') {
      const projDir = inside(PROJECTS, slug);
      if (!projDir || !fs.existsSync(projDir)) return json(res, 404, { error: 'no such project' });
      stopBuild(slug);
      const saved = cur.savedPath && inside(OUTPUTS, path.basename(cur.savedPath));
      fs.rmSync(projDir, { recursive: true, force: true });
      const thumbDir = path.join(THUMBS, 'project');
      if (fs.existsSync(thumbDir)) {
        for (const f of fs.readdirSync(thumbDir)) {
          if (f.startsWith(`${slug}--`)) fs.rmSync(path.join(thumbDir, f), { force: true });
        }
      }
      if (saved && fs.existsSync(saved)) {
        const stillUsed = fs.readdirSync(PROJECTS).some((d) => fs.existsSync(pfile(d)) && load(d).savedPath === saved);
        if (!stillUsed) fs.rmSync(saved, { force: true });
      }
      return json(res, 200, { deleted: slug });
    }
    if (!action && req.method === 'PUT') {
      const b = await body(req);
      if (Array.isArray(b.scenes)) markStale(cur.scenes, b.scenes);
      for (const k of ['title', 'idea', 'format', 'voice', 'music', 'scenes', 'style', 'styleName', 'social', 'targetSeconds']) if (b[k] !== undefined) cur[k] = b[k];
      if (cur.status === 'done' && b.scenes !== undefined) cur.status = 'script-ready'; // edited after finishing: ready to generate again
      if (cur.status === 'draft' && cur.scenes.length) cur.status = 'script-ready';
      return json(res, 200, save(cur));
    }
    if (action === '/script/regenerate' && req.method === 'POST') {
      const b = await body(req);
      try { return json(res, 200, regenerateScript(slug, { seconds: b.seconds !== undefined ? +b.seconds : undefined })); }
      catch (e) { return json(res, 400, { error: e.message }); }
    }
    if (action === '/part' && req.method === 'POST') {
      const b = await body(req);
      try {
        const newSlug = addPart(slug, {
          direction: b.direction,
          title: b.title,
          seconds: b.seconds !== undefined && b.seconds !== '' ? +b.seconds : undefined,
          isEnding: !!b.isEnding,
        });
        return json(res, 200, { slug: newSlug });
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
    }
    if (action === '/social/generate' && req.method === 'POST') {
      if (!cur.final) return json(res, 400, { error: 'finish generating the video first' });
      try { return json(res, 200, attachVideoInfo(slug, await generateSocialMetadata(slug))); }
      catch (e) { return json(res, 400, { error: e.message }); }
    }
    if (action === '/compress' && req.method === 'POST') {
      const b = await body(req);
      const videoPath = path.join(PROJECTS, slug, cur.final || 'final.mp4');
      if (!cur.final || !fs.existsSync(videoPath)) return json(res, 400, { error: 'final video file not found' });
      const preset = compress.PRESETS[b.preset] ? b.preset : 'balanced';
      try {
        activeCompress.set(slug, { preset, pct: 0, startedAt: now() });
        const result = await compress.compressVideo(videoPath, {
          outDir: path.join(PROJECTS, slug, 'work'),
          preset,
          onProgress: ({ pct }) => {
            const job = activeCompress.get(slug);
            if (job) job.pct = pct;
          },
        });
        if (!result.cached) {
          const fresh = load(slug);
          fresh.log ||= [];
          fresh.log.push({ at: now(), text: `Compressed video (${preset}): ${fmtMb(result.originalSize)} → ${fmtMb(result.size)}` });
          save(fresh);
        }
        return json(res, 200, {
          project: attachVideoInfo(slug, load(slug)),
          result: { ...result, relPath: `work/compressed-${preset}.mp4` },
        });
      } catch (e) {
        return json(res, 400, { error: e.message });
      } finally {
        activeCompress.delete(slug);
      }
    }
    if (action === '/repliz/schedule' && req.method === 'POST') {
      const b = await body(req);
      const videoPath = path.join(PROJECTS, slug, cur.final || 'final.mp4');
      if (!cur.final || !fs.existsSync(videoPath)) return json(res, 400, { error: 'final video file not found' });
      const accountIds = Array.isArray(b.accountIds) ? b.accountIds.filter(Boolean) : [];
      if (!accountIds.length) return json(res, 400, { error: 'pick at least one Repliz account' });
      if (!b.scheduleAt || Number.isNaN(new Date(b.scheduleAt).getTime())) return json(res, 400, { error: 'invalid schedule date/time' });
      if (b.metadata && typeof b.metadata === 'object') cur.social = { ...(cur.social || {}), ...b.metadata };
      try {
        const accounts = await repliz.listAccounts();
        const byId = new Map(accounts.map((a) => [a.id, a]));
        const compressMode = compress.COMPRESS_MODES.includes(b.compress) ? b.compress : 'auto';
        const effectivePreset = compressMode === 'auto' ? 'balanced' : compressMode;
        if (compressMode !== 'none' && (compressMode !== 'auto' || fs.statSync(videoPath).size > compress.AUTO_THRESHOLD_BYTES)) {
          activeCompress.set(slug, { preset: effectivePreset, pct: 0, startedAt: now() });
        }
        let resolved;
        try {
          resolved = await compress.resolveVideoForUpload(videoPath, {
            outDir: path.join(PROJECTS, slug, 'work'),
            mode: compressMode,
            onProgress: ({ pct }) => {
              const job = activeCompress.get(slug);
              if (job) job.pct = pct;
            },
          });
        } finally {
          activeCompress.delete(slug);
        }
        if (resolved.compressed && !resolved.cached) {
          cur.log ||= [];
          cur.log.push({ at: now(), text: `Compressed video (${resolved.preset}) for upload: ${fmtMb(resolved.originalSize)} → ${fmtMb(resolved.size)}` });
        }
        const stat = fs.statSync(resolved.filePath);
        const host = ['auto', 'temp', 'repliz'].includes(b.uploadHost) ? b.uploadHost : 'auto';
        const cached = cur.replizUpload;
        const canReuse = cached?.url && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs && (host === 'auto' || cached.host === host);
        if (!canReuse) {
          const uploaded = await repliz.uploadVideo(resolved.filePath, `${slug}.mp4`, { host });
          cur.replizUpload = {
            ...uploaded,
            compressed: resolved.compressed,
            preset: resolved.preset,
            originalSize: resolved.originalSize,
          };
          save(cur);
        }
        const results = [];
        cur.replizSchedules ||= [];
        const opts = b.options || {};
        for (const accountId of accountIds) {
          const account = byId.get(accountId);
          if (!account) { results.push({ accountId, ok: false, error: 'Account not found or disconnected in Repliz' }); continue; }
          try {
            const channel = opts.pinterestBoards?.[accountId];
            const payload = repliz.buildSchedulePayload({
              account,
              metadata: cur.social || { title: cur.title, description: cur.idea },
              videoUrl: cur.replizUpload.url,
              scheduleAt: b.scheduleAt,
              options: { ...opts, ...(channel ? { channel } : {}) },
            });
            const created = await repliz.createSchedule(payload);
            const entry = {
              id: created?._id || created?.id || null,
              accountId,
              platform: account.type,
              name: account.name,
              username: account.username,
              scheduleAt: payload.scheduleAt,
              status: created?.status || 'scheduled',
              createdAt: now(),
            };
            cur.replizSchedules.unshift(entry);
            results.push({ ok: true, ...entry });
          } catch (e) {
            results.push({ accountId, platform: account.type, name: account.name, username: account.username, ok: false, error: e.message });
          }
        }
        if (cur.replizSchedules.length > 50) cur.replizSchedules.length = 50;
        const okCount = results.filter((r) => r.ok).length;
        const compNote = cur.replizUpload?.compressed ? ` (compressed ${cur.replizUpload.preset}: ${fmtMb(cur.replizUpload.originalSize)} → ${fmtMb(cur.replizUpload.size)})` : '';
        cur.log.push({ at: now(), text: `Repliz: scheduled ${okCount}/${results.length} post(s) via ${cur.replizUpload?.provider || 'repliz'}${compNote} for ${new Date(b.scheduleAt).toLocaleString()}` });
        return json(res, 200, { project: attachVideoInfo(slug, save(cur)), results, upload: cur.replizUpload });
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
    }
    if (action === '/build' && req.method === 'POST') {
      const b = await body(req);
      if (b.text) cur.notes.push({ from: 'user', text: b.text, at: now(), read: false });
      if (MANUAL) { cur.status = 'build-requested'; cur.log.push({ at: now(), text: 'Build requested from the UI' }); return json(res, 200, save(cur)); }
      save(cur);
      if (!cur.scenes.length) return json(res, 400, { error: 'the script has no scenes yet' });
      if (b.stitch && cur.scenes.some((s) => !s.clip || !fs.existsSync(path.join(PROJECTS, slug, s.clip)))) return json(res, 400, { error: 'some scenes have no clip yet: generate them first' });
      if (!buildProject(slug, { only: b.only, fresh: b.fresh, stitchOnly: b.stitch })) return json(res, 409, { error: 'this video is already building or queued' });
      return json(res, 200, { ...load(slug), queue: queuePos(slug) });
    }
    if (action === '/series/build' && req.method === 'POST') { // every part that has a script and no video yet, in part order
      const queued = [];
      for (const s of cur.series?.slugs || [slug]) {
        if (!fs.existsSync(pfile(s))) continue;
        const x = load(s);
        if (x.scenes?.length && !['done', 'building', 'queued', 'writing-script'].includes(x.status) && buildProject(s)) queued.push(s);
      }
      return json(res, 200, { queued });
    }
    if (action === '/series/sync' && req.method === 'POST') { // this part's voice and music → every other part (a narrator that never changes)
      const { used, ...v } = cur.voice || {}, voice = used?.provider && v.provider === 'auto' ? { ...v, provider: used.provider, voice: used.voice } : v;
      let updated = 0;
      for (const s of cur.series?.slugs || []) {
        if (s === slug || !fs.existsSync(pfile(s))) continue;
        const x = load(s); if (['building', 'queued', 'writing-script'].includes(x.status)) continue;
        x.voice = { ...voice, ...(x.voice?.used && { used: x.voice.used }) }; x.music = cur.music;
        x.log.push({ at: now(), text: `Voice-over and music copied from part ${cur.series.part}` }); save(x); updated++;
      }
      return json(res, 200, { updated });
    }
    if (action === '/move' && req.method === 'POST') {
      const f = String((await body(req)).folder || '').trim().slice(0, 60); cur.folder = f; putQuiet(cur);
      if (f && !(getSettings().folders || []).includes(f)) putSettings({ folders: [...(getSettings().folders || []), f] });
      return json(res, 200, { folder: f });
    }
    if (action === '/stop' && req.method === 'POST') { stopBuild(slug); return json(res, 200, load(slug));
    }
    if (action === '/note' && req.method === 'POST') {
      const b = await body(req);
      if (b.text) cur.notes.push({ from: 'user', text: String(b.text).slice(0, 4000), at: now(), read: false });
      return json(res, 200, save(cur));
    }
  }
  json(res, 404, { error: 'not found' });
}

// ---------- Settings: API keys (values never leave the server), defaults, voices, preview ----------
async function settingsApi(req, res, p, u) {
  const M = req.method, b = M === 'GET' ? {} : await body(req);
  let m;
  if (p === '/api/keys' && M === 'GET') return json(res, 200, keys.listKeys());
  if (p === '/api/keys' && M === 'POST') { keys.addKey(b.env, b.value, b.label); return json(res, 200, keys.listKeys()); }
  if (p === '/api/keys/import' && M === 'POST') return json(res, 200, { ...keys.importFrom(b.path), providers: keys.listKeys() });
  if ((m = p.match(/^\/api\/keys\/([0-9a-f]{12})$/)) && M === 'PATCH') { keys.updateKey(m[1], b); return json(res, 200, keys.listKeys()); }
  if ((m = p.match(/^\/api\/keys\/([A-Z0-9_]+)\/([0-9a-f]{12})$/)) && M === 'DELETE') { keys.removeKey(m[1], m[2]); return json(res, 200, keys.listKeys()); }
  if ((m = p.match(/^\/api\/keys\/([A-Z0-9_]+)\/order$/)) && M === 'PUT') { keys.reorderKeys(m[1], b.ids || []); return json(res, 200, keys.listKeys()); }
  if ((m = p.match(/^\/api\/keys\/([A-Z0-9_]+)\/([0-9a-f]{12})\/test$/)) && M === 'POST') return json(res, 200, { ...(await keys.testKey(m[1], m[2])), providers: keys.listKeys() });
  if (p === '/api/settings' && M === 'GET') return json(res, 200, getSettings());
  if (p === '/api/settings' && M === 'PUT') return json(res, 200, putSettings(b));
  if (p === '/api/settings/agents' && M === 'GET') return json(res, 200, await agentInfo(u.searchParams.has('refresh')));
  if (p === '/api/providers' && M === 'GET') {
    const lang = u.searchParams.get('lang') || getSettings().lang;
    return json(res, 200, Object.keys(NAMES).map((id) => ({ id, name: NAMES[id], available: available(id), supports: supports(id, lang), env: KEYENV[id] || null })));
  }
  if (p === '/api/voices' && M === 'GET') return json(res, 200, await listVoices(u.searchParams.get('provider'), u.searchParams.get('lang') || 'id'));
  if (p === '/api/voice/preview' && M === 'POST') { // same router as the build, so what you hear is what the video gets
    const text = String(b.text || '').trim().slice(0, 400); if (!text) return json(res, 400, { error: 'nothing to say' });
    const logs = [], cfg = { on: true, provider: b.provider || 'auto', lang: b.lang || 'id', voice: b.voice || '', speed: +b.speed || 1 };
    const r = await synthProject([{ n: 0, start: 0, end: 0, narration: text }], cfg, path.join(ROOT, '.cache', 'preview'), (l) => logs.push(l)).catch((e) => { throw new Error([e.message, ...logs].join(' · ')); });
    const f = r.lines[0]?.file; if (!f) return json(res, 500, { error: logs.join(' · ') || 'no audio' });
    res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store', 'X-VO-Provider': r.used.provider, 'X-VO-Voice': encodeURIComponent(r.used.voice), 'X-VO-Log': encodeURIComponent(logs.join(' · ')) });
    return fs.createReadStream(f).pipe(res);
  }
  return json(res, 404, { error: 'not found' });
}

const cmd = process.argv[2];
if (cmd === 'serve') {
  const port = PORT = +arg('--port', 4790);
  // a build/script run lives in this process: after a restart nothing is running any more, so unstick those projects
  if (!MANUAL) for (const d of fs.readdirSync(PROJECTS)) if (fs.existsSync(pfile(d))) {
    const x = load(d);
    if (x.status === 'building' || x.status === 'queued') { const was = x.status; x.status = x.final ? 'done' : 'script-ready'; x.log.push({ at: now(), text: `The ${was === 'queued' ? 'queue was cleared' : 'build stopped'} when the studio restarted. Press Continue: finished clips are kept.` }); save(x); }
    else if (x.status === 'writing-script') { x.status = x.scenes?.length ? 'script-ready' : 'error'; x.log.push({ at: now(), text: 'Script generation stopped when the studio restarted. Press Regenerate script to try again.' }); save(x); }
  }
  // builds run in their own process group: take them down with the studio instead of leaving orphans that still write into projects
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { killAll(); process.exit(0); });
  http.createServer((req, res) => handle(req, res).catch((e) => json(res, 500, { error: String(e) }))).listen(port, '127.0.0.1', () => console.log(`Animix: http://localhost:${port}`));
} else if (cmd === 'new') {
  const slug = process.argv[3]; if (!slugOk(slug)) { console.error('slug: lowercase letters, digits, hyphens'); process.exit(2); }
  const data = JSON.parse(fs.readFileSync(process.argv[4], 'utf8'));
  const p = { ...blank(slug), ...data, slug, status: 'ready', log: [{ at: now(), text: 'Script and scenes written by Claude' }] };
  save(p); console.log(`project ${slug}: ${p.scenes.length} scenes → http://localhost:4790/?p=${slug}`);
} else if (cmd === 'wait') {
  const slug = process.argv[3], timeout = +arg('--timeout', 3600) * 1000, t0 = Date.now();
  const tick = () => {
    const p = load(slug), unread = p.notes.filter((n) => n.from === 'user' && !n.read);
    if (p.status === 'build-requested' || unread.length) {
      unread.forEach((n) => (n.read = true));
      const event = p.status === 'build-requested' ? 'build' : 'note';
      if (event === 'build') { p.status = 'building'; p.log.push({ at: now(), text: 'Claude picked up the build' }); }
      save(p); console.log(JSON.stringify({ event, notes: unread.map((n) => n.text), project: p }, null, 1)); process.exit(0);
    }
    if (Date.now() - t0 > timeout) { console.log(JSON.stringify({ event: 'timeout' })); process.exit(0); }
    setTimeout(tick, 1500);
  };
  tick();
} else if (cmd === 'progress') {
  const slug = process.argv[3], p = load(slug), text = process.argv[4] || '';
  const sc = arg('--scene'), clip = arg('--clip'), st = arg('--status');
  if (sc) { const s = p.scenes.find((x) => String(x.n) === String(sc)); if (s) { if (clip) { s.clip = clip; delete s.stale; } s.status = clip ? 'done' : 'building'; } }
  if (st) p.status = st;
  if (text) p.log.push({ at: now(), text });
  save(p); console.log('ok');
} else if (cmd === 'done') {
  const slug = process.argv[3], p = load(slug); p.final = process.argv[4]; p.status = 'done'; p.savedPath = publishFinal(p); p.log.push({ at: now(), text: 'Finished: ' + (p.savedPath || p.final) }); save(p); console.log('ok');
} else if (cmd === 'reply') {
  const slug = process.argv[3], p = load(slug); p.notes.push({ from: 'claude', text: process.argv[4] || '', at: now(), read: true }); save(p); console.log('ok');
} else if (cmd === 'show') {
  console.log(JSON.stringify(load(process.argv[3]), null, 1));
} else {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 10).join('\n'));
}
