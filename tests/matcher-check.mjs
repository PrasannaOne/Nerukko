import { Matchmaker } from '../src/worker.js';

function socket(attachment) {
  return {
    a: attachment,
    deserializeAttachment() { return this.a; },
    serializeAttachment(value) { this.a = value; },
    send() {},
  };
}

const roomNearby = [
  socket({ id: 'a'.repeat(32), roomId: 'near', location: { lat: 12.0000, lon: 77.0000 } }),
  socket({ id: 'b'.repeat(32), roomId: 'near', location: { lat: 12.0001, lon: 77.0001 } }),
];
const roomNoLocation = [
  socket({ id: 'c'.repeat(32), roomId: 'open', location: null }),
  socket({ id: 'd'.repeat(32), roomId: 'open', location: null }),
];
const roomMixed = [
  socket({ id: 'e'.repeat(32), roomId: 'mixed', location: { lat: 12.1, lon: 77.1 } }),
  socket({ id: 'f'.repeat(32), roomId: 'mixed', location: null }),
];
const all = [...roomNearby, ...roomMixed, ...roomNoLocation];
const ctx = { getWebSockets: () => all };
const matcher = new Matchmaker(ctx, {});

const noLocationChoice = matcher.chooseRoom(null);
if (noLocationChoice !== 'open') throw new Error(`Expected no-location pool, got ${noLocationChoice}`);
const locatedChoice = matcher.chooseRoom({ lat: 12.0002, lon: 77.0002 });
if (locatedChoice !== 'near') throw new Error(`Expected nearest fully located room, got ${locatedChoice}`);
if (matcher.roomStatus('mixed').label !== 'Open circle') throw new Error('Mixed room should be Open circle');
if (matcher.roomStatus('near').label !== 'Nearby') throw new Error('Close room should be Nearby');
if (matcher.roomStatus('open').label !== 'Open circle') throw new Error('No-location room should be Open circle');
console.log('Matcher checks passed.');

const fallbackSocket = socket({ id: 'g'.repeat(32), roomId: 'only-room', location: { lat: 20, lon: 78 } });
const fallbackMatcher = new Matchmaker({ getWebSockets: () => [fallbackSocket] }, {});
if (fallbackMatcher.chooseRoom(null) !== 'only-room') throw new Error('No-location user should fall back to an available room');
if (fallbackMatcher.roomStatus('only-room').label !== 'Waiting') throw new Error('A solo room should display Waiting');

const distantA = socket({ id: 'h'.repeat(32), roomId: 'distant', location: { lat: 12, lon: 77 } });
const distantB = socket({ id: 'i'.repeat(32), roomId: 'distant', location: { lat: 12.01, lon: 77.01 } });
const distantMatcher = new Matchmaker({ getWebSockets: () => [distantA, distantB] }, {});
if (distantMatcher.roomStatus('distant').label !== 'Wider circle') throw new Error('Distant participants should show Wider circle');
console.log('Fallback and room-label checks passed.');
