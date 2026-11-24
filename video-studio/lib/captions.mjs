// Burn 1-3 word bold white captions with black stroke onto stitched videos (used for cartoon-3d-short).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const isCartoon3d = (project) =>
  String(project?.style || '').startsWith('cartoon3d/') ||
  (project?.scenes || []).some((s) => String(s?.tool || '').startsWith('cartoon3d/'));

const durOf = (file) => {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' });
  return r.status === 0 ? Math.max(0, +r.stdout.trim() || 0) : 0;
};

/** Detect active speech [start, end] inside a TTS audio clip so leading/trailing silence does not skew captions. */
export function detectSpeechBounds(file, totalDur) {
  const total = totalDur || durOf(file);
  if (!(total > 0)) return { start: 0, end: 0, total: 0 };
  const r = spawnSync('ffmpeg', ['-hide_banner', '-i', file, '-af', 'silencedetect=noise=-35dB:d=0.05', '-f', 'null', '-'], { encoding: 'utf8' });
  const log = r.stderr || '';
  const silences = [];
  let curStart = null;
  for (const line of log.split(/\r?\n/)) {
    const ms = line.match(/silence_start:\s*([\d.]+)/);
    if (ms) curStart = +ms[1];
    const me = line.match(/silence_end:\s*([\d.]+)/);
    if (me) {
      silences.push({ start: curStart ?? 0, end: +me[1] });
      curStart = null;
    }
  }
  if (curStart !== null) silences.push({ start: curStart, end: total });

  let start = 0;
  let end = total;
  if (silences.length && silences[0].start <= 0.08) {
    start = Math.min(silences[0].end, Math.max(0, total - 0.15));
  }
  const last = silences[silences.length - 1];
  if (last && last.end >= total - 0.08 && last.start > start + 0.1) {
    end = last.start;
  }
  if (end <= start + 0.05) {
    start = Math.min(0.1, total * 0.1);
    end = Math.max(start + 0.1, total * 0.9);
  }
  return { start, end, total };
}

/** Split narration text into natural 1-3 word chunks, breaking on sentence/clause boundaries. */
export function chunkWords(text, { maxWords = 3 } = {}) {
  const rawTokens = String(text || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  if (!rawTokens.length) return [];

  // Group into clauses at punctuation so a chunk never straddles a sentence stop.
  const clauses = [];
  let cur = [];
  for (const tok of rawTokens) {
    cur.push(tok);
    if (/[.!?,;:—]$/.test(tok)) {
      clauses.push(cur);
      cur = [];
    }
  }
  if (cur.length) clauses.push(cur);

  const chunks = [];
  for (const words of clauses) {
    let i = 0;
    while (i < words.length) {
      const rem = words.length - i;
      let take;
      if (rem <= maxWords) take = rem;
      else if (rem === 4) take = 2; // 2 + 2 instead of 3 + 1
      else take = maxWords;
      chunks.push(words.slice(i, i + take));
      i += take;
    }
  }
  return chunks;
}

const wordWeight = (w) => {
  const clean = w.replace(/[^\p{L}\p{N}]/gu, '');
  let weight = Math.max(2, clean.length);
  if (/[.!?]$/.test(w)) weight += 3.5;
  else if (/[,;:—]$/.test(w)) weight += 2.0;
  return weight;
};

const formatChunkText = (words) =>
  words
    .map((w, i) => (i === words.length - 1 ? w.replace(/[.,;:]+$/, '') : w))
    .join(' ')
    .trim()
    .toUpperCase();

/**
 * Build timed caption events for all narration lines.
 * lines: [{ file, at, text, tempo? }]
 */
export function buildCaptionEvents(lines) {
  const events = [];
  for (const line of lines) {
    const chunks = chunkWords(line.text, { maxWords: 3 });
    if (!chunks.length) continue;
    const tempo = Math.max(0.5, +line.tempo || 1);
    const bounds = line.bounds || detectSpeechBounds(line.file);
    const speechStart = line.at + bounds.start / tempo;
    const speechEnd = Math.max(speechStart + 0.15, line.at + bounds.end / tempo);
    const span = speechEnd - speechStart;

    const weights = chunks.map((c) => c.reduce((sum, w) => sum + wordWeight(w), 0));
    const totalWeight = weights.reduce((a, b) => a + b, 0) || chunks.length;

    let cursor = speechStart;
    for (let i = 0; i < chunks.length; i++) {
      const dur = (weights[i] / totalWeight) * span;
      const start = cursor;
      const end = i === chunks.length - 1 ? speechEnd : cursor + dur;
      cursor = end;
      const text = formatChunkText(chunks[i]);
      if (text) events.push({ start, end, text });
    }
  }
  // Ensure strict non-overlapping timestamps
  for (let i = 0; i < events.length - 1; i++) {
    if (events[i].end > events[i + 1].start) {
      events[i].end = Math.max(events[i].start + 0.05, events[i + 1].start);
    }
  }
  return events;
}

function fmtAssTime(sec) {
  const s = Math.max(0, sec);
  const cs = Math.round(s * 100);
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const secWhole = Math.floor((cs % 6000) / 100);
  const rem = cs % 100;
  return `${h}:${String(m).padStart(2, '0')}:${String(secWhole).padStart(2, '0')}.${String(rem).padStart(2, '0')}`;
}

const escAss = (text) =>
  String(text).replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}').replace(/\r?\n/g, '\\N');

/** Render an ASS subtitle file with bold white text and thick black stroke. */
export function buildAss(events, [W, H] = [1080, 1920]) {
  const portrait = H >= W;
  const fontSize = portrait ? Math.round(W * 0.076) : Math.round(H * 0.068); // 82px on 1080x1920
  const outline = Math.max(4, Math.round(fontSize * 0.1)); // 8px stroke on 1080x1920
  const shadow = Math.max(1, Math.round(outline * 0.25));
  const marginV = portrait ? Math.round(H * 0.28) : Math.round(H * 0.09); // ~538px from bottom on 1080x1920 (clears low labels & Reels/TikTok UI)
  const marginX = Math.round(W * 0.06);

  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,Liberation Sans,${fontSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,1,0,1,${outline},${shadow},2,${marginX},${marginX},${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`;

  const rows = events.map((ev) => {
    const start = fmtAssTime(ev.start);
    const end = fmtAssTime(Math.max(ev.start + 0.06, ev.end));
    return `Dialogue: 0,${start},${end},Cap,,0,0,0,,{\\fscx108\\fscy108\\t(0,70,\\fscx100\\fscy100)}${escAss(ev.text)}`;
  });

  return `${header}\n${rows.join('\n')}\n`;
}

export function writeAssForLines(lines, size, outAssPath) {
  const events = buildCaptionEvents(lines);
  if (!events.length) return null;
  fs.mkdirSync(path.dirname(outAssPath), { recursive: true });
  fs.writeFileSync(outAssPath, buildAss(events, size), 'utf8');
  return { assPath: outAssPath, count: events.length };
}

export const assFilterArg = (assPath) =>
  `ass='${String(assPath).replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'")}'`;
