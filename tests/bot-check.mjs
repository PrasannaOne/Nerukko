import assert from "node:assert/strict";
import { Matchmaker } from "../src/worker.js";
import { buildGeminiContents, clampBotReply, generateNerukkoBotReply } from "../src/nerukko-bot.js";

assert.equal(
  clampBotReply("One two three four five six seven eight nine ten eleven"),
  "One two three four five six seven eight nine ten"
);

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
} finally {
  globalThis.fetch = originalFetch;
}

console.log("Nerukko Bot checks passed.");
