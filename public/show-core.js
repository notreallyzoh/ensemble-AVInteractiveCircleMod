/* Shared show validation, rhythm geometry and diagnostics. No browser dependency. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ShowCore = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const finite = (v) => typeof v === 'number' && Number.isFinite(v);
  const bound = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const COLORS = { ocean: '#57b9ef', ember: '#ffae70', rose: '#ea84af', mint: '#75d7b1' };
  function defaults() {
    return { running: false, anchor: 0, revision: 0, bpm: 96, beats: 4, a: 3, b: 4,
      lead: 150, master: 0.7, brightness: 0.65, style: 'bloom', palette: 'ocean',
      path: 'orbit', autoGuard: true, blackout: false, metronome: false };
  }
  function config(input) {
    const p = input || {}, out = {};
    for (const [key, lo, hi, round] of [
      ['bpm', 30, 180, true], ['beats', 1, 8, true], ['a', 1, 12, true], ['b', 1, 12, true],
      ['lead', 40, 1000, true], ['master', 0, 1], ['brightness', 0, 1],
    ]) if (finite(p[key])) out[key] = round ? Math.round(bound(p[key], lo, hi)) : bound(p[key], lo, hi);
    for (const key of ['autoGuard', 'blackout', 'metronome']) if (typeof p[key] === 'boolean') out[key] = p[key];
    if (['bloom', 'rings', 'ribbons'].includes(p.style)) out.style = p.style;
    if (Object.hasOwn(COLORS, p.palette)) out.palette = p.palette;
    if (['orbit', 'sweep', 'still'].includes(p.path)) out.path = p.path;
    return out;
  }
  function metrics(input) {
    const p = input || {}, out = {};
    for (const [key, lo, hi] of [
      ['rttP50', 0, 1e4], ['rttP95', 0, 1e4], ['jitter', 0, 1e3], ['outputMs', 0, 2e3],
      ['slackP05', -1e4, 1e4], ['frameP95', 0, 1e4], ['fps', 0, 240],
      ['played', 0, 1e9], ['late', 0, 1e9], ['overload', 0, 1e9], ['longTasks', 0, 1e9],
      ['visualLate', 0, 1e9], ['visualCount', 0, 1e9], ['sampleRate', 0, 192000],
    ]) if (finite(p[key])) out[key] = bound(p[key], lo, hi);
    for (const key of ['hidden', 'fullscreen', 'reducedMotion']) if (typeof p[key] === 'boolean') out[key] = p[key];
    if (['running', 'suspended', 'closed', 'interrupted', 'none'].includes(p.audioState)) out.audioState = p.audioState;
    return out;
  }
  function percentile(values, p) {
    const sorted = values.filter(finite).sort((a, b) => a - b);
    return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))] : null;
  }
  function rhythm(show, lane, index) {
    const divisions = lane === 0 ? show.a : lane === 1 ? show.b : show.beats;
    return show.anchor + index * (60000 / show.bpm * show.beats / divisions);
  }
  function source(show, lane, index) {
    if (show.path === 'still') return { x: lane === 0 ? -2.5 : 2.5, y: 0 };
    const divisions = lane === 0 ? show.a : show.b;
    const phase = index / divisions + lane * 0.5;
    if (show.path === 'sweep') return { x: Math.sin(phase * Math.PI * 2) * 3.5, y: lane === 0 ? -1.5 : 1.5 };
    return { x: Math.sin(phase * Math.PI * 2) * 3, y: -Math.cos(phase * Math.PI * 2) * 3 };
  }
  function recommend(room) {
    const devices = room.devices instanceof Map ? [...room.devices.values()] : room.devices || [];
    const active = devices.filter((d) => d.instrumentReady && !d.muted);
    const host = devices.find((d) => d.id === room.hostId);
    const hostTrip = ((host && host.metrics && host.metrics.rttP95) || (host && host.rtt) || 0) / 2;
    const lead = Math.ceil(Math.max(60, ...active.map((d) => {
      const m = d.metrics || {};
      return 35 + hostTrip + (m.rttP95 || d.rtt || 0) / 2 + (m.outputMs || d.lat || 0)
        + 3 * (m.jitter || d.clockJitter || 0) + Math.max(0, -(d.trim || 0));
    })) / 10) * 10;
    const warnings = [];
    for (const d of devices) {
      const m = d.metrics || {};
      if (m.hidden) warnings.push(`${d.name}: page is in the background`);
      if (m.audioState && m.audioState !== 'running') warnings.push(`${d.name}: audio ${m.audioState}`);
      if (!d.pos) warnings.push(`${d.name}: position not set`);
      if (m.frameP95 > 40) warnings.push(`${d.name}: slow screen rendering; try Bloom or reduced motion`);
      if (m.rttP95 > 150) warnings.push(`${d.name}: network tail latency is high`);
    }
    return { leadMs: bound(lead, 40, 1000), uncappedLeadMs: lead, ready: active.length,
      notes: active.reduce((s, d) => s + ((d.metrics || {}).played || d.notePlayed || 0), 0),
      late: active.reduce((s, d) => s + ((d.metrics || {}).late || d.noteLate || 0), 0), warnings };
  }
  function report(room, now) {
    const devices = room.devices instanceof Map ? [...room.devices.values()] : room.devices || [];
    return { version: 1, generatedAt: new Date().toISOString(), clockNow: now, code: room.code,
      mode: room.playback.mode, show: room.show || defaults(), recommendation: recommend(room),
      devices: devices.map((d) => ({ id: d.id, name: d.name, isHost: d.isHost, pos: d.pos,
        muted: d.muted, volume: d.volume, trim: d.trim, ready: d.instrumentReady, awake: d.awake,
        battery: d.battery, timestampSource: d.tsrc, metrics: d.metrics || {}, lastSeen: d.lastSeen })),
      events: room.diagnosticEvents || [],
      limitation: 'Scheduling and browser rendering measurements; acoustic output and physical screen scanout are not measured.' };
  }
  function log(room, at, kind, detail) {
    room.diagnosticEvents ||= [];
    room.diagnosticEvents.push({ at, kind, detail: String(detail).slice(0, 180) });
    if (room.diagnosticEvents.length > 120) room.diagnosticEvents.shift();
  }
  return { COLORS, defaults, config, metrics, percentile, rhythm, source, recommend, report, log };
}));
