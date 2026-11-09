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
    return env.ASSETS.fetch(request);
  }
};

const MAX_PEOPLE = 5;
const MAX_NAME = 24;
const MAX_SIGNAL_MESSAGE = 16_384;
const NEARBY_METERS = 100;
const REPORT_WINDOW_MS = 10 * 60_000;
const COOLDOWN_MS = 5 * 60_000;

export class Matchmaker {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.pendingPrivate = new Map();
    this.requestRate = new Map();
    this.reports = new Map();
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
      if (!member.id || !member.roomId || member.mode !== mode) continue;
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
      ws.serializeAttachment({ id, name, roomId, location, mode: "group" });
      const peers = this.peerList(roomId, id);
      this.send(ws, { type: "joined", roomId, peers });
      for (const peer of this.members(roomId)) {
        if (peer !== ws) this.send(peer, { type: "peer-joined", peer: { id, name } });
      }
      this.broadcastRoomStatus(roomId);
      await this.rebalanceGroupRooms();
      return;
    }

    if (!current.id) return;

    if (data.type === "signal") {
      const target = String(data.to || "");
      if (!target || target === current.id || !data.payload || typeof data.payload !== "object") return;
      const recipient = this.members(current.roomId).find(peer => this.attachment(peer).id === target);
      if (recipient) this.send(recipient, { type: "signal", from: current.id, payload: data.payload });
      return;
    }

    if (data.type === "rename") {
      const name = String(data.name || "").trim().slice(0, MAX_NAME);
      if (!name) return;
      ws.serializeAttachment({ ...current, name });
      for (const peer of this.members(current.roomId)) {
        if (peer !== ws) this.send(peer, { type: "peer-renamed", id: current.id, name });
      }
      return;
    }

    if (data.type === "location-update") {
      const location = this.cleanLocation(data.location);
      if (!location) return;
      ws.serializeAttachment({ ...current, location });
      this.broadcastRoomStatus(current.roomId);
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
    if (sender.mode !== "group" || !targetId || targetId === sender.id) return;
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
    for (const peer of this.members(oldRoom)) {
      if (peer !== ws && peer !== requesterSocket) {
        this.send(peer, { type: "peer-left", id: recipient.id });
        this.send(peer, { type: "peer-left", id: requester.id });
      }
    }
    ws.serializeAttachment({ ...recipient, roomId: newRoom, mode: "private" });
    requesterSocket.serializeAttachment({ ...requester, roomId: newRoom, mode: "private" });
    this.send(ws, { type: "private-start", roomId: newRoom, peer: { id: requester.id, name: requester.name } });
    this.send(requesterSocket, { type: "private-start", roomId: newRoom, peer: { id: recipient.id, name: recipient.name } });
    this.broadcastRoomStatus(oldRoom);
    await this.rebalanceGroupRooms();
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
      ws.serializeAttachment({ ...member, roomId: newRoomId, mode: "group" });
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
  }

  async reportMember(ws, targetId) {
    const reporter = this.attachment(ws);
    if (reporter.mode !== "group" || !targetId || targetId === reporter.id) return;
    const targetSocket = this.members(reporter.roomId).find(peer => this.attachment(peer).id === targetId);
    if (!targetSocket) return;
    const key = targetId;
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
    const until = now + COOLDOWN_MS;
    await this.ctx.storage.put(`cooldown:${target.id}`, until);
    this.send(targetSocket, { type: "blocked", until });
    await this.remove(targetSocket, { rebalance: true });
    try { targetSocket.close(4003, "Temporary cooldown"); } catch {}
    this.reports.delete(key);
  }

  async remove(ws, { rebalance = true } = {}) {
    const member = this.attachment(ws);
    if (!member.id || !member.roomId) return;
    const oldRoom = member.roomId;
    const wasPrivate = member.mode === "private";
    try { ws.serializeAttachment({ id: null, name: "", roomId: null, location: null, mode: "group" }); } catch {}

    for (const [id, request] of this.pendingPrivate.entries()) {
      if (request.from === member.id || request.to === member.id) {
        this.pendingPrivate.delete(id);
        const otherId = request.from === member.id ? request.to : request.from;
        const otherSocket = this.sockets().find(peer => this.attachment(peer).id === otherId);
        if (otherSocket) this.send(otherSocket, { type: "private-request-expired", requestId: id });
      }
    }
    this.requestRate.delete(member.id);
    for (const peer of this.members(oldRoom)) this.send(peer, { type: "peer-left", id: member.id });
    this.broadcastRoomStatus(oldRoom);

    if (wasPrivate) {
      const remaining = this.members(oldRoom).find(peer => this.attachment(peer).mode === "private");
      if (remaining) {
        const person = this.attachment(remaining);
        const roomId = this.chooseRoom(person.location, { requiredSlots: 1, exclude: new Set([oldRoom]) });
        remaining.serializeAttachment({ ...person, roomId, mode: "group" });
        this.syncRoom(roomId);
      }
    }
    if (rebalance) await this.rebalanceGroupRooms();
  }

  webSocketClose(ws) { return this.runSerial(() => this.remove(ws)); }
  webSocketError(ws) { return this.runSerial(() => this.remove(ws)); }
}
