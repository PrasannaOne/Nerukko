import fs from 'node:fs';
import assert from 'node:assert/strict';
import { Matchmaker } from '../src/worker.js';

const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const worker = fs.readFileSync(new URL('../src/worker.js', import.meta.url), 'utf8');

function socket(id, roomId, location = null, mode = 'group', name = id) {
  return { a: { id, name, roomId, location, mode, roomScope: 'random' }, sent: [], deserializeAttachment() { return this.a; }, serializeAttachment(v) { this.a = v; }, send(v) { this.sent.push(v); }, close() {} };
}
function matcherWith(sockets) {
  const store = new Map();
  const ctx = { getWebSockets: () => sockets, storage: { get: async k => store.get(k), put: async (k, v) => store.set(k, v), delete: async k => store.delete(k) } };
  return { matcher: new Matchmaker(ctx, {}), store };
}

// ---- Layout: chat never scrolls sideways, stickers sit in their own compact bubble.
assert.match(html, /\.messages \{ overflow-x: hidden; overflow-y: auto;/);
assert.match(html, /\.message\.sticker-message \{[^}]*background: transparent/);
assert.match(html, /\.message-media\.sticker-media \{[^}]*width: clamp\(92px, 32vw, 132px\)/);
assert.match(html, /@media \(min-width: 700px\)/);
assert.match(html, /@media \(max-height: 520px\) and \(orientation: landscape\)/);
assert.ok(!html.includes('translateX(${-direction * travel}px)'), 'Swipe indicator must not drift outside the chat.');

// ---- Private chats: leaving always works, offline friends can be messaged.
assert.match(html, /function leavePrivateChat\(\)/);
assert.match(html, /function enterOfflineDm\(/);
assert.match(html, /function exitOfflineDm\(/);
assert.match(html, /\$\('returnToGroup'\)\.addEventListener\('click', leavePrivateChat\)/);
assert.match(html, /dm:true, createdAt:Date\.now\(\)/, 'Offline direct messages must be queued with the dm flag.');
assert.match(html, /!item\.dm && !existing\.has\(item\.id\)/, 'Direct messages must never appear in the group view.');
assert.match(html, /dm:!!item\.dm/, 'Queued direct messages must be flagged when delivered.');
assert.match(html, /function readStoredArray/, 'Damaged saved data must not drop incoming messages.');
assert.match(html, /image\\\/\(png\|jpeg\|webp\)/, 'Profile pictures must only accept PNG, JPEG or WebP.');
assert.match(html, /function allowPeerPacket/);

// ---- Friends can exchange waiting messages after a private chat.
{
  const a = socket('a'.repeat(32), 'room', { lat: 12, lon: 77 }, 'group', 'A');
  const b = socket('b'.repeat(32), 'room', { lat: 12.0001, lon: 77 }, 'group', 'B');
  const { matcher, store } = matcherWith([a, b]);
  matcher.createPrivateRequest(a, b.a.id);
  const requestId = [...matcher.pendingPrivate.keys()][0];
  await matcher.respondPrivateRequest(b, requestId, true);
  const key = [a.a.id, b.a.id].sort().join(':');
  assert.ok(Number(store.get(`delivery:${key}`)) > Date.now(), 'Accepting a private chat must allow delivery for later.');
}

// ---- Merging keeps the bigger room's chat intact.
{
  const big = Array.from({ length: 4 }, (_, i) => socket(String(i).repeat(32), 'big', { lat: 12, lon: 77 + i * 0.00001 }));
  const small = [socket('9'.repeat(32), 'small', { lat: 12, lon: 77 })];
  const { matcher } = matcherWith([...big, ...small]);
  await matcher.rebalanceGroupRooms();
  assert.equal(small[0].a.roomId, 'big');
  assert.ok(big.every(p => !p.sent.some(m => JSON.parse(m).type === 'room-reset')), 'Bigger room must not be reset.');
}

// ---- Someone alone among strangers is pulled toward a neighbour with a free seat.
{
  const strangers = [socket('1'.repeat(32), 'far', { lat: 40.7, lon: -74 }), socket('2'.repeat(32), 'far', { lat: 34, lon: -118 }), socket('3'.repeat(32), 'far', { lat: 13, lon: 80 })];
  const locals = [socket('4'.repeat(32), 'near', { lat: 13.0001, lon: 80.0001 }), socket('5'.repeat(32), 'near', { lat: 13.00012, lon: 80.0001 })];
  const lost = socket('6'.repeat(32), 'far', { lat: 13.00011, lon: 80.00011 });
  // 'far' has 4 people, 'near' has 2: they would merge (6 <= 7) so use a full far room to test the pull alone.
  const fill = Array.from({ length: 3 }, (_, i) => socket(String(7 + i).repeat(32), 'far', { lat: 51 + i, lon: 0 }));
  const { matcher } = matcherWith([...strangers.slice(0, 2), ...fill, lost, ...locals]);
  await matcher.rebalanceGroupRooms();
  assert.equal(lost.a.roomId, locals[0].a.roomId, 'Isolated person should end up with the neighbours.');
}

// ---- Matching keeps its hard limit of 7.
{
  const { matcher } = matcherWith([]);
  const sockets = [];
  const m2 = matcherWith(sockets).matcher;
  for (let i = 0; i < 20; i++) {
    const s = socket(String(i).padStart(2, '0').repeat(16), null, { lat: 12 + i * 0.5, lon: 77 });
    s.a.roomId = m2.chooseRoom(s.a.location); sockets.push(s);
    await m2.rebalanceGroupRooms();
  }
  const sizes = new Map();
  for (const s of sockets) sizes.set(s.a.roomId, (sizes.get(s.a.roomId) || 0) + 1);
  assert.ok([...sizes.values()].every(n => n <= 7), 'No room may exceed 7 people.');
}
assert.ok(worker.includes('allowDelivery'));
console.log('Nerukko V14 layout, private-chat, offline-message and matching checks passed.');
