import assert from "node:assert/strict";
import { Matchmaker } from "../src/worker.js";
import { buildGeminiContents, clampBotReply, generateNerukkoBotReply } from "../src/nerukko-bot.js";

assert.equal(
  clampBotReply("One two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty twentyone twentytwo twentythree"),
  "One two three four five six seven eight nine ten"
);
assert.equal(clampBotReply("Aw that sounds lovely, tell me more about your trip to the hills please"), "Aw that sounds lovely, tell me more about your trip");
assert.equal(clampBotReply("Love that! Honestly I think you should absolutely go for it tomorrow"), "Love that!");
assert.equal(clampBotReply("Hey, so glad you stopped by to chat with us and the"), "Hey, so glad you stopped by to chat with us");
assert.equal(clampBotReply("It really made my day to hear from you and"), "It really made my day to hear from you and");
assert.equal(clampBotReply("That is a great idea, you should totally try it with the"), "That is a great idea, you should totally try it");
assert.ok(clampBotReply("a b c d e f g h i j k l").split(" ").length <= 10);
assert.equal(clampBotReply("Nice to meet you!"), "Nice to meet you!");

const firstUserTurn = buildGeminiContents([
  { role: "model", text: "Hey there!" },
  { role: "user", text: "Hlo" }
]);
assert.deepEqual(firstUserTurn, [
  { role: "user", parts: [{ text: "Hlo" }] }
]);

const nudge = buildGeminiContents([
  { role: "user", text: "I like music." },
  { role: "model", text: "What have you been listening to?" }
], "Offer a fresh topic.");
assert.deepEqual(nudge.map(item => item.role), ["user", "model", "user"]);

const originalFetch = globalThis.fetch;
let requestedUrl = "";
let requestedHeaders;
let requestedBody;
globalThis.fetch = async (url, options) => {
  requestedUrl = String(url);
  requestedHeaders = new Headers(options.headers);
  requestedBody = JSON.parse(options.body);
  return new Response(JSON.stringify({
    candidates: [{ content: { parts: [{ text: "Doing well! How about you?" }] } }]
  }), { status: 200, headers: { "content-type": "application/json" } });
};

try {
  const reply = await generateNerukkoBotReply("test-api-key", [
    { role: "model", text: "Hey there!" },
    { role: "user", text: "Hlo" }
  ], "");
  assert.equal(reply, "Doing well! How about you?");
  assert.equal(requestedHeaders.get("x-goog-api-key"), "test-api-key");
  assert.ok(!requestedUrl.includes("test-api-key"), "API key must not appear in the request URL");
  assert.equal(requestedBody.contents[0].role, "user");
  assert.equal(requestedBody.contents[0].parts[0].text, "Hlo");
  const persona = requestedBody.systemInstruction.parts[0].text;
  assert.ok(persona.includes("usually 4–8 words") && persona.includes("never more than 10") && persona.includes("warm, kind and upbeat"),
    "The Bot prompt should enforce tiny, natural chat replies");

  const socket = {
    attachment: { id: "a".repeat(32), name: "Solo", roomId: "solo-room", mode: "group" },
    sent: [],
    deserializeAttachment() { return this.attachment; },
    serializeAttachment(value) { this.attachment = value; },
    send(value) { this.sent.push(JSON.parse(value)); }
  };
  const store = new Map();
  const ctx = {
    getWebSockets: () => [socket],
    storage: {
      get: async key => store.get(key),
      put: async (key, value) => store.set(key, value),
      delete: async key => store.delete(key)
    }
  };
  const matcher = new Matchmaker(ctx, { GEMINI_API_KEY: "test-api-key" });
  // Deliberately leave botRooms empty to simulate a Durable Object restart.
  matcher.botRequestsByRoom.set("solo-room", 0);

  await matcher.handleBotRequest(socket, {
    type: "bot-chat",
    text: "Hlo",
    history: [{ role: "model", text: "Hey there!" }, { role: "user", text: "Hlo" }]
  });

  const botMessage = socket.sent.find(packet => packet.type === "bot-message");
  assert.ok(botMessage, "A normal user message must produce a Bot reply");
  assert.equal(botMessage.text, "Doing well! How about you?");
  assert.equal(botMessage.kind, "reply");

  // A user reply must not be dropped merely because an automatic Bot nudge
  // happened within the cooldown window.
  matcher.botLastRequest.set("solo-room", Date.now());
  socket.sent.length = 0;
  await matcher.handleBotRequest(socket, {
    type: "bot-chat",
    text: "And what about music?",
    history: [{ role: "user", text: "Hlo" }, { role: "model", text: "Doing well! How about you?" }]
  });
  assert.ok(socket.sent.some(packet => packet.type === "bot-message" && packet.kind === "reply"),
    "A real user message must never be silently dropped by the nudge cooldown");

  // Two fast messages are queued and both receive a response, in order.
  socket.sent.length = 0;
  await Promise.all([
    matcher.enqueueBotRequest(socket, { type: "bot-chat", text: "First queued line", history: [{ role: "user", text: "First queued line" }] }),
    matcher.enqueueBotRequest(socket, { type: "bot-chat", text: "Second queued line", history: [{ role: "user", text: "Second queued line" }] })
  ]);
  assert.equal(socket.sent.filter(packet => packet.type === "bot-message" && packet.kind === "reply").length, 2,
    "Queued user messages should each receive their own Bot reply");

  const second = {
    attachment: { id: "b".repeat(32), name: "New person", roomId: "solo-room", mode: "group" },
    sent: [],
    deserializeAttachment() { return this.attachment; },
    serializeAttachment(value) { this.attachment = value; },
    send(value) { this.sent.push(JSON.parse(value)); }
  };
  ctx.getWebSockets = () => [socket, second];
  await matcher.updateBotForRoom("solo-room");
  assert.ok(socket.sent.some(packet => packet.type === "bot-stop"), "A joining human must stop an active Bot even after an in-memory reset");
  assert.ok(second.sent.some(packet => packet.type === "bot-stop"), "New group members should receive the same Bot state reset");

  // A human in a separate named room still counts toward the global total.
  const soloRandom = {
    attachment: { id: "c".repeat(32), name: "Solo", roomId: "random-room", mode: "group", roomScope: "random" },
    sent: [],
    deserializeAttachment() { return this.attachment; },
    serializeAttachment(value) { this.attachment = value; },
    send(value) { this.sent.push(JSON.parse(value)); }
  };
  const customRoomHuman = {
    attachment: { id: "d".repeat(32), name: "Room person", roomId: "named-room", mode: "group", roomScope: "custom" },
    sent: [],
    deserializeAttachment() { return this.attachment; },
    serializeAttachment(value) { this.attachment = value; },
    send(value) { this.sent.push(JSON.parse(value)); }
  };
  const globalCtx = { ...ctx, getWebSockets: () => [soloRandom] };
  const globalMatcher = new Matchmaker(globalCtx, { GEMINI_API_KEY: "test-api-key" });
  await globalMatcher.refreshBotRooms();
  assert.ok(soloRandom.sent.some(packet => packet.type === "bot-start"), "A lone random-chat user should receive the fallback Bot");
  globalCtx.getWebSockets = () => [soloRandom, customRoomHuman];
  await globalMatcher.refreshBotRooms();
  assert.ok(soloRandom.sent.some(packet => packet.type === "bot-stop"), "A human in a separate named room must stop the random-chat Bot globally");

  const namedOnly = {
    attachment: { ...customRoomHuman.attachment }, sent: [],
    deserializeAttachment() { return this.attachment; },
    serializeAttachment(value) { this.attachment = value; },
    send(value) { this.sent.push(JSON.parse(value)); }
  };
  const namedCtx = { ...ctx, getWebSockets: () => [namedOnly] };
  const namedMatcher = new Matchmaker(namedCtx, { GEMINI_API_KEY: "test-api-key" });
  await namedMatcher.refreshBotRooms();
  assert.ok(!namedOnly.sent.some(packet => packet.type === "bot-start"), "Named rooms must never host the Bot");

  const privateOnly = {
    attachment: { id: "e".repeat(32), name: "Private person", roomId: "private-room", mode: "private", roomScope: "random" },
    sent: [],
    deserializeAttachment() { return this.attachment; },
    serializeAttachment(value) { this.attachment = value; },
    send(value) { this.sent.push(JSON.parse(value)); }
  };
  const privateCtx = { ...ctx, getWebSockets: () => [privateOnly] };
  const privateMatcher = new Matchmaker(privateCtx, { GEMINI_API_KEY: "test-api-key" });
  await privateMatcher.refreshBotRooms();
  assert.ok(!privateOnly.sent.some(packet => packet.type === "bot-start"), "One-to-one chats must never host the Bot");
  globalCtx.getWebSockets = () => [soloRandom, privateOnly];
  await globalMatcher.refreshBotRooms();
  assert.ok(soloRandom.sent.some(packet => packet.type === "bot-stop"), "A human in a one-to-one chat must also stop the random-chat Bot globally");
} finally {
  globalThis.fetch = originalFetch;
}

console.log("Nerukko Bot checks passed.");
