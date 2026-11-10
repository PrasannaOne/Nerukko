import { Matchmaker } from '../src/worker.js';
import { clampBotReply } from '../src/nerukko-bot.js';

function socket(id, roomId, location = null, mode = 'group', name = id) {
  return {
    a: { id, name, roomId, location, mode }, sent: [], closed: false,
    deserializeAttachment() { return this.a; },
    serializeAttachment(value) { this.a = value; },
    send(value) { this.sent.push(value); },
    close() { this.closed = true; }
  };
}
function matcherWith(sockets = []) {
  const store = new Map();
  const ctx = {
    getWebSockets: () => sockets,
    storage: { get: async key => store.get(key), put: async (key, value) => store.set(key, value), delete: async key => store.delete(key) }
  };
  return { matcher: new Matchmaker(ctx, {}), sockets, store };
}

// A no-location joiner should prefer a mixed room that already contains a
// person who also chose not to share location.
{
  const mixed = [socket('a'.repeat(32), 'mixed', { lat: 12, lon: 77 }), socket('b'.repeat(32), 'mixed', null)];
  const located = [socket('c'.repeat(32), 'located', { lat: 12, lon: 77 }), socket('d'.repeat(32), 'located', { lat: 12.0001, lon: 77 })];
  const { matcher } = matcherWith([...mixed, ...located]);
  if (matcher.chooseRoom(null) !== 'mixed') throw new Error('No-location joiner should prefer a mixed room with another no-location participant');
}

// When a larger no-location pool exists, it wins over a smaller mixed pool.
{
  const mixed = [socket('e'.repeat(32), 'mixed', { lat: 12, lon: 77 }), socket('f'.repeat(32), 'mixed', null)];
  const open = [socket('g'.repeat(32), 'open', null), socket('h'.repeat(32), 'open', null)];
  const { matcher } = matcherWith([...mixed, ...open]);
  if (matcher.chooseRoom(null) !== 'open') throw new Error('Largest shared no-location pool should be preferred');
}

// Located joiners choose a nearby fully-located room before a distant one.
{
  const near = [socket('i'.repeat(32), 'near', { lat: 12, lon: 77 }), socket('j'.repeat(32), 'near', { lat: 12.0001, lon: 77 })];
  const far = [socket('k'.repeat(32), 'far', { lat: 12.02, lon: 77 }), socket('l'.repeat(32), 'far', { lat: 12.021, lon: 77 })];
  const { matcher } = matcherWith([...near, ...far]);
  if (matcher.chooseRoom({ lat: 12.0002, lon: 77 }) !== 'near') throw new Error('Located joiner should choose the nearby room');
  if (matcher.roomStatus('near').label !== 'Nearby') throw new Error('Nearby room label should be correct');
  if (matcher.roomStatus('far').label !== 'Wider circle') throw new Error('Distant room label should be correct');
}

// A no-location-only room is visibly an open circle; a solo room waits.
{
  const open = [socket('m'.repeat(32), 'open', null), socket('n'.repeat(32), 'open', null)];
  const solo = [socket('o'.repeat(32), 'solo', { lat: 12, lon: 77 })];
  const { matcher } = matcherWith([...open, ...solo]);
  if (matcher.roomStatus('open').label !== 'Open circle') throw new Error('No-location group should be Open circle');
  if (matcher.roomStatus('solo').label !== 'Waiting') throw new Error('Solo room should be Waiting');
}

// Compatible partial groups (2 + 3 nearby) merge and trigger a room reset.
{
  const a = [socket('p'.repeat(32), 'room-a', { lat: 12, lon: 77 }), socket('q'.repeat(32), 'room-a', { lat: 12.0001, lon: 77 })];
  const b = [socket('r'.repeat(32), 'room-b', { lat: 12.0002, lon: 77 }), socket('s'.repeat(32), 'room-b', { lat: 12.0003, lon: 77 }), socket('t'.repeat(32), 'room-b', { lat: 12.0004, lon: 77 })];
  const { matcher } = matcherWith([...a, ...b]);
  await matcher.rebalanceGroupRooms();
  const roomIds = new Set([...a, ...b].map(person => person.a.roomId));
  if (roomIds.size !== 1) throw new Error('Compatible 2 + 3 groups should merge into one room');
  if (![...a, ...b].every(person => person.sent.some(packet => JSON.parse(packet).type === 'room-reset'))) throw new Error('All merged participants should receive a room reset');
}

// Distant location-based rooms should not be merged just to pack seats.
{
  const a = [socket('u'.repeat(32), 'distant-a', { lat: 12, lon: 77 }), socket('v'.repeat(32), 'distant-a', { lat: 12.0001, lon: 77 })];
  const b = [socket('w'.repeat(32), 'distant-b', { lat: 12.02, lon: 77 }), socket('x'.repeat(32), 'distant-b', { lat: 12.021, lon: 77 })];
  const { matcher } = matcherWith([...a, ...b]);
  await matcher.rebalanceGroupRooms();
  if (new Set([...a, ...b].map(person => person.a.roomId)).size !== 2) throw new Error('Distant groups should remain separate');
}

// Private requests only move the two participants after the recipient accepts.
{
  const a = socket('1'.repeat(32), 'group', { lat: 12, lon: 77 }, 'group', 'A');
  const b = socket('2'.repeat(32), 'group', { lat: 12.0001, lon: 77 }, 'group', 'B');
  const { matcher } = matcherWith([a, b]);
  matcher.createPrivateRequest(a, b.a.id);
  const requestId = [...matcher.pendingPrivate.keys()][0];
  if (!requestId) throw new Error('Private request should be created');
  await matcher.respondPrivateRequest(b, requestId, true);
  if (a.a.mode !== 'private' || b.a.mode !== 'private' || a.a.roomId !== b.a.roomId) throw new Error('Accepted participants should move to the same private room');
  await matcher.endPrivateRoom(a.a.roomId);
  if (a.a.mode !== 'group' || b.a.mode !== 'group' || a.a.roomId !== b.a.roomId) throw new Error('Ending private chat should return both people to a group room');
}

// Only one outgoing private invitation can wait at a time; accepting a conversation closes other pending invites.
{
  const a = socket('a'.repeat(32), 'invite-room', { lat:12, lon:77 }, 'group', 'A');
  const b = socket('b'.repeat(32), 'invite-room', { lat:12, lon:77 }, 'group', 'B');
  const c = socket('c'.repeat(32), 'invite-room', { lat:12, lon:77 }, 'group', 'C');
  const d = socket('d'.repeat(32), 'invite-room', { lat:12, lon:77 }, 'group', 'D');
  const { matcher } = matcherWith([a,b,c,d]);
  matcher.createPrivateRequest(a, b.a.id);
  const firstRequest = [...matcher.pendingPrivate.keys()][0];
  matcher.createPrivateRequest(a, d.a.id);
  if (matcher.pendingPrivate.size !== 1) throw new Error('A participant should not send multiple outstanding private invitations');
  if (!a.sent.some(value => JSON.parse(value).type === 'private-error')) throw new Error('A second outstanding private invitation should be rejected visibly');
  matcher.createPrivateRequest(c, a.a.id);
  await matcher.respondPrivateRequest(b, firstRequest, true);
  if (matcher.pendingPrivate.size !== 0) throw new Error('Other pending invitations should close when a participant enters a private conversation');
  if (!c.sent.some(value => JSON.parse(value).type === 'private-request-closed')) throw new Error('The other requester should be notified that their invitation closed');
}

// Two distinct reports trigger a five-minute, server-side ID cooldown.
{
  const reporter1 = socket('3'.repeat(32), 'report-room', null, 'group', 'One');
  const reporter2 = socket('4'.repeat(32), 'report-room', null, 'group', 'Two');
  const target = socket('5'.repeat(32), 'report-room', null, 'group', 'Target');
  const { matcher, store } = matcherWith([reporter1, reporter2, target]);
  const targetId = target.a.id;
  await matcher.reportMember(reporter1, targetId);
  await matcher.reportMember(reporter1, targetId);
  if (store.has(`cooldown:${targetId}`)) throw new Error('Duplicate reports from one ID must not trigger a cooldown');
  await matcher.reportMember(reporter2, targetId);
  if (!(Number(store.get(`cooldown:${targetId}`)) > Date.now())) throw new Error('Two distinct reports should trigger a cooldown');
  if (target.a.id) throw new Error('Reported participant should be removed from the room');
}


// Escalating independent-report cooldowns persist by anonymous participant ID.
{
  const targetId = '9'.repeat(32);
  const store = new Map();
  let incident = 0;
  async function triggerIncident() {
    incident++;
    const roomId = `escalation-${incident}`;
    const reporter1 = socket(`${incident}a`.padEnd(32, 'a'), roomId, null, 'group', 'One');
    const reporter2 = socket(`${incident}b`.padEnd(32, 'b'), roomId, null, 'group', 'Two');
    const target = socket(targetId, roomId, null, 'group', 'Target');
    const sockets = [reporter1, reporter2, target];
    const ctx = {
      getWebSockets: () => sockets,
      storage: { get: async key => store.get(key), put: async (key, value) => store.set(key, value), delete: async key => store.delete(key) }
    };
    const matcher = new Matchmaker(ctx, {});
    await matcher.reportMember(reporter1, targetId);
    await matcher.reportMember(reporter2, targetId);
    const blocked = target.sent.map(value => JSON.parse(value)).find(packet => packet.type === 'blocked');
    return blocked?.durationMinutes;
  }
  if (await triggerIncident() !== 5) throw new Error('First qualifying report incident should pause for five minutes');
  if (await triggerIncident() !== 10) throw new Error('Second qualifying report incident should pause for ten minutes');
  if (await triggerIncident() !== 15) throw new Error('Third qualifying report incident should pause for fifteen minutes');
  if (await triggerIncident() !== 15) throw new Error('Later report incidents should remain at fifteen minutes');
  if (store.get(`report-strikes:${targetId}`) !== 3) throw new Error('Report strike count should cap at three');
}

// Reports from different rooms must never combine into one threshold.
{
  const reporterA = socket('6'.repeat(32), 'room-a', null, 'group', 'A');
  const reporterB = socket('7'.repeat(32), 'room-b', null, 'group', 'B');
  const target = socket('8'.repeat(32), 'room-a', null, 'group', 'Target');
  const { matcher, store } = matcherWith([reporterA, reporterB, target]);
  const targetId = target.a.id;
  await matcher.reportMember(reporterA, targetId);
  target.serializeAttachment({ ...target.a, roomId: 'room-b' });
  await matcher.reportMember(reporterB, targetId);
  if (store.has(`cooldown:${targetId}`)) throw new Error('Reports from separate rooms must not combine');
  if (!target.a.id) throw new Error('A cross-room report pair must not remove the target');
}

// The Durable Object serialises room-affecting socket work so two simultaneous
// joins cannot both claim the same final seat.
{
  const { matcher } = matcherWith([]);
  let active = 0;
  let peak = 0;
  const task = () => matcher.runSerial(async () => {
    active += 1; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active -= 1;
  });
  await Promise.all([task(), task(), task(), task()]);
  if (peak !== 1) throw new Error('Room operations should be serialised');
}

// When no shared no-location preference exists, a no-location user can still
// enter any room with available capacity.
{
  const onlyRoom = [socket('z'.repeat(32), 'only', { lat: 12, lon: 77 })];
  const { matcher } = matcherWith(onlyRoom);
  if (matcher.chooseRoom(null) !== 'only') throw new Error('No-location user should fall back to an available room');
}



// Offline participants are marked for local-only queued delivery; message text is never stored.
{
  const sender = socket('a1'.repeat(16), 'old-room', null, 'group', 'Sender');
  const leaving = socket('b2'.repeat(16), 'old-room', null, 'group', 'Friend');
  const sockets = [sender, leaving];
  const store = new Map();
  const ctx = {
    getWebSockets: () => sockets,
    storage: { get: async key => store.get(key), put: async (key, value) => store.set(key, value), delete: async key => store.delete(key) }
  };
  const matcher = new Matchmaker(ctx, {});
  const friendId = leaving.a.id;
  await matcher.remove(leaving, { rebalance: false, offline: true });
  const offlineEvent = sender.sent.map(value => JSON.parse(value)).find(packet => packet.type === 'peer-offline');
  if (offlineEvent?.peer?.id !== friendId) throw new Error('Room members should be told when a peer goes offline');
  const eligibilityKey = `delivery:${[sender.a.id, friendId].sort().join(':')}`;
  if (!(Number(store.get(eligibilityKey)) > Date.now())) throw new Error('Offline delivery permission should expire after a limited period');

  const returning = socket(friendId, 'new-room', null, 'group', 'Friend');
  sockets.push(returning);
  await matcher.handleDeliveryInvite(sender, friendId);
  const ready = sender.sent.map(value => JSON.parse(value)).find(packet => packet.type === 'delivery-ready');
  const invited = returning.sent.map(value => JSON.parse(value)).find(packet => packet.type === 'delivery-invite');
  if (ready?.peer?.id !== friendId || invited?.peer?.id !== sender.a.id) throw new Error('Both clients should receive cross-room delivery setup');
  await matcher.handleWebSocketMessage(sender, JSON.stringify({ type: 'signal', to: friendId, payload: { candidate: { candidate: 'test' } } }));
  const signal = returning.sent.map(value => JSON.parse(value)).find(packet => packet.type === 'signal');
  if (signal?.from !== sender.a.id) throw new Error('Delivery-only peers should be allowed to exchange WebRTC signals across rooms');
}

// Bot output stays compact and clamps every response to twenty-two words.
{
  const reply = clampBotReply('One two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty twentyone twentytwo twentythree twentyfour');
  if (reply.split(/\s+/).length !== 22) throw new Error('Nerukko Bot replies must be limited to twenty-two words');
  if (clampBotReply('  hello\nthere  ') !== 'hello there') throw new Error('Nerukko Bot output should be a single clean line');
}

// Without a Gemini secret, the bot must remain absent and normal human rooms continue.
{
  const alone = socket('c3'.repeat(16), 'solo', null, 'group', 'Alone');
  const { matcher } = matcherWith([alone]);
  await matcher.updateBotForRoom('solo');
  if (matcher.botRooms.has('solo') || alone.sent.some(value => JSON.parse(value).type === 'bot-start')) throw new Error('Bot must remain disabled unless its Worker secret exists');
}

console.log('Nerukko matcher checks passed.');
