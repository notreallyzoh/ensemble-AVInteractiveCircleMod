const { test } = require('node:test');
const assert = require('node:assert/strict');
const Show = require('../public/show-core.js');
const Core = require('../public/room-core.js');
test('three against four meets at the shared bar without accumulated timer drift', () => {
  const show = { ...Show.defaults(), anchor: 1000, bpm: 120, beats: 4 };
  assert.equal(Show.rhythm(show, 0, 3), 3000);
  assert.equal(Show.rhythm(show, 1, 4), 3000);
  assert.equal(Show.rhythm(show, 0, 30000), 20001000);
});
test('telemetry is bounded and reports omit private device credentials', () => {
  const m = Show.metrics({ rttP95: Infinity, fps: -10, hidden: true, key: 'secret' });
  assert.equal(m.key, undefined); assert.equal(m.rttP95, undefined); assert.equal(m.hidden, true);
  const room = Core.createRoom('TEST');
  room.devices.set('one', { id: 'one', key: 'private-token', metrics: m });
  assert.ok(!JSON.stringify(Show.report(room, 100)).includes('private-token'));
  for (let i = 0; i < 200; i++) Show.log(room, i, 'test', 'sample');
  assert.equal(room.diagnosticEvents.length, 120);
});
test('show controls and visual cues stay host-only; panic stops the sequencer', () => {
  const room = Core.createRoom('TEST'), out = [];
  const ctx = { now: () => 1000, send: (id,m) => out.push(m), broadcast: m => out.push(m) };
  const host = Core.join(room, ctx, { id:'host', key:'host-key' });
  const phone = Core.join(room, ctx, { id:'phone', key:'phone-key' });
  Core.handle(room, phone, { t:'show-run', on:true }, ctx); assert.equal(room.show.running,false);
  Core.handle(room, host, { t:'show-run', on:true }, ctx); assert.equal(room.show.running,true);
  Core.handle(room, phone, { t:'show-config', patch:{master:0} }, ctx); assert.notEqual(room.show.master,0);
  Core.handle(room, host, { t:'instrument-panic' }, ctx); assert.equal(room.show.running,false);
  const count = out.length;
  Core.handle(room, phone, { t:'visual-cue', at:1200 }, ctx); assert.equal(out.length,count);
});
