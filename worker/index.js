import { DurableObject } from 'cloudflare:workers';
import Core from '../public/room-core.js';
import Show from '../public/show-core.js';

const json = (data, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
async function authorized(request, secret) {
  if (!secret) return false;
  const supplied = (request.headers.get('Authorization') || '').replace(/^Bearer /, '');
  const digest = async (s) => crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return crypto.subtle.timingSafeEqual(await digest(supplied), await digest(secret));
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/info') return json({ cloud: true, addresses: [], serverNow: Date.now() });
    if (url.pathname === '/api/rooms' && request.method === 'POST') {
      if (Number(request.headers.get('Content-Length')) > 1024) return json({ error: 'Too large' }, 413);
      let body; try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
      if (typeof body.key !== 'string' || body.key.length < 16 || body.key.length > 128) return json({ error: 'Invalid key' }, 400);
      for (let i = 0; i < 8; i++) {
        const code = Core.makeCode(n => crypto.getRandomValues(new Uint32Array(1))[0] % n);
        if (await env.ROOMS.getByName(code).initialize(code, body.key)) return json({ code });
      }
      return json({ error: 'Retry room creation' }, 503);
    }
    const code = (url.searchParams.get('room') || url.pathname.split('/')[3] || '').toUpperCase();
    if (['/ws', '/api/upload', '/api/diagnostics'].includes(url.pathname) || url.pathname.startsWith('/api/track/')) {
      if (!/^[A-Z0-9]{4}$/.test(code)) return json({ error: 'Room code required' }, 400);
      if (url.pathname === '/api/diagnostics' && !await authorized(request, env.DIAGNOSTICS_KEY)) return json({ error: 'Unauthorized' }, 401);
      return env.ROOMS.getByName(code).fetch(request);
    }
    return env.ASSETS.fetch(request);
  }
};

export class StageRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    ctx.blockConcurrencyWhile(async () => {
      const saved = await ctx.storage.get('room');
      this.room = saved ? { ...saved, devices: new Map() } : null;
      if (this.room) for (const ws of ctx.getWebSockets()) {
        const d = ws.deserializeAttachment(); if (d?.id) this.room.devices.set(d.id, d);
      }
    });
  }
  async initialize(code, key) {
    if (this.room) return false;
    this.room = { ...Core.createRoom(code), ownerKey: key };
    await this.save(); await this.ctx.storage.setAlarm(Date.now() + 86400000);
    return true;
  }
  async save() {
    const { devices, ...state } = this.room;
    for (const ws of this.ctx.getWebSockets()) {
      const id = ws.deserializeAttachment()?.id;
      if (devices.has(id)) ws.serializeAttachment(devices.get(id));
    }
    await this.ctx.storage.put('room', state);
  }
  context(out) {
    return { now: () => Date.now(), send: (id, m) => out.push({ id, m }), broadcast: (m, except) => out.push({ m, except }),
      drop: id => { for (const ws of this.ctx.getWebSockets()) if (ws.deserializeAttachment()?.id === id) ws.close(1000, 'Removed'); Core.leave(this.room, id); } };
  }
  flush(out) {
    for (const item of out) for (const ws of this.ctx.getWebSockets()) {
      const id = ws.deserializeAttachment()?.id;
      if (id && (!item.id || item.id === id) && id !== item.except) try { ws.send(JSON.stringify(item.m)); } catch {}
    }
  }
  roster(out) { out.push({ m: { t: 'roster', room: Core.snapshot(this.room), serverNow: Date.now() } }); }
  async fetch(request) {
    if (!this.room) return json({ error: 'Room not found' }, 404);
    const url = new URL(request.url);
    if (url.pathname === '/api/diagnostics') return json(Show.report(this.room, Date.now()));
    if (url.pathname === '/ws') {
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return json({ error: 'WebSocket required' }, 426);
      if (this.ctx.getWebSockets().length >= 64) return json({ error: 'Room full' }, 429);
      const [client, server] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(server); server.serializeAttachment({ pending: true });
      return new Response(null, { status: 101, webSocket: client });
    }
    if (url.pathname === '/api/upload' && request.method === 'POST') {
      const host = this.room.devices.get(this.room.hostId);
      if (!host || !await authorized(request, host.key)) return json({ error: 'Host required' }, 403);
      const reader = request.body?.getReader(); if (!reader) return json({ error: 'Empty upload' }, 400);
      const chunks = []; let size = 0;
      for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length;
        if (size > 16 * 1024 * 1024) { await reader.cancel(); return json({ error: 'Cloud tracks are limited to 16 MB' }, 413); } chunks.push(value); }
      const data = new Uint8Array(size); let offset = 0; for (const c of chunks) { data.set(c, offset); offset += c.length; }
      const id = crypto.randomUUID();
      await this.ctx.storage.transaction(async txn => {
        const old = await txn.list({ prefix: 'track:' }); await txn.delete([...old.keys()]);
        for (let i = 0; i < size; i += 64000) await txn.put(`track:${id}:${i}`, data.slice(i, i + 64000));
      });
      Core.setTrack(this.room, { id, size, name: (url.searchParams.get('name') || 'Track').slice(0, 200), mime: 'application/octet-stream', url: `/api/track/${this.room.code}/${id}` });
      await this.save(); const out = []; this.roster(out); this.flush(out); return json({ ok: true });
    }
    if (url.pathname.startsWith('/api/track/')) {
      const track = this.room.track;
      if (!track || url.pathname.split('/')[4] !== track.id) return json({ error: 'Track not found' }, 404);
      const parts = await this.ctx.storage.list({ prefix: `track:${track.id}:` });
      const data = new Uint8Array(track.size); for (const [key, part] of parts) data.set(part, Number(key.split(':')[2]));
      return new Response(data, { headers: { 'Content-Type': track.mime, 'Cache-Control': 'private, max-age=3600' } });
    }
    return json({ error: 'Not found' }, 404);
  }
  async webSocketMessage(ws, message) {
    const attachment = ws.deserializeAttachment();
    if (typeof message !== 'string') {
      if (attachment?.id === this.room.hostId && message.byteLength <= 65536) for (const other of this.ctx.getWebSockets()) if (other !== ws) other.send(message);
      return;
    }
    if (message.length > 65536) { ws.close(1009); return; }
    let msg; try { msg = JSON.parse(message); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    const out = [], ctx = this.context(out);
    if (!attachment?.id) {
      if (msg.t !== 'join') return;
      if (typeof msg.key !== 'string' || msg.key.length < 16 || msg.key.length > 128) { ws.close(1008); return; }
      if (!this.room.devices.size && !await authorized(new Request('https://local', { headers: { Authorization: `Bearer ${msg.key}` } }), this.room.ownerKey)) { ws.send(JSON.stringify({ t: 'error', message: 'The host must join first' })); ws.close(1008); return; }
      const stale = Core.findByKey(this.room, msg.key);
      if (stale) { this.room.devices.delete(stale.id); for (const old of this.ctx.getWebSockets()) if (old !== ws && old.deserializeAttachment()?.id === stale.id) old.close(1000, 'Reconnected'); }
      const d = Core.join(this.room, ctx, { id: crypto.randomUUID().slice(0, 12), key: msg.key, name: msg.name, mode: msg.mode, inherit: stale });
      ws.serializeAttachment(d);
      out.push({ id: d.id, m: { t: 'welcome', id: d.id, serverNow: Date.now(), room: Core.snapshot(this.room) } }); this.roster(out);
    } else {
      const d = this.room.devices.get(attachment.id); if (!d) return;
      if (Core.handle(this.room, d, msg, ctx)) this.roster(out);
      if (msg.t === 'sync') { this.flush(out); return; }
    }
    await this.save(); this.flush(out);
  }
  async webSocketClose(ws) {
    const id = ws.deserializeAttachment()?.id;
    if (!this.room || !this.room.devices.has(id)) return;
    const wasHost = id === this.room.hostId;
    const promoted = Core.leave(this.room, id);
    if (promoted) this.room.ownerKey = promoted.key;
    const out = [];
    if (wasHost) { this.room.show.running = false; this.room.show.revision++; out.push({ m: { t: 'instrument-panic', seq: ++this.room.instrumentSeq } }); }
    await this.save(); this.roster(out); this.flush(out);
    try { ws.close(); } catch {}
  }
  async webSocketError(ws) { await this.webSocketClose(ws); }
  async alarm() {
    if (this.ctx.getWebSockets().length) { await this.ctx.storage.setAlarm(Date.now() + 86400000); return; }
    await this.ctx.storage.deleteAll(); this.room = null;
  }
}
