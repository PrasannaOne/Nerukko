import fs from 'node:fs';
import assert from 'node:assert/strict';
import { Matchmaker } from '../src/worker.js';

const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

// ---- Long-press menu: reactions, copy, select, edit, delete.
for (const part of ["const REACTIONS = ['❤️', '👍', '👎', '😂', '😮', '😢']", 'const EDIT_WINDOW_MS = 15 * 60 * 1000', 'function openMessageMenu(', 'function enableMessageMenu(', 'function enterSelection(', 'function startEdit(', 'function submitEdit(', 'function deleteForEveryone(', 'function applyRemoteAction(', "label:'Delete for everyone', icon:'trash', danger:true, confirm:true"]) assert.ok(html.includes(part), `Missing: ${part}`);
assert.ok(!html.includes("label:'Reply'"), 'Reply is not part of the menu (swipe already does it).');
assert.ok(!html.includes("label:'Pin'") && !html.includes("label:'Forward'"));
// Only the original sender may edit or delete, and edits only count inside the time window.
assert.match(html, /article\.dataset\.senderId !== senderId \|\| article\.dataset\.kind !== 'text'/);
assert.match(html, /if \(article\) \{ if \(article\.dataset\.senderId !== senderId\) return; markDeleted\(article\); \}/);
assert.match(html, /EDIT_WINDOW_MS \+ 60_000/);
assert.match(html, /REACTIONS\.includes\(action\.emoji\)/, 'Only the six allowed reactions are accepted.');
assert.match(html, /if \(packet\.type === 'react' \|\| packet\.type === 'edit' \|\| packet\.type === 'delete'\) \{ applyRemoteAction\(peer\.id, packet, false\); return; \}/);
assert.match(html, /p\?\.type==='private-action'\)\{handleDmAction\(friend\.id,p\)/);
assert.match(html, /case 'private-action': if \(data\.from\) handleDmAction/);
assert.match(html, /if \(state\.editTarget\) \{ submitEdit\(text\); return; \}/);
assert.match(html, /\.messages \{ overflow-x: hidden/, 'The chat must still never scroll sideways.');

// ---- Server relay between friends (used when no direct channel is open yet).
function socket(id) {
  return { a: { id, name: id.slice(0, 4), roomId: 'r', location: null, mode: 'group', roomScope: 'random' }, sent: [], deserializeAttachment() { return this.a; }, serializeAttachment(v) { this.a = v; }, send(v) { this.sent.push(JSON.parse(v)); }, close() {} };
}
function harness(sockets) {
  const store = new Map();
  const ctx = { getWebSockets: () => sockets, storage: { get: async k => store.get(k), put: async (k, v) => store.set(k, v), delete: async k => store.delete(k), list: async () => new Map() } };
  return { matcher: new Matchmaker(ctx, {}), store };
}
const A = 'a'.repeat(32), B = 'b'.repeat(32), C = 'c'.repeat(32);
{
  const a = socket(A), b = socket(B), c = socket(C);
  const { matcher } = harness([a, b, c]);
  const key = [A, B].sort().join(':');
  matcher.deliveryEligible.set(key, Date.now() + 60_000);
  const send = (from, packet) => matcher.handleWebSocketMessage(from, JSON.stringify({ type: 'private-action', ...packet }));
  await send(a, { to: B, action: 'react', messageId: 'm1', emoji: '❤️' });
  assert.deepEqual(b.sent.at(-1), { type: 'private-action', from: A, action: 'react', messageId: 'm1', emoji: '❤️' });
  await send(a, { to: B, action: 'edit', messageId: 'm1', text: '  fixed text  ' });
  assert.equal(b.sent.at(-1).text, 'fixed text');
  await send(a, { to: B, action: 'delete', messageId: 'm1' });
  assert.equal(b.sent.at(-1).action, 'delete');
  const count = b.sent.length;
  await send(a, { to: B, action: 'hack', messageId: 'm1' });
  await send(a, { to: B, action: 'edit', messageId: 'm1', text: '   ' });
  await send(a, { to: C, action: 'delete', messageId: 'm1' });           // not friends
  await send(c, { to: B, action: 'delete', messageId: 'm1' });           // not friends
  assert.equal(b.sent.length, count, 'Unknown actions, empty edits and non-friends must be ignored.');
  assert.equal(c.sent.length, 0);
  // The "from" field is always the real sender, never what the client claims.
  await send(a, { to: B, action: 'delete', messageId: 'm2', from: C });
  assert.equal(b.sent.at(-1).from, A);
}
console.log('Neruko message menu, reactions, edit and delete checks passed.');
