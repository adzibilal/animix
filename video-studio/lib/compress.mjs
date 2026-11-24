// Video compression helper for Video Studio (uses ffmpeg/ffprobe).
// Produces web/social-ready H.264/AAC MP4 copies cached per source file (size + mtimeMs).
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';

export const AUTO_THRESHOLD_BYTES = 85 * 1024 * 1024; // 85 MiB (safe for temp hosts & fast uploads)

export const PRESETS = {
  balanced: {
    id: 'balanced',
    label: '1080p HD (≤ 80 MB)',
    maxShortEdge: 1080,
    crf: 24,
    maxVideoKbps: 3500,
    audioKbps: 128,
    targetMaxBytes: 80 * 1024 * 1024,
    ffPreset: 'veryfast',
  },
  compact: {
    id: 'compact',
    label: '720p Compact (≤ 42 MB)',
    maxShortEdge: 720,
    crf: 26,
    maxVideoKbps: 2000,
    audioKbps: 96,
    targetMaxBytes: 42 * 1024 * 1024,
    ffPreset: 'veryfast',
  },
  small: {
    id: 'small',
    label: '540p Small (≤ 24 MB)',
    maxShortEdge: 540,
    crf: 28,
    maxVideoKbps: 1100,
    audioKbps: 96,
    targetMaxBytes: 24 * 1024 * 1024,
    ffPreset: 'veryfast',
  },
};

export const COMPRESS_MODES = ['auto', 'balanced', 'compact', 'small', 'none'];

const inFlight = new Map();

export function probeVideo(filePath) {
  if (!fs.existsSync(filePath)) return Promise.reject(new Error('Video file not found: ' + filePath));
  const stat = fs.statSync(filePath);
  return new Promise((resolve, reject) => {
    execFile(
      'ffprobe',
      [
        '-v', 'error',
        '-show_entries', 'format=duration,size:stream=codec_type,width,height',
        '-of', 'json',
        filePath,
      ],
      { encoding: 'utf8', maxBuffer: 2 << 20 },
      (err, stdout) => {
        if (err) return reject(new Error(`ffprobe failed: ${err.message}`));
        let data = {};
        try { data = JSON.parse(stdout || '{}'); } catch {}
        const vStream = (data.streams || []).find((s) => s.codec_type === 'video') || {};
        const aStream = (data.streams || []).find((s) => s.codec_type === 'audio') || null;
        const duration = Math.max(0.1, Number(data.format?.duration) || 0);
        resolve({
          duration,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          width: Number(vStream.width) || 0,
          height: Number(vStream.height) || 0,
          hasAudio: !!aStream,
        });
      },
    );
  });
}

export function buildCompressArgs(info, outPath, presetId = 'balanced') {
  const preset = PRESETS[presetId];
  if (!preset) throw new Error(`Unknown compression preset: ${presetId}`);

  const duration = Math.max(1, Number(info.duration) || 1);
  const targetBits = preset.targetMaxBytes * 8 * 0.88;
  const audioBps = info.hasAudio !== false ? preset.audioKbps * 1000 : 0;
  const budgetKbps = Math.floor((targetBits / duration - audioBps) / 1000);
  const videoKbps = Math.min(preset.maxVideoKbps, Math.max(300, budgetKbps));

  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', info.filePath];

  const w = Number(info.width) || 0;
  const h = Number(info.height) || 0;
  const shortEdge = w && h ? Math.min(w, h) : 0;
  if (shortEdge > preset.maxShortEdge) {
    const E = preset.maxShortEdge;
    args.push('-vf', `scale='if(gte(iw,ih),-2,${E})':'if(gte(iw,ih),${E},-2)'`);
  }

  args.push(
    '-c:v', 'libx264',
    '-preset', preset.ffPreset,
    '-crf', String(preset.crf),
    '-maxrate', `${videoKbps}k`,
    '-bufsize', `${videoKbps * 2}k`,
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
  );

  if (info.hasAudio !== false) {
    args.push('-c:a', 'aac', '-b:a', `${preset.audioKbps}k`);
  } else {
    args.push('-an');
  }

  args.push('-progress', 'pipe:1', '-nostats', '-f', 'mp4', outPath);
  return { args, preset, videoKbps };
}

function cachePaths(outDir, presetId) {
  return {
    mp4: path.join(outDir, `compressed-${presetId}.mp4`),
    tmp: path.join(outDir, `compressed-${presetId}.tmp.mp4`),
    meta: path.join(outDir, `compressed-${presetId}.json`),
  };
}

export function getCachedCompressed(filePath, outDir, presetId) {
  if (!PRESETS[presetId] || !fs.existsSync(filePath)) return null;
  const stat = fs.statSync(filePath);
  const { mp4, meta } = cachePaths(outDir, presetId);
  if (!fs.existsSync(mp4) || !fs.existsSync(meta)) return null;
  try {
    const info = JSON.parse(fs.readFileSync(meta, 'utf8'));
    if (info.sourceSize !== stat.size || info.sourceMtimeMs !== stat.mtimeMs) return null;
    const outStat = fs.statSync(mp4);
    if (!outStat.size) return null;
    return {
      preset: presetId,
      path: mp4,
      size: outStat.size,
      mtimeMs: outStat.mtimeMs,
      originalSize: stat.size,
      duration: info.duration || 0,
      cached: true,
    };
  } catch {
    return null;
  }
}

export function listCachedCompressed(filePath, outDir) {
  if (!fs.existsSync(filePath)) return null;
  const stat = fs.statSync(filePath);
  const presets = {};
  for (const id of Object.keys(PRESETS)) {
    const c = getCachedCompressed(filePath, outDir, id);
    if (c) presets[id] = { size: c.size, mtimeMs: c.mtimeMs, duration: c.duration };
  }
  return { originalSize: stat.size, mtimeMs: stat.mtimeMs, presets };
}

export async function compressVideo(filePath, { outDir, preset = 'balanced', onProgress } = {}) {
  if (!PRESETS[preset]) throw new Error(`Unknown compression preset: ${preset}`);
  if (!fs.existsSync(filePath)) throw new Error('Video file not found: ' + filePath);
  const dir = outDir || path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  const cached = getCachedCompressed(filePath, dir, preset);
  if (cached) {
    onProgress?.({ pct: 100, preset });
    return cached;
  }

  const key = `${path.resolve(filePath)}::${path.resolve(dir)}::${preset}`;
  if (inFlight.has(key)) return inFlight.get(key);

  const job = (async () => {
    const info = await probeVideo(filePath);
    const { mp4, tmp, meta } = cachePaths(dir, preset);
    const { args } = buildCompressArgs({ ...info, filePath }, tmp, preset);

    await new Promise((resolve, reject) => {
      const child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let outBuf = '';
      let errBuf = '';
      let lastPct = -1;
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        outBuf += chunk;
        let idx;
        while ((idx = outBuf.indexOf('\n')) >= 0) {
          const line = outBuf.slice(0, idx).trim();
          outBuf = outBuf.slice(idx + 1);
          const m = line.match(/^out_time_us=(\d+)$/);
          if (m && info.duration > 0) {
            const pct = Math.max(0, Math.min(99, Math.round(((Number(m[1]) / 1e6) / info.duration) * 100)));
            if (pct !== lastPct) {
              lastPct = pct;
              onProgress?.({ pct, preset });
            }
          }
        }
      });
      child.stderr.on('data', (d) => { errBuf += d; if (errBuf.length > 4000) errBuf = errBuf.slice(-4000); });
      child.on('error', (e) => reject(new Error(`ffmpeg failed to start: ${e.message}`)));
      child.on('close', (code) => {
        if (code !== 0) {
          try { fs.rmSync(tmp, { force: true }); } catch {}
          return reject(new Error(`ffmpeg compression failed (exit ${code}): ${errBuf.trim().slice(-300) || 'unknown error'}`));
        }
        resolve();
      });
    });

    fs.renameSync(tmp, mp4);
    const outStat = fs.statSync(mp4);
    fs.writeFileSync(meta, JSON.stringify({
      preset,
      sourceSize: info.size,
      sourceMtimeMs: info.mtimeMs,
      size: outStat.size,
      duration: info.duration,
      createdAt: new Date().toISOString(),
    }, null, 2));
    onProgress?.({ pct: 100, preset });

    return {
      preset,
      path: mp4,
      size: outStat.size,
      mtimeMs: outStat.mtimeMs,
      originalSize: info.size,
      duration: info.duration,
      cached: false,
    };
  })().finally(() => {
    inFlight.delete(key);
  });

  inFlight.set(key, job);
  return job;
}

export async function resolveVideoForUpload(filePath, { outDir, mode = 'auto', onProgress } = {}) {
  if (!fs.existsSync(filePath)) throw new Error('Video file not found: ' + filePath);
  const stat = fs.statSync(filePath);
  const norm = COMPRESS_MODES.includes(mode) ? mode : 'auto';
  if (norm === 'none' || (norm === 'auto' && stat.size <= AUTO_THRESHOLD_BYTES)) {
    return {
      filePath,
      compressed: false,
      preset: 'none',
      originalSize: stat.size,
      size: stat.size,
      cached: false,
    };
  }
  const preset = norm === 'auto' ? 'balanced' : norm;
  const res = await compressVideo(filePath, { outDir, preset, onProgress });
  return {
    filePath: res.path,
    compressed: true,
    preset: res.preset,
    originalSize: stat.size,
    size: res.size,
    cached: res.cached,
  };
}
