const { test } = require('node:test');
const assert = require('node:assert/strict');
const Spatial = require('../public/spatial.js');
const Room = require('../public/room-core.js');
const speaker = (id, x, y, extra = {}) => ({ id, pos: { x, y }, instrumentReady: true, ...extra });

test('equal power at the midpoint; sound follows the source to a nearby phone', () => {
  const nodes = [speaker('l', -2, 0), speaker('r', 2, 0)];
  const middle = Spatial.gains(nodes, { x: 0, y: 0 }, 1);
  assert.ok(Math.abs(middle.l - Math.SQRT1_2) < 1e-10);
  assert.equal(middle.l, middle.r);
  const near = Spatial.gains(nodes, { x: -2, y: 0 }, 1);
  assert.ok(near.l > 0.99 && near.r < 0.001);
  assert.ok(Math.abs(near.l ** 2 + near.r ** 2 - 1) < 1e-12);
});
test('mute, locked audio and unplaced speakers do not steal gain; remote sources stay finite', () => {
  const nodes = [speaker('a', 0, 0), speaker('b', 0, 0, { muted: true }), speaker('c', 0, 0, { instrumentReady: false }), { id: 'd', instrumentReady: true }];
  assert.deepEqual(Spatial.gains(nodes, { x: 50, y: 50 }, 0.3), { a: 1 });
  assert.deepEqual(Spatial.gains([], { x: 0, y: 0 }, 1), {});
});
test('power normalization holds for many irregular arrangements', () => {
  for (let n = 1; n < 40; n++) {
    const nodes = Array.from({ length: n }, (_, i) => speaker(String(i), Math.sin(i * 1.7) * 10, Math.cos(i) * 8));
    for (const spread of [0.3, 1, 6, 12]) {
      const gains = Object.values(Spatial.gains(nodes, { x: -10, y: 15 }, spread));
      assert.ok(gains.every((g) => Number.isFinite(g) && g >= 0 && g <= 1));
      assert.ok(Math.abs(gains.reduce((s, g) => s + g * g, 0) - 1) < 1e-10);
    }
  }
});
test('position and note validation reject nonfinite and malformed input', () => {
  for (const p of [null, { x: NaN, y: 2 }, { x: 0 }, { x: 0, y: Infinity }, { x: '0', y: 0 }]) assert.equal(Spatial.position(p), null);
  assert.deepEqual(Spatial.position({ x: 100, y: -200 }), { x: 50, y: -50 });
  assert.equal(Spatial.note({ at: 100 }), null);
});
test('late events are dropped and timing budget accounts for slow output and early trim', () => {
  assert.equal(Spatial.scheduleDecision(10, 9.999).play, false);
  assert.equal(Spatial.scheduleDecision(10, 10.002).play, false);
  assert.equal(Spatial.scheduleDecision(10, 10.02).play, true);
  assert.equal(Spatial.scheduleDecision(0, Infinity).play, false);
  const nodes = [speaker('host', 0, 0, { rtt: 10 }), speaker('phone', 1, 1, { rtt: 30, lat: 100, clockJitter: 5, trim: -50 })];
  assert.ok(Spatial.recommendedLead(nodes, 'host') >= 210);
});

function roomFixture() {
  const room = Room.createRoom('TEST'), sent = [], broadcasts = [];
  const ctx = { now: () => 1000, send: (id, msg) => sent.push({ id, msg }), broadcast: (m) => broadcasts.push(m), drop: () => {} };
  const host = Room.join(room, ctx, { id: 'h', name: 'Host' });
  const guest = Room.join(room, ctx, { id: 'g', name: 'Phone' });
  return { room, host, guest, ctx, sent, broadcasts };
}
const event = () => ({ t: 'instrument-note', at: 1120, pos: { x: 0, y: 0 }, spread: 1.5, midi: 62, duration: 0.4, velocity: 0.65, voice: 'sine' });

test('only the host can start, place or play; positions reach the room snapshot', () => {
  const { room, host, guest, ctx, broadcasts } = roomFixture();
  Room.handle(room, guest, { t: 'instrument-mode', on: true }, ctx);
  assert.equal(room.playback.mode, 'idle');
  Room.handle(room, guest, { t: 'device', id: 'h', pos: { x: 10, y: 10 } }, ctx);
  assert.equal(host.pos, null);
  Room.handle(room, guest, { t: 'state', patch: { pos: { x: 9, y: 9 } } }, ctx);
  assert.equal(guest.pos, null);
  Room.handle(room, host, { t: 'device', id: 'g', pos: { x: 2, y: -3 }, posSource: 'acoustic' }, ctx);
  const snapshot = Room.snapshot(room).devices.find((d) => d.id === 'g');
  assert.deepEqual(snapshot.pos, { x: 2, y: -3 }); assert.equal(snapshot.posSource, 'acoustic');
  Room.handle(room, host, { t: 'instrument-mode', on: true }, ctx);
  const before = broadcasts.length;
  Room.handle(room, guest, event(), ctx);
  assert.equal(broadcasts.length, before);
});
test('one validated event carries identical timestamp and authoritative gains to every speaker', () => {
  const { room, host, guest, ctx, broadcasts } = roomFixture();
  host.pos = { x: -2, y: 0 }; guest.pos = { x: 2, y: 0 };
  host.instrumentReady = guest.instrumentReady = true;
  Room.handle(room, host, { t: 'instrument-mode', on: true }, ctx);
  const changed = Room.handle(room, host, { ...event(), gains: { h: 999 } }, ctx);
  assert.equal(changed, false);
  const note = broadcasts.at(-1);
  assert.equal(note.at, 1120); assert.equal(note.t, 'instrument-note');
  assert.ok(Math.abs(note.gains.h - Math.SQRT1_2) < 1e-10);
  assert.equal(note.gains.h, note.gains.g);
  assert.equal(note.seq, 2);
  Room.handle(room, host, { t: 'instrument-panic' }, ctx);
  assert.equal(broadcasts.at(-1).seq, 3);
});
test('stale, overly future, malformed and excess events are rejected', () => {
  const { room, host, ctx, broadcasts } = roomFixture();
  Room.handle(room, host, { t: 'instrument-mode', on: true }, ctx);
  const start = broadcasts.length;
  for (const bad of [{ at: 999 }, { at: 3000 }, { voice: 'bad' }, { velocity: NaN }, { pos: { x: 0, y: null } }]) Room.handle(room, host, { ...event(), ...bad }, ctx);
  assert.equal(broadcasts.length, start);
  for (let i = 0; i < 60; i++) Room.handle(room, host, event(), ctx);
  assert.equal(broadcasts.length - start, 40);
  Room.handle(room, host, { t: 'instrument-mode', on: false }, ctx);
  const stopped = broadcasts.length;
  Room.handle(room, host, event(), ctx);
  assert.equal(broadcasts.length, stopped);
});
