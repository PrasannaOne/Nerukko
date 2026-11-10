import assert from 'node:assert/strict';
import { Matchmaker } from '../src/worker.js';

function socket(id, roomId = 'random', name = 'Guest') {
  return {
    a: { id, name, roomId, location: null, mode: 'group', roomScope: 'random', customRoomId: null },
    sent: [],
    deserializeAttachment() { return this.a; },
    serializeAttachment(value) { this.a = value; },
    send(value) { this.sent.push(value); },
    close() {}
  };
}
function createMatcher(sockets = []) {
  const data = new Map();
  const ctx = {
    getWebSockets: () => sockets,
    storage: {
      get: async key => data.get(key),
      put: async (key, value) => data.set(key, value),
      delete: async key => data.delete(key)
    }
  };
  return { matcher: new Matchmaker(ctx, {}), sockets, data };
}
function packets(person, type) {
  return person.sent.map(value => JSON.parse(value)).filter(packet => packet.type === type);
}

// Random matchmaking now fills to ten, then creates a fresh room instead of exceeding capacity.
{
  const full = Array.from({ length: 10 }, (_, index) => socket(String(index + 1).padStart(32, '0'), 'full'));
  const { matcher } = createMatcher(full);
  assert.notEqual(matcher.chooseRoom(null), 'full', 'A random group at 10/10 must not accept an eleventh member');
  const partial = full.slice(0, 9);
  const other = createMatcher(partial).matcher;
  assert.equal(other.chooseRoom(null), 'full', 'A random group at 9/10 should accept one more member');
}

// Named rooms are separate from random matchmaking and have a publicly visible directory.
{
  const owner = socket('a'.repeat(32), 'random-a', 'Owner');
  const visitor = socket('b'.repeat(32), 'random-b', 'Visitor');
  const { matcher, sockets, data } = createMatcher([owner, visitor]);
  await matcher.handleWebSocketMessage(owner, JSON.stringify({ type: 'room-create', name: 'Late Night Talks', description: 'Quiet conversations', visibility: 'public', keepWhenEmpty: false }));
  const roomId = owner.a.customRoomId;
  assert.ok(roomId, 'Creating a public room should automatically enter it');
  assert.equal(owner.a.roomScope, 'custom');
  assert.equal(owner.a.roomId, `named:${roomId}`);
  assert.equal(packets(owner, 'room-entered')[0].room.capacity, 10);
  assert.equal(matcher.chooseRoom(null), 'random-b', 'Named rooms must not be selected by the random matcher');
  await matcher.handleWebSocketMessage(visitor, JSON.stringify({ type: 'rooms-list' }));
  const listed = packets(visitor, 'rooms-list').at(-1).rooms.find(room => room.id === roomId);
  assert.equal(listed.name, 'Late Night Talks');
  assert.equal(listed.visibility, 'public');
  assert.equal(listed.memberCount, 1);
  await matcher.handleWebSocketMessage(visitor, JSON.stringify({ type: 'room-join', roomId }));
  assert.equal(visitor.a.customRoomId, roomId);
  assert.equal(matcher.namedRoomMembers(roomId).length, 2);
  assert.ok(packets(owner, 'peer-joined').some(packet => packet.peer.id === visitor.a.id));
  assert.equal(packets(owner, 'room-members').at(-1).room.memberCount, 2);
  await matcher.handleWebSocketMessage(visitor, JSON.stringify({ type: 'room-leave' }));
  assert.equal(visitor.a.roomScope, 'random');
  assert.equal(visitor.a.customRoomId, null);
  assert.equal(matcher.namedRoomMembers(roomId).length, 1);
  await matcher.remove(owner, { offline: false, rebalance: false });
  assert.equal((await matcher.getNamedRooms())[roomId], undefined, 'Temporary rooms should be deleted when the final member leaves');
  assert.equal(sockets.length, 2);
  assert.ok(data.has('named-rooms'));
}

// Private rooms remain listed publicly, but reject an incorrect password and verify a correct one.
{
  const owner = socket('c'.repeat(32), 'random-owner', 'Owner');
  const visitor = socket('d'.repeat(32), 'random-visitor', 'Visitor');
  const { matcher, data } = createMatcher([owner, visitor]);
  await matcher.handleWebSocketMessage(owner, JSON.stringify({ type: 'room-create', name: 'Password Lounge', visibility: 'private', password: 'correct-horse', keepWhenEmpty: true }));
  const roomId = owner.a.customRoomId;
  const saved = (await matcher.getNamedRooms())[roomId];
  assert.ok(saved.passwordHash && saved.passwordSalt);
  assert.ok(!JSON.stringify(saved).includes('correct-horse'), 'Room passwords must never be stored in plaintext');
  await matcher.handleWebSocketMessage(visitor, JSON.stringify({ type: 'rooms-list' }));
  const listed = packets(visitor, 'rooms-list').at(-1).rooms.find(room => room.id === roomId);
  assert.equal(listed.visibility, 'private', 'Private rooms must remain publicly discoverable');
  await matcher.handleWebSocketMessage(visitor, JSON.stringify({ type: 'room-join', roomId, password: 'incorrect' }));
  assert.equal(visitor.a.customRoomId, null);
  assert.match(packets(visitor, 'room-error').at(-1).message, /password/i);
  await matcher.handleWebSocketMessage(visitor, JSON.stringify({ type: 'room-join', roomId, password: 'correct-horse' }));
  assert.equal(visitor.a.customRoomId, roomId);
  assert.equal(matcher.namedRoomMembers(roomId).length, 2);
  await matcher.remove(visitor, { offline: false, rebalance: false });
  await matcher.remove(owner, { offline: false, rebalance: false });
  assert.ok((await matcher.getNamedRooms())[roomId], 'Kept rooms should survive after all members leave');
  assert.equal(data.get('named-rooms')[roomId].keepWhenEmpty, true);
}

// Named room admission is capped at ten and a full room rejects the next user.
{
  const people = Array.from({ length: 11 }, (_, index) => socket((index + 1).toString(16).padStart(32, '0'), 'random-' + index, 'Person ' + (index + 1)));
  const { matcher, data } = createMatcher(people);
  const roomId = 'room-capacity-test';
  data.set('named-rooms', { [roomId]: { id: roomId, name: 'Capacity Test', description: '', visibility: 'public', keepWhenEmpty: true, ownerId: people[0].a.id, createdAt: Date.now() } });
  for (let index = 0; index < 10; index++) {
    await matcher.handleWebSocketMessage(people[index], JSON.stringify({ type: 'room-join', roomId }));
  }
  assert.equal(matcher.namedRoomMembers(roomId).length, 10);
  await matcher.handleWebSocketMessage(people[10], JSON.stringify({ type: 'room-join', roomId }));
  assert.equal(people[10].a.customRoomId, null);
  assert.match(packets(people[10], 'room-error').at(-1).message, /full/i);
}

// Named room settings are owner-only and allow a public room to be password-protected.
{
  const owner = socket('e'.repeat(32), 'random-owner', 'Owner');
  const visitor = socket('f'.repeat(32), 'random-visitor', 'Visitor');
  const { matcher } = createMatcher([owner, visitor]);
  await matcher.handleWebSocketMessage(owner, JSON.stringify({ type: 'room-create', name: 'Open Room', visibility: 'public' }));
  const roomId = owner.a.customRoomId;
  await matcher.handleWebSocketMessage(visitor, JSON.stringify({ type: 'room-join', roomId }));
  await matcher.handleWebSocketMessage(visitor, JSON.stringify({ type: 'room-update', name: 'Hijack', visibility: 'public', keepWhenEmpty: true }));
  assert.match(packets(visitor, 'room-error').at(-1).message, /owner/i);
  await matcher.handleWebSocketMessage(owner, JSON.stringify({ type: 'room-update', name: 'Members Only', visibility: 'private', password: 'secret123', keepWhenEmpty: true }));
  const saved = (await matcher.getNamedRooms())[roomId];
  assert.equal(saved.name, 'Members Only');
  assert.equal(saved.visibility, 'private');
  assert.ok(saved.passwordHash);
}


// Leaving a kept room transfers ownership to a remaining member; a later owner can still manage it.
{
  const owner = socket('1'.repeat(32), 'random-owner', 'Original owner');
  const nextOwner = socket('2'.repeat(32), 'random-next', 'Next owner');
  const { matcher } = createMatcher([owner, nextOwner]);
  await matcher.handleWebSocketMessage(owner, JSON.stringify({ type: 'room-create', name: 'Ownership Lounge', visibility: 'public', keepWhenEmpty: true }));
  const roomId = owner.a.customRoomId;
  await matcher.handleWebSocketMessage(nextOwner, JSON.stringify({ type: 'room-join', roomId }));
  await matcher.handleWebSocketMessage(owner, JSON.stringify({ type: 'room-leave' }));
  const stored = (await matcher.getNamedRooms())[roomId];
  assert.equal(stored.ownerId, nextOwner.a.id, 'A kept room should transfer ownership if its owner leaves');
  await matcher.handleWebSocketMessage(nextOwner, JSON.stringify({ type: 'room-update', name: 'New Owner Lounge', visibility: 'public', keepWhenEmpty: true }));
  assert.equal((await matcher.getNamedRooms())[roomId].name, 'New Owner Lounge');
}

// Owner deletion returns everyone to normal random groups and removes the room directory entry.
{
  const owner = socket('3'.repeat(32), 'random-owner', 'Owner');
  const guest = socket('4'.repeat(32), 'random-guest', 'Guest');
  const { matcher } = createMatcher([owner, guest]);
  await matcher.handleWebSocketMessage(owner, JSON.stringify({ type: 'room-create', name: 'Delete Test', visibility: 'public', keepWhenEmpty: true }));
  const roomId = owner.a.customRoomId;
  await matcher.handleWebSocketMessage(guest, JSON.stringify({ type: 'room-join', roomId }));
  await matcher.handleWebSocketMessage(owner, JSON.stringify({ type: 'room-delete' }));
  assert.equal(owner.a.roomScope, 'random');
  assert.equal(guest.a.roomScope, 'random');
  assert.equal(owner.a.customRoomId, null);
  assert.equal(guest.a.customRoomId, null);
  assert.equal((await matcher.getNamedRooms())[roomId], undefined);
}

// A user already in a one-to-one private chat cannot join a group room through the room feature.
{
  const person = socket('5'.repeat(32), 'private-room', 'One-to-one');
  person.a.mode = 'private';
  const { matcher } = createMatcher([person]);
  await matcher.handleWebSocketMessage(person, JSON.stringify({ type: 'room-create', name: 'Blocked room', visibility: 'public' }));
  assert.equal(person.a.customRoomId, null);
  assert.match(packets(person, 'room-error').at(-1).message, /one-to-one/i);
}

console.log('Nerukko room and 10-member capacity checks passed.');
