/* Ensemble — the room state machine.
 *
 * Loaded by BOTH the Node server (LAN mode) and the host's browser tab
 * (peer-to-peer mode), so the two transports cannot drift apart: one protocol,
 * one implementation. The caller supplies a context with now(), send() and
 * broadcast(); everything else is pure state.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RoomCore = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const CODE_ALPHABET = 'ACDEFGHJKLMNPQRTUVWXY34679';
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const spatial = typeof module === 'object' && module.exports ? require('./spatial.js') : Spatial;
  const showCore = typeof module === 'object' && module.exports ? require('./show-core.js') : ShowCore;

  const ShowExtensions = typeof module === 'object' && module.exports ? require('./extensions-core.js') : globalThis.ShowExtensions;

  function makeCode(rand) {
    const r = rand || ((n) => Math.floor(Math.random() * n));
    return Array.from({ length: 4 }, () => CODE_ALPHABET[r(CODE_ALPHABET.length)]).join('');
  }

  function createRoom(code) {
    return {
      code,
      hostId: null,
      devices: new Map(),
      track: null,          // { id, name, mime, size, url|null }
      syncBuffer: 700,
      instrumentSeq: 0,
      show: showCore.defaults(), diagnosticEvents: [],
      playback: { mode: 'idle', trackId: null, anchorServer: 0, anchorPos: 0, bpm: 100 },
    };
  }

  function createDevice(opts) {
    return {
      id: opts.id,
      key: opts.key || null,
      name: String(opts.name || 'Device').slice(0, 24) || 'Device',
      isHost: !!opts.isHost,
      joinedAt: opts.joinedAt,
      mode: opts.mode || 'stereo',
      volume: 1, muted: false, trim: 0,
      rtt: 0, ready: false, progress: 0, drift: 0, skew: 0,
      calib: null, battery: null, charging: false, net: null, awake: false,
      lat: null, tsrc: null,
      peerId: opts.peerId || null,     // dialable address, for the distribution tree
      parent: null, depth: 0, hopRtt: null, slack: null, buf: null, gaps: 0,
      lastSeen: opts.joinedAt,
      pos: null,            // { x, y } metres, from the acoustic room map
      posSource: null, instrumentReady: false, clockJitter: 0,
      noteLate: 0, notePlayed: 0, noteSlack: null,
      metrics: {}, visualReady: false, role: 'all', timingTrim: 0,
    };
  }

  function publicDevice(d) {
    return {
      id: d.id, name: d.name, role: d.role || 'all', timingTrim: d.timingTrim || 0, isHost: d.isHost, joinedAt: d.joinedAt,
      mode: d.mode, volume: d.volume, muted: d.muted, trim: d.trim,
      rtt: d.rtt, ready: d.ready, progress: d.progress, drift: d.drift, skew: d.skew,
      calib: d.calib, battery: d.battery, charging: d.charging, net: d.net,
      awake: d.awake, pos: d.pos, lat: d.lat, tsrc: d.tsrc,
      peerId: d.peerId, parent: d.parent, depth: d.depth, hopRtt: d.hopRtt,
      slack: d.slack, buf: d.buf, gaps: d.gaps,
      posSource: d.posSource, instrumentReady: d.instrumentReady, clockJitter: d.clockJitter,
      noteLate: d.noteLate, notePlayed: d.notePlayed, noteSlack: d.noteSlack,
      metrics: d.metrics, visualReady: d.visualReady, lastSeen: d.lastSeen,
    };
  }

  function snapshot(room) {
    return {
      code: room.code,
      hostId: room.hostId,
      devices: [...room.devices.values()].map(publicDevice),
      syncBuffer: room.syncBuffer,
      track: room.track && {
        id: room.track.id, name: room.track.name,
        size: room.track.size, url: room.track.url || null,
      },
      playback: room.playback,
      show: room.show,
    };
  }

  /** An earlier entry from the same physical device, if it is still listed. */
  function findByKey(room, key) {
    if (!key) return null;
    for (const d of room.devices.values()) if (d.key === key) return d;
    return null;
  }

  function join(room, ctx, opts) {
    // Only ever inherit from an entry the transport actually retired and handed
    // over. Looking it up here instead would let a device that is still listed —
    // the hub's own tab, say — be inherited from, producing two hosts.
    const previous = opts.inherit || null;
    const device = createDevice({
      id: opts.id,
      key: opts.key,
      name: opts.name,
      mode: opts.mode,
      peerId: opts.peerId,
      joinedAt: ctx.now(),
      isHost: room.devices.size === 0 || !!opts.forceHost || !!(previous && previous.isHost),
    });
    // Carry the old entry's setup across, so a reload does not lose this
    // speaker's role, trim or measurements.
    if (previous) {
      device.mode = previous.mode;
      device.volume = previous.volume;
      device.muted = previous.muted;
      device.trim = previous.trim;
      device.calib = previous.calib;
      device.role = previous.role || 'all'; device.timingTrim = previous.timingTrim || 0;
      device.pos = previous.pos;
      device.posSource = previous.posSource;
      device.name = previous.name;
    }
    if (device.isHost) room.hostId = device.id;
    room.devices.set(device.id, device);
    return device;
  }

  /** Remove a device; promotes the longest-connected survivor if the host left. */
  function leave(room, id) {
    const d = room.devices.get(id);
    if (!d) return null;
    room.devices.delete(id);
    if (room.hostId === id) { room.calibrationUntil = 0; room.calibrationRun = null; }
    if (room.hostId !== id || room.devices.size === 0) return null;
    const next = [...room.devices.values()].sort((a, b) => a.joinedAt - b.joinedAt)[0];
    next.isHost = true;
    room.hostId = next.id;
    return next;
  }

  function setTrack(room, track) {
    room.show.running = false;
    room.track = track;
    room.playback = { mode: 'idle', trackId: track ? track.id : null, anchorServer: 0, anchorPos: 0, bpm: room.playback.bpm };
    for (const d of room.devices.values()) { d.ready = false; d.progress = 0; d.drift = 0; }
  }

  /**
   * Apply one client message. `ctx` = { now, send(id,msg), broadcast(msg), roster() }.
   * Returns true when the roster should be republished.
   */
  function handle(room, device, msg, ctx) {
    if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return false;
    const isHost = device.id === room.hostId;
    device.lastSeen = ctx.now();

    switch (msg.t) {
      case 'sync':
        ctx.send(device.id, { t: 'sync', c: msg.c, s: ctx.now() });
        return false;

      case 'state': {
        const p = msg.patch || {};
        const num = (k, lo, hi, round) => {
          if (typeof p[k] !== 'number' || !isFinite(p[k])) return;
          device[k] = round ? Math.round(clamp(p[k], lo, hi)) : clamp(p[k], lo, hi);
        };
        num('rtt', 0, 1e5); num('progress', 0, 1); num('drift', -1e5, 1e5);
        num('skew', -1e4, 1e4); num('volume', 0, 3); num('trim', -500, 500, true);
        num('battery', 0, 100, true);
        num('lat', 0, 2000);
        num('hopRtt', 0, 10000);
        num('slack', -10000, 10000);
        num('gaps', 0, 1e9);
        num('buf', 0, 5000);
        num('clockJitter', 0, 1000); num('noteLate', 0, 1e9); num('notePlayed', 0, 1e9);
        num('noteSlack', -10000, 10000);
        if (typeof p.instrumentReady === 'boolean') device.instrumentReady = p.instrumentReady;
        if (typeof p.visualReady === 'boolean') device.visualReady = p.visualReady;
        if (p.metrics && typeof p.metrics === 'object') device.metrics = showCore.metrics(p.metrics);
        if (typeof p.peerId === 'string') device.peerId = p.peerId.slice(0, 64);
        if (typeof p.tsrc === 'string') device.tsrc = p.tsrc.slice(0, 12);
        if (typeof p.ready === 'boolean') device.ready = p.ready;
        if (typeof p.muted === 'boolean') device.muted = p.muted;
        if (typeof p.charging === 'boolean') device.charging = p.charging;
        if (typeof p.awake === 'boolean') device.awake = p.awake;
        if (typeof p.mode === 'string') device.mode = p.mode;
        if (typeof p.net === 'string') device.net = p.net.slice(0, 16);
        if (typeof p.name === 'string' && p.name.trim()) device.name = p.name.slice(0, 24);
        if (p.calib === null || typeof p.calib === 'number') device.calib = p.calib;
        // Placement is controlled by the host, not a participant's status packet.
        return true;
      }

      /* Anything the devices need to say to each other (acoustic ranging) goes
         through here, so the positioning logic lives entirely client-side. */
      case 'relay': {
        const wrapped = { t: 'relayed', from: device.id, payload: msg.payload };
        if (msg.to === '*') ctx.broadcast(wrapped, device.id);
        else if (msg.to === 'host') ctx.send(room.hostId, wrapped);
        else if (room.devices.has(msg.to)) ctx.send(msg.to, wrapped);
        return false;
      }

      default: break;
    }

    if (!isHost) return false;      // everything below is the host's privilege
    if (room.calibrationUntil > ctx.now() && ['play', 'metronome', 'live', 'instrument-mode'].includes(msg.t)) return false;

    switch (msg.t) {
      case 'show-config': {
        const patch = showCore.config(msg.patch);
        if (patch.calibrationEnabled === false) {
          room.calibrationUntil = 0; room.calibrationRun = null;
          ctx.broadcast({ t: 'timing-cancel' });
        }
        const timingChanged = ['bpm', 'beats', 'a', 'b', 'path', 'metronome', 'rolesEnabled', 'calibrationEnabled'].some((k) => k in patch && patch[k] !== room.show[k]) || (patch.gesturesEnabled === false && room.show.gesturesEnabled);
        Object.assign(room.show, patch);
        if (timingChanged) {
          room.show.anchor = ctx.now() + Math.max(600, room.show.lead + 200);
          room.show.revision++;
          ctx.broadcast({ t: 'instrument-panic', seq: ++room.instrumentSeq });
        }
        showCore.log(room, ctx.now(), 'settings', Object.keys(patch).map((k) => `${k}=${patch[k]}`).join(', '));
        return true;
      }
      case 'show-run': {
        if (msg.on && room.calibrationUntil > ctx.now()) return false;
        if (!msg.on && room.calibrationRun) { room.calibrationUntil = 0; room.calibrationRun = null; ctx.broadcast({t:'timing-cancel'}); }
        room.show.running = !!msg.on;
        room.show.anchor = ctx.now() + Math.max(600, room.show.lead + 200);
        room.show.revision++;
        room.playback = { mode: msg.on ? 'instrument' : 'idle', trackId: null, anchorServer: ctx.now(), anchorPos: 0, bpm: room.show.bpm };
        showCore.log(room, ctx.now(), msg.on ? 'show-start' : 'show-stop', `${room.show.a}:${room.show.b} at ${room.show.bpm} BPM`);
        ctx.broadcast({ t: 'instrument-panic', seq: ++room.instrumentSeq });
        ctx.broadcast({ t: 'playback', playback: room.playback, serverNow: ctx.now() });
        return true;
      }
      case 'timing-begin': {
        if (!room.show.calibrationEnabled || room.show.running || room.playback.mode !== 'idle' || typeof msg.run !== 'string' || msg.run.length > 64) return false;
        room.calibrationRun = msg.run; room.calibrationUntil = ctx.now() + 180000;
        ctx.send(device.id, { t: 'timing-ack', run: msg.run });
        return false;
      }
      case 'timing-chirp': {
        const target = room.devices.get(msg.id);
        if (room.show.rolesEnabled && target?.role === 'visual') return false;
        if (!room.show.calibrationEnabled || room.calibrationRun !== msg.run || !(room.calibrationUntil > ctx.now()) || !target?.instrumentReady || target.muted || !Number.isFinite(msg.at) || msg.at < ctx.now() + 100 || msg.at > ctx.now() + 2500) return false;
        if (room.lastChirp && ctx.now() - room.lastChirp < 900) return false;
        room.lastChirp = ctx.now();
        ctx.send(target.id, { t: 'timing-chirp', run: msg.run, at: msg.at });
        return false;
      }
      case 'timing-end':
        if (msg.run !== room.calibrationRun) return false;
        room.calibrationUntil = 0; room.calibrationRun = null;
        ctx.broadcast({ t: 'timing-cancel' });
        return false;
      case 'timing-apply': {
        if (!room.show.calibrationEnabled || room.show.running || room.playback.mode !== 'idle' || !Array.isArray(msg.results) || msg.results.length < 2 || msg.results.length > 12) return false;
        const seen = new Set();
        for (const r of msg.results) {
          if (!r || typeof r !== 'object') return false;
          const d = room.devices.get(r.id);
          if (!d || seen.has(r.id) || !Number.isFinite(r.offset) || r.offset < 0 || r.offset > 500 || !spatial.position(r.pos) || !d.pos || d.pos.x !== r.pos.x || d.pos.y !== r.pos.y) return false;
          seen.add(r.id);
        }
        for (const d of room.devices.values()) d.timingTrim = 0;
        for (const r of msg.results) room.devices.get(r.id).timingTrim = r.offset;
        showCore.log(room, ctx.now(), 'timing-calibration', `${msg.results.length} reference-microphone offsets applied`);
        return true;
      }
      case 'timing-reset':
        if (room.playback.mode !== 'idle') return false;
        for (const d of room.devices.values()) d.timingTrim = 0;
        return true;
      case 'visual-cue': {
        if (!Number.isFinite(msg.at) || msg.at < ctx.now() - 50 || msg.at > ctx.now() + 2000) return false;
        if (device.cueAt && ctx.now() - device.cueAt < 100) return false;
        device.cueAt = ctx.now();
        const gains = {};
        for (const d of room.devices.values()) if (d.visualReady && (msg.target === 'all' || msg.target === d.id)) gains[d.id] = 1;
        ctx.broadcast({ t: 'visual-cue', seq: ++room.instrumentSeq, at: msg.at, duration: 0.8,
          palette: Object.hasOwn(showCore.COLORS, msg.palette) ? msg.palette : room.show.palette, gains });
        return false;
      }
      case 'diagnostic-mark':
        if (['soundcheck-start', 'soundcheck-end'].includes(msg.kind)) showCore.log(room, ctx.now(), msg.kind, {});
        return false;
      case 'diagnostics-request':
        ctx.send(device.id, { t: 'diagnostics-report', report: showCore.report(room, ctx.now()) });
        return false;
      case 'instrument-mode': {
        room.show.running = false;
        room.playback = { mode: msg.on ? 'instrument' : 'idle', trackId: null,
          anchorServer: ctx.now(), anchorPos: 0, bpm: room.playback.bpm };
        ctx.broadcast({ t: 'instrument-panic', seq: ++room.instrumentSeq });
        ctx.broadcast({ t: 'playback', playback: room.playback, serverNow: ctx.now() });
        return true;
      }
      case 'instrument-note': {
        if (room.playback.mode !== 'instrument' || room.calibrationUntil > ctx.now()) return false;
        if (msg.replay && !room.show.gesturesEnabled) return false;
        const event = spatial.note(msg);
        if (!event) return false;
        if (event.at < ctx.now() + 5 || event.at > ctx.now() + 1500) {
          ctx.send(device.id, { t: 'instrument-rejected', reason: 'deadline — increase gesture lead' });
          return false;
        }
        // Bound work on every phone even if a controller floods the room.
        if (!device.noteWindow || ctx.now() - device.noteWindow.at >= 1000) device.noteWindow = { at: ctx.now(), count: 0 };
        if (++device.noteWindow.count > 40) return false;
        const participants = [...room.devices.values()];
        const routed = d => !room.show.rolesEnabled || ShowExtensions.accepts(d.role, msg.lane);
        event.gains = spatial.gains(participants.filter(routed), event.pos, event.spread);
        if (room.show.rolesEnabled) event.parts = Object.fromEntries(participants.filter(d => d.role === 'bass').map(d => [d.id, { midi: Math.max(36, event.midi - 12), voice: 'sine' }]));
        event.visualGains = spatial.gains(participants.filter(d => routed(d) || d.role === 'visual').map((d) => ({ ...d, muted: false, instrumentReady: d.visualReady })), event.pos, event.spread);
        event.palette = Object.hasOwn(showCore.COLORS, msg.palette) ? msg.palette : room.show.palette;
        event.lane = Number.isInteger(msg.lane) ? Math.max(0, Math.min(2, msg.lane)) : null;
        ctx.broadcast({ ...event, t: 'instrument-note', seq: ++room.instrumentSeq });
        return false; // No full roster broadcast on the performance path.
      }
      case 'instrument-panic':
        if (room.calibrationRun) { room.calibrationUntil = 0; room.calibrationRun = null; ctx.broadcast({t:'timing-cancel'}); }
        room.show.running = false;
        room.show.revision++;
        ctx.broadcast({ t: 'instrument-panic', seq: ++room.instrumentSeq });
        return true;
      case 'play': {
        room.show.running = false;
        if (!room.track) return false;
        room.playback = {
          mode: 'playing', trackId: room.track.id,
          anchorServer: ctx.now() + room.syncBuffer,
          anchorPos: Math.max(0, Number(msg.position) || 0),
          bpm: room.playback.bpm,
        };
        ctx.broadcast({ t: 'playback', playback: room.playback, serverNow: ctx.now() });
        return true;
      }
      case 'pause': {
        room.show.running = false;
        const pos = Number(msg.position);
        room.playback = {
          mode: 'paused', trackId: room.playback.trackId, anchorServer: ctx.now(),
          anchorPos: isFinite(pos) ? Math.max(0, pos) : room.playback.anchorPos,
          bpm: room.playback.bpm,
        };
        ctx.broadcast({ t: 'playback', playback: room.playback, serverNow: ctx.now() });
        return true;
      }
      case 'seek': {
        const playing = room.playback.mode === 'playing';
        room.playback = {
          mode: playing ? 'playing' : 'paused', trackId: room.playback.trackId,
          anchorServer: ctx.now() + (playing ? room.syncBuffer : 0),
          anchorPos: Math.max(0, Number(msg.position) || 0),
          bpm: room.playback.bpm,
        };
        ctx.broadcast({ t: 'playback', playback: room.playback, serverNow: ctx.now() });
        return true;
      }
      case 'live': {
        room.show.running = false;
        room.playback = msg.on
          ? {
              mode: 'live', trackId: null, anchorServer: ctx.now(), anchorPos: 0,
              bpm: room.playback.bpm, rate: Number(msg.rate) || 48000,
              channels: Number(msg.channels) || 2,
              liveBufferMs: clamp(Number(msg.bufferMs) || 700, 120, 3000),
              source: device.id,
            }
          : { mode: 'idle', trackId: room.track ? room.track.id : null, anchorServer: ctx.now(), anchorPos: 0, bpm: room.playback.bpm };
        ctx.broadcast({ t: 'playback', playback: room.playback, serverNow: ctx.now() });
        return true;
      }
      case 'metronome': {
        room.show.running = false;
        room.playback = msg.on
          ? { mode: 'metronome', trackId: null, anchorServer: ctx.now() + room.syncBuffer, anchorPos: 0, bpm: clamp(Number(msg.bpm) || 100, 30, 240) }
          : { mode: 'idle', trackId: room.track ? room.track.id : null, anchorServer: ctx.now(), anchorPos: 0, bpm: room.playback.bpm };
        ctx.broadcast({ t: 'playback', playback: room.playback, serverNow: ctx.now() });
        return true;
      }
      case 'buffer': {
        room.syncBuffer = clamp(Number(msg.ms) || 700, 150, 3000);
        return true;
      }
      case 'resync': {
        const pb = room.playback;
        if (pb.mode === 'playing') {
          const pos = pb.anchorPos + (ctx.now() - pb.anchorServer) / 1000;
          room.playback = Object.assign({}, pb, { anchorServer: ctx.now() + room.syncBuffer, anchorPos: Math.max(0, pos) });
        } else if (pb.mode === 'metronome') {
          room.playback = Object.assign({}, pb, { anchorServer: ctx.now() + room.syncBuffer });
        } else return false;
        ctx.broadcast({ t: 'playback', playback: room.playback, serverNow: ctx.now(), hard: true });
        return true;
      }
      case 'device': {
        const target = room.devices.get(msg.id);
        if (!target) return false;
        const patch = {};
        if (ShowExtensions.ROLES.includes(msg.role)) target.role = msg.role;
        if (msg.pos === null || spatial.position(msg.pos)) {
          target.pos = spatial.position(msg.pos);
          target.posSource = target.pos ? (msg.posSource === 'acoustic' ? 'acoustic' : 'manual') : null;
          patch.pos = target.pos;
        }
        if (typeof msg.mode === 'string') { target.mode = msg.mode; patch.mode = msg.mode; }
        if (typeof msg.volume === 'number') { target.volume = clamp(msg.volume, 0, 3); patch.volume = target.volume; }
        if (typeof msg.muted === 'boolean') { target.muted = msg.muted; patch.muted = msg.muted; }
        if (typeof msg.trim === 'number') { target.trim = Math.round(clamp(msg.trim, -500, 500)); patch.trim = target.trim; }
        ctx.send(target.id, { t: 'apply', patch });
        return true;
      }
      case 'kick': {
        if (msg.id === device.id || !room.devices.has(msg.id)) return false;
        ctx.send(msg.id, { t: 'kicked' });
        ctx.drop(msg.id);
        return true;
      }
      case 'makeHost': {
        const target = room.devices.get(msg.id);
        if (!target) return false;
        device.isHost = false;
        target.isHost = true;
        room.hostId = target.id;
        ctx.broadcast({ t: 'hostChanged', hostId: target.id });
        return true;
      }
      default: return false;
    }
  }

  /** Devices that have said nothing for a while are gone, whatever the socket thinks. */
  function reap(room, nowMs, maxSilenceMs) {
    const dead = [];
    for (const d of room.devices.values()) {
      if (nowMs - d.lastSeen > maxSilenceMs) dead.push(d.id);
    }
    return dead;
  }

  return { CODE_ALPHABET, makeCode, reap, findByKey, createRoom, createDevice, publicDevice, snapshot, join, leave, setTrack, handle };
}));
