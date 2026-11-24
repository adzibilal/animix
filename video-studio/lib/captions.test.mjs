// Self-check for 1-3 word caption chunking, timing, and ASS styling.
// Run: node video-studio/lib/captions.test.mjs
import assert from 'node:assert/strict';
import { isCartoon3d, chunkWords, buildCaptionEvents, buildAss } from './captions.mjs';

assert.equal(isCartoon3d({ style: 'cartoon3d/fire', scenes: [] }), true);
assert.equal(isCartoon3d({ style: 'tvhead/doodle', scenes: [{ tool: 'cartoon3d/fire' }] }), true);
assert.equal(isCartoon3d({ style: 'tvhead/doodle', scenes: [{ tool: 'tvhead/doodle' }] }), false);

// Chunking: every chunk is 1-3 words and respects punctuation splits
const chunks = chunkWords('Kancing jaketmu copot semua. Pas hujan.');
assert.deepEqual(chunks, [
  ['Kancing', 'jaketmu'],
  ['copot', 'semua.'],
  ['Pas', 'hujan.'],
]);
for (const c of chunks) assert.ok(c.length >= 1 && c.length <= 3);

const seven = chunkWords('Satu dua tiga empat lima enam tujuh');
assert.ok(seven.every((c) => c.length >= 1 && c.length <= 3));
assert.equal(seven.flat().length, 7);

// Timing with mocked speech bounds
const events = buildCaptionEvents([
  { file: 'a.mp3', at: 0.15, tempo: 1, text: 'Kancing jaketmu copot semua. Pas hujan.', bounds: { start: 0.25, end: 2.55, total: 2.9 } },
  { file: 'b.mp3', at: 2.60, tempo: 1.2, text: 'Jaketnya kebuka.', bounds: { start: 0.2, end: 1.4, total: 1.6 } },
]);
assert.equal(events.length, 4);
assert.equal(events[0].text, 'KANCING JAKETMU');
assert.equal(events[1].text, 'COPOT SEMUA');
assert.equal(events[2].text, 'PAS HUJAN');
assert.equal(events[3].text, 'JAKETNYA KEBUKA');
assert.ok(Math.abs(events[0].start - 0.40) < 0.001);
assert.ok(events[0].end <= events[1].start);
assert.ok(events[2].end <= events[3].start);

// ASS format: bold white primary color, black outline, Liberation Sans
const ass = buildAss(events, [1080, 1920]);
assert.match(ass, /Style: Cap,Liberation Sans,82,&H00FFFFFF,&H00FFFFFF,&H00000000,/);
assert.match(ass, /,-1,0,0,0,100,100,1,0,1,8,2,2,/);
assert.match(ass, /KANCING JAKETMU/);

console.log('captions: ok');
