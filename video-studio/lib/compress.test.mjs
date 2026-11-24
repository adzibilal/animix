// Self-check for video compression helper (runs real ffmpeg on a 2s synthetic video).
// Run: node video-studio/lib/compress.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  probeVideo,
  buildCompressArgs,
  compressVideo,
  getCachedCompressed,
  listCachedCompressed,
  resolveVideoForUpload,
} from './compress.mjs';

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-compress-'));
const src = path.join(T, 'sample.mp4');
const work = path.join(T, 'work');

// Create a 2s 1080x1920 test clip with audio
execFileSync('ffmpeg', [
  '-v', 'error', '-y',
  '-f', 'lavfi', '-i', 'testsrc=size=1080x1920:rate=30:duration=2',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
  '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18', '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-b:a', '128k',
  src,
]);

const info = await probeVideo(src);
assert.equal(info.width, 1080);
assert.equal(info.height, 1920);
assert.equal(info.hasAudio, true);
assert.ok(info.duration >= 1.8 && info.duration <= 2.3);

// buildCompressArgs caps bitrate for long videos so they fit targetMaxBytes
const longArgs = buildCompressArgs(
  { filePath: src, duration: 300, width: 1080, height: 1920, hasAudio: true },
  path.join(work, 'out.mp4'),
  'compact',
);
const maxrateIdx = longArgs.args.indexOf('-maxrate');
assert.ok(maxrateIdx > 0);
const maxrateKbps = parseInt(longArgs.args[maxrateIdx + 1], 10);
assert.ok(maxrateKbps <= 1200, `Expected capped bitrate for 5m compact video, got ${maxrateKbps}k`);
assert.ok(longArgs.args.includes('-vf'), 'Should include scale filter when shortEdge 1080 > 720');

// Compress with compact preset + progress callback + caching
const seenPct = [];
const res1 = await compressVideo(src, {
  outDir: work,
  preset: 'compact',
  onProgress: ({ pct }) => seenPct.push(pct),
});
assert.equal(res1.preset, 'compact');
assert.equal(res1.cached, false);
assert.ok(fs.existsSync(res1.path));
assert.ok(seenPct.includes(100));

const outInfo = await probeVideo(res1.path);
assert.equal(outInfo.width, 720);
assert.equal(outInfo.height, 1280);

// Second call hits cache
const res2 = await compressVideo(src, { outDir: work, preset: 'compact' });
assert.equal(res2.cached, true);
assert.equal(res2.path, res1.path);
assert.ok(getCachedCompressed(src, work, 'compact'));
assert.ok(listCachedCompressed(src, work).presets.compact);

// resolveVideoForUpload: 'auto' skips compression when small, 'small' compresses
const autoRes = await resolveVideoForUpload(src, { outDir: work, mode: 'auto' });
assert.equal(autoRes.compressed, false);
assert.equal(autoRes.filePath, src);

const smallRes = await resolveVideoForUpload(src, { outDir: work, mode: 'small' });
assert.equal(smallRes.compressed, true);
assert.equal(smallRes.preset, 'small');
const smallInfo = await probeVideo(smallRes.filePath);
assert.equal(smallInfo.width, 540);
assert.equal(smallInfo.height, 960);

fs.rmSync(T, { recursive: true, force: true });
console.log('compress: ok');
