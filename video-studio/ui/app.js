// Animix UI: new video wizard (title ideas → title → parts → voice-over) → Claude writes the scripts → you review/validate → Claude generates the video.
const $ = (s) => document.querySelector(s);
const api = async (url, opts = {}) => { const r = await fetch(url, { cache: 'no-store', headers: { 'Content-Type': 'application/json' }, ...opts }); return r.json(); };
let SET = null, PROVS = [], CAT = null, P = null, slug = new URLSearchParams(location.search).get('p'), dirty = false, saveTimer = null, selected = null;

const toolById = (id) => CAT.tools.find((t) => t.id === id);
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

// ---------- style picker of the new video (thumbnails; hover plays the example) ----------
let toolTab = '';
const styleOf = (t, s) => toolById(t)?.styles.find((x) => x.id === s);
function renderCatalog() {
  const f = $('#filter').value.trim().toLowerCase(), cards = [];
  $('#toolTabs').innerHTML = [['', 'All'], ...CAT.tools.map((t) => [t.id, t.name])].map(([id, n]) => `<button type="button" class="${id === toolTab ? 'on' : ''}" data-t="${id}">${esc(n)}</button>`).join('');
  for (const t of CAT.tools) {
    if (toolTab && t.id !== toolTab) continue;
    for (const st of t.styles) {
      if (f && !`${t.name} ${st.name}`.toLowerCase().includes(f)) continue;
      const on = selected?.tool === t.id && selected?.style === st.id;
      cards.push(`<button type="button" class="sty ${on ? 'on' : ''} ${st.example ? '' : 'noex'}" data-tool="${t.id}" data-style="${st.id}" ${on ? 'aria-pressed="true"' : ''}>
        <span class="sty-th">${st.example ? `<img loading="lazy" alt="" src="/thumb/style/${t.id}/${st.id}.jpg">` : '<i>preview still rendering</i>'}</span>
        <span class="sty-n">${esc(st.name)}</span>${toolTab || st.name === t.name ? '' : `<span class="sty-t">${esc(t.name)}</span>`}</button>`);
    }
  }
  $('#catalog').innerHTML = cards.join('') || '<p class="muted">No style matches.</p>';
}
function renderStyleCur() {
  const t = selected && toolById(selected.tool), st = selected && styleOf(selected.tool, selected.style);
  $('#styleCur').innerHTML = st ? `<span class="sty-th">${st.example ? `<img alt="" src="/thumb/style/${t.id}/${st.id}.jpg">` : ''}</span>
    <span class="style-txt"><span><b>${esc(st.name)}</b>${st.name !== t.name ? ` <span class="muted">· ${esc(t.name)}</span>` : ''}</span><span class="muted">${esc(t.what || '')}${t.speed ? ` · ${esc(t.speed)}` : ''}</span></span>
    <button type="button" id="changeStyle" class="ghost small">${$('#stylePick').hidden ? 'Change style' : 'Done'}</button>` : '<span class="muted">Pick the look of the video below.</span>';
  $('#styleCur').querySelector('#changeStyle')?.addEventListener('click', () => { $('#stylePick').hidden = !$('#stylePick').hidden; if (!$('#stylePick').hidden) renderCatalog(); renderStyleCur(); });
}
$('#toolTabs').onclick = (e) => { const b = e.target.closest('button'); if (b) { toolTab = b.dataset.t; renderCatalog(); } };
$('#catalog').onclick = (e) => {
  const b = e.target.closest('.sty'); if (!b) return;
  select(b.dataset.tool, b.dataset.style); $('#stylePick').hidden = true; renderStyleCur();
  try { localStorage.setItem('vs.style', `${b.dataset.tool}/${b.dataset.style}`); } catch {}
};
$('#catalog').addEventListener('mouseover', (e) => {
  const b = e.target.closest('.sty'); if (!b || b.querySelector('video')) return;
  const st = styleOf(b.dataset.tool, b.dataset.style); if (!st?.example) return;
  const v = document.createElement('video'); Object.assign(v, { src: '/' + st.example, muted: true, loop: true, playsInline: true, autoplay: true });
  b.querySelector('.sty-th').appendChild(v); b.addEventListener('mouseleave', () => v.remove(), { once: true });
});
function select(toolId, styleId) {
  const t = toolById(toolId); if (!t) return;
  const st = t.styles.find((s) => s.id === styleId) || t.styles.find((s) => s.example) || t.styles[0];
  if (!st) return;
  selected = { tool: toolId, style: st.id };
  if (!P) return renderStyleCur(), renderWizard(); // the new-video page has no stage: the picker shows the style
  setStage('style', st.name !== t.name ? st.name : t.name, st.name !== t.name ? `${t.name} · style example` : 'style example');
  if (st.example) { $('#noVideo').hidden = true; showVideo('/' + st.example); } else { const v = $('#player'); v.pause(); v.removeAttribute('src'); v.load(); $('#noVideo').hidden = false; $('#noVideo').innerHTML = `No preview of <b>${esc(st.name)}</b> yet: it is rendering in the background.<br>You can still pick this style and write a prompt.`; }
  const kind = t.example === 'fire' ? 'the discovery of fire' : t.example;
  $('#toolInfo').innerHTML = `<span>${esc(t.what)}</span>${t.speed ? `<span><b>Speed</b> ${esc(t.speed)}</span>` : ''}${kind ? `<span><b>Example</b> ${esc(kind)}</span>` : ''}`;

}
// the stage plays a style example (muted loop), a scene's clip or the final video (with controls and sound)
let stageMode = 'style', stageScene = null;
function showVideo(src, { loop = true, controls = false, sound = false } = {}) {
  const v = $('#player'); v.loop = loop; v.controls = controls; $('#noVideo').hidden = true;
  $('#mute').hidden = controls;
  if (v.getAttribute('src') !== src) { v.src = src; }
  if (sound) v.muted = false;
  v.play().catch(() => { v.muted = true; v.play().catch(() => {}); });
}
function setStage(mode, title, sub = '') {
  stageMode = mode; $('#previewTitle').textContent = title; $('#previewSub').textContent = sub;
  $('#playFinal').classList.toggle('on', mode === 'final');
  document.querySelectorAll('.scene.playing').forEach((el) => el.classList.remove('playing'));
  if (mode !== 'final') stageScene = null;
}
function playFinal(sound = true) {
  if (!P?.final) return;
  showVideo('/files/' + P.slug + '/' + P.final + '?v=' + encodeURIComponent(P.updatedAt || ''), { loop: false, controls: true, sound });
  setStage('final', 'Final video', `${P.format || ''} · ${Math.max(0, ...P.scenes.map((s) => +s.end || 0)).toFixed(0)} s`);
}
function playClip(s) {
  showVideo('/files/' + P.slug + '/' + s.clip, { loop: true, controls: true, sound: true });
  setStage('clip', `Scene ${s.n}`, `${s.start}–${s.end} s · rendered clip`);
  document.querySelector(`.scene[data-n="${s.n}"]`)?.classList.add('playing');
}
// while the final video plays, the scene being shown lights up in the script
$('#player').addEventListener('timeupdate', () => {
  if (stageMode !== 'final' || !P) return;
  const t = $('#player').currentTime, s = P.scenes.find((x) => t >= +x.start && t < +x.end);
  if (!s || s.n === stageScene) return;
  stageScene = s.n;
  document.querySelectorAll('.scene').forEach((el) => el.classList.toggle('playing', +el.dataset.n === s.n));
});
$('#mute').onclick = () => { const v = $('#player'); v.muted = !v.muted; $('#mute').textContent = v.muted ? '🔇' : '🔊'; };
$('#filter').oninput = renderCatalog;

// ---------- new video: idea → title → parts → voice-over → script (Claude writes, like Mochi Studio) ----------
let W = { ideas: [], voice: null };
const NEW_FOLDER = new URLSearchParams(location.search).get('folder'); // set when "+ New video" is pressed inside a dashboard folder
const VOICES = {}; // provider|lang → voice list
const LEN_PRESETS = ['0', '30', '45', '60', '90', '120', '180', '240', '300'];
const fmtDur = (sec) => { const s = Math.round(+sec || 0); if (!s) return 'auto'; const m = Math.floor(s / 60), r = s % 60; return m ? (r ? `${m}m ${r}s` : `${m}m`) : `${s}s`; };
const wzSecondsVal = () => $('#wzSeconds').value === '__custom' ? Math.max(10, Math.min(900, Math.round(+$('#wzSecondsCustom').value) || 0)) : +$('#wzSeconds').value;
const projSecondsVal = () => $('#targetSeconds').value === '__custom' ? Math.max(10, Math.min(900, Math.round(+$('#targetSecondsCustom').value) || 0)) : +$('#targetSeconds').value;
const wzParts = () => Math.max(1, Math.min(10, Math.round(+$('#wzParts').value) || 1));
const wzVoice = () => (W.voice ??= { on: true, provider: SET?.provider || 'auto', voice: '', speed: SET?.speed || 1 });
const wzKeep = () => { try { localStorage.setItem('vs.wizard', JSON.stringify({ ref: $('#wzRef').value, topic: $('#wzTopic').value, lang: $('#wzLang').value, title: $('#wzTitle').value, logline: $('#wzLogline').value, ideas: W.ideas })); } catch {} };
function wzRestore() {
  let d = null; try { d = JSON.parse(localStorage.getItem('vs.wizard')); } catch {}
  $('#wzLang').value = d?.lang || SET?.lang || 'id';
  renderRef(d?.ref);
  if (!d) return;
  $('#wzTopic').value = d.topic || ''; $('#wzTitle').value = d.title || ''; $('#wzLogline').value = d.logline || ''; W.ideas = d.ideas || [];
}
// format presets: a transcript of another video; Claude copies its format (hook, point of view, structure, ending), not its content
const presets = () => SET?.presets || [];
const curRef = () => presets().find((p) => p.id === $('#wzRef').value);
let refEditing = null; // null | 'new' | preset id
function renderRef(pick = $('#wzRef').value) {
  const sel = $('#wzRef');
  sel.innerHTML = '<option value="">None, free format</option>' + presets().map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('') + '<option value="__new">+ New preset from a transcript…</option>';
  sel.value = presets().some((p) => p.id === pick) ? pick : '';
  const r = curRef(), words = r ? r.transcript.replace(/\[[^\]]*\]/g, '').split(/\s+/).filter(Boolean).length : 0;
  $('#wzRefEdit').hidden = !r || !!refEditing;
  $('#wzRefInfo').textContent = r ? `${words} words, ~${Math.round(words / 2.6)} s · “${r.transcript.slice(0, 80)}…”` : 'Optional: paste a transcript of a video whose format you like';
  $('#wzRefForm').hidden = !refEditing; $('#wzRefDel').hidden = !refEditing || refEditing === 'new';
}
$('#wzRef').onchange = () => {
  if ($('#wzRef').value === '__new') { refEditing = 'new'; $('#wzRefName').value = $('#wzRefText').value = ''; renderRef(curRef()?.id || ''); $('#wzRefName').focus(); }
  else { refEditing = null; renderRef(); }
  wzKeep(); renderWizard();
};
$('#wzRefEdit').onclick = () => { const r = curRef(); refEditing = r.id; $('#wzRefName').value = r.name; $('#wzRefText').value = r.transcript; renderRef(); };
$('#wzRefCancel').onclick = () => { refEditing = null; renderRef(); };
async function savePresets(list, pick) {
  const r = await api('/api/settings', { method: 'PUT', body: JSON.stringify({ presets: list }) });
  if (r.error) return toast(r.error, 'bad');
  SET = r; refEditing = null; renderRef(pick); wzKeep(); renderWizard();
}
$('#wzRefSave').onclick = () => {
  const name = $('#wzRefName').value.trim(), transcript = $('#wzRefText').value.trim();
  if (!name || transcript.split(/\s+/).length < 20) return toast('Give the preset a name and paste a transcript (at least a few sentences)', 'warn');
  const list = presets().filter((p) => p.id !== refEditing);
  let id = refEditing !== 'new' ? refEditing : name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'preset';
  if (refEditing === 'new') { const base = id; let k = 2; while (list.some((p) => p.id === id)) id = `${base}-${k++}`; }
  const at = presets().findIndex((p) => p.id === refEditing), item = { id, name: name.slice(0, 80), transcript: transcript.slice(0, 20000) };
  at >= 0 ? list.splice(at, 0, item) : list.push(item);
  savePresets(list, id).then(() => toast(`Preset “${item.name}” saved`));
};
$('#wzRefDel').onclick = () => { const r = curRef(); if (r && confirm(`Delete the preset “${r.name}”?`)) savePresets(presets().filter((p) => p.id !== r.id), ''); };
async function ensureProvs(lang) { if (provLang !== lang) { PROVS = await api('/api/providers?lang=' + lang); provLang = lang; } }
function providerOptions(cur) {
  const chain = (SET?.priority || []).map((id) => PROVS.find((p) => p.id === id)).filter((p) => p && usable(p));
  return { chain, html: `<option value="auto" title="Tries ${(SET?.priority || []).map((p) => NAMES[p]).join(' → ')}">Auto${chain[0] ? ` (${NAMES[chain[0].id]} first)` : ''}</option>` + PROVS.map((p) =>
    `<option value="${p.id}" ${usable(p) || cur === p.id ? '' : 'disabled'}>${NAMES[p.id]}${!p.available ? (p.env ? ' (no key)' : ' (not installed)') : !p.supports ? ' (English only)' : ''}</option>`).join('') };
}
async function renderWizard() {
  if (P) return;
  const lang = $('#wzLang').value, n = wzParts(), title = $('#wzTitle').value.trim(), v = wzVoice();
  $('#wzIdeas').textContent = W.ideas.length ? '↻ More ideas' : '✦ Generate title ideas';
  $('#wzIdeas').className = W.ideas.length ? 'ghost small' : 'primary small'; // purple only for the next step
  $('#wzIdeaList').innerHTML = W.ideas.length ? W.ideas.map((x, i) => `<button type="button" class="idea ${x.title === title ? 'on' : ''}" data-i="${i}"><b>${esc(x.title)}</b><span>${esc(x.logline)}</span><i>“${esc(x.hook)}”</i></button>`).join('')
    : '<p class="muted">No ideas yet: generate some in step 1, or type your own title below.</p>';
  $('#wzPartsPick').innerHTML = [1, 2, 3, 5].map((k) => `<button type="button" class="${k === n ? 'on' : ''}" data-n="${k}">${k === 1 ? 'Just 1 video' : k + ' parts'}</button>`).join('');
  $('#wzPartsNote').textContent = n > 1 ? `${n} videos: “${title || 'Title'} (Part 1)” … “(Part ${n})”. Every part opens with a hook and ends on a cliffhanger (${lang === 'id' ? '“Lanjut part 2…”' : '“Part 2 next…”'}); the last part ends the story.` : 'One standalone video.';
  // voice-over, same router and keys as the project's voice bar
  await ensureProvs(lang);
  if (v.provider === 'kokoro' && lang !== 'en') v.provider = 'auto';
  const { chain, html } = providerOptions(v.provider), auto = v.provider === 'auto';
  $('#wzVoOn').checked = v.on; $('#wzProvider').innerHTML = html; $('#wzProvider').value = v.provider;
  $('#wzSpeed').value = v.speed; $('#wzSpeedVal').textContent = (+v.speed).toFixed(2) + '×';
  for (const el of ['#wzProvider', '#wzVoice', '#wzSpeed', '#wzPreview']) $(el).disabled = !v.on;
  const ready = auto ? chain.length > 0 : usable(PROVS.find((p) => p.id === v.provider) || {});
  $('#wzVoWarn').hidden = !v.on || ready; $('#wzVoWarn').innerHTML = `No voice provider is ready for ${LANGS[lang] || lang}. <a href="#settings">Add a key</a>`;
  const sel = $('#wzVoice'); sel.hidden = auto;
  if (!auto) {
    const key = `${v.provider}|${lang}`, cur = v.voice || SET?.voices?.[lang]?.[v.provider] || '';
    VOICES[key] ??= await api(`/api/voices?provider=${v.provider}&lang=${lang}`);
    sel.innerHTML = voiceOptions(VOICES[key], cur);
  }
  const st = selected && toolById(selected.tool)?.styles.find((s) => s.id === selected.style);
  const customLen = $('#wzSeconds').value === '__custom';
  $('#wzSecondsCustomWrap').hidden = !customLen;
  if (customLen) $('#wzSecondsHuman').textContent = `(${fmtDur(wzSecondsVal())})`;
  const sec = wzSecondsVal();
  $('#wzSummary').innerHTML = title ? `<b>${esc(title)}</b> · ${n > 1 ? n + ' parts' : '1 video'}${sec ? ` (~${fmtDur(sec)}/part)` : ''} · ${esc(st?.name || 'no style')}${curRef() ? ' · format: ' + esc(curRef().name) : ''} · ${LANGS[lang]} · ${v.on ? 'voice-over ' + (auto ? 'auto' : NAMES[v.provider]) : 'no voice-over'} · ${$('#newFormat').value}${NEW_FOLDER || n > 1 ? ` · folder “${esc(NEW_FOLDER || title)}”` : ''}` : 'Pick or write a title first (step 2).';
  $('#wzGo').disabled = !title || !selected;
  $('#wzGo').textContent = n > 1 ? `✦ Generate ${n} scripts` : '✦ Generate script';
  document.querySelectorAll('.wz-step').forEach((el) => el.classList.toggle('done', { 1: !!selected, 2: !!title, 3: !!title, 4: !!title }[el.dataset.step] || false));
}
$('#wzIdeas').onclick = async () => {
  if (!selected) return toast('Pick a style first', 'warn');
  const b = $('#wzIdeas'); b.disabled = true; $('#wzIdeasState').innerHTML = '<span class="dot"></span> Claude is thinking of titles…';
  const r = await api('/api/ideas', { method: 'POST', body: JSON.stringify({ topic: $('#wzTopic').value.trim(), lang: $('#wzLang').value, style: `${selected.tool}/${selected.style}`, avoid: W.ideas.map((x) => x.title), reference: curRef()?.transcript || '' }) }).catch((e) => ({ error: e.message }));
  b.disabled = false; $('#wzIdeasState').textContent = '';
  if (r.error) return toast('Title ideas failed: ' + r.error, 'bad');
  W.ideas = r.ideas; wzKeep(); renderWizard();
  $('[data-step="2"]').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
};
$('#wzIdeaList').onclick = (e) => {
  const b = e.target.closest('.idea'); if (!b) return;
  const x = W.ideas[+b.dataset.i]; $('#wzTitle').value = x.title; $('#wzLogline').value = x.logline; wzKeep(); renderWizard();
};
$('#wzPartsPick').onclick = (e) => { const b = e.target.closest('button'); if (b) { $('#wzParts').value = b.dataset.n; renderWizard(); } };
for (const id of ['#wzTopic', '#wzTitle', '#wzLogline']) $(id).addEventListener('input', () => { wzKeep(); if (id !== '#wzTopic') renderWizard(); });
for (const id of ['#wzParts', '#wzSeconds', '#wzSecondsCustom', '#newFormat', '#wzMusic']) $(id).addEventListener('change', renderWizard);
$('#wzSecondsCustom').addEventListener('input', renderWizard);
$('#wzLang').onchange = () => { wzVoice().voice = ''; wzKeep(); renderWizard(); };
$('#wzVoOn').onchange = () => { wzVoice().on = $('#wzVoOn').checked; renderWizard(); };
$('#wzProvider').onchange = () => { Object.assign(wzVoice(), { provider: $('#wzProvider').value, voice: '' }); renderWizard(); };
$('#wzVoice').onchange = () => { const id = pickVoice($('#wzVoice'), wzVoice().voice); if (id) { wzVoice().voice = id; renderWizard(); } };
$('#wzSpeed').oninput = () => { $('#wzSpeedVal').textContent = (+$('#wzSpeed').value).toFixed(2) + '×'; };
$('#wzSpeed').onchange = () => { wzVoice().speed = +$('#wzSpeed').value; };
$('#wzPreview').onclick = (e) => {
  const v = wzVoice(), lang = $('#wzLang').value, idea = W.ideas.find((x) => x.title === $('#wzTitle').value.trim());
  vsPlay(e.currentTarget, { provider: v.provider, lang, voice: v.provider === 'auto' ? '' : v.voice || SET?.voices?.[lang]?.[v.provider] || '', speed: v.speed, text: idea?.hook || $('#wzTitle').value.trim() || (lang === 'id' ? 'Halo, ini contoh suara narasi.' : 'Hi, this is how the narration sounds.') });
};
$('#wzGo').onclick = async () => {
  const v = wzVoice(), lang = $('#wzLang').value, b = $('#wzGo');
  b.disabled = true;
  const r = await api('/api/series', { method: 'POST', body: JSON.stringify({ title: $('#wzTitle').value.trim(), logline: $('#wzLogline').value.trim(), topic: $('#wzTopic').value.trim(), style: `${selected.tool}/${selected.style}`, lang,
    parts: wzParts(), seconds: wzSecondsVal(), format: $('#newFormat').value, music: $('#wzMusic').value,
    voice: { on: v.on, provider: v.provider, voice: v.provider === 'auto' ? '' : v.voice, speed: v.speed }, reference: curRef()?.transcript || '', referenceName: curRef()?.name || '', ...(NEW_FOLDER !== null && { folder: NEW_FOLDER }) }) }).catch((e) => ({ error: e.message }));
  b.disabled = false;
  if (r.error) return toast(r.error, 'bad');
  try { localStorage.setItem('vs.wizard', JSON.stringify({ ref: $('#wzRef').value, lang })); } catch {} // the format preset stays picked for the next video
  W = { ideas: [], voice: null }; $('#wzTopic').value = $('#wzTitle').value = $('#wzLogline').value = ''; $('#wzParts').value = 1;
  slug = r.slugs[0]; history.replaceState(null, '', '?p=' + slug);
  P = await api('/api/project/' + slug); lastStatus = P.status; await loadProjects(); renderProject();
  $('#main').scrollTo({ top: 0 });
};

// ---------- project ----------
$('#newVideo').onclick = async () => {
  if (dirty) await save();
  P = null; slug = null; dirty = false; lastStatus = null;
  history.replaceState(null, '', location.pathname);
  $('#finalModal').hidden = true; document.title = 'Animix';
  await loadProjects(); renderProject();
  $('#main').scrollTo({ top: 0, behavior: 'smooth' }); $('#wzTopic').focus({ preventScroll: true });
};
let PLIST = []; // every project (status of the other parts of a series)
async function loadProjects() {
  const list = PLIST = await api('/api/projects'), pick = $('#projectPick');
  const opt = (p) => `<option value="${p.slug}">${esc(p.title || p.slug)}</option>`, seen = new Set(); // parts of a series stay together, in order
  pick.innerHTML = '<option value="">New video</option>' + list.map((p) => {
    if (!p.series) return opt(p);
    if (seen.has(p.series.id)) return ''; seen.add(p.series.id);
    return `<optgroup label="${esc(p.series.title)} · ${p.series.of} parts">${list.filter((x) => x.series?.id === p.series.id).sort((a, b) => a.series.part - b.series.part).map(opt).join('')}</optgroup>`;
  }).join('');
  pick.value = slug || '';
  pick.onchange = () => { location.search = pick.value ? '?p=' + pick.value : ''; };
}
function toolOptions(cur) {
  let html = '<option value="">— pick —</option>', found = false;
  for (const t of CAT.tools) {
    const st = t.styles; if (!st.length) continue;
    html += `<optgroup label="${esc(t.name)}">` + st.map((s) => { const v = `${t.id}/${s.id}`; if (v === cur) found = true; return `<option value="${v}" ${v === cur ? 'selected' : ''}>${esc(s.name)}</option>`; }).join('') + '</optgroup>';
  }
  if (cur && !found) html += `<option value="${esc(cur)}" selected>${esc(cur)}</option>`;
  return html;
}
function renderScenes() {
  const list = $('#sceneRows'); list.innerHTML = '';
  const locked = ['building', 'queued', 'writing-script'].includes(P.status), projStyle = P.style || '';
  const field = (k, label, ph = '') => `<div class="fld f-${k}"><span class="lbl">${label}</span><textarea data-k="${k}" aria-label="${label}" placeholder="${ph}" rows="1"></textarea></div>`;
  P.scenes.forEach((s, i) => {
    const el = document.createElement('article'); el.className = `scene ${s.status || ''}`; el.dataset.n = s.n;
    el.innerHTML = `<header class="sc-head">
        <button class="sc-n" type="button" title="${s.clip ? 'Play this scene' : P.final ? 'Jump to this scene in the final video' : 'Scene ' + s.n}">${s.n}</button>
        <span class="sc-time"><input type="number" step="0.1" min="0" data-k="start" aria-label="Start (s)"><span>–</span><input type="number" step="0.1" min="0" data-k="end" aria-label="End (s)"><span class="unit">s</span></span>
        <span class="sc-dur"></span>
        <select data-k="tool" class="sc-tool ${s.tool === projStyle ? 'same' : ''}" title="Style of this scene">${toolOptions(s.tool)}</select>
        ${s.stale ? '<span class="sc-badge stale" title="Edited after its clip was rendered: the next build renders it again">edited</span>' : ''}
        ${s.clip ? '<button class="ghost small sc-clip" type="button">▶ Clip</button>' : s.status === 'building' ? '<span class="sc-state">rendering…</span>' : s.status === 'pending' && ['building', 'queued'].includes(P.status) ? '<span class="sc-state wait">waiting</span>' : ''}
        ${s.clip && !locked ? '<button class="ghost small sc-redo" type="button" title="Render only this scene again, then stitch">↻</button>' : ''}
        <button class="sc-del" type="button" title="Remove scene ${s.n}" aria-label="Remove scene ${s.n}">×</button>
      </header>
      <div class="sc-grid">
        ${field('visual', 'What we see')}
        <div class="fld f-narration"><span class="lbl">Narration <button class="say" type="button" title="Hear this line with the project's voice">▶ hear</button><em class="longnote"></em></span><textarea data-k="narration" aria-label="Narration" rows="1"></textarea></div>
        ${field('onscreen', 'On-screen text', '—')}${field('sound', 'Sound', '—')}${field('notes', 'Notes for Claude', 'specs for this scene…')}
      </div>`;
    const dur = () => { el.querySelector('.sc-dur').textContent = `${Math.max(0, (+s.end || 0) - (+s.start || 0)).toFixed(1)} s`; };
    el.querySelectorAll('[data-k]').forEach((x) => {
      const k = x.dataset.k; x.disabled = locked;
      if (x.tagName !== 'SELECT') x.value = s[k] ?? '';
      x.addEventListener(x.tagName === 'SELECT' ? 'change' : 'input', () => {
        s[k] = x.type === 'number' ? +x.value : x.value; touch();
        if (['start', 'end', 'narration'].includes(k)) { markLong(el, s); updateTotal(); dur(); }
        if (k === 'tool' && s.tool) { x.classList.toggle('same', s.tool === projStyle); const [t, st] = s.tool.split('/'); select(t, st); }
      });
    });
    dur(); markLong(el, s);
    const del = el.querySelector('.sc-del'); del.disabled = locked;
    del.onclick = () => { if (((s.visual || '') + (s.narration || '')).trim() && !confirm(`Remove scene ${s.n}?`)) return; P.scenes.splice(i, 1); P.scenes.forEach((x, j) => (x.n = j + 1)); renderScenes(); touch(); };
    el.querySelector('.sc-clip')?.addEventListener('click', () => playClip(s));
    el.querySelector('.sc-redo')?.addEventListener('click', () => { if (confirm(`Render scene ${s.n} again? Only this scene is rendered, then the video is stitched.`)) startBuild({ only: [s.n] }); });
    el.querySelector('.sc-n').onclick = () => {
      if (stageMode === 'final' || (!s.clip && P.final)) { if (stageMode !== 'final') playFinal(); $('#player').currentTime = +s.start + 0.01; $('#player').play().catch(() => {}); }
      else if (s.clip) playClip(s);
    };
    el.querySelector('.say').onclick = (e) => { if ((s.narration || '').trim()) previewVO(s.narration, e.currentTarget); };
    // focusing a scene's style previews it, except while you're watching this project's own video
    el.querySelector('select').addEventListener('focus', () => { if (s.tool && stageMode === 'style') { const [t, st] = s.tool.split('/'); select(t, st); } });
    if (stageScene === s.n || (stageMode === 'clip' && $('#previewTitle').textContent === `Scene ${s.n}`)) el.classList.add('playing');
    list.appendChild(el);
  });
  updateTotal();
}
// narration longer than its scene: it would run over into the next one. Measured on real Gemini lines: ~13 characters per second at
// speed 1 (words are a bad unit: "menghadiahkannya" is one word), and the line starts 0.15 s into its scene.
function markLong(tr, s) { // tr: the scene's element
  const text = (s.narration || '').trim(), words = text ? text.split(/\s+/).length : 0, need = text.length / 13 / (vo().speed || 1) + 0.15, room = (+s.end || 0) - (+s.start || 0);
  const long = P.voice?.on === true && words > 0 && need > room + 0.05;
  tr.querySelector('[data-k="narration"]').classList.toggle('long', long);
  tr.querySelector('.longnote').textContent = long ? ` ~${need.toFixed(1)} s for a ${room.toFixed(1)} s scene` : '';
}
function updateTotal() {
  const end = Math.max(0, ...P.scenes.map((s) => +s.end || 0));
  const words = P.scenes.map((s) => s.narration || '').join(' ').split(/\s+/).filter(Boolean).length;
  const long = document.querySelectorAll('#sceneRows textarea.long').length;
  const target = +P.targetSeconds > 0 ? ` (target ~${fmtDur(P.targetSeconds)})` : '';
  $('#total').innerHTML = `${P.scenes.length} scenes · ${end.toFixed(1)} s (${fmtDur(end)})${target} · ${words} words of narration` + (long ? ` · <span class="warn">${long} narration line${long > 1 ? 's' : ''} too long for the scene</span>` : '');
}
function styleNameOf(v) { const [t, s] = String(v || '').split('/'); const tool = toolById(t); const st = tool?.styles.find((x) => x.id === s); return st ? (st.name === tool.name ? tool.name : `${st.name} (${tool.name})`) : v; }
$('#projectStyle').onchange = () => {
  const v = $('#projectStyle').value; if (!P || !v) return;
  P.style = v; P.styleName = styleNameOf(v); P.scenes.forEach((s) => (s.tool = v));
  const [t, s] = v.split('/'); select(t, s);
  renderScenes(); renderProject(); touch();
};
function renderProject() {
  $('#empty').hidden = !!P; $('#proj').hidden = !P;
  $('#main').classList.toggle('has-proj', !!P);
  $('#main').classList.toggle('wide-video', P?.format === '16:9');
  if (!P) { $('#player').pause(); renderStyleCur(); return renderWizard(); }
  renderParts();
  $('#title').value = P.title || ''; $('#format').value = P.format || '9:16'; $('#music').value = P.music && P.music !== 'auto' ? P.music : 'lofi';
  const ts = String(Math.round(+P.targetSeconds || 0));
  const isPreset = LEN_PRESETS.includes(ts);
  $('#targetSeconds').value = isPreset ? ts : '__custom';
  $('#targetSecondsCustomWrap').hidden = isPreset;
  if (!isPreset) $('#targetSecondsCustom').value = ts;
  const locked = ['building', 'queued', 'writing-script'].includes(P.status);
  $('#targetSeconds').disabled = locked; $('#targetSecondsCustom').disabled = locked;
  $('#ideaLine').textContent = (P.styleName ? 'Style: ' + P.styleName + ' · ' : '') + (P.idea ? 'Prompt: ' + P.idea : '');
  const ps = $('#projectStyle'), cur = P.style || P.scenes.find((s) => s.tool)?.tool || '';
  ps.innerHTML = toolOptions(cur).replace('— pick —', 'Style: pick one'); ps.value = cur;
  ps.disabled = locked;
  renderVoice(); renderScenes(); renderLive(); renderSocial();
}

// ---------- series: every part's state, build them all (one after another), one narrator and one music bed ----------
const partOf = (s) => (s === P.slug ? P : PLIST.find((x) => x.slug === s));
const buildable = (x) => x && (x.scenes?.length ?? x.scenes) && !['done', 'building', 'queued', 'writing-script', 'build-requested'].includes(x.status);
function renderParts() {
  const sr = P.series; $('#partChips').hidden = false;
  const links = sr?.slugs ? '<span>Part</span>' + sr.slugs.map((s, i) => {
    const x = partOf(s), st = x?.status || '';
    return `<a href="?p=${s}" class="${s === P.slug ? 'on' : ''} ps-${st}" ${s === P.slug ? 'aria-current="page"' : ''} title="${esc(sr.title)} · part ${i + 1} of ${sr.of} · ${esc(STATUS[st] || st)}">${i + 1}</a>`;
  }).join('') : '';
  const left = sr?.slugs ? sr.slugs.filter((s) => buildable(partOf(s))).length : 0;
  const series = sr?.slugs?.length > 1 ? `<button id="seriesBuild" class="ghost small" type="button" ${left ? '' : 'disabled'} title="Queue every part that has a script and no video yet. They build one after another, each reusing the cast and world of the part before it.">▶ Build ${left || 'all'} part${left === 1 ? '' : 's'}</button><button id="seriesSync" class="ghost small" type="button" title="Copy this part's voice-over (provider, voice, speed) and music to every other part, so the narrator never changes">⇄ Same voice &amp; music</button>` : '';
  $('#partChips').innerHTML = links + series + `<button id="addPartBtn" class="add-part-btn" type="button" title="Add a new part continuing from this story" ${P.status === 'writing-script' ? 'disabled' : ''}>+ Add part</button>`;
}
$('#partChips').onclick = async (e) => {
  const b = e.target.closest('button'); if (!b || !P) return;
  if (b.id === 'addPartBtn') return openAddPartModal();
  if (dirty) await save();
  if (b.id === 'seriesBuild') {
    const n = P.series.slugs.filter((s) => buildable(partOf(s))).length;
    if (!confirm(`Build ${n} part${n > 1 ? 's' : ''} of this series, one after another? Each part reuses the cast and world of the part before it. This takes a while.`)) return;
    askNotify();
    const r = await api(`/api/project/${P.slug}/series/build`, { method: 'POST', body: '{}' });
    if (r.error) return toast(r.error, 'bad');
    toast(r.queued.length ? `${r.queued.length} part${r.queued.length > 1 ? 's' : ''} queued: they build one after another` : 'Nothing to build: every part is done or already queued', r.queued.length ? 'ok' : 'warn');
  } else if (b.id === 'seriesSync') {
    const v = vo();
    if (!confirm(`Use this part's voice-over (${v.on ? (v.provider === 'auto' ? (P.voice?.used ? `${NAMES[P.voice.used.provider]} · ${P.voice.used.voice}` : 'auto') : `${NAMES[v.provider]}${v.voice ? ' · ' + v.voice : ''}`) + ` · ${(+v.speed).toFixed(2)}×` : 'off'}) and music (${P.music}) for every other part?`)) return;
    const r = await api(`/api/project/${P.slug}/series/sync`, { method: 'POST', body: '{}' });
    if (r.error) return toast(r.error, 'bad');
    toast(`Voice-over and music copied to ${r.updated} part${r.updated === 1 ? '' : 's'}`);
  }
  P = await api('/api/project/' + P.slug); await loadProjects(); renderProject();
};

// ---------- voice-over (provider/voice/lang/speed per project; keys live in Settings) ----------
const NAMES = { gemini: 'Gemini', elevenlabs: 'ElevenLabs', fish: 'Fish Audio', edge: 'Edge TTS', kokoro: 'Kokoro' };
const LANGS = { id: 'Bahasa Indonesia', en: 'English' };
const defaultVoice = () => ({ on: false, provider: SET?.provider || 'auto', lang: SET?.lang || 'id', voice: '', speed: SET?.speed || 1 });
// old projects ({engine:'kokoro', voice} without provider): shown as Kokoro/English; the build treats them exactly as before
function vo() {
  const v = P?.voice || {};
  if (v.provider) return { lang: 'id', speed: 1, voice: '', ...v };
  return v.on === true ? { on: true, provider: 'kokoro', lang: 'en', voice: v.voice || 'am_michael', speed: 1 } : defaultVoice();
}
function setVoice(patch) { const { engine, used, ...cur } = vo(); P.voice = { ...cur, ...patch, used: P.voice?.used }; renderVoice(); renderScenes(); touch(); }
let provLang = null, voicesFor = '';
async function loadVoiceMeta() { SET = await api('/api/settings'); provLang = null; voicesFor = ''; }
const usable = (p) => p.available && p.supports;
async function renderVoice() {
  if (!P) return;
  const v = vo(), locked = ['building', 'queued', 'writing-script'].includes(P.status), auto = v.provider === 'auto';
  await ensureProvs(v.lang);
  $('#voOn').checked = !!v.on; $('#voCtl').hidden = !v.on; $('#voOff').hidden = !!v.on;
  $('#proj').classList.toggle('vo-off', !v.on);
  const { chain, html } = providerOptions(v.provider); $('#voProvider').innerHTML = html;
  $('#voProvider').value = v.provider; $('#voLang').value = v.lang;
  $('#voSpeed').value = v.speed; $('#voSpeedVal').textContent = (+v.speed).toFixed(2) + '×';
  // nothing can speak this language yet: say so now, not at the end of a long build
  const ready = auto ? chain.length > 0 : usable(PROVS.find((p) => p.id === v.provider) || {});
  $('#voWarn').hidden = !v.on || ready;
  $('#voWarn').innerHTML = `No voice provider is ready for ${LANGS[v.lang] || v.lang}. <a href="#settings">Add a key</a>`;
  $('#voPreview').disabled = !ready;
  const u = P.voice?.used; $('#voUsed').hidden = !u; if (u) $('#voUsed').textContent = `Last build: ${NAMES[u.provider] || u.provider} · ${u.voice}`;
  for (const el of $('#voBar').querySelectorAll('select, input')) el.disabled = locked;
  const sel = $('#voVoice'); sel.hidden = auto;
  if (!auto) {
    const cur = v.voice || SET?.voices?.[v.lang]?.[v.provider] || '', key = `${v.provider}|${v.lang}`;
    if (key !== voicesFor) { voicesFor = key; sel.innerHTML = voiceOptions([], cur); sel._list = await api(`/api/voices?provider=${v.provider}&lang=${v.lang}`); }
    sel.innerHTML = voiceOptions(sel._list || [], cur);
  }
}
$('#voOn').onchange = () => setVoice({ on: $('#voOn').checked });
$('#voProvider').onchange = () => setVoice({ provider: $('#voProvider').value, voice: '' });
$('#voLang').onchange = () => { const lang = $('#voLang').value; setVoice({ lang, voice: '', provider: vo().provider === 'kokoro' && lang !== 'en' ? 'auto' : vo().provider }); };
$('#voVoice').onchange = () => { const id = pickVoice($('#voVoice'), vo().voice); if (id) setVoice({ voice: id }); };
$('#voSpeed').oninput = () => { $('#voSpeedVal').textContent = (+$('#voSpeed').value).toFixed(2) + '×'; };
$('#voSpeed').onchange = () => setVoice({ speed: +$('#voSpeed').value });
$('#voText').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#voPreview').click(); });
$('#voPreview').onclick = (e) => previewVO($('#voText').value.trim() || P.scenes.find((s) => (s.narration || '').trim())?.narration || 'Halo, ini contoh suara narasi.', e.currentTarget);
function previewVO(text, btn) { const v = vo(); return vsPlay(btn, { provider: v.provider, lang: v.lang, voice: v.provider === 'auto' ? '' : v.voice, speed: v.speed, text }); }

// voice <select>: names instead of raw ids, the current one always present, and a way to paste any other id
function voiceOptions(list, cur) {
  return list.map((x) => `<option value="${esc(x.id)}" ${x.id === cur ? 'selected' : ''}>${esc(x.name)}</option>`).join('') +
    (cur && !list.some((x) => x.id === cur) ? `<option value="${esc(cur)}" selected>${esc(cur)}</option>` : '') + '<option value="__other">Other voice id…</option>';
}
function pickVoice(sel, prev) {
  if (sel.value !== '__other') return sel.value;
  const id = (prompt('Paste the voice id from the provider') || '').trim();
  if (!id) sel.value = prev || sel.options[0]?.value;
  return id || null;
}
// one preview at a time: the button shows "…" while generating, becomes Stop while playing; errors go to a toast
let playing = null;
function stopPreview() { if (!playing) return; playing.audio.pause(); playing.btn.textContent = playing.btn.dataset.label; playing = null; }
async function vsPlay(btn, cfg) { // the same router the build uses, so what you hear is what the video gets
  if (playing?.btn === btn) return stopPreview();
  stopPreview(); btn.dataset.label ??= btn.textContent; const label = btn.dataset.label;
  btn.textContent = '…'; btn.disabled = true;
  try {
    const r = await fetch('/api/voice/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg) });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'HTTP ' + r.status);
    const audio = new Audio(URL.createObjectURL(await r.blob()));
    playing = { audio, btn }; btn.textContent = label.length > 2 ? '■ Stop' : '■';
    audio.onended = () => { if (playing?.audio === audio) stopPreview(); };
    await audio.play();
    const log = decodeURIComponent(r.headers.get('X-VO-Log') || '');
    toast(`${NAMES[r.headers.get('X-VO-Provider')] || 'Voice'} · ${decodeURIComponent(r.headers.get('X-VO-Voice') || '')}${log ? ' — ' + log : ''}`, log ? 'warn' : 'ok');
  } catch (err) { if (playing?.btn === btn) playing = null; btn.textContent = label; toast('Preview failed: ' + err.message, 'bad'); }
  finally { btn.disabled = false; }
}
function toast(msg, kind = 'ok') {
  let t = $('#toast'); if (!t) { t = document.createElement('div'); t.id = 'toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
  t.textContent = msg; t.className = `toast ${kind} show`;
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), kind === 'ok' ? 2600 : 7000);
}
window.addEventListener('vs:settings', async () => { await loadVoiceMeta(); Object.keys(VOICES).forEach((k) => delete VOICES[k]); P ? (renderVoice(), loadReplizAccounts(true)) : renderWizard(); });
let lastLogStatus = null;
const STATUS = { 'writing-script': 'writing script…', 'script-ready': 'script ready: edit & validate', ready: 'script ready: edit & validate', draft: 'draft', 'build-requested': 'waiting for Claude', queued: 'in queue', building: 'generating video…', done: 'done', error: 'error' };
function renderLive() {
  const st = $('#status'); st.textContent = STATUS[P.status] || P.status; st.className = 'status ' + P.status;
  const writing = P.status === 'writing-script';
  $('#writing').hidden = !writing; $('#scriptBlock').hidden = writing;
  const busy = ['build-requested', 'building', 'queued'].includes(P.status);
  const locked = writing || busy;
  const errBox = $('#scriptError');
  const lastErr = [...(P.log || [])].reverse().find((l) => /failed|error|stopped|no clip/i.test(l.text || ''));
  const showErr = P.status === 'error' && !writing;
  const scriptErr = showErr && (!P.scenes.length || /^Script failed/.test(lastErr?.text || '')); // a build error must never offer "regenerate script": it throws the scenes away
  errBox.hidden = !showErr;
  if (showErr) {
    $('#errTitle').textContent = scriptErr ? 'Script error' : 'The build stopped';
    $('#scriptErrorMsg').textContent = lastErr?.text || (scriptErr ? 'Script generation failed. Try regenerating the script.' : 'The build stopped before the final video.');
    $('#regenErrorBtn').hidden = !scriptErr; $('#regenErrorBtn').disabled = locked;
    $('#errContinue').hidden = scriptErr;
    $('#errContinue').textContent = P.scenes.every((s) => s.clip && !s.stale) ? '▶ Stitch final video' : '▶ Continue';
  }
  renderBuildBar(busy);
  $('#addScene').disabled = locked;
  $('#regenScript').disabled = locked;
  const log = P.log || [], last = log.at(-1);
  $('#log').innerHTML = log.slice(-80).map((l) => `<li><time>${new Date(l.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>${esc(l.text)}</li>`).join('');
  $('#logLast').textContent = last ? `· ${last.text}` : '';
  if ((busy || showErr) && P.status !== lastLogStatus) $('#logBox').open = true; // open while building or on error
  lastLogStatus = P.status;
  $('#log').scrollTop = 1e6;
  $('#showFinal').hidden = !P.final; $('#playFinal').hidden = !P.final;
}
// ---------- the finished video: its own window, closes only with "Close" ----------
function openFinal(autoplay = true) {
  if (!P || !P.final) return;
  const m = $('#finalModal'), v = $('#finalVideo'), src = '/files/' + P.slug + '/' + P.final;
  $('#finalTitle').textContent = P.title || P.slug;
  $('#finalPath').textContent = P.savedPath || '(copying to the outputs folder…)';
  const dl = $('#finalDownload'); dl.href = src; dl.download = `${(P.title || P.slug).replace(/[\/:*?"<>|]+/g, '').trim() || P.slug}.mp4`;
  if (v.getAttribute('src') !== src) v.src = src;
  $('#player').pause();
  m.hidden = false;
  renderCompressUI();
  if (autoplay) { v.muted = false; v.play().catch(() => { v.muted = true; v.play().catch(() => {}); }); }
}
function announceFinal() {
  openFinal(true);
  document.title = '✅ ' + (P.title || 'Video') + ' · Animix';
  try { if (Notification.permission === 'granted') new Notification('Animix — Your video is ready', { body: P.title }); } catch {}
}
$('#showFinal').onclick = () => openFinal(true);
$('#playFinal').onclick = () => playFinal(true);
$('#finalClose').onclick = () => { const v = $('#finalVideo'); v.pause(); $('#finalModal').hidden = true; document.title = 'Animix'; if (stageMode !== 'final') $('#player').play().catch(() => {}); };
$('#finalSocial').onclick = () => {
  $('#finalVideo').pause(); $('#finalModal').hidden = true; document.title = 'Animix';
  if (stageMode !== 'final') $('#player').play().catch(() => {});
  const card = $('#socialCard');
  card.hidden = false;
  card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  if (!P?.social?.title && !P?.social?.description) $('#socialGen').click();
};
$('#finalReveal').onclick = async () => { const r = await api(`/api/project/${P.slug}/reveal`, { method: 'POST', body: '{}' }); if (r.path) { P.savedPath = r.path; $('#finalPath').textContent = r.path; } };
$('#finalCopyPath').onclick = () => { navigator.clipboard?.writeText($('#finalPath').textContent); $('#finalCopyPath').textContent = 'Copied'; setTimeout(() => ($('#finalCopyPath').textContent = 'Copy path'), 1500); };
function touch() { dirty = true; $('#saveState').textContent = 'saving…'; if ($('#socialState')) $('#socialState').textContent = 'saving…'; clearTimeout(saveTimer); saveTimer = setTimeout(save, 600); }
async function save() {
  if (!P) return;
  clearTimeout(saveTimer);
  P = await api('/api/project/' + P.slug, { method: 'PUT', body: JSON.stringify({ title: P.title, format: P.format, voice: P.voice, music: P.music, scenes: P.scenes, style: P.style, styleName: P.styleName, social: P.social, targetSeconds: +P.targetSeconds || 0 }) });
  dirty = false; $('#saveState').textContent = 'saved'; if ($('#socialState')) $('#socialState').textContent = 'saved'; renderLive();
}

// ---------- Social media metadata + Repliz scheduling ----------
let REPLIZ = { loaded: false, configured: false, accounts: [], error: '', selected: new Set(), boards: {} };
const fmtMb = (bytes) => `${(Number(bytes || 0) / (1024 * 1024)).toFixed(1)} MB`;
const safeSlugName = () => `${(P?.title || P?.slug || 'video').replace(/[\/:*?"<>|]+/g, '').trim() || P?.slug || 'video'}`;
let compressingLocal = false;
function renderCompressUI() {
  if (!P) return;
  const vi = P.videoInfo || {};
  const job = vi.compressing || null;
  const mode = $('#replizCompress')?.value || 'auto';
  const effPreset = mode === 'auto' ? 'balanced' : mode;
  const cachedRepliz = effPreset !== 'none' ? vi.presets?.[effPreset] : null;
  const sizeEl = $('#replizVideoSize'), compBtn = $('#replizCompressBtn'), dlComp = $('#replizDownloadComp');
  if (sizeEl && compBtn && dlComp) {
    if (job) {
      sizeEl.textContent = `Compressing (${job.preset})… ${job.pct || 0}%`;
      compBtn.disabled = true;
      compBtn.textContent = `Compressing ${job.pct || 0}%…`;
      dlComp.hidden = true;
    } else {
      const parts = [];
      if (vi.size) parts.push(`Original: ${fmtMb(vi.size)}`);
      if (cachedRepliz) parts.push(`Compressed (${effPreset}): ${fmtMb(cachedRepliz.size)}`);
      else if (mode === 'auto' && vi.size > (vi.autoThreshold || 85 * 1024 * 1024)) parts.push('Will auto-compress (1080p HD) before upload');
      else if (mode === 'auto' && vi.size) parts.push('No compression needed (≤ 85 MB)');
      else if (mode !== 'none') parts.push(`Will compress (${mode}) before upload`);
      sizeEl.textContent = parts.join(' · ');
      compBtn.disabled = compressingLocal || mode === 'none' || !!cachedRepliz;
      compBtn.textContent = cachedRepliz ? `✓ Compressed (${fmtMb(cachedRepliz.size)})` : '⚡ Compress now';
      if (cachedRepliz) {
        dlComp.hidden = false;
        dlComp.href = `/files/${P.slug}/work/compressed-${effPreset}.mp4`;
        dlComp.download = `${safeSlugName()} (${effPreset}).mp4`;
      } else {
        dlComp.hidden = true;
      }
    }
  }
  const fPreset = $('#finalCompressPreset')?.value || 'balanced';
  const fCached = vi.presets?.[fPreset];
  const fInfo = $('#finalSizeInfo'), fBtn = $('#finalCompressBtn'), fDl = $('#finalCompressDownload');
  if (fInfo && fBtn && fDl) {
    if (job) {
      fInfo.textContent = `Compressing (${job.preset})… ${job.pct || 0}%`;
      fBtn.disabled = true;
      fBtn.textContent = `Compressing ${job.pct || 0}%…`;
      fDl.hidden = true;
    } else {
      fInfo.textContent = (vi.size ? `Original: ${fmtMb(vi.size)}` : '') + (fCached ? ` → Compressed (${fPreset}): ${fmtMb(fCached.size)}` : '');
      fBtn.disabled = compressingLocal || !!fCached;
      fBtn.textContent = fCached ? `✓ Compressed (${fmtMb(fCached.size)})` : '⚡ Compress MP4';
      if (fCached) {
        fDl.hidden = false;
        fDl.href = `/files/${P.slug}/work/compressed-${fPreset}.mp4`;
        fDl.download = `${safeSlugName()} (${fPreset}).mp4`;
      } else {
        fDl.hidden = true;
      }
    }
  }
}
async function runCompress(preset) {
  if (!P || compressingLocal) return;
  compressingLocal = true;
  renderCompressUI();
  if ($('#replizStatus')) $('#replizStatus').textContent = `Compressing video (${preset})…`;
  try {
    const r = await api(`/api/project/${P.slug}/compress`, { method: 'POST', body: JSON.stringify({ preset }) });
    if (r.error) throw new Error(r.error);
    P = r.project;
    const msg = `Compressed (${preset}): ${fmtMb(r.result.originalSize)} → ${fmtMb(r.result.size)}`;
    if ($('#replizStatus')) $('#replizStatus').textContent = msg;
    toast(msg);
  } catch (e) {
    if ($('#replizStatus')) $('#replizStatus').textContent = e.message;
    toast('Compression failed: ' + e.message, 'bad');
  } finally {
    compressingLocal = false;
    renderCompressUI();
    renderLive();
  }
}
const fmtHashtags = (arr) => (Array.isArray(arr) ? arr : []).map((h) => '#' + String(h).replace(/^#+/, '')).join(' ');
const parseHashtags = (str) => String(str || '').split(/[\s,]+/).map((s) => s.trim().replace(/^#+/, '')).filter(Boolean);
const parseTags = (str) => String(str || '').split(',').map((s) => s.trim()).filter(Boolean);
const toLocalInput = (d) => {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
function ensureSocialObj() { return (P.social ??= { title: '', description: '', hashtags: [], tags: [], firstComment: '', topic: '' }); }
function updateSocialCounts() {
  const t = $('#socTitle').value.length, d = $('#socDesc').value.length, h = $('#socHashtags').value.length, c = $('#socFirstComment').value.length;
  const full = d + (d && h ? 2 : 0) + h;
  $('#socTitleCount').textContent = `${t}/100`;
  $('#socDescCount').textContent = `${d} chars (with hashtags: ${full})`;
  $('#socCommentCount').textContent = `${c}/150`;
}
function renderReplizAccounts() {
  const box = $('#replizAccounts'), ctl = $('#replizControls');
  if (!REPLIZ.loaded) { box.innerHTML = '<span class="muted">Loading Repliz accounts…</span>'; ctl.hidden = true; return; }
  if (!REPLIZ.configured) {
    box.innerHTML = '<p class="muted">Repliz keys not set yet. Add <code>REPLIZ_ACCESS_KEY</code> and <code>REPLIZ_SECRET_KEY</code> in <a href="#settings">Settings → API Keys</a>.</p>';
    ctl.hidden = true; return;
  }
  if (REPLIZ.error) {
    box.innerHTML = `<p class="kerr">${esc(REPLIZ.error)}</p>`;
    ctl.hidden = true; return;
  }
  if (!REPLIZ.accounts.length) {
    box.innerHTML = '<p class="muted">No connected accounts found in Repliz. Connect an account in your Repliz dashboard, then click Refresh.</p>';
    ctl.hidden = true; return;
  }
  ctl.hidden = false;
  box.innerHTML = REPLIZ.accounts.map((a) => {
    const on = REPLIZ.selected.has(a.id);
    const boards = a.type === 'pinterest' && on ? REPLIZ.boards[a.id] : null;
    return `<div class="repliz-acc-wrap">
      <label class="repliz-acc ${on ? 'on' : ''}">
        <input type="checkbox" data-acc="${esc(a.id)}" ${on ? 'checked' : ''}>
        <span class="badge">${esc(a.type)}</span>
        <span class="acc-name">${esc(a.name)}</span>
        ${a.username ? `<span class="muted">@${esc(a.username)}</span>` : ''}
      </label>
      ${a.type === 'pinterest' && on ? `<select class="pin-board" data-board="${esc(a.id)}">${boards ? boards.map((b) => `<option value="${esc(b.id)}">${esc(b.name)}</option>`).join('') || '<option value="">No boards found</option>' : '<option value="">Loading boards…</option>'}</select>` : ''}
    </div>`;
  }).join('');
  $('#replizSend').disabled = !REPLIZ.selected.size || !$('#replizAt').value;
  updateReplizHostNote();
}
function updateReplizHostNote() {
  const note = $('#replizHostNote');
  if (!note) return;
  const host = $('#replizHost')?.value || 'auto';
  const picked = REPLIZ.accounts.filter((a) => REPLIZ.selected.has(a.id));
  const needsStorage = picked.some((a) => ['tiktok', 'whatsapp', 'telegram'].includes(a.type));
  if (host !== 'repliz' && needsStorage) {
    note.hidden = false;
    note.textContent = 'Note: Repliz copies external URLs into Repliz Storage for TikTok, WhatsApp, and Telegram (YouTube, Instagram, Facebook, Threads, LinkedIn download directly).';
  } else {
    note.hidden = true;
  }
}
async function loadReplizAccounts(force = false) {
  if (REPLIZ.loaded && !force) return renderReplizAccounts();
  REPLIZ.loaded = false; REPLIZ.error = ''; renderReplizAccounts();
  const r = await api('/api/repliz/accounts').catch((e) => ({ error: e.message }));
  REPLIZ.loaded = true;
  REPLIZ.configured = !!r.configured;
  REPLIZ.accounts = r.accounts || [];
  REPLIZ.error = r.error || '';
  // keep only still-existing selected ids
  const validIds = new Set(REPLIZ.accounts.map((a) => a.id));
  for (const id of [...REPLIZ.selected]) if (!validIds.has(id)) REPLIZ.selected.delete(id);
  renderReplizAccounts();
}
function renderReplizHistory() {
  const el = $('#replizHistory'), list = P?.replizSchedules || [];
  el.hidden = !list.length;
  if (!list.length) return;
  el.innerHTML = '<h4>Scheduled posts</h4><ul>' + list.slice(0, 12).map((x) =>
    `<li><span class="badge">${esc(x.platform || 'post')}</span> <b>${esc(x.name || x.username || x.accountId)}</b> <span>${new Date(x.scheduleAt).toLocaleString()}</span> <span class="badge st-ok">${esc(x.status || 'scheduled')}</span></li>`
  ).join('') + '</ul>';
}
function renderSocial() {
  const card = $('#socialCard');
  if (!P || !P.final) { card.hidden = true; return; }
  card.hidden = false;
  const s = P.social || {};
  const hasMeta = !!(s.title || s.description || (s.hashtags && s.hashtags.length));
  $('#socialGen').textContent = hasMeta ? '↻ Regenerate metadata' : '✦ Generate metadata';
  $('#socialGen').className = hasMeta ? 'ghost small' : 'primary small';
  if (!document.activeElement?.closest?.('#socialCard')) {
    $('#socTitle').value = s.title || '';
    $('#socTopic').value = s.topic || '';
    $('#socDesc').value = s.description || '';
    $('#socHashtags').value = fmtHashtags(s.hashtags);
    $('#socTags').value = (s.tags || []).join(', ');
    $('#socFirstComment').value = s.firstComment || '';
  }
  if (!$('#replizAt').value) {
    const d = new Date(Date.now() + 60 * 60 * 1000); d.setSeconds(0, 0);
    $('#replizAt').value = toLocalInput(d);
  }
  updateSocialCounts();
  renderReplizHistory();
  renderCompressUI();
  if (!REPLIZ.loaded) loadReplizAccounts(); else renderReplizAccounts();
}
$('#socialGen').onclick = async () => {
  const b = $('#socialGen'); b.disabled = true; $('#socialState').textContent = 'generating…';
  const r = await api(`/api/project/${P.slug}/social/generate`, { method: 'POST', body: '{}' }).catch((e) => ({ error: e.message }));
  b.disabled = false;
  if (r.error) { $('#socialState').textContent = ''; return toast('Metadata failed: ' + r.error, 'bad'); }
  P = r; $('#socialState').textContent = 'generated'; renderSocial(); renderLive(); toast('Social media metadata generated');
};
for (const [id, fn] of [
  ['#socTitle', (v) => { ensureSocialObj().title = v; }],
  ['#socTopic', (v) => { ensureSocialObj().topic = v; }],
  ['#socDesc', (v) => { ensureSocialObj().description = v; }],
  ['#socHashtags', (v) => { ensureSocialObj().hashtags = parseHashtags(v); }],
  ['#socTags', (v) => { ensureSocialObj().tags = parseTags(v); }],
  ['#socFirstComment', (v) => { ensureSocialObj().firstComment = v; }],
]) {
  $(id).addEventListener('input', () => { fn($(id).value); updateSocialCounts(); touch(); });
}
$('#replizRefresh').onclick = () => loadReplizAccounts(true);
$('#replizAccounts').addEventListener('change', async (e) => {
  const cb = e.target.closest('input[data-acc]');
  if (!cb) return;
  const id = cb.dataset.acc;
  if (cb.checked) REPLIZ.selected.add(id); else REPLIZ.selected.delete(id);
  const acc = REPLIZ.accounts.find((a) => a.id === id);
  if (cb.checked && acc?.type === 'pinterest' && !REPLIZ.boards[id]) {
    renderReplizAccounts();
    const res = await api(`/api/repliz/pinterest-boards?accountId=${encodeURIComponent(id)}`).catch(() => ({ boards: [] }));
    REPLIZ.boards[id] = res.boards || [];
  }
  renderReplizAccounts();
});
$('#replizAt').addEventListener('input', () => { $('#replizSend').disabled = !REPLIZ.selected.size || !$('#replizAt').value; });
$('#replizHost').addEventListener('change', updateReplizHostNote);
$('#replizCompress').addEventListener('change', renderCompressUI);
$('#replizCompressBtn').addEventListener('click', () => {
  const mode = $('#replizCompress').value;
  if (mode === 'none') return;
  runCompress(mode === 'auto' ? 'balanced' : mode);
});
$('#finalCompressPreset').addEventListener('change', renderCompressUI);
$('#finalCompressBtn').addEventListener('click', () => runCompress($('#finalCompressPreset').value));
$('#replizPresets').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  const d = new Date();
  if (b.dataset.min) d.setMinutes(d.getMinutes() + (+b.dataset.min));
  else if (b.dataset.day) { d.setDate(d.getDate() + (+b.dataset.day)); d.setHours(+b.dataset.hour, 0, 0, 0); }
  d.setSeconds(0, 0);
  $('#replizAt').value = toLocalInput(d);
  $('#replizSend').disabled = !REPLIZ.selected.size || !$('#replizAt').value;
});
$('#replizSend').onclick = async () => {
  const accountIds = [...REPLIZ.selected], when = $('#replizAt').value;
  if (!accountIds.length) return toast('Pick at least one Repliz account', 'warn');
  if (!when) return toast('Pick a schedule date and time', 'warn');
  if (dirty) await save();
  const pinterestBoards = {};
  for (const sel of document.querySelectorAll('#replizAccounts select[data-board]')) {
    const id = sel.dataset.board, boardId = sel.value;
    const board = (REPLIZ.boards[id] || []).find((b) => b.id === boardId);
    if (board) pinterestBoards[id] = { id: board.id, type: 'board', name: board.name, picture: board.picture || '' };
  }
  const compressMode = $('#replizCompress').value;
  const needsCompress = compressMode !== 'none' && (compressMode !== 'auto' || (P.videoInfo?.size || 0) > (P.videoInfo?.autoThreshold || 85 * 1024 * 1024));
  const btn = $('#replizSend'); btn.disabled = true; btn.textContent = needsCompress ? 'Compressing & uploading…' : 'Uploading & scheduling…';
  $('#replizStatus').textContent = needsCompress ? 'Compressing video (if not cached), uploading, and creating schedules…' : 'Uploading video and creating schedules…';
  const r = await api(`/api/project/${P.slug}/repliz/schedule`, {
    method: 'POST',
    body: JSON.stringify({
      accountIds,
      scheduleAt: new Date(when).toISOString(),
      uploadHost: $('#replizHost').value,
      compress: compressMode,
      metadata: P.social,
      options: {
        isAiGenerated: $('#replizAi').checked,
        privacy: $('#replizPrivacy').value,
        isShareToFeed: $('#replizFeed').checked,
        pinterestBoards,
      },
    }),
  }).catch((e) => ({ error: e.message }));
  btn.disabled = false; btn.textContent = 'Schedule to Repliz';
  if (r.error) { $('#replizStatus').textContent = r.error; return toast('Repliz failed: ' + r.error, 'bad'); }
  P = r.project; renderSocial(); renderLive();
  const ok = (r.results || []).filter((x) => x.ok), fail = (r.results || []).filter((x) => !x.ok);
  const compInfo = r.upload?.compressed ? ` · compressed ${r.upload.preset}: ${fmtMb(r.upload.originalSize)} → ${fmtMb(r.upload.size)}` : '';
  const hostInfo = r.upload?.url ? ` (hosted on ${r.upload.provider}${compInfo}: ${r.upload.url})` : '';
  $('#replizStatus').textContent = fail.length
    ? `Scheduled ${ok.length}, failed ${fail.length}: ${fail.map((f) => `${f.platform || f.accountId} (${f.error})`).join('; ')}${hostInfo}`
    : `Scheduled ${ok.length} post(s) to Repliz${hostInfo}.`;
  toast(fail.length ? `Scheduled ${ok.length}, ${fail.length} failed` : `Scheduled ${ok.length} post(s) to Repliz`, fail.length ? 'warn' : 'ok');
};
$('#title').oninput = () => { P.title = $('#title').value; touch(); };
$('#format').onchange = () => { P.format = $('#format').value; touch(); };
$('#music').onchange = () => { P.music = $('#music').value; touch(); };
$('#targetSeconds').onchange = () => {
  const custom = $('#targetSeconds').value === '__custom';
  $('#targetSecondsCustomWrap').hidden = !custom;
  P.targetSeconds = projSecondsVal();
  updateTotal(); touch();
  if (custom) $('#targetSecondsCustom').focus();
};
$('#targetSecondsCustom').oninput = () => { P.targetSeconds = projSecondsVal(); updateTotal(); touch(); };
$('#addScene').onclick = () => { if (!P) return; const last = P.scenes[P.scenes.length - 1]; const s0 = last ? +last.end : 0; P.scenes.push({ n: P.scenes.length + 1, start: s0, end: +(s0 + 3).toFixed(1), tool: last ? last.tool : '', visual: '', narration: '', onscreen: '', sound: '', notes: '' }); renderScenes(); touch(); };
// ---------- build bar: what a press does depends on which clips exist (finished clips are always kept unless you ask) ----------
function renderBuildBar(busy) {
  const total = P.scenes.length, have = P.scenes.filter((s) => s.clip).length, todo = P.scenes.filter((s) => !s.clip || s.stale).length;
  const last = P.log?.at(-1)?.text || '', stitching = P.status === 'building' && /^Stitching/.test(last);
  $('#buildProg').hidden = !busy;
  if (busy) {
    const q = P.queue ?? -1;
    $('#bpFill').style.width = (P.status === 'queued' || stitching ? 100 : Math.round((have / Math.max(1, total)) * 100)) + '%';
    $('#bpFill').classList.toggle('indet', P.status === 'queued' || stitching);
    $('#bpText').textContent = P.status === 'queued' ? (q > 0 ? `In queue · ${q} video${q > 1 ? 's' : ''} ahead` : 'In queue · next up')
      : stitching ? 'Stitching voice-over, music and captions…' : `${have} of ${total} scenes rendered`;
  }
  const b = (id, label, cls, title = '') => `<button id="${id}" class="${cls}" type="button" title="${esc(title)}">${label}</button>`;
  const fresh = b('buildFresh', '↻ Re-render all', 'ghost', 'Render every scene again from scratch');
  $('#buildBtns').innerHTML = busy ? b('stop', P.status === 'queued' ? 'Remove from queue' : 'Stop', 'ghost', 'Finished clips are kept')
    : !total ? ''
    : !have ? b('build', 'Validate script &amp; generate video', 'primary')
    : todo ? fresh + b('build', `▶ Continue: render ${todo} scene${todo > 1 ? 's' : ''}`, 'primary', `${total - todo} finished clip${total - todo === 1 ? ' is' : 's are'} kept`)
    : fresh + b('stitch', P.final ? '⟳ Stitch again' : '▶ Stitch final video', P.final ? 'ghost' : 'primary', 'Rebuild final.mp4 from the clips (voice-over, music, captions). Nothing is rendered.');
}
const askNotify = () => { try { if (window.Notification && Notification.permission === 'default') Notification.requestPermission(); } catch {} };
async function startBuild(opts = {}) {
  if (!P) return;
  if (dirty) await save();
  const long = document.querySelectorAll('#sceneRows textarea.long').length;
  if (long && !confirm(`${long} narration line${long > 1 ? 's are' : ' is'} longer than ${long > 1 ? 'their scenes' : 'its scene'} and will run into the next one (marked in orange). Continue anyway?`)) return;
  askNotify();
  const r = await api(`/api/project/${P.slug}/build`, { method: 'POST', body: JSON.stringify(opts) });
  if (r.error) return toast(r.error, 'bad');
  P = r; lastStatus = P.status; renderScenes(); renderLive(); renderParts();
}
$('#buildBtns').onclick = async (e) => {
  const b = e.target.closest('button'); if (!b || !P) return;
  if (b.id === 'stop') { P = await api(`/api/project/${P.slug}/stop`, { method: 'POST', body: '{}' }); renderScenes(); renderLive(); return; }
  if (b.id === 'build' && !P.scenes.some((s) => s.clip) && !confirm('Generate the video from this script? Claude Code renders every scene (this can take a while).')) return;
  if (b.id === 'buildFresh' && !confirm(`Render all ${P.scenes.length} scenes again from scratch? The finished clips will be replaced.`)) return;
  startBuild(b.id === 'stitch' ? { stitch: true } : b.id === 'buildFresh' ? { fresh: true } : {});
};
$('#errContinue').onclick = () => startBuild(P.scenes.every((s) => s.clip && !s.stale) ? { stitch: true } : {});
async function regenScript() {
  if (!P) return;
  if (P.scenes?.length && !confirm('Regenerate the script? This will replace the current scenes.')) return;
  if (dirty) await save();
  const r = await api(`/api/project/${P.slug}/script/regenerate`, { method: 'POST', body: JSON.stringify({ seconds: projSecondsVal() }) }).catch((e) => ({ error: e.message }));
  if (r.error) return toast('Regenerate failed: ' + r.error, 'bad');
  P = r; lastStatus = P.status; renderProject();
  toast('Regenerating script…');
}
$('#regenScript').onclick = regenScript;
$('#regenErrorBtn').onclick = regenScript;

function openAddPartModal() {
  if (!P) return;
  const nextPart = (P.series?.slugs?.length || 1) + 1;
  const baseTitle = (P.series?.title || P.title || P.slug).replace(/\s*\(Part\s*\d+\)\s*$/i, '').trim();
  $('#addPartTitle').textContent = `Add Part ${nextPart} — ${baseTitle}`;
  $('#addPartName').value = '';
  $('#addPartName').placeholder = `Auto: ${baseTitle} (Part ${nextPart})`;
  $('#addPartDir').value = '';
  $('#addPartEnding').checked = false;
  $('#addPartGo').textContent = `✦ Generate Part ${nextPart}`;
  const ts = String(Math.round(+P.targetSeconds || 0));
  $('#addPartSec').value = ['0', '30', '45', '60', '90', '120', '180'].includes(ts) ? ts : '0';
  const last = P.scenes?.[P.scenes.length - 1];
  const prevBox = $('#addPartPrev');
  if (last) {
    prevBox.hidden = false;
    prevBox.innerHTML = `<b>Previous ending (Scene ${last.n})</b>` +
      (last.onscreen ? `<div>On-screen: ${esc(last.onscreen)}</div>` : '') +
      (last.narration ? `<div>Narration: “${esc(last.narration)}”</div>` : '');
  } else {
    prevBox.hidden = true;
  }
  $('#addPartModal').hidden = false;
  $('#addPartDir').focus();
}
function closeAddPartModal() { $('#addPartModal').hidden = true; }
$('#addPartClose').onclick = closeAddPartModal;
$('#addPartCancel').onclick = closeAddPartModal;
$('#addPartModal').addEventListener('mousedown', (e) => { if (e.target === $('#addPartModal')) closeAddPartModal(); });
$('#addPartGo').onclick = async () => {
  if (!P) return;
  const direction = $('#addPartDir').value.trim();
  if (!direction) { toast('Describe what happens in the next part', 'bad'); return $('#addPartDir').focus(); }
  const btn = $('#addPartGo'); btn.disabled = true;
  try {
    if (dirty) await save();
    const r = await api(`/api/project/${P.slug}/part`, {
      method: 'POST',
      body: JSON.stringify({
        direction,
        title: $('#addPartName').value.trim(),
        seconds: +$('#addPartSec').value || 0,
        isEnding: $('#addPartEnding').checked,
      }),
    });
    if (r.error) throw new Error(r.error);
    closeAddPartModal();
    location.search = '?p=' + r.slug;
  } catch (e) {
    toast('Add part failed: ' + e.message, 'bad');
    btn.disabled = false;
  }
};
$('#deleteProject').onclick = async () => {
  if (!P) return;
  const title = P.title || P.slug;
  const busy = ['building', 'build-requested'].includes(P.status);
  if (!confirm(`Delete "${title}"?${busy ? ' This will stop the active build.' : ''} All clips and files in this project will be permanently removed.`)) return;
  const btn = $('#deleteProject'); btn.disabled = true;
  const r = await api(`/api/project/${P.slug}`, { method: 'DELETE' }).catch((e) => ({ error: e.message }));
  btn.disabled = false;
  if (r.error) return toast('Delete failed: ' + r.error, 'bad');
  clearTimeout(saveTimer);
  P = null; slug = null; dirty = false; lastStatus = null;
  history.replaceState(null, '', location.pathname);
  $('#finalModal').hidden = true; document.title = 'Animix';
  await loadProjects(); renderProject();
  toast(`Deleted "${title}"`);
};

// live updates while Claude writes or builds (never overwrite what you're typing)
let lastStatus = null, tick = 0;
setInterval(async () => {
  if (!P || dirty) return;
  const fresh = await api('/api/project/' + P.slug); if (fresh.error) return;
  const changedScenes = JSON.stringify(fresh.scenes) !== JSON.stringify(P.scenes) || fresh.status !== lastStatus;
  const changedSocial = JSON.stringify(fresh.social) !== JSON.stringify(P.social) || JSON.stringify(fresh.replizSchedules) !== JSON.stringify(P.replizSchedules);
  const changedVideoInfo = JSON.stringify(fresh.videoInfo) !== JSON.stringify(P.videoInfo);
  const becameDone = fresh.final && fresh.final !== P.final;
  P = fresh;
  if (changedScenes && !document.activeElement?.closest?.('#sceneRows')) { renderProject(); if (lastStatus === 'writing-script') loadProjects(); }
  if (P.series && ++tick % 4 === 0) { PLIST = await api('/api/projects').catch(() => PLIST); renderParts(); }
  else if (changedSocial || becameDone) renderSocial();
  else if (changedVideoInfo) renderCompressUI();
  lastStatus = P.status;
  renderLive();
  if (becameDone) { playFinal(false); announceFinal(); }
}, 2500);

(async () => {
  CAT = await api('/api/catalog');
  await loadVoiceMeta(); $('#newFormat').value = SET.format || '9:16'; wzRestore();
  await loadProjects();
  if (slug) { P = await api('/api/project/' + slug); if (P.error) P = null; }
  lastStatus = P?.status;
  renderProject();
  const first = P?.scenes?.find((s) => s.tool);
  let last = null; try { last = localStorage.getItem('vs.style'); } catch {}
  const [t, s] = (first?.tool || last || SET.style || 'tvhead/prehistoric').split('/'); select(t, s);
  if (!P && !last && !SET.style) { $('#stylePick').hidden = false; renderCatalog(); renderStyleCur(); } // first visit: show the styles
  if (P?.final) playFinal(false); // an open project shows its own video first, not the style example
  else if (P?.scenes?.find((s) => s.clip)) playClip(P.scenes.find((s) => s.clip)); // …or its first rendered clip
  if (!P) $('#wzTopic').focus({ preventScroll: true });
})();
