import assert from 'node:assert/strict';
import { Matchmaker } from '../src/worker.js';
import { buildGeminiContents, clampBotReply, generateNerukkoBotReply } from '../src/nerukko-bot.js';

assert.equal(
  clampBotReply('One two three four five six seven eight nine ten eleven twelve thirteen'),
  'One two three four five six seven eight nine ten'
);
assert.equal(clampBotReply('  That was funny!\nHonestly.  '), 'That was funny! Honestly.');

const firstUserTurn = buildGeminiContents([
  { role: 'model', text: 'Hey there!' },
  { role: 'user', text: 'Hlo' }
]);
assert.deepEqual(firstUserTurn, [{ role: 'user', parts: [{ text: 'Hlo' }] }]);

const stickerTurn = buildGeminiContents([
  { role: 'user', text: 'This day is weird.' },
  { role: 'model', text: 'Absolutely chaotic.' }
], 'The person sent a sticker. React briefly.');
assert.deepEqual(stickerTurn.map(item => item.role), ['user', 'model', 'user']);
assert.match(stickerTurn.at(-1).parts[0].text, /sticker/i);

const frontend = await (await import('node:fs/promises')).readFile('public/index.html', 'utf8');
assert.match(frontend, /case 'bot-start':\s*state\.botActive = true; state\.botHistory = \[\]; break;/,
  'Activating the Bot must not automatically replay saved stickers');
assert.doesNotMatch(frontend, /case 'bot-start':[\s\S]{0,140}flushPendingStickers\(\)/,
  'The Bot must wait for a new user action after activation');

const originalFetch = globalThis.fetch;
let requestedUrl = '';
let requestedHeaders;
let requestedBody;
let responseText = 'Doing well! How about you?';
globalThis.fetch = async (url, options) => {
  requestedUrl = String(url);
  requestedHeaders = new Headers(options.headers);
  requestedBody = JSON.parse(options.body);
  return new Response(JSON.stringify({
    candidates: [{ content: { parts: [{ text: responseText }] } }]
  }), { status: 200, headers: { 'content-type': 'application/json' } });
};

function socket(id, roomId, mode = 'group', roomScope = 'random') {
  return {
    attachment: { id, name: `Person-${id[0]}`, roomId, mode, roomScope, customRoomId: roomScope === 'custom' ? roomId : null },
    sent: [],
    deserializeAttachment() { return this.attachment; },
    serializeAttachment(value) { this.attachment = value; },
    send(value) { this.sent.push(JSON.parse(value)); }
  };
}
function makeMatcher(sockets) {
  const store = new Map();
  const ctx = {
    getWebSockets: () => sockets,
    storage: {
      get: async key => store.get(key),
      put: async (key, value) => store.set(key, value),
      delete: async key => store.delete(key)
    }
  };
  return { matcher: new Matchmaker(ctx, { GEMINI_API_KEY: 'test-api-key' }), store };
}

try {
  const personaReply = await generateNerukkoBotReply('test-api-key', [
    { role: 'user', text: 'Hlo' }
  ], '');
  assert.equal(personaReply, 'Doing well! How about you?');
  assert.equal(requestedHeaders.get('x-goog-api-key'), 'test-api-key');
  assert.ok(!requestedUrl.includes('test-api-key'), 'API key must not appear in the request URL');
  assert.equal(requestedBody.contents[0].role, 'user');
  assert.equal(requestedBody.contents[0].parts[0].text, 'Hlo');
  assert.equal(requestedBody.generationConfig.maxOutputTokens, 48);
  const persona = requestedBody.systemInstruction.parts[0].text;
  assert.match(persona, /2–8 words/i);
  assert.match(persona, /never more than 10 words/i);
  assert.match(persona, /Do not greet again/i);
  assert.match(persona, /Do not ask a question in every reply/i);

  // One human in random chat: Bot activates silently, then answers an actual message.
  const solo = socket('a'.repeat(32), 'solo-room');
  const sockets = [solo];
  const { matcher } = makeMatcher(sockets);
  await matcher.refreshBotRooms();
  assert.ok(solo.sent.some(packet => packet.type === 'bot-start'), 'A sole random-chat user should activate the Bot');
  assert.ok(!solo.sent.some(packet => packet.type === 'bot-message'), 'The Bot must not greet proactively');

  solo.sent.length = 0;
  await matcher.handleBotRequest(solo, {
    type: 'bot-chat', text: 'Hlo', history: [{ role: 'user', text: 'Hlo' }]
  });
  const reply = solo.sent.find(packet => packet.type === 'bot-message');
  assert.ok(reply, 'A real user message must receive a Bot reply');
  assert.equal(reply.kind, 'reply');
  assert.equal(reply.text, 'Doing well! How about you?');

  // Stickers count as user activity and can receive a brief reaction.
  solo.sent.length = 0;
  await matcher.handleBotRequest(solo, {
    type: 'bot-sticker', stickerId: 'sticker-123', history: [{ role: 'user', text: 'Hlo' }]
  });
  const stickerReply = solo.sent.find(packet => packet.type === 'bot-message');
  assert.ok(stickerReply, 'A user sticker should receive a Bot reaction');
  assert.equal(stickerReply.stickerId, 'sticker-123');
  assert.equal(stickerReply.kind, 'reply');

  // Two people in the same room must stop the Bot.
  const sameRoomSecond = socket('b'.repeat(32), 'solo-room');
  sockets.push(sameRoomSecond);
  solo.sent.length = 0;
  await matcher.refreshBotRooms();
  assert.ok(solo.sent.some(packet => packet.type === 'bot-stop'));
  assert.ok(sameRoomSecond.sent.some(packet => packet.type === 'bot-stop'));
  assert.equal(matcher.botRooms.size, 0);

  // Two singleton random groups still count as two humans globally.
  sockets.splice(0, sockets.length,
    socket('c'.repeat(32), 'room-one'),
    socket('d'.repeat(32), 'room-two')
  );
  await matcher.refreshBotRooms();
  assert.ok(sockets.every(person => person.sent.some(packet => packet.type === 'bot-stop')),
    'The Bot must stay off when people are split across separate random rooms');
  assert.equal(matcher.botRooms.size, 0);

  // One random user plus someone in a named room: no Bot.
  sockets.splice(0, sockets.length,
    socket('e'.repeat(32), 'random-alone'),
    socket('f'.repeat(32), 'named:quiet-room', 'group', 'custom')
  );
  await matcher.refreshBotRooms();
  assert.ok(sockets.every(person => person.sent.some(packet => packet.type === 'bot-stop')),
    'A person in any named room must count towards the global human total');
  assert.equal(matcher.botRooms.size, 0);

  // A sole user in a named room or one-to-one mode must not receive the Bot.
  sockets.splice(0, sockets.length, socket('g'.repeat(32), 'named:solo', 'group', 'custom'));
  await matcher.refreshBotRooms();
  assert.ok(sockets[0].sent.some(packet => packet.type === 'bot-stop'));
  assert.equal(matcher.botRooms.size, 0);
  sockets.splice(0, sockets.length, socket('h'.repeat(32), 'private-solo', 'private', 'random'));
  await matcher.refreshBotRooms();
  assert.ok(sockets[0].sent.some(packet => packet.type === 'bot-stop'));
  assert.equal(matcher.botRooms.size, 0);
  sockets.splice(0, sockets.length,
    socket('l'.repeat(32), 'random-alone'),
    socket('m'.repeat(32), 'private-room', 'private', 'random')
  );
  await matcher.refreshBotRooms();
  assert.ok(sockets.every(person => person.sent.some(packet => packet.type === 'bot-stop')),
    'A private one-to-one participant must count towards the global human total');
  assert.equal(matcher.botRooms.size, 0);

  // If the second person leaves, the lone random-chat user can receive the Bot again.
  const returningSolo = socket('i'.repeat(32), 'returning-room');
  sockets.splice(0, sockets.length, returningSolo);
  await matcher.refreshBotRooms();
  assert.ok(returningSolo.sent.some(packet => packet.type === 'bot-start'));
  assert.ok(!returningSolo.sent.some(packet => packet.type === 'bot-message'));

  // A request is discarded if another human arrives while Gemini is responding.
  let releaseFetch;
  globalThis.fetch = async () => new Promise(resolve => {
    releaseFetch = () => resolve(new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: 'A tiny reply.' }] } }]
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
  });
  const inFlight = matcher.handleBotRequest(returningSolo, {
    type: 'bot-chat', text: 'Still here?', history: [{ role: 'user', text: 'Still here?' }]
  });
  while (!releaseFetch) await new Promise(resolve => setImmediate(resolve));
  const secondArrives = socket('j'.repeat(32), 'somewhere-else');
  sockets.push(secondArrives);
  await matcher.refreshBotRooms();
  releaseFetch();
  await inFlight;
  assert.ok(!returningSolo.sent.some(packet => packet.type === 'bot-message' && packet.text === 'A tiny reply.'),
    'An in-flight Bot reply must be suppressed as soon as another human appears anywhere');

  // Even if that second person leaves before Gemini returns, the old request
  // belongs to the previous Bot activation and must not leak into the new one.
  sockets.splice(0, sockets.length, returningSolo);
  await matcher.refreshBotRooms();
  let releaseAfterReturn;
  globalThis.fetch = async () => new Promise(resolve => {
    releaseAfterReturn = () => resolve(new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: 'Stale reply.' }] } }]
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
  });
  const staleRequest = matcher.handleBotRequest(returningSolo, {
    type: 'bot-chat', text: 'One more thought.', history: [{ role: 'user', text: 'One more thought.' }]
  });
  while (!releaseAfterReturn) await new Promise(resolve => setImmediate(resolve));
  const transientSecond = socket('k'.repeat(32), 'temporary-room');
  sockets.push(transientSecond);
  await matcher.refreshBotRooms();
  sockets.splice(sockets.indexOf(transientSecond), 1);
  await matcher.refreshBotRooms();
  releaseAfterReturn();
  await staleRequest;
  assert.ok(!returningSolo.sent.some(packet => packet.type === 'bot-message' && packet.text === 'Stale reply.'),
    'A request from an earlier Bot activation must not appear after a brief second-person arrival');
  assert.ok(matcher.botEpoch >= 3, 'Bot activation changes should invalidate in-flight replies');

  // A bot-nudge from an old client is ignored; nudges are no longer a feature.
  const before = returningSolo.sent.filter(packet => packet.type === 'bot-message').length;
  await matcher.handleBotRequest(returningSolo, { type: 'bot-nudge', prompt: 'Say something' });
  assert.equal(returningSolo.sent.filter(packet => packet.type === 'bot-message').length, before);
} finally {
  globalThis.fetch = originalFetch;
}

console.log('Nerukko global Bot checks passed.');
