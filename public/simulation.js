'use strict';
// Rehearsal uses the real room protocol entirely in memory. No sockets or peers.
const Simulation = {
  active: false, room: null, draft: null, draftApplied: false, assigned: new Map(),
  resetClock() { Object.assign(Clock, { samples: [], offset: 0, at: performance.now(), skew: 0, rtt: 0, ready: false }); },
  deliver(message) {
    const room = this.room;
    queueMicrotask(() => { if (this.active && this.room === room) handleMessage(structuredClone(message)); });
  },
  ctx() { return { now: () => performance.now(),
    send: (id, message) => { if (id === this.room.hostId) this.deliver(message); },
    broadcast: message => this.deliver(message),
    drop: id => { this.room.devices.delete(id); },
  }; },
  roster() { this.deliver({ t: 'roster', room: RoomCore.snapshot(this.room) }); },
  receive(message) {
    if (!this.active) return;
    // Hardware measurements and host transfer have no meaning for virtual phones.
    if (['relay','live','makeHost','kick'].includes(message.t) || message.t.startsWith('timing-')) return;
    if (message.t === 'show-config') message = { ...message, patch: { ...message.patch, calibrationEnabled: false } };
    if (RoomCore.handle(this.room, this.room.devices.get(this.room.hostId), message, this.ctx())) this.roster();
  },
  async start() {
    const input = $('#simulation-count');
    if (!input.reportValidity() || input.value === '') return;
    if (App.connected && !this.active) return;
    const button = $('#simulation-start'); button.disabled = true;
    try {
      await Engine.unlock();
      const old = this.active ? RoomCore.snapshot(this.room) : null;
      Extras.stop(); Diagnostics.stopTest(); Instrument.reset(); Stage.clear(); Engine.stop(); Engine.stopMetronome();
      this.active = true; this.room = RoomCore.createRoom('REHEARSAL'); this.resetClock();
      const count = Math.max(1, Math.min(64, Math.round(Number(input.value)))); input.value = count;
      const columns = Math.ceil(Math.sqrt(count)), rows = Math.ceil(count / columns);
      for (let i = 0; i < count; i++) {
        const d = RoomCore.join(this.room, this.ctx(), { id: `virtual-${i+1}`, name: `Phone ${i+1}`, mode: 'stereo' });
        const angle = i / count * Math.PI * 2 - Math.PI / 2;
        const position = count > 16 ? { x: ((i % columns) - (columns-1)/2) * 7/columns, y: (Math.floor(i/columns) - (rows-1)/2) * 7/rows } : { x: Math.cos(angle)*3, y: Math.sin(angle)*3 };
        Object.assign(d, { pos: old?.devices.length === count ? old.devices[i].pos || position : position,
          role: old?.devices[i]?.role || 'all', posSource: 'manual', instrumentReady: true, visualReady: true });
      }
      if (old) this.room.show = { ...old.show, running: false, anchor: 0, revision: 0, calibrationEnabled: false };
      Net.mode = 'simulation'; Net.isHub = true; Net.onMessage = handleMessage;
      Net.link = { send: m => this.receive(m), close() {} };
      Net.hub = { setTrack: meta => { RoomCore.setTrack(this.room, meta); this.roster(); } };
      App.connected = true; App.appliedPlayback = ''; App.loadedTrackId = null;
      for (let i = 0; i < 4; i++) Clock.note(performance.now(), performance.now());
      handleMessage({ t: 'welcome', id: this.room.hostId, room: RoomCore.snapshot(this.room) });
      pumpSync(true); this.receive({ t: 'instrument-mode', on: true });
      Desk.close();
    } catch (error) { toast(`Could not start rehearsal: ${error.message}`); }
    finally { button.disabled = false; }
  },
  prepareLive(create) {
    if (!this.active) { if (!create) this.draft = null; return; }
    this.draft = create ? { show: { ...this.room.show, running: false }, slots: [...this.room.devices.values()].map(d => ({ pos: d.pos, role: d.role, volume: d.volume, muted: d.muted })) } : null;
    this.assigned.clear(); this.draftApplied = false; Extras.stop(); Diagnostics.stopTest(); Timing.cancel();
    this.active = false; this.room = null;
    Instrument.reset(); Stage.clear(); Engine.stop(); Engine.stopMetronome();
    Net.link = null; Net.hub = null; Net.mode = null; Net.isHub = false; Net.localBytes = null;
    App.connected = false; App.room = null; App.id = null; App.appliedPlayback = '';
    this.resetClock(); Diagnostics.history = []; Diagnostics.frames = []; Diagnostics.margins = []; Diagnostics.longTasks = 0; Diagnostics.baselines.clear();
    Stage.visualCount = 0; Stage.visualLate = 0; Stage.skipped = 0;
    Desk.refresh();
  },
  applyDraft(welcome = false) {
    if (this.active || !this.draft || !isHost()) return;
    if (welcome && !this.draftApplied) { this.draftApplied = true; send({ t: 'show-config', patch: this.draft.show }); }
    // Assign planned slots to arriving phones, leaving the laptop unplaced.
    // IDs retain their assignment during reconnect; departed slots can be reused.
    for (const [id] of this.assigned) if (!App.room.devices.some(d => d.id === id)) this.assigned.delete(id);
    for (const d of App.room.devices) {
      if (d.id === App.id || this.assigned.has(d.id)) continue;
      const used = new Set(this.assigned.values());
      const slot = this.draft.slots.findIndex((_, i) => !used.has(i));
      if (slot < 0) break;
      this.assigned.set(d.id, slot);
      send({ t: 'device', id: d.id, ...this.draft.slots[slot], posSource: 'manual' });
    }
    $('#simulation-transfer').hidden = false;
    $('#simulation-transfer').textContent = `Rehearsal layout: ${this.assigned.size} / ${this.draft.slots.length} phone slots filled in join order. Check each person's position before starting. Laptop stays unplaced. Extra phones need manual placement.`;
  },
  // Stereo power mix, grouped by musical part: bounded synth count even at 64 phones.
  monitor(event) {
    const groups = new Map();
    for (const d of App.room.devices) {
      const gain = (event.gains?.[d.id] || 0) * Math.min(2, d.volume);
      if (gain <= 0 || d.muted) continue;
      const note = { ...event, ...event.parts?.[d.id] };
      const key = `${note.voice}:${note.midi}`;
      const group = groups.get(key) || { note, power: 0, pan: 0 };
      const power = gain * gain; group.power += power;
      group.pan += Math.max(-1, Math.min(1, (d.pos?.x || 0) / Instrument.halfSpan)) * power;
      groups.set(key, group);
    }
    return [...groups.values()].map(g => ({ note: g.note, gain: Math.min(1, Math.sqrt(g.power)), pan: g.pan / g.power }));
  },
  refresh() {
    if (!$('#simulation-tools')) return;
    const live = !!App.room && !this.active;
    $('#simulation-tools').hidden = live;
    $('#simulation-shortcut').hidden = live;
    $('#simulation-start').textContent = this.active ? 'Apply phone count' : 'Start simulation';
    $('#simulation-note').hidden = !this.active;
    $('#simulation-transfer').hidden = !live || !this.draft;
    $('#enable-calibration').disabled = this.active;
    $('#show-auto-guard').disabled = this.active;
    $('.playback-details').inert = this.active || Timing.running;
    if (this.active) {
      $('#diagnostics-panel').hidden = true;
      $('#sync-pill').hidden = true;
      $('#instrument-local-mute').textContent = App.muted ? 'Unmute laptop monitor' : 'Mute laptop monitor';
    }
  },
  init() {
    const tools = document.createElement('section'); tools.id = 'simulation-tools';
    tools.innerHTML = '<label for="simulation-count">Rehearse with virtual phones</label><div class="simulation-actions"><input id="simulation-count" type="number" min="1" max="64" step="1" value="8" aria-label="Number of simulated phones"><button class="btn primary" id="simulation-start">Start simulation</button></div><p>1–64 phones. No room or other devices needed. Changing the count stops playback and rearranges the layout.</p>';
    $('#desk-intro').after(tools);
    const note = document.createElement('p'); note.id = 'simulation-note'; note.hidden = true;
    note.textContent = 'SIMULATION · Laptop stereo preview of all phones. Drag nodes with placement enabled; play pads, polyrhythms and screen cues. Phone hardware, Wi-Fi latency and room acoustics are not simulated. Legacy playback and microphone calibration are available in a live room.';
    tools.after(note);
    const transfer = document.createElement('p'); transfer.id = 'simulation-transfer'; transfer.hidden = true; note.after(transfer);
    $('#simulation-start').addEventListener('click', () => this.start());
    const shortcut = document.createElement('button'); shortcut.id = 'simulation-shortcut'; shortcut.className = 'btn wide'; shortcut.textContent = 'Rehearse without a room';
    shortcut.addEventListener('click', () => { Desk.close(); $('#simulation-count').focus(); });
    $('#room-panel .panel-heading').after(shortcut);
    this.refresh();
  },
};
