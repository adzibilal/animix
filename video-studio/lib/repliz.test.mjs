// Self-check for Repliz keys + upload + platform payload mapping + schedule creation (mock fetch, temp .env).
// Run: node video-studio/lib/repliz.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-repliz-'));
process.env.VS_ENV_FILE = path.join(T, '.env');
process.env.VS_KEYS_FILE = path.join(T, '.keys.json');

const keys = await import('./keys.mjs');
const repliz = await import('./repliz.mjs');

// 1. Paired Repliz key testing in keys.mjs
fs.writeFileSync(process.env.VS_ENV_FILE, '');
keys.addKey('REPLIZ_ACCESS_KEY', 'acc_123456', 'main');
const accId = keys.listKeys().find((p) => p.env === 'REPLIZ_ACCESS_KEY').keys[0].id;

// Testing Access Key before Secret Key exists returns skipSave: true -> does not mark Invalid
const rMissing = await keys.testKey('REPLIZ_ACCESS_KEY', accId);
assert.equal(rMissing.ok, false);
assert.match(rMissing.msg, /REPLIZ_SECRET_KEY/);
assert.equal(keys.listKeys().find((p) => p.env === 'REPLIZ_ACCESS_KEY').keys[0].error, undefined);

const reqs = [];
globalThis.fetch = async (url, opts = {}) => {
  reqs.push({ url: String(url), method: opts.method || 'GET', headers: opts.headers || {}, body: opts.body });
  if (String(url).includes('/public/account')) {
    return new Response(JSON.stringify({
      docs: [
        { _id: 'acc_yt', name: 'My YT', username: 'myyt', type: 'youtube', isConnected: true },
        { _id: 'acc_tt', name: 'My TT', username: 'mytt', type: 'tiktok', isConnected: true },
      ],
      hasNextPage: false,
    }));
  }
  if (String(url).endsWith('/public/storage/file/init')) {
    return new Response(JSON.stringify({
      id: 'file_1',
      upload: 'https://upload.example.test/presigned',
      key: 'uploads/test.mp4',
      url: 'https://storage.repliz.com/uploads/test.mp4',
    }));
  }
  if (String(url) === 'https://upload.example.test/presigned') {
    return new Response('', { status: 200 });
  }
  if (String(url).endsWith('/public/storage/file/file_1/complete')) {
    return new Response(JSON.stringify({ ok: true }));
  }
  if (String(url).endsWith('/public/schedule')) {
    return new Response(JSON.stringify({ _id: 'sched_1', status: 'scheduled' }));
  }
  if (String(url) === 'https://pomf2.lain.la/upload.php') {
    return new Response(JSON.stringify({ success: true, files: [{ url: 'https://pomf2.lain.la/f/abc.mp4' }] }));
  }
  if (String(url) === 'https://uguu.se/upload') {
    return new Response(JSON.stringify({ success: true, files: [{ url: 'https://h.uguu.se/abc.mp4' }] }));
  }
  if (String(url) === 'https://catbox.moe/user/api.php') {
    return new Response('https://files.catbox.moe/abc123.mp4');
  }
  return new Response('{}', { status: 404 });
};

keys.addKey('REPLIZ_SECRET_KEY', 'sec_abcdef');
const secId = keys.listKeys().find((p) => p.env === 'REPLIZ_SECRET_KEY').keys[0].id;
const rOk = await keys.testKey('REPLIZ_SECRET_KEY', secId);
assert.equal(rOk.ok, true);
assert.equal(repliz.isConfigured(), true);
assert.equal(reqs[0].headers.Authorization, `Basic ${Buffer.from('acc_123456:sec_abcdef').toString('base64')}`);

// 2. listAccounts + 3-step uploadVideo
const accounts = await repliz.listAccounts();
assert.equal(accounts.length, 2);

const dummyVid = path.join(T, 'final.mp4');
fs.writeFileSync(dummyVid, Buffer.from('mp4bytes'));
const up = await repliz.uploadVideo(dummyVid, 'final.mp4');
assert.equal(up.url, 'https://storage.repliz.com/uploads/test.mp4');
assert.equal(up.size, 8);
const putReq = reqs.find((x) => x.url === 'https://upload.example.test/presigned');
assert.equal(putReq.method, 'PUT');
assert.equal(putReq.headers['Content-Type'], 'video/mp4');
assert.equal(putReq.headers.Authorization, undefined, 'presigned PUT must not include Authorization');

// 3. buildSchedulePayload platform limits
const meta = {
  title: 'A'.repeat(120),
  description: 'Hook line here',
  hashtags: ['resleting', '#faktaunik', 'Resleting'],
  tags: ['zipper', 'cara kerja resleting'],
  firstComment: 'C'.repeat(200),
  topic: 'Sains',
};
const ytPayload = repliz.buildSchedulePayload({
  account: { id: 'acc_yt', type: 'youtube' },
  metadata: meta,
  videoUrl: up.url,
  scheduleAt: '2026-11-16T10:00:00.000Z',
  options: { isAiGenerated: true, privacy: 'unlisted' },
});
assert.equal(ytPayload.title.length, 100);
assert.match(ytPayload.description, /Hook line here\n\n#resleting #faktaunik/);
assert.deepEqual(ytPayload.additionalInfo.tags, ['zipper', 'cara kerja resleting']);
assert.equal(ytPayload.additionalInfo.privacy, 'unlisted');
assert.equal(ytPayload.additionalInfo.isAiGenerated, true);

const ttPayload = repliz.buildSchedulePayload({
  account: { id: 'acc_tt', type: 'tiktok' },
  metadata: meta,
  videoUrl: up.url,
  scheduleAt: '2026-11-16T10:00:00.000Z',
});
assert.equal(ttPayload.title, '');
assert.equal(ttPayload.additionalInfo.firstComment.length, 150);

const threadsPayload = repliz.buildSchedulePayload({
  account: { id: 'acc_th', type: 'threads' },
  metadata: { ...meta, description: 'D'.repeat(600) },
  videoUrl: up.url,
  scheduleAt: '2026-11-16T10:00:00.000Z',
});
assert.equal(threadsPayload.description.length, 500);
assert.equal(threadsPayload.topic, 'Sains');
assert.equal(threadsPayload.additionalInfo.firstComment, undefined);

const created = await repliz.createSchedule(ytPayload);
assert.equal(created._id, 'sched_1');

// 4. 402 from Repliz Storage falls back to temp web host (pomf2 -> uguu)
const prevFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  if (String(url).endsWith('/public/storage/file/init')) {
    return new Response(JSON.stringify({ code: 402, message: 'upgrade to get more storage' }), { status: 402 });
  }
  return prevFetch(url, opts);
};
const fallbackUp = await repliz.uploadVideo(dummyVid, 'final.mp4', { host: 'auto' });
assert.equal(fallbackUp.host, 'temp');
assert.equal(fallbackUp.provider, 'pomf2.lain.la');
assert.equal(fallbackUp.url, 'https://pomf2.lain.la/f/abc.mp4');

globalThis.fetch = async (url, opts = {}) => {
  if (String(url) === 'https://pomf2.lain.la/upload.php') return new Response('down', { status: 503 });
  return prevFetch(url, opts);
};
const uguuUp = await repliz.uploadVideo(dummyVid, 'final.mp4', { host: 'temp' });
assert.equal(uguuUp.host, 'temp');
assert.equal(uguuUp.provider, 'uguu.se');
assert.equal(uguuUp.url, 'https://h.uguu.se/abc.mp4');

// 5. Fallback to catbox.moe when pomf2 + uguu fail
globalThis.fetch = async (url, opts = {}) => {
  if (String(url) === 'https://pomf2.lain.la/upload.php') return new Response('down', { status: 503 });
  if (String(url) === 'https://uguu.se/upload') return new Response('down', { status: 503 });
  return prevFetch(url, opts);
};
const catboxUp = await repliz.uploadVideo(dummyVid, 'final.mp4', { host: 'temp' });
assert.equal(catboxUp.host, 'temp');
assert.equal(catboxUp.provider, 'catbox.moe');
assert.equal(catboxUp.url, 'https://files.catbox.moe/abc123.mp4');

fs.rmSync(T, { recursive: true });
console.log('repliz: ok');
