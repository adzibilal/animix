// Settings (route #settings): API keys per provider (values never reach the browser, only ••••last4) and voice & audio defaults.
// Uses toast(), voiceOptions(), pickVoice(), vsPlay(), toolOptions() and CAT from app.js.
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const call = async (url, opts = {}) => {
    const r = await fetch(url, { cache: 'no-store', headers: { 'Content-Type': 'application/json' }, ...opts });
    const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`); return j;
  };
  const post = (url, data = {}, method = 'POST') => call(url, { method, body: JSON.stringify(data) });
  const NAMES = { gemini: 'Gemini', elevenlabs: 'ElevenLabs', fish: 'Fish Audio', edge: 'Edge TTS', kokoro: 'Kokoro (local)' };
  const LANGS = { id: 'Bahasa Indonesia', en: 'English' };
  let tab = 'keys', KEYS = [], S = null, PROVS = [];
  const adding = new Set(); // provider cards whose "add key" form is open
  const modal = $('#settingsModal'), body = $('#settingsBody');

  async function open() {
    modal.hidden = false;
    try { await load(); }
    catch (e) { body.innerHTML = `<p class="kerr">Could not load settings (${esc(e.message)}). If the server was started before an update, restart it: <code>node video-studio/vs.mjs serve</code></p>`; }
  }
  function close() {
    if (modal.hidden) return;
    modal.hidden = true;
    if (location.hash === '#settings') history.replaceState(null, '', location.pathname + location.search);
    window.dispatchEvent(new Event('vs:settings'));
  }
  async function load() { [KEYS, S, PROVS] = await Promise.all([call('/api/keys'), call('/api/settings'), call('/api/providers')]); render(); }
  // run a change, refresh, and say what happened. okMsg: text, or (result) => text | [text, kind]
  async function act(fn, okMsg) {
    try {
      const r = await fn();
      if (Array.isArray(r)) KEYS = r; else if (r?.providers) KEYS = r.providers;
      PROVS = await call('/api/providers'); render();
      const [text, kind = 'ok'] = [].concat(typeof okMsg === 'function' ? okMsg(r) : okMsg || []);
      if (text) toast(text, kind);
    } catch (e) { render(); toast(e.message, 'bad'); }
  }

  function status(k) {
    if (k.disabled) return ['Disabled', 'off'];
    if (k.error) return ['Invalid', 'bad'];
    if (k.spent.length) return ['Quota used up', 'warn'];
    if (k.limitedUntil) return [`Limited until ${new Date(k.limitedUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`, 'warn'];
    return ['Active', 'ok'];
  }
  const addForm = (p) => `<form class="row addkey"><input type="password" name="value" class="grow" placeholder="Paste a ${esc(p.name)} key and press Enter" autocomplete="off" required>
    <input name="label" placeholder="Label (optional)"><button class="primary small">Add key</button></form>`;

  function renderKeys() {
    return `<p class="help">Keys are saved in <code>.env</code> in the kit folder and are never shown again (only the last 4 characters).
      With several keys for one provider, the top one is used first and the next one takes over when it fails or runs out of quota.</p>
    ${KEYS.map((p) => `<section class="kcard" data-env="${esc(p.env)}">
      <header><b>${esc(p.name)}</b><span class="use">${esc(p.use)}</span>${p.url ? `<a href="${esc(p.url)}" target="_blank" rel="noopener">Get a key ↗</a>` : ''}</header>
      ${p.keys.length ? `<ol class="klist">${p.keys.map((k, i) => { const [t, c] = status(k), many = p.keys.length > 1; return `<li data-id="${k.id}">
        <span class="mono">••••${esc(k.tail)}</span>
        <input class="klabel" value="${esc(k.label)}" placeholder="add a label" data-act="label" aria-label="Label">
        <span class="badge st-${c}">${t}</span>${k.duplicate ? '<span class="badge st-warn" title="Same key as one above: it is used only once">duplicate</span>' : ''}
        <span class="count">${k.used ? `${k.used} request${k.used === 1 ? '' : 's'} today` : ''}</span>
        ${many ? `<button class="ghost small" data-act="up" ${i ? '' : 'disabled'} title="Use earlier">↑</button><button class="ghost small" data-act="down" ${i < p.keys.length - 1 ? '' : 'disabled'} title="Use later">↓</button>` : ''}
        ${p.testable ? '<button class="ghost small" data-act="test" title="Check this key with the provider">Test</button>' : ''}
        ${k.error || k.spent.length || k.limitedUntil ? '<button class="ghost small" data-act="reset" title="Clear the invalid / quota marks and try this key again">Reset</button>' : ''}
        <button class="ghost small" data-act="toggle">${k.disabled ? 'Enable' : 'Disable'}</button>
        <button class="ghost small danger" data-act="del">Delete</button>
        ${k.error ? `<span class="kerr">${esc(k.error)}</span>` : k.spent.length ? '<span class="kerr warn">Daily quota used up. It comes back around 14:00–15:00 WIB.</span>' : ''}</li>`; }).join('')}</ol>` : ''}
      ${!p.keys.length || adding.has(p.env) ? addForm(p) : '<div><button class="ghost small" data-act="add">+ Add another key</button></div>'}</section>`).join('')}
    <details class="more"><summary>Import keys from another .env file</summary>
      <div class="row"><input id="impPath" class="grow" value="~/.t3/projects/sandekala/workspace/.env" aria-label="Path of the .env file"><button class="ghost small" data-act="import">Import</button></div>
      <p class="help">Copies the keys that are not here yet. Nothing is shown or changed in the other file.</p></details>
    <details class="more"><summary>Add a key for another provider</summary>
      <form id="newProv" class="row"><input name="env" placeholder="NAME_API_KEY" pattern="[A-Za-z][A-Za-z0-9_]*" required><input type="password" name="value" class="grow" placeholder="Key" autocomplete="off" required><input name="label" placeholder="Label (optional)"><button class="primary small">Add key</button></form></details>
    <p class="help">Gemini counts quota per Google project, not per key: keys from the same project share one quota.</p>`;
  }

  function renderVoice() {
    const avail = Object.fromEntries(PROVS.map((p) => [p.id, p.available]));
    const opt = (v, cur, text = v) => `<option value="${v}" ${cur === v ? 'selected' : ''}>${text}</option>`;
    const styleSel = typeof toolOptions === 'function' && CAT ? toolOptions(S.style || '').replace('— pick —', 'No default (pick each time)') : '';
    return `<p class="help">These are the starting values for new videos. Every project can still choose its own voice. Changes are saved as you make them.</p>
    <h3>Which provider speaks</h3>
    <div class="cols"><div>
      <ol class="prio">${S.priority.map((p, i) => `<li data-p="${p}"><b>${i + 1}</b><span>${NAMES[p]}</span><span class="badge ${avail[p] ? 'st-ok' : 'st-off'}">${avail[p] ? 'ready' : p === 'kokoro' ? 'not installed' : 'no key'}</span>
        <button class="ghost small" data-act="pup" ${i ? '' : 'disabled'} title="Try earlier">↑</button><button class="ghost small" data-act="pdown" ${i < S.priority.length - 1 ? '' : 'disabled'} title="Try later">↓</button></li>`).join('')}</ol>
    </div><p class="help">“Auto” tries these from the top and skips the ones without a key. One provider speaks the whole video: if it fails on any line, every line is done again with the next one, so the voice never changes in the middle. Kokoro runs on this computer, is free, and speaks English only.</p></div>
    <h3>New videos start with</h3>
    <div class="row"><label>Provider <select data-set="provider">${opt('auto', S.provider, 'Auto (order above)')}${PROVS.map((p) => opt(p.id, S.provider, NAMES[p.id] + (p.available ? '' : ' (no key)'))).join('')}</select></label>
      <label>Language <select data-set="lang">${Object.entries(LANGS).map(([k, v]) => opt(k, S.lang, v)).join('')}</select></label>
      <label>Speed <input type="range" min="0.8" max="1.3" step="0.05" value="${S.speed}" data-set="speed"> <span>${(+S.speed).toFixed(2)}×</span></label></div>
    <div class="row"><label>Format <select data-set="format">${['9:16', '16:9', '1:1'].map((v) => opt(v, S.format)).join('')}</select></label>
      <label>Music <select data-set="music">${['lofi', 'ambient', 'upbeat', 'epic', 'none'].map((v) => opt(v, S.music)).join('')}</select></label>
      ${styleSel ? `<label>Style <select data-set="style">${styleSel}</select></label>` : ''}</div>
    <h3>Voice of each provider</h3>
    <table class="vgrid"><tr><th></th>${Object.values(LANGS).map((l) => `<th>${l}</th>`).join('')}</tr>
      ${S.priority.map((p) => `<tr><td>${NAMES[p]}</td>${Object.keys(LANGS).map((l) => p === 'kokoro' && l !== 'en' ? '<td class="help">not available</td>'
        : `<td><select data-voice="${l}|${p}">${voiceOptions([], S.voices[l]?.[p] || '')}</select> <button class="ghost small" data-act="try" data-l="${l}" data-p="${p}" title="Hear this voice" ${avail[p] ? '' : 'disabled'}>▶</button></td>`).join('')}</tr>`).join('')}</table>
    <div class="row"><label class="grow">Sentence for ▶ <input id="tryText" class="grow" value="Halo, ini contoh suara narasi untuk video kamu."></label></div>
    <h3>Music under the voice</h3>
    <div class="row"><label>Volume <input type="range" min="0" max="1" step="0.01" value="${S.musicVolume}" data-set="musicVolume"> <span>${(+S.musicVolume).toFixed(2)}</span></label>
      <label><input type="checkbox" data-set="ducking" ${S.ducking ? 'checked' : ''}> Lower the music while someone speaks</label></div>`;
  }

  // ---------- AI agent: Claude Code or Cursor (own subscription login, like Mochi Studio) + models ----------
  let AG = null, agLoading = false;
  async function loadAgents(refresh = false) {
    agLoading = true; if (tab === 'ai') render();
    try { AG = await call('/api/settings/agents' + (refresh ? '?refresh=1' : '')); if (refresh) toast(AG[S.ai.agent].error || 'Models refreshed', AG[S.ai.agent].error ? 'bad' : 'ok'); }
    catch (e) { toast(e.message, 'bad'); }
    agLoading = false; if (tab === 'ai') render();
  }
  const modelOptions = (list, cur) => list.map((x) => `<option value="${esc(x.id)}" ${x.id === cur ? 'selected' : ''}>${esc(x.name)}${x.id && x.id !== x.name ? ` · ${esc(x.id)}` : ''}</option>`).join('')
    + (cur && !list.some((x) => x.id === cur) ? `<option value="${esc(cur)}" selected>${esc(cur)}</option>` : '') + '<option value="__other">Other model id…</option>';
  function renderAI() {
    if (!AG) return `<p class="help"><span class="dot"></span> Checking Claude Code and Cursor on this computer…</p>`;
    const cur = S.ai.agent, g = AG[cur], m = S.ai[cur];
    const card = (id) => {
      const a = AG[id], st = a.loggedIn ? 'st-ok' : a.installed ? 'st-warn' : 'st-off';
      return `<label class="agent ${id === cur ? 'on' : ''} ${a.installed ? '' : 'off'}">
        <input type="radio" name="agent" value="${id}" ${id === cur ? 'checked' : ''} ${a.installed ? '' : 'disabled'}>
        <span class="agent-main"><b>${esc(a.name)}</b><code>${esc(a.bin)} -p</code></span>
        <span class="agent-st ${st}">${a.loggedIn ? '✓ ' : ''}${esc(a.detail)}</span>
        ${a.installed && !a.loggedIn ? `<span class="help agent-login">Log in once in a terminal: <code>${esc(a.login)}</code>, then press Refresh.</span>` : ''}
      </label>`;
    };
    return `<p class="help">The agent that writes title ideas and scripts and builds the video. It runs on its own subscription login on this computer (no API key), like Mochi Studio. <code>.env</code> and <code>.keys.json</code> stay out of its reach.</p>
      <div class="agents">${card('claude')}${card('cursor')}</div>
      <h3>Models for ${esc(g.name)}</h3>
      <div class="row">
        <label>Writing ideas &amp; scripts <select data-model="script">${modelOptions(g.models, m.script)}</select></label>
        <label>Building the video <select data-model="build">${modelOptions(g.models, m.build)}</select></label>
        <button class="ghost small" data-act="models" ${agLoading ? 'disabled' : ''}>${agLoading ? 'Fetching…' : '↻ Refresh'}</button>
      </div>
      <p class="help">${cur === 'cursor' ? (g.error ? esc(g.error) : g.fetched ? `${g.models.length - 1} models fetched from your Cursor account.` : 'Log in to Cursor to load its models.')
        : 'Claude Code has no command that lists models: the aliases always mean the newest model, a full id pins one version.'} “Other model id…” accepts any id the CLI takes.</p>`;
  }
  async function setAI(patch) { await putS({ ai: { ...S.ai, ...patch } }); render(); }

  function render() {
    document.querySelectorAll('#settingsModal .tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
    const y = body.scrollTop; body.innerHTML = tab === 'keys' ? renderKeys() : tab === 'ai' ? renderAI() : renderVoice(); body.scrollTop = y;
    if (tab === 'voice') for (const sel of body.querySelectorAll('[data-voice]')) { // names instead of raw ids, once the lists arrive
      const [l, p] = sel.dataset.voice.split('|');
      call(`/api/voices?provider=${p}&lang=${l}`).then((vs) => { sel.innerHTML = voiceOptions(vs, S.voices[l]?.[p] || ''); }).catch(() => {});
    }
  }
  const putS = async (patch) => { try { S = await post('/api/settings', patch, 'PUT'); } catch (e) { toast(e.message, 'bad'); } };

  // ---------- events ----------
  body.addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-act]'); if (!b) return;
    const a = b.dataset.act, card = b.closest('.kcard'), env = card?.dataset.env, id = b.closest('li')?.dataset.id;
    if (a === 'add') { adding.add(env); render(); $(`.kcard[data-env="${env}"] .addkey input`).focus(); return; }
    if (a === 'import') { b.disabled = true; return act(() => post('/api/keys/import', { path: $('#impPath').value }), (r) => (r.added ? `Imported ${r.added} key(s)` : 'Nothing new to import') + (r.skipped ? `, ${r.skipped} already here` : '')); }
    if (a === 'up' || a === 'down') {
      const ids = KEYS.find((p) => p.env === env).keys.map((k) => k.id), i = ids.indexOf(id), j = a === 'up' ? i - 1 : i + 1;
      [ids[i], ids[j]] = [ids[j], ids[i]];
      return act(() => post(`/api/keys/${env}/order`, { ids }, 'PUT'));
    }
    if (a === 'test') { b.textContent = 'Testing…'; b.disabled = true; return act(() => post(`/api/keys/${env}/${id}/test`), (r) => (r.ok ? 'This key works' : ['Test failed: ' + r.msg, 'bad'])); }
    if (a === 'reset') return act(() => post(`/api/keys/${id}`, { reset: true }, 'PATCH'), 'Marks cleared: the key will be tried again');
    if (a === 'toggle') { const k = KEYS.find((p) => p.env === env).keys.find((x) => x.id === id); return act(() => post(`/api/keys/${id}`, { disabled: !k.disabled }, 'PATCH'), k.disabled ? 'Key enabled' : 'Key disabled: it will be skipped'); }
    if (a === 'del') { if (confirm('Delete this key? It is removed from .env and cannot be recovered here.')) act(() => call(`/api/keys/${env}/${id}`, { method: 'DELETE' }), 'Key deleted'); return; }
    if (a === 'pup' || a === 'pdown') {
      const pr = [...S.priority], i = pr.indexOf(b.closest('li').dataset.p), j = a === 'pup' ? i - 1 : i + 1;
      [pr[i], pr[j]] = [pr[j], pr[i]]; await putS({ priority: pr }); return render();
    }
    if (a === 'models') return loadAgents(true);
    if (a === 'try') vsPlay(b, { provider: b.dataset.p, lang: b.dataset.l, voice: S.voices[b.dataset.l]?.[b.dataset.p] || '', speed: S.speed, text: $('#tryText').value });
  });
  body.addEventListener('submit', async (e) => { // add a key, then test it right away so its status is real
    e.preventDefault(); const f = e.target, d = Object.fromEntries(new FormData(f));
    const env = f.id === 'newProv' ? d.env.trim().toUpperCase() : f.closest('.kcard').dataset.env;
    f.querySelector('button').disabled = true;
    await act(async () => {
      const list = await post('/api/keys', { env, value: d.value, label: d.label }); adding.delete(env);
      const p = list.find((x) => x.env === env), k = p.keys.at(-1);
      return p.testable ? await post(`/api/keys/${env}/${k.id}/test`) : { ok: null, providers: list };
    }, (r) => (r.ok === false ? ['Key added, but the test failed: ' + r.msg, 'bad'] : r.ok ? 'Key added and it works' : 'Key added'));
  });
  body.addEventListener('change', async (e) => {
    const el = e.target;
    if (el.name === 'agent') return setAI({ agent: el.value });
    if (el.dataset.model) {
      const cur = S.ai.agent, prev = S.ai[cur][el.dataset.model];
      let v = el.value;
      if (v === '__other') { v = (prompt('Model id, exactly as the CLI takes it', prev || '') || '').trim(); if (!v) { el.value = prev; return; } }
      return setAI({ [cur]: { ...S.ai[cur], [el.dataset.model]: v } });
    }
    if (el.dataset.act === 'label') return act(() => post(`/api/keys/${el.closest('li').dataset.id}`, { label: el.value }, 'PATCH'));
    if (el.dataset.set) {
      const k = el.dataset.set, v = el.type === 'checkbox' ? el.checked : el.type === 'range' ? +el.value : el.value || null;
      return putS({ [k]: v });
    }
    if (el.dataset.voice) {
      const [l, p] = el.dataset.voice.split('|'), id = pickVoice(el, S.voices[l]?.[p]); if (!id) return;
      await putS({ voices: { ...S.voices, [l]: { ...S.voices[l], [p]: id } } }); if (!el.querySelector(`option[value="${CSS.escape(id)}"]`)) render();
    }
  });
  body.addEventListener('input', (e) => { if (e.target.type === 'range') e.target.nextElementSibling.textContent = (+e.target.value).toFixed(2) + (e.target.dataset.set === 'speed' ? '×' : ''); });
  document.querySelectorAll('#settingsModal .tab').forEach((t) => (t.onclick = () => { tab = t.dataset.tab; body.scrollTop = 0; render(); if (tab === 'ai' && !AG && !agLoading) loadAgents(); }));
  $('#settingsClose').onclick = close;
  modal.addEventListener('mousedown', (e) => { if (e.target === modal) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  const route = () => { if (location.hash === '#settings') open(); };
  window.addEventListener('hashchange', route); route();
})();
