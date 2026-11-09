export { Matchmaker };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/ws") {
      if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected WebSocket", { status: 426 });
      const id = env.MATCHMAKER.idFromName("global-lobby");
      return env.MATCHMAKER.get(id).fetch(request);
    }
    return env.ASSETS.fetch(request);
  }
};

const MAX_PEOPLE = 5;
const MAX_NAME = 24;
const MAX_MESSAGE = 2048;

export class Matchmaker {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }

  async fetch(request) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ id: null, name: "", roomId: null, location: null });
    return new Response(null, { status: 101, webSocket: client });
  }

  sockets() { return this.ctx.getWebSockets(); }
  attachment(ws) { try { return ws.deserializeAttachment() || {}; } catch { return {}; } }
  send(ws, data) { try { ws.send(JSON.stringify(data)); } catch {} }
  members(roomId) { return this.sockets().filter(ws => this.attachment(ws).roomId === roomId && this.attachment(ws).id); }

  async webSocketMessage(ws, message) {
    if (typeof message !== "string" || message.length > MAX_MESSAGE) return;
    let data; try { data = JSON.parse(message); } catch { return; }
    const current = this.attachment(ws);
    if (data.type === "join") {
      if (current.id) return;
      const id = String(data.id || "").slice(0, 64);
      const name = String(data.name || "Guest").trim().slice(0, MAX_NAME) || "Guest";
      if (!/^[a-f0-9-]{20,64}$/i.test(id)) { this.send(ws, { type: "error", message: "Invalid participant ID. Refresh and try again." }); return; }
      const location = this.cleanLocation(data.location);
      const roomId = this.chooseRoom(location);
      ws.serializeAttachment({ id, name, roomId, location });
      const peers = this.members(roomId).filter(s => s !== ws).map(s => { const a=this.attachment(s); return { id:a.id, name:a.name }; });
      this.send(ws, { type: "joined", roomId, peers });
      for (const peer of this.members(roomId)) if (peer !== ws) this.send(peer, { type: "peer-joined", peer: { id, name } });
      return;
    }
    if (!current.id) return;
    if (data.type === "signal") {
      const target = String(data.to || "");
      if (target === current.id) return;
      const recipient = this.members(current.roomId).find(s => this.attachment(s).id === target);
      if (recipient) this.send(recipient, { type: "signal", from: current.id, payload: data.payload });
    }
  }

  cleanLocation(value) {
    if (!value || typeof value.lat !== "number" || typeof value.lon !== "number") return null;
    if (!Number.isFinite(value.lat) || !Number.isFinite(value.lon) || Math.abs(value.lat)>90 || Math.abs(value.lon)>180) return null;
    // Coordinates are held only in the matchmaker's live socket attachments and are never sent to other participants.
    return { lat: Math.round(value.lat*100)/100, lon: Math.round(value.lon*100)/100 };
  }

  chooseRoom(location) {
    const rooms = new Map();
    for (const ws of this.sockets()) {
      const a = this.attachment(ws); if (!a.id || !a.roomId) continue;
      if (!rooms.has(a.roomId)) rooms.set(a.roomId, []);
      rooms.get(a.roomId).push(a);
    }
    let choice = null, best = Infinity;
    for (const [roomId, people] of rooms) {
      if (people.length >= MAX_PEOPLE) continue;
      let score = 0;
      if (location && people.some(p => p.location)) {
        const located = people.filter(p => p.location);
        score = located.reduce((sum,p)=>sum+this.distance(location,p.location),0)/located.length;
      }
      // Without usable location, fill the oldest available room rather than splitting a tiny launch crowd.
      if (!location || !people.some(p=>p.location)) score = -1;
      if (score < best) { best=score; choice=roomId; }
    }
    return choice || crypto.randomUUID();
  }

  distance(a,b) {
    const rad = x => x*Math.PI/180;
    const dLat=rad(b.lat-a.lat), dLon=rad(b.lon-a.lon);
    const x=Math.sin(dLat/2)**2+Math.cos(rad(a.lat))*Math.cos(rad(b.lat))*Math.sin(dLon/2)**2;
    return 6371000*2*Math.atan2(Math.sqrt(x),Math.sqrt(1-x));
  }

  async webSocketClose(ws) { this.remove(ws); }
  async webSocketError(ws) { this.remove(ws); }
  remove(ws) {
    const a=this.attachment(ws); if(!a.id||!a.roomId)return;
    for(const peer of this.members(a.roomId)) if(peer!==ws) this.send(peer,{type:"peer-left",id:a.id});
  }
}
