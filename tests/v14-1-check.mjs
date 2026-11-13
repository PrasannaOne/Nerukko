import fs from 'node:fs';
import assert from 'node:assert/strict';
import { Matchmaker } from '../src/worker.js';

const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const workflow = fs.readFileSync(new URL('../.github/workflows/deploy-from-zip.yml', import.meta.url), 'utf8');

function socket(id, ipLocation = null, name = id) {
  return { a: { id: null, name: '', roomId: null, location: null, mode: 'group', ipLocation }, sent: [], deserializeAttachment() { return this.a; }, serializeAttachment(v) { this.a = v; }, send(v) { this.sent.push(v); }, close() {}, rid: id, rname: name };
}
function harness(sockets) {
  const store = new Map();
  const ctx = { getWebSockets: () => sockets, storage: { get: async k => store.get(k), put: async (k, v) => store.set(k, v), delete: async k => store.delete(k), list: async () => new Map() } };
  return new Matchmaker(ctx, {});
}
const join = (m, s, location = null) => m.handleWebSocketMessage(s, JSON.stringify({ type: 'join', id: s.rid, name: s.rname, location }));
const types = s => s.sent.map(p => JSON.parse(p).type);

// ---- Connection-based fallback location (only used when real location is missing).
{
  const chennaiA = socket('a'.repeat(32), { lat: 13.1, lon: 80.3 }, 'A');
  const chennaiB = socket('b'.repeat(32), { lat: 13.1, lon: 80.3 }, 'B');
  const newYork = socket('c'.repeat(32), { lat: 40.7, lon: -74 }, 'C');
  const unknown = socket('d'.repeat(32), null, 'D');
  const all = [chennaiA, chennaiB, newYork, unknown];
  const m = harness(all);
  for (const s of all) await join(m, s, null);
  assert.equal(chennaiA.a.approx, true, 'Fallback location must be marked approximate.');
  assert.deepEqual(chennaiA.a.location, { lat: 13.1, lon: 80.3 });
  assert.equal(unknown.a.location, null, 'No guess available means the old fallback pool still applies.');
  assert.equal(chennaiA.a.roomId, chennaiB.a.roomId, 'People from the same area should be grouped.');
}

// Real location always wins over the connection guess.
{
  const s = socket('e'.repeat(32), { lat: 13.1, lon: 80.3 }, 'E');
  const m = harness([s]);
  await join(m, s, { lat: 12.9716, lon: 77.5946 });
  assert.equal(s.a.approx, false);
  assert.equal(s.a.location.lat, 12.9716);
  // Turning location off falls back to the guess, turning it on switches back.
  await m.handleWebSocketMessage(s, JSON.stringify({ type: 'location-update', location: null }));
  assert.equal(s.a.approx, true);
  assert.deepEqual(s.a.location, { lat: 13.1, lon: 80.3 });
  await m.handleWebSocketMessage(s, JSON.stringify({ type: 'location-update', location: { lat: 12.9, lon: 77.6 } }));
  assert.equal(s.a.approx, false);
}

// Nearby Rooms need real location, never the city-level guess.
{
  const s = socket('f'.repeat(32), { lat: 13.1, lon: 80.3 }, 'F');
  const m = harness([s]);
  await join(m, s, null);
  await m.handleWebSocketMessage(s, JSON.stringify({ type: 'room-create', name: 'Chai', description: '', visibility: 'public', password: '', emptyPolicy: 'immediate' }));
  assert.ok(s.sent.some(p => JSON.parse(p).type === 'room-error'), 'Approximate people cannot create nearby rooms.');
  assert.ok(!s.a.customRoomId);
  assert.equal(m.roomStatus(s.a.roomId).kind, 'waiting');
}
{
  const a = socket('1'.repeat(32), { lat: 13.1, lon: 80.3 }, 'A'), b = socket('2'.repeat(32), { lat: 13.1, lon: 80.3 }, 'B');
  const m = harness([a, b]);
  await join(m, a); await join(m, b);
  assert.equal(m.roomStatus(a.a.roomId).kind, 'wider', 'A city-level guess must never be labelled nearby.');
}

// ---- Photos shrink automatically in private chats.
assert.match(html, /async function prepareImageForSend\(file\)/);
assert.match(html, /file\.type === 'image\/gif'\) return file/, 'GIFs must be left untouched.');
assert.match(html, /canvas\.toBlob\(resolve, 'image\/webp', quality\)/);
assert.match(html, /canvas\.toBlob\(resolve, 'image\/jpeg', quality\)/, 'Browsers that cannot write WebP need a JPEG fallback.');
assert.match(html, /MAX_PICK_BYTES = 30 \* 1024 \* 1024/);
assert.ok(!html.includes('Keep images and GIFs under 2 MB for now.'), 'The old hard 2 MB block must be gone.');
assert.match(html, /packet\.kind === 'sticker' \? MAX_MEDIA_BYTES : MAX_IMAGE_BYTES/);

// ---- Honest privacy copy.
assert.match(html, /rough city-level area of your internet connection/);

// ---- Zip workflow.
assert.match(workflow, /paths:\s*\n\s*- "\*\.zip"/);
assert.match(workflow, /unzip -q "\$ZIP"/);
assert.match(workflow, /npm test/);
assert.match(workflow, /wrangler-action@v4/);
assert.match(workflow, /--exclude='\.\/\.github'/, 'Workflow files must never be overwritten by the sync.');
assert.match(workflow, /! -iname 'README\*'/, 'The repository README must survive a zip deploy.');
assert.match(workflow, /GEMINI_API_KEY/);

// ---- License.
const license = fs.readFileSync(new URL('../LICENSE', import.meta.url), 'utf8');
assert.ok(license.startsWith('Required Notice: Copyright (c) 2026 Prasanna'), 'LICENSE must start with the required notice.');
for (const part of ['# PolyForm Noncommercial License 1.0.0', 'https://polyformproject.org/licenses/noncommercial/1.0.0', '## Noncommercial Purposes', '## Patent Defense', '## No Liability', '**Use** means anything you do with the software requiring one']) assert.ok(license.includes(part), `LICENSE is missing: ${part}`);
assert.equal(JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).license, 'PolyForm-Noncommercial-1.0.0');

console.log('Nerukko V14.1 approximate-location, photo-shrinking and zip-deploy checks passed.');
