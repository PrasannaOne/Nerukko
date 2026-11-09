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

export class Matchmaker {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch() {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({
      id: null,
      name: "",
      roomId: null,
      location: null
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  sockets() {
    return this.ctx.getWebSockets();
  }

  attachment(ws) {
    try {
      return ws.deserializeAttachment() || {};
    } catch {
      return {};
    }
  }

  send(ws, data) {
    try {
      ws.send(JSON.stringify(data));
    } catch {}
  }

  members(roomId) {
    return this.sockets().filter(ws => {
      const member = this.attachment(ws);
      return member.id && member.roomId === roomId;
    });
  }

  roomMap() {
    const rooms = new Map();
    for (const ws of this.sockets()) {
      const member = this.attachment(ws);
      if (!member.id || !member.roomId) continue;
      if (!rooms.has(member.roomId)) rooms.set(member.roomId, []);
      rooms.get(member.roomId).push(member);
    }
    return rooms;
  }

  async webSocketMessage(ws, message) {
    if (typeof message !== "string" || message.length > MAX_SIGNAL_MESSAGE) return;

    let data;
    try {
      data = JSON.parse(message);
    } catch {
      return;
    }

    const current = this.attachment(ws);

    if (data.type === "join") {
      if (current.id) return;

      const id = String(data.id || "").slice(0, 64);
      const name = String(data.name || "Guest").trim().slice(0, MAX_NAME) || "Guest";
      if (!/^[a-f0-9-]{20,64}$/i.test(id)) {
        this.send(ws, { type: "error", message: "Please refresh and try again." });
        return;
      }

      // A participant ID can have only one active session. This also cleans up stale tabs.
      for (const other of this.sockets()) {
        if (other === ws) continue;
        const member = this.attachment(other);
        if (member.id === id) {
          this.remove(other);
          try { other.close(4000, "Session replaced"); } catch {}
        }
      }

      const location = this.cleanLocation(data.location);
      const roomId = this.chooseRoom(location);
      ws.serializeAttachment({ id, name, roomId, location });

      const peers = this.members(roomId)
        .filter(memberSocket => memberSocket !== ws)
        .map(memberSocket => {
          const member = this.attachment(memberSocket);
          return { id: member.id, name: member.name };
        });

      this.send(ws, { type: "joined", roomId, peers });
      for (const peer of this.members(roomId)) {
        if (peer !== ws) {
          this.send(peer, { type: "peer-joined", peer: { id, name } });
        }
      }
      this.broadcastRoomStatus(roomId);
      return;
    }

    if (!current.id) return;

    if (data.type === "signal") {
      const target = String(data.to || "");
      if (!target || target === current.id || !data.payload || typeof data.payload !== "object") return;

      const recipient = this.members(current.roomId)
        .find(peer => this.attachment(peer).id === target);
      if (recipient) {
        this.send(recipient, {
          type: "signal",
          from: current.id,
          payload: data.payload
        });
      }
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

    if (data.type === "ping") {
      this.send(ws, { type: "pong" });
      return;
    }

    if (data.type === "leave") {
      this.remove(ws);
      try { ws.close(1000, "Left room"); } catch {}
    }
  }

  cleanLocation(value) {
    if (!value || typeof value.lat !== "number" || typeof value.lon !== "number") return null;
    if (!Number.isFinite(value.lat) || !Number.isFinite(value.lon)) return null;
    if (Math.abs(value.lat) > 90 || Math.abs(value.lon) > 180) return null;

    // Coordinates remain inside live server-side socket attachments. They are never sent to peers.
    return {
      lat: Math.round(value.lat * 10_000) / 10_000,
      lon: Math.round(value.lon * 10_000) / 10_000
    };
  }

  chooseRoom(location) {
    const rooms = [...this.roomMap().entries()]
      .map(([roomId, people]) => ({ roomId, people }))
      .filter(room => room.people.length < MAX_PEOPLE);

    if (!rooms.length) return crypto.randomUUID();

    // Users without location first join a room made entirely of other no-location users.
    if (!location) {
      const noLocationRooms = rooms.filter(room => room.people.every(person => !person.location));
      const pool = noLocationRooms.length ? noLocationRooms : rooms;
      // Fill an existing conversation before opening another room.
      pool.sort((a, b) => b.people.length - a.people.length);
      return pool[0].roomId;
    }

    // Located users first prefer rooms where everyone has opted into approximate matching.
    const fullyLocated = rooms.filter(room => room.people.every(person => person.location));
    const partlyLocated = rooms.filter(room => room.people.some(person => person.location));
    const pool = fullyLocated.length ? fullyLocated : (partlyLocated.length ? partlyLocated : rooms);

    let bestRoom = pool[0];
    let bestDistance = Infinity;
    for (const room of pool) {
      const locatedPeople = room.people.filter(person => person.location);
      const average = locatedPeople.length
        ? locatedPeople.reduce((sum, person) => sum + this.distance(location, person.location), 0) / locatedPeople.length
        : Infinity;
      if (average < bestDistance) {
        bestDistance = average;
        bestRoom = room;
      }
    }
    return bestRoom.roomId;
  }

  roomStatus(roomId) {
    const members = this.members(roomId).map(ws => this.attachment(ws));
    if (members.length < 2) {
      return {
        kind: "waiting",
        label: "Waiting",
        detail: "Your circle is waiting for others to join."
      };
    }
    if (members.some(member => !member.location)) {
      return {
        kind: "open",
        label: "Open circle",
        detail: "This room wasn't matched using everyone's location."
      };
    }

    let widestGap = 0;
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        widestGap = Math.max(widestGap, this.distance(members[i].location, members[j].location));
      }
    }

    if (widestGap <= NEARBY_METERS) {
      return {
        kind: "nearby",
        label: "Nearby",
        detail: "Matched using approximate location."
      };
    }

    return {
      kind: "wider",
      label: "Wider circle",
      detail: "No closer room had space, so the match expanded."
    };
  }

  broadcastRoomStatus(roomId) {
    const status = this.roomStatus(roomId);
    for (const ws of this.members(roomId)) this.send(ws, { type: "room-status", status });
  }

  distance(a, b) {
    const rad = value => value * Math.PI / 180;
    const dLat = rad(b.lat - a.lat);
    const dLon = rad(b.lon - a.lon);
    const x =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 6_371_000 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
  }

  async webSocketClose(ws) {
    this.remove(ws);
  }

  async webSocketError(ws) {
    this.remove(ws);
  }

  remove(ws) {
    const member = this.attachment(ws);
    if (!member.id || !member.roomId) return;

    // Clear first so repeated close/error events cannot send duplicate departures.
    try { ws.serializeAttachment({ id: null, name: "", roomId: null, location: null }); } catch {}
    for (const peer of this.members(member.roomId)) {
      this.send(peer, { type: "peer-left", id: member.id });
    }
    this.broadcastRoomStatus(member.roomId);
  }
}
