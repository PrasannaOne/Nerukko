import { generateNerukkoBotReply } from "./nerukko-bot.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/ws") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected WebSocket", { status: 426 });
      }
      const id = env.MATCHMAKER.idFromName("global-lobby");
      return env.MATCHMAKER.get(id).fetch(request);
    }
    const response = await env.ASSETS.fetch(request);
    if (request.method === "GET" && ["/", "/index.html", "/service-worker.js"].includes(url.pathname) && response.ok) {
      const headers = new Headers(response.headers);
      headers.set("Cache-Control", "no-store, no-cache, must-revalidate");
      headers.set("Pragma", "no-cache");
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    }
    return response;
  }
};

const MAX_PEOPLE = 7;
const ROOM_NAME_MAX = 36;
const ROOM_DESCRIPTION_MAX = 120;
const ROOM_PASSWORD_MIN = 4;
const ROOM_PASSWORD_MAX = 64;
const ROOM_PASSWORD_ITERATIONS = 120_000;
const ROOM_EMPTY_TTL_MS = 24 * 60 * 60_000;
const MAX_NAME = 24;
const MAX_SIGNAL_MESSAGE = 16_384;
const NEARBY_METERS = 100;
const REPORT_WINDOW_MS = 10 * 60_000;
const DELIVERY_TTL_MS = 7 * 24 * 60 * 60_000;
const BOT_DAILY_LIMIT = 40;
const BOT_ROOM_LIMIT = 24;

function deliveryKey(a, b) { return [String(a), String(b)].sort().join(":"); }

export class Matchmaker {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.pendingPrivate = new Map();
    this.requestRate = new Map();
    this.reports = new Map();
    this.deliveryEligible = new Map();
    this.activeDeliveries = new Map();
    this.botRooms = new Set();
    this.botRequestsByRoom = new Map();
    this.botEpoch = 0;
    this.botUsageQueue = Promise.resolve();
    this.botRequestQueues = new Map();
    this.roomJoinAttempts = new Map();
    this.roomCreateAttempts = new Map();
    this.serialQueue = Promise.resolve();
  }

  async fetch() {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ id: null, name: "", roomId: null, location: null, mode: "group" });
    return new Response(null, { status: 101, webSocket: client });
  }

  sockets() { return this.ctx.getWebSockets(); }

  attachment(ws) {
    try { return ws.deserializeAttachment() || {}; }
    catch { return {}; }
  }

  send(ws, data) {
    try { ws.send(JSON.stringify(data)); }
    catch {}
  }

  members(roomId) {
    return this.sockets().filter(ws => {
      const member = this.attachment(ws);
      return member.id && member.roomId === roomId;
    });
  }

  roomMap(mode = "group") {
    const rooms = new Map();
    for (const ws of this.sockets()) {
      const member = this.attachment(ws);
      if (!member.id || !member.roomId || member.mode !== mode || member.roomScope === "custom") continue;
      if (!rooms.has(member.roomId)) rooms.set(member.roomId, []);
      rooms.get(member.roomId).push({ ws, ...member });
    }
    return rooms;
  }

  runSerial(task) {
    const next = this.serialQueue.then(task, task);
    this.serialQueue = next.catch(() => {});
    return next;
  }

  webSocketMessage(ws, message) {
    if (typeof message === "string" && message.length <= MAX_SIGNAL_MESSAGE) {
      try {
        const packet = JSON.parse(message);
        if (packet?.type === "bot-chat" || packet?.type === "bot-sticker") {
          this.enqueueBotRequest(ws, packet).catch(() => this.send(ws, { type: "bot-unavailable", stickerId: packet.stickerId || null, message: "Nerukko Bot could not reply just now. Try again in a moment." }));
          return;
        }
      } catch {}
    }
    return this.runSerial(() => this.handleWebSocketMessage(ws, message));
  }

  async handleWebSocketMessage(ws, message) {
    if (typeof message !== "string" || message.length > MAX_SIGNAL_MESSAGE) return;
    let data;
    try { data = JSON.parse(message); } catch { return; }
    const current = this.attachment(ws);

    if (data.type === "join") {
      if (current.id) return;
      const id = String(data.id || "").slice(0, 64);
      const name = String(data.name || "Guest").trim().slice(0, MAX_NAME) || "Guest";
      if (!/^[a-f0-9-]{20,64}$/i.test(id)) {
        this.send(ws, { type: "error", message: "Please refresh and try again." });
        return;
      }
      const cooldownKey = `cooldown:${id}`;
      const until = await this.ctx.storage.get(cooldownKey);
      if (Number(until) > Date.now()) {
        this.send(ws, { type: "blocked", until: Number(until) });
        try { ws.close(4003, "Temporary cooldown"); } catch {}
        return;
      } else if (until) {
        await this.ctx.storage.delete(cooldownKey);
      }

      // A persistent browser ID can have only one live session.
      for (const other of this.sockets()) {
        if (other === ws) continue;
        if (this.attachment(other).id === id) {
          await this.remove(other, { rebalance: false });
          try { other.close(4000, "Session replaced"); } catch {}
        }
      }

      const location = this.cleanLocation(data.location);
      const roomId = this.chooseRoom(location, { requiredSlots: 1 });
      ws.serializeAttachment({ id, name, roomId, location, mode: "group", roomScope: "random", customRoomId: null });
      const peers = this.peerList(roomId, id);
      this.send(ws, { type: "joined", roomId, peers });
      for (const peer of this.members(roomId)) {
        if (peer !== ws) this.send(peer, { type: "peer-joined", peer: { id, name } });
      }
      this.broadcastRoomStatus(roomId);
      await this.rebalanceGroupRooms();
      await this.refreshBotRooms();
      await this.broadcastRoomDirectory();
      return;
    }

    if (!current.id) return;

    if (data.type === "rooms-list") { await this.sendRoomDirectory(ws); return; }
    if (data.type === "room-create") { await this.createNamedRoom(ws, data); return; }
    if (data.type === "room-join") { await this.joinNamedRoom(ws, data); return; }
    if (data.type === "room-leave") { await this.leaveNamedRoom(ws); return; }
    if (data.type === "room-update") { await this.updateNamedRoom(ws, data); return; }
    if (data.type === "room-delete") { await this.deleteNamedRoom(ws); return; }

    if (data.type === "signal") {
      const target = String(data.to || "");
      if (!target || target === current.id || !data.payload || typeof data.payload !== "object") return;
      let recipient = this.members(current.roomId).find(peer => this.attachment(peer).id === target);
      if (!recipient) {
        const key = deliveryKey(current.id, target);
        const until = this.activeDeliveries.get(key) || 0;
        if (until > Date.now()) recipient = this.sockets().find(peer => this.attachment(peer).id === target);
        else if (until) this.activeDeliveries.delete(key);
      }
      if (recipient) this.send(recipient, { type: "signal", from: current.id, payload: data.payload });
      return;
    }

    if (data.type === "delivery-invite") {
      await this.handleDeliveryInvite(ws, String(data.to || ""));
      return;
    }

    if (data.type === "rename") {
      const name = String(data.name || "").trim().slice(0, MAX_NAME);
      if (!name) return;
      ws.serializeAttachment({ ...current, name });
      for (const peer of this.members(current.roomId)) {
        if (peer !== ws) this.send(peer, { type: "peer-renamed", id: current.id, name });
      }
      if (current.customRoomId) { await this.broadcastCustomRoomMembers(current.customRoomId); await this.broadcastRoomDirectory(); }
      return;
    }

    if (data.type === "location-update") {
      const location = this.cleanLocation(data.location);
      if (!location && data.location !== null) return;
      ws.serializeAttachment({ ...current, location });
      if (!location && current.customRoomId) {
        await this.leaveNamedRoom(ws);
        return;
      }
      if (current.mode === "group" && current.roomScope !== "custom") {
        await this.rebalanceGroupRooms();
        await this.refreshBotRooms();
      }
      const updated = this.attachment(ws);
      this.broadcastRoomStatus(updated.roomId);
      await this.broadcastRoomDirectory();
      return;
    }

    if (data.type === "private-request") {
      this.createPrivateRequest(ws, String(data.to || ""));
      return;
    }

    if (data.type === "private-respond") {
      await this.respondPrivateRequest(ws, String(data.requestId || ""), data.accept === true);
      return;
    }

    if (data.type === "private-end") {
      await this.endPrivateRoom(current.roomId);
      return;
    }

    if (data.type === "report") {
      await this.reportMember(ws, String(data.target || ""));
      return;
    }

    if (data.type === "ping") {
      this.send(ws, { type: "pong" });
      return;
    }

    // No user-facing Leave button, but lifecycle cleanup still handles deliberate unloads.
    if (data.type === "leave") await this.remove(ws);
  }

  async getNamedRooms() {
    const value = await this.ctx.storage.get("named-rooms");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  }

  async saveNamedRooms(rooms) {
    await this.ctx.storage.put("named-rooms", rooms);
  }

  async scheduleNamedRoomExpiry(rooms) {
    const next = Object.values(rooms).map(room => Number(room?.expiresAt) || 0).filter(value => value > 0).sort((a, b) => a - b)[0];
    if (next && typeof this.ctx.storage.setAlarm === "function") await this.ctx.storage.setAlarm(next);
    else if (!next && typeof this.ctx.storage.deleteAlarm === "function") await this.ctx.storage.deleteAlarm();
  }

  async cleanupExpiredNamedRooms() {
    const rooms = await this.getNamedRooms();
    const now = Date.now();
    let changed = false;
    for (const [roomId, meta] of Object.entries(rooms)) {
      if (!meta || !meta.id) { delete rooms[roomId]; changed = true; continue; }
      if (!meta.emptyPolicy) { meta.emptyPolicy = meta.keepWhenEmpty ? "24h" : "immediate"; changed = true; }
      if ("keepWhenEmpty" in meta) { delete meta.keepWhenEmpty; changed = true; }
      const members = this.namedRoomMembers(roomId);
      if (!meta.location && !members.length) { delete rooms[roomId]; changed = true; continue; }
      if (!meta.location && members.length) {
        const locatedMember = members.find(member => member.location);
        if (locatedMember) { meta.location = { ...locatedMember.location }; changed = true; }
        else if (meta.emptyPolicy !== "immediate") { meta.emptyPolicy = "immediate"; changed = true; }
      }
      if (members.length) {
        if (meta.expiresAt || meta.emptySince) { meta.expiresAt = null; meta.emptySince = null; changed = true; }
      } else if (meta.emptyPolicy === "24h") {
        if (!Number(meta.expiresAt)) {
          meta.emptySince = now;
          meta.expiresAt = now + ROOM_EMPTY_TTL_MS;
          changed = true;
        } else if (Number(meta.expiresAt) <= now) {
          delete rooms[roomId];
          changed = true;
        }
      } else {
        delete rooms[roomId];
        changed = true;
      }
      if (rooms[roomId]) rooms[roomId] = meta;
    }
    if (changed) await this.saveNamedRooms(rooms);
    await this.scheduleNamedRoomExpiry(rooms);
    return rooms;
  }

  async alarm() {
    await this.runSerial(async () => {
      await this.cleanupExpiredNamedRooms();
      await this.broadcastRoomDirectory();
    });
  }

  namedRoomMembers(roomId) {
    return this.sockets().map(ws => ({ ws, ...this.attachment(ws) }))
      .filter(member => member.id && member.customRoomId === roomId && member.roomScope === "custom");
  }

  namedRoomView(meta) {
    const members = this.namedRoomMembers(meta.id);
    return {
      id: meta.id,
      name: meta.name,
      description: meta.description || "",
      visibility: meta.visibility,
      emptyPolicy: meta.emptyPolicy === "24h" ? "24h" : "immediate",
      expiresAt: Number(meta.expiresAt) || null,
      ownerId: meta.ownerId,
      memberCount: members.length,
      capacity: MAX_PEOPLE,
      members: members.map(member => ({ id: member.id, name: member.name || "Guest" })),
      createdAt: meta.createdAt
    };
  }

  async sendRoomDirectory(ws, storedRooms = null) {
    const stored = storedRooms || await this.cleanupExpiredNamedRooms();
    const member = this.attachment(ws);
    if (!member.location) {
      this.send(ws, { type: "rooms-list", rooms: [], requiresLocation: true });
      return;
    }
    const nearby = Object.values(stored)
      .filter(meta => meta && meta.id && meta.location && this.distance(member.location, meta.location) <= NEARBY_METERS)
      .map(meta => ({ ...this.namedRoomView(meta), distanceMeters: Math.round(this.distance(member.location, meta.location)) }));
    const byDistance = (a, b) => a.distanceMeters - b.distanceMeters || b.memberCount - a.memberCount || a.name.localeCompare(b.name);
    const publicRooms = nearby.filter(room => room.visibility === "public").sort(byDistance).slice(0, 10);
    const privateRooms = nearby.filter(room => room.visibility === "private").sort(byDistance).slice(0, 10);
    const safeRoom = ({ distanceMeters, ...room }) => room;
    this.send(ws, { type: "rooms-list", rooms: [...publicRooms, ...privateRooms].map(safeRoom), requiresLocation: false });
  }

  async broadcastRoomDirectory() {
    const stored = await this.cleanupExpiredNamedRooms();
    for (const ws of this.sockets()) if (this.attachment(ws).id) await this.sendRoomDirectory(ws, stored);
  }

  async broadcastCustomRoomMembers(roomId) {
    const meta = (await this.getNamedRooms())[roomId];
    if (!meta) return;
    const room = this.namedRoomView(meta);
    for (const member of this.namedRoomMembers(roomId)) this.send(member.ws, { type: "room-members", room });
  }

  async cleanupNamedRoom(roomId) {
    if (!roomId) return;
    const rooms = await this.getNamedRooms();
    const meta = rooms[roomId];
    if (!meta) return;
    const members = this.namedRoomMembers(roomId);
    if (!meta.emptyPolicy) meta.emptyPolicy = meta.keepWhenEmpty ? "24h" : "immediate";
    delete meta.keepWhenEmpty;
    if (!members.length) {
      if (meta.emptyPolicy === "24h") {
        if (!Number(meta.expiresAt)) {
          meta.emptySince = Date.now();
          meta.expiresAt = Date.now() + ROOM_EMPTY_TTL_MS;
        }
        rooms[roomId] = meta;
      } else delete rooms[roomId];
      await this.saveNamedRooms(rooms);
      await this.scheduleNamedRoomExpiry(rooms);
      return;
    }
    meta.emptySince = null;
    meta.expiresAt = null;
    if (!members.some(member => member.id === meta.ownerId)) {
      meta.ownerId = members[0].id;
      meta.ownerName = members[0].name;
    }
    rooms[roomId] = meta;
    await this.saveNamedRooms(rooms);
    await this.scheduleNamedRoomExpiry(rooms);
  }

  async hashRoomPassword(password, saltHex = null) {
    const encoder = new TextEncoder();
    const salt = saltHex
      ? Uint8Array.from(saltHex.match(/.{1,2}/g).map(part => parseInt(part, 16)))
      : crypto.getRandomValues(new Uint8Array(16));
    const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: ROOM_PASSWORD_ITERATIONS, hash: "SHA-256" }, key, 256);
    const bytes = new Uint8Array(bits);
    const hex = [...bytes].map(value => value.toString(16).padStart(2, "0")).join("");
    return { salt: [...salt].map(value => value.toString(16).padStart(2, "0")).join(""), hash: hex };
  }

  async verifyRoomPassword(meta, password) {
    if (!meta.passwordHash || !meta.passwordSalt) return false;
    const result = await this.hashRoomPassword(password, meta.passwordSalt);
    if (result.hash.length !== meta.passwordHash.length) return false;
    let mismatch = 0;
    for (let index = 0; index < result.hash.length; index++) mismatch |= result.hash.charCodeAt(index) ^ meta.passwordHash.charCodeAt(index);
    return mismatch === 0;
  }

  async createNamedRoom(ws, data) {
    const member = this.attachment(ws);
    if (!member.id || member.mode !== "group") return this.send(ws, { type: "room-error", message: "Leave your one-to-one chat before creating a room." });
    if (!member.location) return this.send(ws, { type: "room-error", message: "Enable location in Settings to create or discover nearby rooms." });
    const name = String(data.name || "").replace(/[\\\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, ROOM_NAME_MAX);
    const description = String(data.description || "").replace(/[\\\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, ROOM_DESCRIPTION_MAX);
    const visibility = data.visibility === "private" ? "private" : "public";
    const password = String(data.password || "");
    if (name.length < 2) return this.send(ws, { type: "room-error", message: "Give your room a name with at least two characters." });
    if (visibility === "private" && (password.length < ROOM_PASSWORD_MIN || password.length > ROOM_PASSWORD_MAX)) {
      return this.send(ws, { type: "room-error", message: "Private room passwords must be 4 to 64 characters." });
    }
    const now = Date.now();
    const createdRecently = (this.roomCreateAttempts.get(member.id) || []).filter(time => now - time < 10 * 60_000);
    if (createdRecently.length >= 3) return this.send(ws, { type: "room-error", message: "You can create up to three rooms every ten minutes." });
    const rooms = await this.cleanupExpiredNamedRooms();
    if (Object.keys(rooms).length >= 500) return this.send(ws, { type: "room-error", message: "The room directory is full for now." });
    if (Object.values(rooms).some(room => room.name.toLowerCase() === name.toLowerCase() && room.location && this.distance(member.location, room.location) <= NEARBY_METERS)) {
      return this.send(ws, { type: "room-error", message: "A room with that name already exists nearby." });
    }
    const id = crypto.randomUUID();
    const credentials = visibility === "private" ? await this.hashRoomPassword(password) : null;
    const meta = {
      id, name, description, visibility,
      emptyPolicy: data.emptyPolicy === "24h" ? "24h" : "immediate",
      emptySince: null, expiresAt: null, location: { ...member.location },
      ownerId: member.id, ownerName: member.name,
      passwordSalt: credentials?.salt || null, passwordHash: credentials?.hash || null,
      createdAt: Date.now()
    };
    rooms[id] = meta;
    await this.saveNamedRooms(rooms);
    await this.scheduleNamedRoomExpiry(rooms);
    createdRecently.push(now); this.roomCreateAttempts.set(member.id, createdRecently);
    await this.enterNamedRoom(ws, meta);
  }

  async joinNamedRoom(ws, data) {
    const member = this.attachment(ws);
    if (!member.id || member.mode !== "group") return this.send(ws, { type: "room-error", message: "Leave your one-to-one chat before joining a room." });
    const roomId = String(data.roomId || "").slice(0, 64);
    if (!member.location) return this.send(ws, { type: "room-error", message: "Enable location in Settings to join nearby rooms." });
    const rooms = await this.cleanupExpiredNamedRooms();
    const meta = rooms[roomId];
    if (!meta) return this.send(ws, { type: "room-error", message: "That room is no longer available." });
    if (!meta.location || this.distance(member.location, meta.location) > NEARBY_METERS) return this.send(ws, { type: "room-error", message: "That room is outside your nearby area." });
    if (meta.visibility === "private") {
      const key = `${member.id}:${roomId}`;
      const attempts = (this.roomJoinAttempts.get(key) || []).filter(time => Date.now() - time < 60_000);
      if (attempts.length >= 6) return this.send(ws, { type: "room-error", message: "Too many password attempts. Try again in a minute." });
      attempts.push(Date.now()); this.roomJoinAttempts.set(key, attempts);
      const password = String(data.password || "");
      if (!await this.verifyRoomPassword(meta, password)) return this.send(ws, { type: "room-error", message: "That password doesn't match." });
      this.roomJoinAttempts.delete(key);
    }
    if (meta.id === member.customRoomId) return this.send(ws, { type: "room-entered", room: this.namedRoomView(meta), peers: this.peerList(member.roomId, member.id) });
    if (this.namedRoomMembers(roomId).length >= MAX_PEOPLE) return this.send(ws, { type: "room-error", message: `This room is full (${MAX_PEOPLE}/${MAX_PEOPLE}).` });
    await this.enterNamedRoom(ws, meta);
  }

  async enterNamedRoom(ws, meta) {
    const member = this.attachment(ws);
    const rooms = await this.getNamedRooms();
    meta = rooms[meta.id] || meta;
    meta.emptySince = null; meta.expiresAt = null;
    const existingMembers = this.namedRoomMembers(meta.id);
    if (!existingMembers.some(person => person.id === meta.ownerId)) {
      meta.ownerId = member.id;
      meta.ownerName = member.name;
    }
    rooms[meta.id] = meta;
    await this.saveNamedRooms(rooms);
    await this.scheduleNamedRoomExpiry(rooms);
    const oldRoom = member.roomId;
    const oldCustomRoom = member.customRoomId || null;
    this.send(ws, { type: "bot-stop" });
    for (const [requestId, request] of this.pendingPrivate.entries()) {
      if (request.from === member.id || request.to === member.id) {
        this.pendingPrivate.delete(requestId);
        const otherId = request.from === member.id ? request.to : request.from;
        const otherSocket = this.sockets().find(peer => this.attachment(peer).id === otherId);
        if (otherSocket) this.send(otherSocket, { type: "private-request-expired", requestId });
      }
    }
    for (const peer of this.members(oldRoom)) if (peer !== ws) this.send(peer, { type: "peer-left", id: member.id });
    const roomId = `named:${meta.id}`;
    ws.serializeAttachment({ ...member, roomId, mode: "group", roomScope: "custom", customRoomId: meta.id });
    const peers = this.peerList(roomId, member.id);
    const room = this.namedRoomView(meta);
    this.send(ws, { type: "room-entered", room, roomId, peers });
    for (const peer of this.members(roomId)) if (peer !== ws) this.send(peer, { type: "peer-joined", peer: { id: member.id, name: member.name } });
    if (oldCustomRoom && oldCustomRoom !== meta.id) await this.cleanupNamedRoom(oldCustomRoom);
    if (!oldCustomRoom) this.broadcastRoomStatus(oldRoom);
    await this.refreshBotRooms();
    await this.broadcastCustomRoomMembers(meta.id);
    await this.broadcastRoomDirectory();
  }

  async leaveNamedRoom(ws) {
    const member = this.attachment(ws);
    if (!member.id || member.roomScope !== "custom" || !member.customRoomId) return;
    const oldRoom = member.roomId;
    const oldCustomRoom = member.customRoomId;
    for (const peer of this.members(oldRoom)) if (peer !== ws) this.send(peer, { type: "peer-left", id: member.id });
    const newRoom = this.chooseRoom(member.location, { requiredSlots: 1 });
    ws.serializeAttachment({ ...member, roomId: newRoom, mode: "group", roomScope: "random", customRoomId: null });
    const peers = this.peerList(newRoom, member.id);
    this.send(ws, { type: "joined", roomId: newRoom, peers, scope: "random" });
    for (const peer of this.members(newRoom)) if (peer !== ws) this.send(peer, { type: "peer-joined", peer: { id: member.id, name: member.name } });
    await this.cleanupNamedRoom(oldCustomRoom);
    this.broadcastRoomStatus(newRoom);
    await this.rebalanceGroupRooms();
    await this.refreshBotRooms();
    await this.broadcastCustomRoomMembers(oldCustomRoom);
    await this.broadcastRoomDirectory();
  }

  async updateNamedRoom(ws, data) {
    const member = this.attachment(ws);
    const roomId = member.customRoomId;
    if (!roomId || member.roomScope !== "custom") return;
    const rooms = await this.getNamedRooms();
    const meta = rooms[roomId];
    if (!meta || meta.ownerId !== member.id) return this.send(ws, { type: "room-error", message: "Only the room owner can change its settings." });
    const name = String(data.name || meta.name).replace(/[\\\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, ROOM_NAME_MAX);
    const description = String(data.description || "").replace(/[\\\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, ROOM_DESCRIPTION_MAX);
    const visibility = data.visibility === "private" ? "private" : "public";
    const password = String(data.password || "");
    if (name.length < 2) return this.send(ws, { type: "room-error", message: "Room name must contain at least two characters." });
    if (Object.values(rooms).some(room => room.id !== roomId && room.name.toLowerCase() === name.toLowerCase() && room.location && this.distance(member.location, room.location) <= NEARBY_METERS)) return this.send(ws, { type: "room-error", message: "A room with that name already exists nearby." });
    if (visibility === "private" && password && (password.length < ROOM_PASSWORD_MIN || password.length > ROOM_PASSWORD_MAX)) return this.send(ws, { type: "room-error", message: "Passwords must be 4 to 64 characters." });
    if (visibility === "private" && !meta.passwordHash && !password) return this.send(ws, { type: "room-error", message: "Set a password before making this room private." });
    let credentials = null;
    if (visibility === "private" && password) credentials = await this.hashRoomPassword(password);
    meta.name = name; meta.description = description; meta.visibility = visibility;
    meta.emptyPolicy = data.emptyPolicy === "24h" ? "24h" : "immediate";
    if (visibility === "public") { meta.passwordSalt = null; meta.passwordHash = null; }
    else if (credentials) { meta.passwordSalt = credentials.salt; meta.passwordHash = credentials.hash; }
    rooms[roomId] = meta;
    await this.saveNamedRooms(rooms);
    await this.scheduleNamedRoomExpiry(rooms);
    const room = this.namedRoomView(meta);
    for (const person of this.namedRoomMembers(roomId)) this.send(person.ws, { type: "room-updated", room });
    await this.broadcastRoomDirectory();
  }

  async deleteNamedRoom(ws) {
    const member = this.attachment(ws);
    const roomId = member.customRoomId;
    if (!roomId || member.roomScope !== "custom") return;
    const rooms = await this.getNamedRooms();
    const meta = rooms[roomId];
    if (!meta || meta.ownerId !== member.id) return this.send(ws, { type: "room-error", message: "Only the room owner can delete this room." });
    delete rooms[roomId];
    await this.saveNamedRooms(rooms);
    await this.scheduleNamedRoomExpiry(rooms);
    const participants = this.namedRoomMembers(roomId).map(person => person.ws);
    for (const participant of participants) {
      const person = this.attachment(participant);
      const oldRoom = person.roomId;
      for (const peer of this.members(oldRoom)) if (peer !== participant) this.send(peer, { type: "peer-left", id: person.id });
      const newRoom = this.chooseRoom(person.location, { requiredSlots: 1 });
      participant.serializeAttachment({ ...person, roomId: newRoom, mode: "group", roomScope: "random", customRoomId: null });
      const peers = this.peerList(newRoom, person.id);
      this.send(participant, { type: "joined", roomId: newRoom, peers, scope: "random", notice: "This room was deleted by its owner." });
      for (const peer of this.members(newRoom)) if (peer !== participant) this.send(peer, { type: "peer-joined", peer: { id: person.id, name: person.name } });
      this.broadcastRoomStatus(newRoom);
    }
    await this.rebalanceGroupRooms();
    await this.refreshBotRooms();
    await this.broadcastRoomDirectory();
  }

  async handleDeliveryInvite(ws, targetId) {
    const sender = this.attachment(ws);
    if (!sender.id || sender.mode !== "group" || sender.roomScope === "custom" || !targetId || targetId === sender.id) return;
    const key = deliveryKey(sender.id, targetId);
    const now = Date.now();
    let until = this.deliveryEligible.get(key) || 0;
    if (until <= now) {
      until = Number(await this.ctx.storage.get(`delivery:${key}`) || 0);
      if (until > now) this.deliveryEligible.set(key, until);
    }
    if (until <= now) {
      if (until) await this.ctx.storage.delete(`delivery:${key}`);
      this.send(ws, { type: "delivery-expired", to: targetId });
      return;
    }
    const recipient = this.sockets().find(peer => this.attachment(peer).id === targetId);
    if (!recipient || this.attachment(recipient).mode !== "group" || this.attachment(recipient).roomScope === "custom") return;
    const receiver = this.attachment(recipient);
    this.activeDeliveries.set(key, now + 5 * 60_000);
    this.send(ws, { type: "delivery-ready", peer: { id: receiver.id, name: receiver.name } });
    this.send(recipient, { type: "delivery-invite", peer: { id: sender.id, name: sender.name } });
  }

  async refreshBotRooms() {
    // Nerukko Bot is available only when the entire Worker has exactly one
    // connected human, and that person is in the random-chat pool. Counting
    // sockets rather than room members also excludes users in named rooms and
    // one-to-one conversations.
    const humans = this.sockets()
      .map(ws => ({ ws, member: this.attachment(ws) }))
      .filter(({ member }) => member.id && member.roomId);
    const only = humans.length === 1 ? humans[0] : null;
    const eligible = !!this.env.GEMINI_API_KEY && !!only &&
      only.member.mode === "group" && only.member.roomScope === "random" &&
      !only.member.customRoomId;
    const activeSocket = eligible ? only.ws : null;
    const activeRoomId = activeSocket ? only.member.roomId : null;
    const previousRooms = [...this.botRooms];
    const sameActivation = activeRoomId
      ? previousRooms.length === 1 && previousRooms[0] === activeRoomId
      : previousRooms.length === 0;
    if (!sameActivation) this.botEpoch++;

    // Explicitly stop every ineligible client. This also repairs stale browser
    // bot state after a Durable Object restart or a move into another room.
    for (const { ws } of humans) {
      if (ws !== activeSocket) this.send(ws, { type: "bot-stop" });
    }

    for (const roomId of [...this.botRooms]) {
      if (roomId !== activeRoomId) {
        for (const ws of this.members(roomId)) this.send(ws, { type: "bot-stop" });
        this.botRooms.delete(roomId);
        this.botRequestsByRoom.delete(roomId);
      }
    }

    if (!activeSocket) {
      this.botRooms.clear();
      return;
    }
    await this.updateBotForRoom(activeRoomId, activeSocket);
  }

  async updateBotForRoom(roomId, expectedSocket = null) {
    const humans = this.sockets()
      .map(ws => ({ ws, member: this.attachment(ws) }))
      .filter(({ member }) => member.id && member.roomId);
    const only = humans.length === 1 ? humans[0] : null;
    const socket = expectedSocket || only?.ws;
    const member = socket ? this.attachment(socket) : null;
    const shouldRun = !!this.env.GEMINI_API_KEY && !!only && only.ws === socket &&
      member?.roomId === roomId && member.mode === "group" &&
      member.roomScope === "random" && !member.customRoomId;

    if (!shouldRun) {
      if (socket) this.send(socket, { type: "bot-stop" });
      this.botRooms.delete(roomId);
      return;
    }
    if (this.botRooms.has(roomId)) return;
    this.botRooms.add(roomId);
    this.botRequestsByRoom.set(roomId, 0);
    // Joining is silent. The Bot waits for the person's first message or
    // sticker instead of greeting or nudging them without being asked.
    this.send(socket, { type: "bot-start" });
  }

  enqueueBotRequest(ws, data) {
    const roomId = this.attachment(ws).roomId;
    if (!roomId) return Promise.resolve();
    const previous = this.botRequestQueues.get(roomId) || Promise.resolve();
    const queued = previous.catch(() => {}).then(() => this.handleBotRequest(ws, data));
    this.botRequestQueues.set(roomId, queued);
    const cleanup = () => {
      if (this.botRequestQueues.get(roomId) === queued) this.botRequestQueues.delete(roomId);
    };
    queued.then(cleanup, cleanup);
    return queued;
  }

  reserveBotDailySlot(day) {
    const task = this.botUsageQueue.then(async () => {
      const key = `bot-usage:${day}`;
      const used = Number(await this.ctx.storage.get(key) || 0);
      if (used >= BOT_DAILY_LIMIT) return false;
      await this.ctx.storage.put(key, used + 1);
      return true;
    });
    this.botUsageQueue = task.catch(() => false);
    return task;
  }

  async handleBotRequest(ws, data) {
    const member = this.attachment(ws);
    if (!member.id || member.mode !== "group" || member.roomScope !== "random" ||
        member.customRoomId || !member.roomId || !this.env.GEMINI_API_KEY) return;
    if (data?.type !== "bot-chat" && data?.type !== "bot-sticker") return;

    // A room containing one person is not enough. The whole app must contain
    // exactly one live human, and it must be this exact socket in random chat.
    const humans = this.sockets()
      .map(socket => ({ socket, person: this.attachment(socket) }))
      .filter(({ person }) => person.id && person.roomId);
    if (humans.length !== 1 || humans[0].socket !== ws) return;
    const requestEpoch = this.botEpoch;

    const latestText = String(data.text || "").slice(0, 700).trim();
    if (data.type === "bot-chat" && !latestText) return;
    const roomCount = this.botRequestsByRoom.get(member.roomId) || 0;
    if (roomCount >= BOT_ROOM_LIMIT) {
      return this.send(ws, { type: "bot-unavailable", stickerId: data.stickerId || null, message: "Nerukko Bot has reached its chat limit for now." });
    }

    const day = new Date().toISOString().slice(0, 10);
    this.botRequestsByRoom.set(member.roomId, roomCount + 1);
    if (!await this.reserveBotDailySlot(day)) {
      return this.send(ws, { type: "bot-unavailable", stickerId: data.stickerId || null, message: "Nerukko Bot is resting for today." });
    }
    if (requestEpoch !== this.botEpoch) return;
    const stillEligibleBeforeRequest = this.sockets()
      .map(socket => ({ socket, person: this.attachment(socket) }))
      .filter(({ person }) => person.id && person.roomId);
    if (stillEligibleBeforeRequest.length !== 1 || stillEligibleBeforeRequest[0].socket !== ws) return;

    const history = Array.isArray(data.history) ? data.history.slice(-12) : [];
    if (data.type === "bot-chat" && !history.some(item => item?.role === "user" && item?.text === latestText)) {
      history.push({ role: "user", text: latestText });
    }
    const stickerId = data.type === "bot-sticker" && typeof data.stickerId === "string"
      ? data.stickerId.slice(0, 80) : null;
    const prompt = data.type === "bot-sticker"
      ? "The person sent a sticker. You cannot see it. React to the gesture without guessing what it shows."
      : "";
    const reply = await generateNerukkoBotReply(this.env.GEMINI_API_KEY, history, prompt);

    // Re-check globally after Gemini returns. A second person may have arrived
    // while the request was in flight, in which case the Bot must stay silent.
    const stillAlone = this.sockets()
      .map(socket => ({ socket, person: this.attachment(socket) }))
      .filter(({ person }) => person.id && person.roomId);
    if (stillAlone.length !== 1 || stillAlone[0].socket !== ws || requestEpoch !== this.botEpoch) return;
    const current = this.attachment(ws);
    if (current.mode !== "group" || current.roomScope !== "random" || current.roomId !== member.roomId) return;

    this.send(ws, {
      type: "bot-message", kind: "reply", text: reply,
      messageId: crypto.randomUUID(), stickerId
    });
  }

  peerList(roomId, exceptId = null) {
    return this.members(roomId)
      .map(ws => this.attachment(ws))
      .filter(person => person.id !== exceptId)
      .map(person => ({ id: person.id, name: person.name }));
  }

  cleanLocation(value) {
    if (!value || typeof value.lat !== "number" || typeof value.lon !== "number") return null;
    if (!Number.isFinite(value.lat) || !Number.isFinite(value.lon)) return null;
    if (Math.abs(value.lat) > 90 || Math.abs(value.lon) > 180) return null;
    return {
      lat: Math.round(value.lat * 10_000) / 10_000,
      lon: Math.round(value.lon * 10_000) / 10_000
    };
  }

  distance(a, b) {
    const rad = value => value * Math.PI / 180;
    const dLat = rad(b.lat - a.lat);
    const dLon = rad(b.lon - a.lon);
    const x = Math.sin(dLat / 2) ** 2 +
      Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 6_371_000 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
  }

  roomDistances(location, people) {
    const distances = people.filter(person => person.location)
      .map(person => this.distance(location, person.location));
    return { nearest: distances.length ? Math.min(...distances) : Infinity,
      widest: distances.length ? Math.max(...distances) : Infinity };
  }

  chooseRoom(location, { requiredSlots = 1, exclude = new Set() } = {}) {
    const rooms = [...this.roomMap("group").entries()]
      .map(([roomId, people]) => ({ roomId, people }))
      .filter(room => !exclude.has(room.roomId) && MAX_PEOPLE - room.people.length >= requiredSlots);
    if (!rooms.length) return crypto.randomUUID();

    if (!location) {
      // A user who declines location joins a room that already contains at least
      // one other no-location participant before falling back to other rooms.
      const sharedPreference = rooms.filter(room => room.people.some(person => !person.location));
      const pool = sharedPreference.length ? sharedPreference : rooms;
      pool.sort((a, b) => {
        const aNo = a.people.filter(person => !person.location).length;
        const bNo = b.people.filter(person => !person.location).length;
        return bNo - aNo || b.people.length - a.people.length;
      });
      return pool[0].roomId;
    }

    const measured = rooms.map(room => ({
      ...room,
      ...this.roomDistances(location, room.people),
      fullyLocated: room.people.every(person => person.location)
    }));
    const nearby = measured.filter(room => room.nearest <= NEARBY_METERS);
    let pool;
    if (nearby.length) {
      const nearbyFullyLocated = nearby.filter(room => room.fullyLocated);
      pool = nearbyFullyLocated.length ? nearbyFullyLocated : nearby;
    } else {
      const widerFullyLocated = measured.filter(room => room.fullyLocated);
      pool = widerFullyLocated.length ? widerFullyLocated : measured;
    }
    pool.sort((a, b) => a.nearest - b.nearest || b.people.length - a.people.length);
    return pool[0].roomId;
  }

  roomStatus(roomId) {
    const members = this.members(roomId).map(ws => this.attachment(ws));
    if (members.length < 2) return { kind: "waiting", label: "Waiting" };
    if (members.some(member => !member.location)) return { kind: "open", label: "Open circle" };
    let widestGap = 0;
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        widestGap = Math.max(widestGap, this.distance(members[i].location, members[j].location));
      }
    }
    return widestGap <= NEARBY_METERS
      ? { kind: "nearby", label: "Nearby" }
      : { kind: "wider", label: "Wider circle" };
  }

  broadcastRoomStatus(roomId) {
    const status = this.roomStatus(roomId);
    for (const ws of this.members(roomId)) this.send(ws, { type: "room-status", status });
  }

  syncRoom(roomId) {
    const sockets = this.members(roomId);
    const people = sockets.map(ws => this.attachment(ws));
    for (const ws of sockets) {
      const self = this.attachment(ws);
      this.send(ws, {
        type: "room-reset",
        roomId,
        mode: self.mode,
        peers: people.filter(person => person.id !== self.id).map(person => ({ id: person.id, name: person.name }))
      });
    }
    this.broadcastRoomStatus(roomId);
  }

  canMergeRooms(a, b) {
    const noA = a.people.filter(person => !person.location).length;
    const noB = b.people.filter(person => !person.location).length;
    // Shared no-location preference is a strong compatibility signal.
    if (noA > 0 && noB > 0) return true;
    const locA = a.people.filter(person => person.location).map(person => person.location);
    const locB = b.people.filter(person => person.location).map(person => person.location);
    if (!locA.length || !locB.length) return false;
    let widest = 0;
    for (const left of locA) for (const right of locB) {
      widest = Math.max(widest, this.distance(left, right));
    }
    return widest <= NEARBY_METERS;
  }

  async rebalanceGroupRooms() {
    // Consolidate compatible partial rooms (e.g. 2 + 3) and force a clean
    // peer-connection rebuild on every affected phone after changing membership.
    for (let pass = 0; pass < 10; pass++) {
      const rooms = [...this.roomMap("group").entries()]
        .map(([roomId, people]) => ({ roomId, people }));
      let best = null;
      for (let i = 0; i < rooms.length; i++) {
        for (let j = i + 1; j < rooms.length; j++) {
          const a = rooms[i], b = rooms[j];
          const total = a.people.length + b.people.length;
          if (total > MAX_PEOPLE || !this.canMergeRooms(a, b)) continue;
          const closest = this.closestRoomGap(a.people, b.people);
          const score = total * 1000 + (total === MAX_PEOPLE ? 500 : 0) - Math.min(closest, 1000);
          if (!best || score > best.score) best = { a, b, score };
        }
      }
      if (!best) break;
      const keepId = best.a.roomId;
      for (const person of best.b.people) {
        person.ws.serializeAttachment({ ...this.attachment(person.ws), roomId: keepId });
      }
      for (const request of this.pendingPrivate.values()) {
        if (request.roomId === best.b.roomId) request.roomId = keepId;
      }
      this.syncRoom(keepId);
      // No socket should remain in the now-empty old room.
    }
  }

  closestRoomGap(a, b) {
    const locA = a.filter(person => person.location).map(person => person.location);
    const locB = b.filter(person => person.location).map(person => person.location);
    if (!locA.length || !locB.length) return 0;
    let closest = Infinity;
    for (const left of locA) for (const right of locB) closest = Math.min(closest, this.distance(left, right));
    return closest;
  }

  createPrivateRequest(ws, targetId) {
    const sender = this.attachment(ws);
    if (sender.mode !== "group" || sender.roomScope === "custom" || !targetId || targetId === sender.id) {
      if (sender.roomScope === "custom") this.send(ws, { type: "private-error", message: "Private one-to-one requests are available in random chat." });
      return;
    }
    const targetSocket = this.members(sender.roomId).find(peer => this.attachment(peer).id === targetId);
    if (!targetSocket) {
      this.send(ws, { type: "private-error", message: "That person is no longer in your room." });
      return;
    }
    const now = Date.now();
    for (const [id, pending] of this.pendingPrivate.entries()) {
      if (now - pending.createdAt > 90_000) {
        this.pendingPrivate.delete(id);
        const fromSocket = this.sockets().find(peer => this.attachment(peer).id === pending.from);
        const toSocket = this.sockets().find(peer => this.attachment(peer).id === pending.to);
        if (fromSocket) this.send(fromSocket, { type: "private-request-expired", requestId: id });
        if (toSocket) this.send(toSocket, { type: "private-request-expired", requestId: id });
      }
    }
    const outgoingPending = [...this.pendingPrivate.values()].some(request => request.from === sender.id);
    if (outgoingPending) {
      this.send(ws, { type: "private-error", message: "You already have a private invitation waiting for a reply." });
      return;
    }
    const recent = (this.requestRate.get(sender.id) || []).filter(time => now - time < 60_000);
    if (recent.length >= 4) {
      this.send(ws, { type: "private-error", message: "Give it a moment before sending another request." });
      return;
    }
    recent.push(now);
    this.requestRate.set(sender.id, recent);
    const alreadyPending = [...this.pendingPrivate.values()].some(request =>
      (request.from === sender.id && request.to === targetId) ||
      (request.from === targetId && request.to === sender.id));
    if (alreadyPending) {
      this.send(ws, { type: "private-error", message: "A request between you is already pending." });
      return;
    }
    const requestId = crypto.randomUUID();
    const request = { id: requestId, from: sender.id, to: targetId, roomId: sender.roomId, createdAt: now };
    this.pendingPrivate.set(requestId, request);
    const target = this.attachment(targetSocket);
    this.send(targetSocket, { type: "private-request", request: { id: requestId, from: sender.id, name: sender.name } });
    this.send(ws, { type: "private-request-sent", request: { id: requestId, to: targetId, name: target.name } });
  }

  async respondPrivateRequest(ws, requestId, accept) {
    const recipient = this.attachment(ws);
    const request = this.pendingPrivate.get(requestId);
    if (!request || request.to !== recipient.id) return;
    this.pendingPrivate.delete(requestId);
    const requesterSocket = this.members(request.roomId).find(peer => this.attachment(peer).id === request.from);
    if (Date.now() - request.createdAt > 90_000 || !requesterSocket || recipient.mode !== "group" || recipient.roomId !== request.roomId) {
      this.send(ws, { type: "private-request-expired", requestId });
      if (requesterSocket) this.send(requesterSocket, { type: "private-request-expired", requestId });
      return;
    }
    if (!accept) {
      this.send(requesterSocket, { type: "private-request-declined", requestId, by: recipient.name });
      this.send(ws, { type: "private-request-closed", requestId });
      return;
    }

    const oldRoom = recipient.roomId;
    const newRoom = crypto.randomUUID();
    const requester = this.attachment(requesterSocket);
    for (const [otherRequestId, pending] of this.pendingPrivate.entries()) {
      if (otherRequestId === requestId || ![recipient.id, requester.id].some(id => pending.from === id || pending.to === id)) continue;
      this.pendingPrivate.delete(otherRequestId);
      for (const participantId of [pending.from, pending.to]) {
        const participantSocket = this.sockets().find(peer => this.attachment(peer).id === participantId);
        if (participantSocket) this.send(participantSocket, { type: "private-request-closed", requestId: otherRequestId });
      }
    }
    for (const peer of this.members(oldRoom)) {
      if (peer !== ws && peer !== requesterSocket) {
        this.send(peer, { type: "peer-left", id: recipient.id });
        this.send(peer, { type: "peer-left", id: requester.id });
      }
    }
    ws.serializeAttachment({ ...recipient, roomId: newRoom, mode: "private", roomScope: "random", customRoomId: null });
    requesterSocket.serializeAttachment({ ...requester, roomId: newRoom, mode: "private", roomScope: "random", customRoomId: null });
    this.send(ws, { type: "private-start", roomId: newRoom, peer: { id: requester.id, name: requester.name } });
    this.send(requesterSocket, { type: "private-start", roomId: newRoom, peer: { id: recipient.id, name: recipient.name } });
    this.broadcastRoomStatus(oldRoom);
    await this.rebalanceGroupRooms();
    await this.refreshBotRooms();
  }

  async endPrivateRoom(roomId) {
    const privateMembers = this.members(roomId).filter(ws => this.attachment(ws).mode === "private");
    if (!privateMembers.length) return;
    const exclude = new Set([roomId]);
    const first = this.attachment(privateMembers[0]);
    const room = this.chooseRoom(first.location, { requiredSlots: privateMembers.length, exclude });
    const newRoomId = room;
    for (const ws of privateMembers) {
      const member = this.attachment(ws);
      ws.serializeAttachment({ ...member, roomId: newRoomId, mode: "group", roomScope: "random", customRoomId: null });
    }
    const groupSockets = this.members(newRoomId);
    const allPeople = groupSockets.map(ws => this.attachment(ws));
    for (const ws of groupSockets) {
      const self = this.attachment(ws);
      this.send(ws, {
        type: "room-reset", roomId: newRoomId, mode: "group",
        peers: allPeople.filter(person => person.id !== self.id).map(person => ({ id: person.id, name: person.name }))
      });
    }
    this.broadcastRoomStatus(newRoomId);
    await this.rebalanceGroupRooms();
    await this.refreshBotRooms();
  }

  async reportMember(ws, targetId) {
    const reporter = this.attachment(ws);
    if (reporter.mode !== "group" || !targetId || targetId === reporter.id) return;
    const targetSocket = this.members(reporter.roomId).find(peer => this.attachment(peer).id === targetId);
    if (!targetSocket) return;
    const key = `${reporter.roomId}:${targetId}`;
    const now = Date.now();
    for (const [reportKey, report] of this.reports.entries()) {
      if (now > report.expires) this.reports.delete(reportKey);
    }
    let record = this.reports.get(key);
    if (!record || now > record.expires) record = { reporters: new Set(), expires: now + REPORT_WINDOW_MS };
    record.reporters.add(reporter.id);
    this.reports.set(key, record);
    this.send(ws, { type: "report-received", target: targetId, count: record.reporters.size });
    if (record.reporters.size < 2) return;

    const target = this.attachment(targetSocket);
    const strikeKey = `report-strikes:${target.id}`;
    const strikes = Math.min(3, Number(await this.ctx.storage.get(strikeKey) || 0) + 1);
    const durationMinutes = strikes === 1 ? 5 : strikes === 2 ? 10 : 15;
    const until = now + durationMinutes * 60_000;
    await this.ctx.storage.put(strikeKey, strikes);
    await this.ctx.storage.put(`cooldown:${target.id}`, until);
    this.send(targetSocket, { type: "blocked", until, durationMinutes });
    await this.remove(targetSocket, { rebalance: true });
    try { targetSocket.close(4003, "Temporary cooldown"); } catch {}
    this.reports.delete(key);
  }

  async remove(ws, { rebalance = true, offline = false } = {}) {
    const member = this.attachment(ws);
    if (!member.id || !member.roomId) return;
    const oldRoom = member.roomId;
    const wasPrivate = member.mode === "private";
    const oldRoomPeers = this.members(oldRoom).filter(peer => peer !== ws);
    if (offline && !wasPrivate && member.roomScope !== "custom") {
      const expires = Date.now() + DELIVERY_TTL_MS;
      for (const peer of oldRoomPeers) {
        const other = this.attachment(peer);
        const key = deliveryKey(member.id, other.id);
        this.deliveryEligible.set(key, expires);
        await this.ctx.storage.put(`delivery:${key}`, expires);
      }
    }
    try { ws.serializeAttachment({ id: null, name: "", roomId: null, location: null, mode: "group", roomScope: null, customRoomId: null }); } catch {}

    for (const [id, request] of this.pendingPrivate.entries()) {
      if (request.from === member.id || request.to === member.id) {
        this.pendingPrivate.delete(id);
        const otherId = request.from === member.id ? request.to : request.from;
        const otherSocket = this.sockets().find(peer => this.attachment(peer).id === otherId);
        if (otherSocket) this.send(otherSocket, { type: "private-request-expired", requestId: id });
      }
    }
    this.requestRate.delete(member.id);
    for (const peer of this.members(oldRoom)) {
      if (offline && !wasPrivate && member.roomScope !== "custom") this.send(peer, { type: "peer-offline", peer: { id: member.id, name: member.name } });
      else this.send(peer, { type: "peer-left", id: member.id });
    }
    this.broadcastRoomStatus(oldRoom);
    if (member.customRoomId) {
      await this.cleanupNamedRoom(member.customRoomId);
      await this.broadcastCustomRoomMembers(member.customRoomId);
    }

    if (wasPrivate) {
      const remaining = this.members(oldRoom).find(peer => this.attachment(peer).mode === "private");
      if (remaining) {
        const person = this.attachment(remaining);
        const roomId = this.chooseRoom(person.location, { requiredSlots: 1, exclude: new Set([oldRoom]) });
        remaining.serializeAttachment({ ...person, roomId, mode: "group", roomScope: "random", customRoomId: null });
        this.syncRoom(roomId);
      }
    }
    if (rebalance) await this.rebalanceGroupRooms();
    await this.refreshBotRooms();
    if (member.customRoomId) await this.broadcastRoomDirectory();
  }

  webSocketClose(ws) { return this.runSerial(() => this.remove(ws, { offline: true })); }
  webSocketError(ws) { return this.runSerial(() => this.remove(ws, { offline: true })); }
}
