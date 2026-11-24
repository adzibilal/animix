// Dashboard: every video project as a card, in folders (drag a card onto a folder, or ⋯ → Move to).
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const api = async (url, opts = {}) => { const r = await fetch(url, { cache: 'no-store', headers: { 'Content-Type': 'application/json' }, ...opts }); const j = await r.json(); if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status); return j; };
const post = (url, data) => api(url, { method: 'POST', body: JSON.stringify(data) });
const ALL = '', NONE = '__none';
let LIST = [], FOLDERS = [], folder = new URLSearchParams(location.search).get('f') ?? ALL, status = 'all';

const FOLDER_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
const GRID_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/></svg>';
const INBOX_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 13h4l1.5 2h5L16 13h4M5 6h14l1 7v5H4v-5z"/></svg>';
const STATUS = { // filter group, label
  done: ['done', 'Done'], building: ['building', 'Generating'], queued: ['building', 'In queue'], 'build-requested': ['building', 'Waiting'], 'writing-script': ['script', 'Writing script'],
  'script-ready': ['script', 'Script ready'], ready: ['script', 'Script ready'], draft: ['script', 'Draft'], error: ['error', 'Error'],
};
const group = (p) => STATUS[p.status]?.[0] || 'script';
const time = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
function ago(iso) {
  const s = (Date.now() - new Date(iso)) / 1000;
  if (!iso || isNaN(s)) return '';
  if (s < 60) return 'just now'; if (s < 3600) return `${Math.floor(s / 60)} min ago`; if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} d ago`;
  return new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short' });
}
function toast(msg, kind = 'ok') {
  let t = $('#toast'); if (!t) { t = document.createElement('div'); t.id = 'toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
  t.textContent = msg; t.className = `toast ${kind} show`; clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), kind === 'ok' ? 2200 : 6000);
}

async function load() {
  [LIST, FOLDERS] = await Promise.all([api('/api/projects'), api('/api/folders')]);
  if (folder !== ALL && folder !== NONE && !FOLDERS.includes(folder)) folder = ALL;
  render();
}
const inFolder = (p) => folder === ALL || (folder === NONE ? !p.folder : p.folder === folder);

function renderFolders() {
  const count = (f) => LIST.filter((p) => (f === ALL ? true : f === NONE ? !p.folder : p.folder === f)).length;
  const COLORS = ['#6226FF', '#10B981', '#F97316', '#FBBF24', '#F43F5E', '#8B5CF6', '#34D399', '#14142B']; // Animix spectrum, one per folder
  const row = (f, label, icon, extra = '') => `<a href="?f=${encodeURIComponent(f)}" class="dfolder ${f === folder ? 'on' : ''}" data-f="${esc(f)}" ${FOLDERS.includes(f) ? `style="--fc:${COLORS[FOLDERS.indexOf(f) % COLORS.length]}"` : ''} ${f === folder ? 'aria-current="page"' : ''}>${icon}<span class="fl">${esc(label)}</span><span class="fc">${count(f)}</span>${extra}</a>`;
  $('#folders').innerHTML = row(ALL, 'All videos', GRID_ICON) + row(NONE, 'Not in a folder', INBOX_ICON)
    + (FOLDERS.length ? '<div class="dsep">Folders</div>' : '')
    + FOLDERS.map((f) => row(f, f, FOLDER_ICON, `<button class="fmore" data-folder="${esc(f)}" title="Rename or delete" aria-label="Folder options">⋯</button>`)).join('');
  const done = LIST.filter((p) => p.status === 'done');
  $('#stats').textContent = LIST.length ? `${LIST.length} videos · ${done.length} done · ${time(done.reduce((a, p) => a + p.seconds, 0))} of finished video` : '';
}

function sorted(list) {
  const sort = $('#sort').value;
  if (sort === 'title') return list.sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }));
  const key = sort === 'created' ? 'createdAt' : 'updatedAt', latest = {};
  for (const p of list) { const g = p.series?.id || p.slug; if ((p[key] || '') > (latest[g] || '')) latest[g] = p[key] || ''; }
  // the parts of a series stay together, in order
  return list.sort((a, b) => (latest[b.series?.id || b.slug]).localeCompare(latest[a.series?.id || a.slug]) || (a.series?.id || a.slug).localeCompare(b.series?.id || b.slug) || (a.series?.part || 0) - (b.series?.part || 0));
}

function card(p) {
  let [g, label] = STATUS[p.status] || ['script', p.status]; const wide = p.format === '16:9' ? 'wide' : p.format === '1:1' ? 'square' : '';
  const prog = p.status === 'building' && p.scenes ? `<div class="vprog" title="${p.done} of ${p.scenes} scenes rendered"><i style="width:${Math.round((p.done / p.scenes) * 100)}%"></i></div>` : '';
  if (p.status === 'queued' && p.queue > 0) label = `In queue · #${p.queue + 1}`;
  return `<article class="vcard" data-slug="${p.slug}" draggable="true">
    <a href="/?p=${p.slug}" class="vlink" aria-label="Open ${esc(p.title)}"></a>
    <div class="vthumb ${wide}">
      <img loading="lazy" alt="" src="/thumb/project/${p.slug}.jpg?v=${encodeURIComponent(p.updatedAt || '')}" onerror="this.remove()">
      <span class="vstatus st-${g}">${g === 'building' || p.status === 'writing-script' ? '<span class="pulse"></span>' : ''}${esc(label)}</span>
      ${p.series ? `<span class="vpart">Part ${p.series.part}/${p.series.of}</span>` : ''}
      ${p.seconds ? `<span class="vdur">${time(p.seconds)}</span>` : ''}
      ${prog}
    </div>
    <div class="vbody">
      <h3 class="vtitle" title="${esc(p.title)}">${esc(p.title)}</h3>
      <p class="vmeta">${esc(p.styleName || 'no style')} · ${esc(p.format || '')} · ${p.scenes} scenes</p>
      <p class="vmeta">${p.folder && folder === ALL ? `<span class="vfolder">${FOLDER_ICON}${esc(p.folder)}</span> · ` : ''}${ago(p.updatedAt)}</p>
    </div>
    <button class="vmore" data-slug="${p.slug}" title="More" aria-label="More actions for ${esc(p.title)}">⋯</button>
  </article>`;
}

function render() {
  renderFolders();
  const q = $('#q').value.trim().toLowerCase();
  const here = LIST.filter(inFolder), shown = sorted(here.filter((p) => (status === 'all' || group(p) === status) && (!q || `${p.title} ${p.idea} ${p.styleName} ${p.folder}`.toLowerCase().includes(q))));
  $('#fname').textContent = folder === ALL ? 'All videos' : folder === NONE ? 'Not in a folder' : folder;
  $('#fsub').textContent = `${here.length} video${here.length === 1 ? '' : 's'}${shown.length !== here.length ? ` · ${shown.length} shown` : ''}`;
  const n = (g) => here.filter((p) => group(p) === g).length;
  $('#statusSeg').innerHTML = [['all', 'All', here.length], ['script', 'Scripts', n('script')], ['building', 'Generating', n('building')], ['done', 'Done', n('done')], ['error', 'Error', n('error')]]
    .filter(([k, , c]) => k === 'all' || c || k === status).map(([k, l, c]) => `<button type="button" data-s="${k}" class="${k === status ? 'on' : ''}" role="tab" aria-selected="${k === status}">${l} <span>${c}</span></button>`).join('');
  $('#grid').innerHTML = shown.map(card).join('');
  const newHref = folder !== ALL && folder !== NONE ? `/?new&folder=${encodeURIComponent(folder)}` : '/?new';
  $('#newBtn').href = newHref;
  const empty = !shown.length; $('#emptyMsg').hidden = !empty;
  if (empty) $('#emptyMsg').innerHTML = q || status !== 'all' ? `<p>No videos match.</p><button class="ghost" id="clearF">Clear filters</button>`
    : `<div class="dempty-art">${FOLDER_ICON}</div><h2>${folder === ALL ? 'No videos yet' : 'This folder is empty'}</h2><p>${folder === ALL ? 'Start with a title idea; Claude writes the script, you review it, the video gets made.' : 'Drag videos here, or make a new one in this folder.'}</p><a class="primary" href="${newHref}">+ New video</a>`;
  document.title = `${folder === ALL ? 'Dashboard' : $('#fname').textContent} · Animix`;
}

// ---------- navigation and filters ----------
function goFolder(f) { folder = f; history.replaceState(null, '', f === ALL ? '/dashboard' : '/dashboard?f=' + encodeURIComponent(f)); render(); }
$('#folders').addEventListener('click', (e) => {
  const more = e.target.closest('.fmore');
  if (more) { e.preventDefault(); e.stopPropagation(); return folderMenu(more.dataset.folder, more); }
  const a = e.target.closest('.dfolder'); if (a) { e.preventDefault(); goFolder(a.dataset.f); }
});
$('#statusSeg').onclick = (e) => { const b = e.target.closest('button'); if (b) { status = b.dataset.s; render(); } };
$('#sort').onchange = render;
$('#q').oninput = render;
$('#emptyMsg').onclick = (e) => { if (e.target.id === 'clearF') { $('#q').value = ''; status = 'all'; render(); } };
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) { e.preventDefault(); $('#q').focus(); }
  if (e.key === 'Escape') closeMenu();
});
try { $('#sort').value = localStorage.getItem('vs.sort') || 'recent'; } catch {}
$('#sort').addEventListener('change', () => { try { localStorage.setItem('vs.sort', $('#sort').value); } catch {} });

// ---------- folders ----------
async function folderDo(data, msg) { try { FOLDERS = await post('/api/folders', data); LIST = await api('/api/projects'); toast(msg); return true; } catch (e) { toast(e.message, 'bad'); return false; } }
$('#newFolder').onclick = async () => {
  const name = (prompt('Name of the new folder') || '').trim(); if (!name) return;
  if (await folderDo({ op: 'create', name }, `Folder “${name}” created`)) goFolder(name);
};
function folderMenu(f, at) {
  openMenu(at, [
    ['Rename…', async () => { const to = (prompt('Rename the folder', f) || '').trim(); if (to && to !== f && await folderDo({ op: 'rename', name: f, to }, 'Folder renamed')) goFolder(folder === f ? to : folder); }],
    ['Delete folder', async () => {
      const n = LIST.filter((p) => p.folder === f).length;
      if (!confirm(`Delete the folder “${f}”?${n ? ` Its ${n} video${n > 1 ? 's stay' : ' stays'}, just without a folder.` : ''}`)) return;
      if (await folderDo({ op: 'delete', name: f }, 'Folder deleted')) goFolder(folder === f ? ALL : folder);
    }, 'bad'],
  ]);
}

// ---------- a video's menu: open, move ----------
async function move(slug, f) {
  const p = LIST.find((x) => x.slug === slug); if (!p || p.folder === f) return;
  try { await post(`/api/project/${slug}/move`, { folder: f }); p.folder = f; if (f && !FOLDERS.includes(f)) FOLDERS.push(f); render(); toast(f ? `Moved to “${f}”` : 'Removed from the folder'); }
  catch (e) { toast(e.message, 'bad'); }
}
async function delProject(slug) {
  const p = LIST.find((x) => x.slug === slug); if (!p) return;
  const busy = ['building', 'build-requested'].includes(p.status);
  if (!confirm(`Delete "${p.title || slug}"?${busy ? ' This will stop the active build.' : ''} All clips and files in this project will be permanently removed.`)) return;
  try {
    await api(`/api/project/${slug}`, { method: 'DELETE' });
    LIST = LIST.filter((x) => x.slug !== slug);
    render();
    toast(`Deleted "${p.title || slug}"`);
  } catch (e) { toast(e.message, 'bad'); }
}
async function delSeries(parts) {
  const title = parts[0]?.series?.title || 'this series';
  if (!confirm(`Delete all ${parts.length} parts of "${title}"? All clips and files will be permanently removed.`)) return;
  try {
    for (const part of parts) {
      await api(`/api/project/${part.slug}`, { method: 'DELETE' });
      LIST = LIST.filter((x) => x.slug !== part.slug);
    }
    render();
    toast(`Deleted ${parts.length} parts of "${title}"`);
  } catch (e) { render(); toast(e.message, 'bad'); }
}
function videoMenu(slug, at) {
  const p = LIST.find((x) => x.slug === slug);
  const parts = p.series ? LIST.filter((x) => x.series?.id === p.series.id) : [p];
  const moveAll = (f) => parts.forEach((x) => move(x.slug, f));
  openMenu(at, [
    ['Open', () => (location.href = '/?p=' + slug)],
    ...(p.final ? [['Play the video', () => window.open(`/files/${slug}/${p.final}`, '_blank')]] : []),
    '-', 'Move to',
    ...FOLDERS.filter((f) => f !== p.folder).map((f) => [`${f}`, () => move(slug, f), '', FOLDER_ICON]),
    ['New folder…', async () => { const f = (prompt('Name of the new folder') || '').trim(); if (f) move(slug, f); }],
    ...(p.folder ? [['Remove from “' + p.folder + '”', () => move(slug, '')]] : []),
    ...(parts.length > 1 ? ['-', `All ${parts.length} parts of this series`, ...FOLDERS.filter((f) => parts.some((x) => x.folder !== f)).slice(0, 6).map((f) => [`→ ${f}`, () => moveAll(f)])] : []),
    '-',
    ['Delete video', () => delProject(slug), 'bad'],
    ...(parts.length > 1 ? [[`Delete all ${parts.length} parts`, () => delSeries(parts), 'bad']] : []),
  ]);
}
function openMenu(at, items) {
  const m = $('#menu');
  m.innerHTML = items.map((it, i) => it === '-' ? '<hr>' : typeof it === 'string' ? `<div class="mlabel">${esc(it)}</div>` : `<button data-i="${i}" class="${it[2] || ''}" role="menuitem">${it[3] || ''}${esc(it[0])}</button>`).join('');
  m.hidden = false;
  const r = at.getBoundingClientRect(), w = m.offsetWidth, h = m.offsetHeight;
  m.style.left = Math.max(8, Math.min(r.right - w, innerWidth - w - 8)) + 'px';
  m.style.top = (r.bottom + h + 8 > innerHeight ? Math.max(8, r.top - h - 4) : r.bottom + 4) + 'px';
  m.onclick = (e) => { const b = e.target.closest('button'); if (!b) return; closeMenu(); items[+b.dataset.i][1](); };
  m.querySelector('button')?.focus();
  setTimeout(() => document.addEventListener('click', closeMenu, { once: true }), 0);
}
function closeMenu() { $('#menu').hidden = true; }
$('#grid').addEventListener('click', (e) => { const b = e.target.closest('.vmore'); if (b) { e.preventDefault(); e.stopPropagation(); videoMenu(b.dataset.slug, b); } });
$('#grid').addEventListener('contextmenu', (e) => { const c = e.target.closest('.vcard'); if (c) { e.preventDefault(); videoMenu(c.dataset.slug, c.querySelector('.vmore')); } });

// ---------- drag a card onto a folder ----------
$('#grid').addEventListener('dragstart', (e) => { const c = e.target.closest('.vcard'); if (!c) return; e.dataTransfer.setData('text/x-vs', c.dataset.slug); e.dataTransfer.effectAllowed = 'move'; c.classList.add('dragging'); document.body.classList.add('dragging'); });
$('#grid').addEventListener('dragend', (e) => { e.target.closest('.vcard')?.classList.remove('dragging'); document.body.classList.remove('dragging'); });
$('#folders').addEventListener('dragover', (e) => { const a = e.target.closest('.dfolder'); if (!a || a.dataset.f === ALL) return; e.preventDefault(); document.querySelectorAll('.dfolder.drop').forEach((x) => x !== a && x.classList.remove('drop')); a.classList.add('drop'); });
$('#folders').addEventListener('dragleave', (e) => { const a = e.target.closest('.dfolder'); if (a && !a.contains(e.relatedTarget)) a.classList.remove('drop'); });
$('#folders').addEventListener('drop', (e) => {
  const a = e.target.closest('.dfolder'), slug = e.dataTransfer.getData('text/x-vs'); if (!a || !slug) return;
  e.preventDefault(); a.classList.remove('drop'); move(slug, a.dataset.f === NONE ? '' : a.dataset.f);
});

// ---------- hover a finished video to see it move ----------
$('#grid').addEventListener('mouseover', (e) => {
  const c = e.target.closest('.vcard'); if (!c || c.querySelector('video')) return;
  const p = LIST.find((x) => x.slug === c.dataset.slug); if (!p?.final) return;
  const v = document.createElement('video'); Object.assign(v, { src: `/files/${p.slug}/${p.final}`, muted: true, loop: true, playsInline: true, autoplay: true, preload: 'auto' });
  c.querySelector('.vthumb').appendChild(v);
  c.addEventListener('mouseleave', () => v.remove(), { once: true });
});

// live: cards update while Claude writes or builds
setInterval(async () => {
  if (!LIST.some((p) => ['building', 'queued', 'build-requested', 'writing-script'].includes(p.status)) || !$('#menu').hidden) return;
  try { LIST = await api('/api/projects'); render(); } catch {}
}, 4000);
// free the space the stitch step left behind (per-scene parts, the silent cut, the music bed) once a video is finished
async function checkCleanup() {
  const r = await api('/api/cleanup').catch(() => null), b = $('#cleanBtn');
  b.hidden = !r || r.bytes < 20 * 1024 * 1024;
  if (r) b.textContent = `Free up ${(r.bytes / 1024 ** 3 >= 1 ? (r.bytes / 1024 ** 3).toFixed(1) + ' GB' : Math.round(r.bytes / 1024 ** 2) + ' MB')}`;
}
$('#cleanBtn').onclick = async () => {
  if (!confirm('Delete the temporary stitch files of finished videos? The final videos, clips and scripts stay. (A new stitch makes them again if needed.)')) return;
  try { const r = await post('/api/cleanup', {}); toast(`Freed ${Math.round(r.bytes / 1024 ** 2)} MB`); } catch (e) { toast(e.message, 'bad'); }
  checkCleanup();
};
load().then(checkCleanup).catch((e) => toast('Could not load the videos: ' + e.message, 'bad'));
