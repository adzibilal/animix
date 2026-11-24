// Repliz Public API client (https://docs.repliz.com/).
// Credentials live in .env as REPLIZ_ACCESS_KEY and REPLIZ_SECRET_KEY (managed via keys.mjs).
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { keysFor } from './keys.mjs';

// ponytail: Node's happy-eyeballs gives each address only 250ms; slow IPv4 (temp hosts from WSL) then
// falls through to an unroutable IPv6 and fetch dies with ETIMEDOUT. 2s per attempt fixes it process-wide.
net.setDefaultAutoSelectFamilyAttemptTimeout(2000);

const BASE = 'https://api.repliz.com';

export const isConfigured = () =>
  keysFor('REPLIZ_ACCESS_KEY').length > 0 && keysFor('REPLIZ_SECRET_KEY').length > 0;

function authHeader() {
  const access = keysFor('REPLIZ_ACCESS_KEY')[0];
  const secret = keysFor('REPLIZ_SECRET_KEY')[0];
  if (!access || !secret) {
    throw new Error('Repliz credentials missing: add REPLIZ_ACCESS_KEY and REPLIZ_SECRET_KEY in Settings → API Keys');
  }
  return `Basic ${Buffer.from(`${access}:${secret}`).toString('base64')}`;
}

async function request(pathname, { method = 'GET', body, timeout = 30_000 } = {}) {
  const headers = { Authorization: authHeader() };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeout),
  });
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch {}
  if (!res.ok) {
    const msg = data.message || data.error || text.slice(0, 200) || `HTTP ${res.status}`;
    throw new Error(`Repliz ${res.status}: ${msg}`);
  }
  return data;
}

export async function listAccounts() {
  const accounts = [];
  let page = 1;
  while (page <= 20) {
    const data = await request(`/public/account?page=${page}&limit=100&status=connected`);
    for (const a of data.docs || []) {
      accounts.push({
        id: a._id || a.id,
        name: a.name || a.username || 'Account',
        username: a.username || '',
        type: a.type || '',
        picture: a.picture || '',
        isConnected: a.isConnected !== false,
      });
    }
    if (!data.hasNextPage) break;
    page = data.nextPage || page + 1;
  }
  return accounts;
}

export async function listPinterestBoards(accountId) {
  const data = await request(`/public/addon/pinterest/board?accountId=${encodeURIComponent(accountId)}`);
  return data.docs || [];
}

async function fileBlob(filePath) {
  if (typeof fs.openAsBlob === 'function') return fs.openAsBlob(filePath, { type: 'video/mp4' });
  return new Blob([await fs.promises.readFile(filePath)], { type: 'video/mp4' });
}

/** Three-step Repliz Storage upload: init -> PUT binary to presigned URL -> complete. */
export async function uploadReplizStorage(filePath, filename = path.basename(filePath), { timeout = 600_000 } = {}) {
  if (!fs.existsSync(filePath)) throw new Error('Video file not found: ' + filePath);
  const stat = fs.statSync(filePath);
  const init = await request('/public/storage/file/init', {
    method: 'POST',
    body: { filename, size: stat.size, mimetype: 'video/mp4' },
  });
  if (!init?.id || !init?.upload || !init?.url) {
    throw new Error('Repliz storage init did not return upload URL');
  }
  const blob = await fileBlob(filePath);
  const putRes = await fetch(init.upload, {
    method: 'PUT',
    headers: { 'Content-Type': 'video/mp4' },
    body: blob,
    signal: AbortSignal.timeout(timeout),
  });
  if (!putRes.ok) {
    const errText = await putRes.text().catch(() => '');
    throw new Error(`Repliz storage PUT failed (${putRes.status}): ${errText.slice(0, 200)}`);
  }
  await request(`/public/storage/file/${encodeURIComponent(init.id)}/complete`, {
    method: 'POST',
    body: {},
  });
  return {
    host: 'repliz',
    provider: 'repliz',
    id: init.id,
    key: init.key,
    url: init.url,
    filename,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    uploadedAt: new Date().toISOString(),
  };
}

const fmtMb = (bytes) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

/** Upload to public web file host (pomf2.lain.la up to 1 GiB, uguu.se up to 128 MiB, catbox.moe up to 200 MiB). */
export async function uploadTempWeb(filePath, filename = path.basename(filePath), { timeout = 600_000 } = {}) {
  if (!fs.existsSync(filePath)) throw new Error('Video file not found: ' + filePath);
  const stat = fs.statSync(filePath);
  const hosts = [
    {
      name: 'pomf2.lain.la',
      url: 'https://pomf2.lain.la/upload.php',
      field: 'files[]',
      maxBytes: 1024 * 1024 * 1024,
      parse: (res, text) => {
        let data = {};
        try { data = JSON.parse(text); } catch {}
        const url = data?.files?.[0]?.url;
        if (!res.ok || !data?.success || !url) {
          throw new Error(data?.description || data?.error || text.slice(0, 160) || `HTTP ${res.status}`);
        }
        return url;
      },
    },
    {
      name: 'uguu.se',
      url: 'https://uguu.se/upload',
      field: 'files[]',
      maxBytes: 128 * 1024 * 1024,
      parse: (res, text) => {
        let data = {};
        try { data = JSON.parse(text); } catch {}
        const url = data?.files?.[0]?.url;
        if (!res.ok || !data?.success || !url) {
          throw new Error(data?.description || data?.error || text.slice(0, 160) || `HTTP ${res.status}`);
        }
        return url;
      },
    },
    {
      name: 'catbox.moe',
      url: 'https://catbox.moe/user/api.php',
      field: 'fileToUpload',
      extra: { reqtype: 'fileupload' },
      maxBytes: 200 * 1024 * 1024,
      parse: (res, text) => {
        const trimmed = String(text || '').trim();
        if (!res.ok || !/^https?:\/\/\S+/.test(trimmed)) {
          throw new Error(trimmed.slice(0, 160) || `HTTP ${res.status}`);
        }
        return trimmed;
      },
    },
  ];
  const errors = [];
  for (const h of hosts) {
    if (h.maxBytes && stat.size > h.maxBytes) {
      errors.push(`${h.name}: skipped (${fmtMb(stat.size)} > ${fmtMb(h.maxBytes)} limit)`);
      continue;
    }
    try {
      const form = new FormData();
      if (h.extra) for (const [k, v] of Object.entries(h.extra)) form.append(k, v);
      form.append(h.field, await fileBlob(filePath), filename);
      const res = await fetch(h.url, {
        method: 'POST',
        headers: { 'User-Agent': 'VideoStudio/1.0' },
        body: form,
        signal: AbortSignal.timeout(timeout),
      });
      const text = await res.text();
      const fileUrl = h.parse(res, text);
      return {
        host: 'temp',
        provider: h.name,
        url: fileUrl,
        filename,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        uploadedAt: new Date().toISOString(),
      };
    } catch (e) {
      errors.push(`${h.name}: ${e.message}`);
    }
  }
  const hint = stat.size > 100 * 1024 * 1024 ? ' — Try enabling video compression before upload' : '';
  throw new Error(`Temp web upload failed (${errors.join('; ')})${hint}`);
}

/** Upload video either to Repliz Storage or temp web host (auto falls back to temp web on 402/429 quota error). */
export async function uploadVideo(filePath, filename = path.basename(filePath), { host = 'auto', timeout = 600_000 } = {}) {
  if (host === 'temp') return uploadTempWeb(filePath, filename, { timeout });
  if (host === 'repliz') return uploadReplizStorage(filePath, filename, { timeout });
  try {
    return await uploadReplizStorage(filePath, filename, { timeout });
  } catch (e) {
    if (/Repliz (402|429):|upgrade to get more storage/i.test(e.message)) {
      return uploadTempWeb(filePath, filename, { timeout });
    }
    throw e;
  }
}

function normalizeHashtags(hashtags) {
  const items = Array.isArray(hashtags)
    ? hashtags
    : String(hashtags || '').split(/[\s,]+/).filter(Boolean);
  const seen = new Set();
  const out = [];
  for (let h of items) {
    h = String(h || '').trim().replace(/^#+/, '').replace(/[^\p{L}\p{N}_]/gu, '');
    if (!h) continue;
    const tag = '#' + h;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out;
}

function fitYouTubeTags(rawTags) {
  const items = Array.isArray(rawTags)
    ? rawTags
    : String(rawTags || '').split(',').map((s) => s.trim()).filter(Boolean);
  const out = [];
  let total = 0;
  for (const raw of items) {
    const t = String(raw || '').trim();
    if (!t || out.includes(t)) continue;
    if (total + t.length > 500) break;
    out.push(t);
    total += t.length;
  }
  return out;
}

const DESC_LIMIT = { shopee: 150, threads: 500, pinterest: 800, instagram: 2200, tiktok: 2200 };
const COMMENT_LIMIT = { tiktok: 150, linkedin: 1250, instagram: 2200, facebook: 8000, youtube: 10_000 };

export function buildSchedulePayload({ account, metadata = {}, videoUrl, scheduleAt, options = {} }) {
  const platform = String(account?.type || '').toLowerCase();
  const accountId = account?.id || account?._id;
  if (!accountId) throw new Error('Missing accountId');
  if (!videoUrl) throw new Error('Missing uploaded videoUrl');

  const isoDate = new Date(scheduleAt);
  if (Number.isNaN(isoDate.getTime())) throw new Error('Invalid scheduleAt date');

  const rawTitle = String(metadata.title || '').trim();
  const rawDesc = String(metadata.description || '').trim();
  const hashtags = normalizeHashtags(metadata.hashtags);
  const fullDesc = [rawDesc, hashtags.join(' ')].filter(Boolean).join(rawDesc && hashtags.length ? '\n\n' : '');

  const descCap = DESC_LIMIT[platform];
  let description = descCap ? fullDesc.slice(0, descCap) : fullDesc;
  if (platform === 'shopee' && !description) {
    description = (rawTitle || 'Video').slice(0, 150);
  }

  let title = '';
  if (platform === 'youtube' || platform === 'pinterest') title = rawTitle.slice(0, 100);
  else if (platform === 'facebook') title = rawTitle;

  const firstCommentRaw = String(metadata.firstComment || '').trim();
  const commentLimit = COMMENT_LIMIT[platform];
  const firstComment = commentLimit && firstCommentRaw ? firstCommentRaw.slice(0, commentLimit) : '';

  const privacy = ['public', 'unlisted', 'private'].includes(options.privacy) ? options.privacy : 'public';
  const tags = platform === 'youtube' ? fitYouTubeTags(metadata.tags) : [];

  const additionalInfo = {
    isAiGenerated: !!options.isAiGenerated,
    isDraft: false,
    isAutoAddMusic: false,
    isShareToFeed: options.isShareToFeed !== false,
    privacy,
    trialParams: { graduationStrategy: '' },
    collaborators: [],
    mentions: [],
    music: { id: '', artist: '', name: '', thumbnail: '', volume: { video: 50, music: 100 } },
    products: [],
    tags,
    targetCountries: [],
    ...(firstComment ? { firstComment } : {}),
    ...(options.channel ? { channel: options.channel } : {}),
  };

  return {
    title,
    description,
    topic: platform === 'threads' ? String(metadata.topic || '').trim() : '',
    type: 'video',
    medias: [
      {
        alt: '',
        customThumbnail: false,
        type: 'video',
        thumbnail: '',
        url: videoUrl,
      },
    ],
    meta: { title: '', description: '', url: '' },
    additionalInfo,
    replies: [],
    accountId,
    scheduleAt: isoDate.toISOString(),
  };
}

export async function createSchedule(payload) {
  return request('/public/schedule', { method: 'POST', body: payload });
}
