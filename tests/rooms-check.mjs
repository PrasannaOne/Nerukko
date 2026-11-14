import assert from 'node:assert/strict';
import { Matchmaker } from '../src/worker.js';

function socket(id, roomId = 'random', name = 'Guest', location = { lat: 12, lon: 77 }) {
  return {
    a: { id, name, roomId, location, mode: 'group', roomScope: 'random', customRoomId: null },
    sent: [],
    deserializeAttachment() { return this.a; },
    serializeAttachment(value) { this.a = value; },
    send(value) { this.sent.push(value); },
    close() {}
  };
}
function createMatcher(sockets = []) {
  const data = new Map();
  const alarms = { at: null };
  const ctx = {
    getWebSockets: () => sockets,
    storage: {
      get: async key => data.get(key),
      put: async (key, value) => data.set(key, value),
      delete: async key => data.delete(key),
      setAlarm: async at => { alarms.at = at; },
      deleteAlarm: async () => { alarms.at = null; }
    }
  };
  return { matcher: new Matchmaker(ctx, {}), sockets, data, alarms };
}
function packets(person, type) {
  return person.sent.map(value => JSON.parse(value)).filter(packet => packet.type === type);
}

// Random matchmaking now fills to seven, then creates a fresh room instead of exceeding capacity.
{
  const full = Array.from({ length: 7 }, (_, index) => socket(String(index + 1).padStart(32, '0'), 'full'));
  const { matcher } = createMatcher(full);
  assert.notEqual(matcher.chooseRoom(null), 'full', 'A random group at 7/7 must not accept an eighth member');
  const partial = full.slice(0, 6);
  const other = createMatcher(partial).matcher;
  assert.equal(other.chooseRoom(null), 'full', 'A random group at 6/7 should accept one more member');
}

// Named rooms are separate from random matchmaking and have a publicly visible directory.
{
  const owner = socket('a'.repeat(32), 'random-a', 'Owner');
  const visitor = socket('b'.repeat(32), 'random-b', 'Visitor');
  const { matcher, sockets, data } = createMatcher([owner, visitor]);
  await matcher.handleWebSocketMessage(owner, JSON.stringify({ type: 'room-create', name: 'Late Night Talks', description: 'Quiet conversations', visibility: 'public', emptyPolicy: 'immediate' }));
  const roomId = owner.a.customRoomId;
  assert.ok(roomId, 'Creating a public room should automatically enter it');
  assert.equal(owner.a.roomScope, 'custom');
  assert.equal(owner.a.roomId, `named:${roomId}`);
  assert.equal(packets(owner, 'room-entered')[0].room.capacity, 7);
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


// Room discovery and joining are restricted to the fixed 100 m creation area.
{
  const owner = socket('9'.repeat(32), 'random-owner', 'Owner', { lat: 12, lon: 77 });
  const nearby = socket('a'.repeat(32), 'random-nearby', 'Nearby', { lat: 12.0002, lon: 77 });
  const far = socket('b'.repeat(32), 'random-far', 'Far away', { lat: 12.002, lon: 77 });
  const { matcher } = createMatcher([owner, nearby, far]);
  await matcher.handleWebSocketMessage(owner, JSON.stringify({ type:'room-create', name:'Fixed Location', visibility:'public', emptyPolicy:'immediate' }));
  const roomId = owner.a.customRoomId;
  const creationLocation = (await matcher.getNamedRooms())[roomId].location;
  await matcher.handleWebSocketMessage(owner, JSON.stringify({ type:'location-update', location:{ lat:12.01, lon:77 } }));
  assert.deepEqual((await matcher.getNamedRooms())[roomId].location, creationLocation, 'A room location must remain fixed when its owner moves');
  await matcher.handleWebSocketMessage(nearby, JSON.stringify({ type:'rooms-list' }));
  const nearbyListing = packets(nearby, 'rooms-list').at(-1).rooms.find(room => room.id === roomId);
  assert.ok(nearbyListing, 'Nearby members should discover the room');
  assert.equal('distanceMeters' in nearbyListing, false, 'Exact room distance should not be exposed to viewers');
  await matcher.handleWebSocketMessage(far, JSON.stringify({ type:'rooms-list' }));
  assert.ok(!packets(far, 'rooms-list').at(-1).rooms.some(room => room.id === roomId), 'Distant members should not discover the room');
  await matcher.handleWebSocketMessage(far, JSON.stringify({ type:'room-join', roomId }));
  assert.match(packets(far, 'room-error').at(-1).message, /outside your nearby area/i);
  far.serializeAttachment({ ...far.a, location:null });
  await matcher.handleWebSocketMessage(far, JSON.stringify({ type:'rooms-list' }));
  assert.equal(packets(far, 'rooms-list').at(-1).requiresLocation, true, 'No-location users should not see Rooms');
  await matcher.handleWebSocketMessage(far, JSON.stringify({ type:'room-create', name:'No Location Room' }));
  assert.match(packets(far, 'room-error').at(-1).message, /enable location/i);
}


// Losing location permission removes a participant from a named room and returns them to fallback matching.
{
  const owner = socket('c'.repeat(32), 'random-owner', 'Owner');
  const guest = socket('d'.repeat(32), 'random-guest', 'Guest');
  const { matcher } = createMatcher([owner, guest]);
  await matcher.handleWebSocketMessage(owner, JSON.stringify({ type:'room-create', name:'Location Required', visibility:'public' }));
  const roomId = owner.a.customRoomId;
  await matcher.handleWebSocketMessage(guest, JSON.stringify({ type:'room-join', roomId }));
  await matcher.handleWebSocketMessage(guest, JSON.stringify({ type:'location-update', location:null }));
  assert.equal(guest.a.roomScope, 'random');
  assert.equal(guest.a.customRoomId, null);
}

// Room names can repeat in different locations but remain unique in the same nearby area.
{
  const localOwner = socket('e'.repeat(32), 'local-owner', 'Local owner', { lat:12, lon:77 });
  const distantOwner = socket('f'.repeat(32), 'distant-owner', 'Distant owner', { lat:12.01, lon:77 });
  const { matcher } = createMatcher([localOwner, distantOwner]);
  await matcher.handleWebSocketMessage(localOwner, JSON.stringify({ type:'room-create', name:'Chill Corner', visibility:'public' }));
  await matcher.handleWebSocketMessage(distantOwner, JSON.stringify({ type:'room-create', name:'Chill Corner', visibility:'public' }));
  assert.ok(distantOwner.a.customRoomId, 'A room name may be reused at a different location');
  assert.notEqual(localOwner.a.customRoomId, distantOwner.a.customRoomId);
}

// Private rooms remain listed publicly, but reject an incorrect password and verify a correct one.
{
  const owner = socket('c'.repeat(32), 'random-owner', 'Owner');
  const visitor = socket('d'.repeat(32), 'random-visitor', 'Visitor');
  const { matcher, data, alarms } = createMatcher([owner, visitor]);
  await matcher.handleWebSocketMessage(owner, JSON.stringify({ type: 'room-create', name: 'Password Lounge', visibility: 'private', password: 'correct-horse', emptyPolicy: '24h' }));
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
  assert.ok((await matcher.getNamedRooms())[roomId], 'Rooms selected for 24-hour retention should survive after all members leave');
  assert.equal(data.get('named-rooms')[roomId].emptyPolicy, '24h');
  assert.ok(data.get('named-rooms')[roomId].expiresAt > Date.now());
  assert.ok(alarms.at > Date.now());
  const expiredRooms = await matcher.getNamedRooms();
  expiredRooms[roomId].expiresAt = Date.now() - 1000;
  await matcher.saveNamedRooms(expiredRooms);
  await matcher.cleanupExpiredNamedRooms();
  assert.equal((await matcher.getNamedRooms())[roomId], undefined, '24-hour rooms must be removed after their expiry alarm');
  assert.equal(alarms.at, null, 'The Durable Object alarm should be cleared when no expiry remains');
}

// Named room admission is capped at seven and a full room rejects the next user.
{
  const people = Array.from({ length: 8 }, (_, index) => socket((index + 1).toString(16).padStart(32, '0'), 'random-' + index, 'Person ' + (index + 1)));
  const { matcher, data } = createMatcher(people);
  const roomId = 'room-capacity-test';
  data.set('named-rooms', { [roomId]: { id: roomId, name: 'Capacity Test', description: '', visibility: 'public', emptyPolicy: '24h', location: { lat: 12, lon: 77 }, ownerId: people[0].a.id, createdAt: Date.now() } });
  for (let index = 0; index < 7; index++) {
    await matcher.handleWebSocketMessage(people[index], JSON.stringify({ type: 'room-join', roomId }));
  }
  assert.equal(matcher.namedRoomMembers(roomId).length, 7);
  await matcher.handleWebSocketMessage(people[7], JSON.stringify({ type: 'room-join', roomId }));
  assert.equal(people[7].a.customRoomId, null);
  assert.match(packets(people[7], 'room-error').at(-1).message, /full/i);
}

// Named room settings are owner-only and allow a public room to be password-protected.
{
  const owner = socket('e'.repeat(32), 'random-owner', 'Owner');
  const visitor = socket('f'.repeat(32), 'random-visitor', 'Visitor');
  const { matcher } = createMatcher([owner, visitor]);
  await matcher.handleWebSocketMessage(owner, JSON.stringify({ type: 'room-create', name: 'Open Room', visibility: 'public' }));
  const roomId = owner.a.customRoomId;
  await matcher.handleWebSocketMessage(visitor, JSON.stringify({ type: 'room-join', roomId }));
  await matcher.handleWebSocketMessage(visitor, JSON.stringify({ type: 'room-update', name: 'Hijack', visibility: 'public', emptyPolicy: '24h' }));
  assert.match(packets(visitor, 'room-error').at(-1).message, /owner/i);
  await matcher.handleWebSocketMessage(owner, JSON.stringify({ type: 'room-update', name: 'Members Only', visibility: 'private', password: 'secret123', emptyPolicy: '24h' }));
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
  await matcher.handleWebSocketMessage(owner, JSON.stringify({ type: 'room-create', name: 'Ownership Lounge', visibility: 'public', emptyPolicy: '24h' }));
  const roomId = owner.a.customRoomId;
  await matcher.handleWebSocketMessage(nextOwner, JSON.stringify({ type: 'room-join', roomId }));
  await matcher.handleWebSocketMessage(owner, JSON.stringify({ type: 'room-leave' }));
  const stored = (await matcher.getNamedRooms())[roomId];
  assert.equal(stored.ownerId, nextOwner.a.id, 'A kept room should transfer ownership if its owner leaves');
  await matcher.handleWebSocketMessage(nextOwner, JSON.stringify({ type: 'room-update', name: 'New Owner Lounge', visibility: 'public', emptyPolicy: '24h' }));
  assert.equal((await matcher.getNamedRooms())[roomId].name, 'New Owner Lounge');
}

// Owner deletion returns everyone to normal random groups and removes the room directory entry.
{
  const owner = socket('3'.repeat(32), 'random-owner', 'Owner');
  const guest = socket('4'.repeat(32), 'random-guest', 'Guest');
  const { matcher } = createMatcher([owner, guest]);
  await matcher.handleWebSocketMessage(owner, JSON.stringify({ type: 'room-create', name: 'Delete Test', visibility: 'public', emptyPolicy: '24h' }));
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

console.log('Neruko room lifecycle, location, and 7-member capacity checks passed.');
