/* A distributed instrument: musical events cross the network; sound stays local. */
'use strict';
const Instrument = {
  context: null, output: null, limiter: null, voices: new Map(),
  source: { x: 0, y: 0 }, halfSpan: 5, placing: false, drag: null,
  selectedNote: 0, sequence: 0, played: 0, late: 0, slack: null,
  motion: null, lastMotion: 0, movementCount: 0, reportedReady: null,
  notes: [50, 53, 55, 57, 60, 62, 65, 67],
  labels: ['D3', 'F3', 'G3', 'A3', 'C4', 'D4', 'F4', 'G4'],
  keys: ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k'],
  active() { return playback().mode === 'instrument'; },

  prepare() {
    if (!Engine.unlocked() || typeof Tone === 'undefined') return false;
    if (!this.context) {
      // Reuse Ensemble's output clock. Explicit times avoid Tone.now()'s extra lead.
      this.context = new Tone.Context({ context: Engine.ctx, lookAhead: 0, updateInterval: 0.025 });
      Tone.setContext(this.context);
      this.output = Engine.ctx.createGain();
      this.output.connect(Engine.analyser);
      this.limiter = new Tone.Limiter(-4);
      this.limiter.connect(this.output);
      Engine.ctx.addEventListener('statechange', () => {
        if (!Engine.unlocked()) this.silence();
        this.report();
      });
      // Allocate voices before the first gesture, not on its deadline.
      this.makeVoices();
    }
    this.updateGain();
    return true;
  },
  makeVoices(only) {
    if (!this.context) return;
    for (const voice of only ? [only] : ['sine', 'triangle', 'bell']) {
      if (this.voices.has(voice)) continue;
      const Synth = voice === 'bell' ? Tone.FMSynth : Tone.Synth;
      const options = voice === 'bell'
          ? { harmonicity: 2, modulationIndex: 2, envelope: { attack: 0.005, decay: 0.35, sustain: 0.12, release: 0.5 }, modulationEnvelope: { attack: 0.003, decay: 0.25, sustain: 0, release: 0.3 } }
          : { oscillator: { type: voice }, envelope: { attack: 0.008, decay: 0.15, sustain: 0.3, release: 0.25 } };
      // Direct Synth calls write automation into Web Audio immediately. PolySynth
      // defers voice allocation through JS timers, undesirable at short deadlines.
      this.voices.set(voice, Array.from({ length: 8 }, () => {
        const synth = new Synth({ ...options, context: this.context, volume: -14 });
        synth.connect(this.limiter);
        return { synth, availableAt: 0 };
      }));
    }
  },
  updateGain() {
    if (!this.output) return;
    const g = this.output.gain, now = Engine.ctx.currentTime;
    g.cancelScheduledValues(now);
    g.setTargetAtTime(App.muted ? 0 : Math.min(2, App.volume) * (App.room?.show?.master ?? 1), now, 0.015);
  },
  silence() {
    // Disposing cancels future attacks as well as ringing voices. releaseAll alone
    // would leave notes which were already scheduled ahead of the panic event.
    for (const pool of this.voices.values()) for (const voice of pool) voice.synth.dispose();
    this.voices.clear();
    this.drag = null;
    if ($('#field-pulses')) $('#field-pulses').replaceChildren();
  },
  reset() {
    this.silence(); this.sequence = 0;
    this.played = 0; this.late = 0; this.overload = 0; this.rejected = 0; this.slack = null; this.reportedReady = null;
  },
  receive(event) {
    if (!Number.isSafeInteger(event.seq) || event.seq <= this.sequence) return;
    this.sequence = event.seq;
    if (event.t === 'instrument-panic') { this.silence(); return; }
    if (!this.active() || !Clock.ready || !App.connected || document.hidden || !this.prepare()) return;
    const note = Spatial.note({ ...event, ...(event.parts?.[App.id] || {}) });
    if (!note) return;
    const gain = event.gains && event.gains[App.id];
    if (Number.isFinite(gain) && gain > 0.001 && !App.muted) {
      this.makeVoices(note.voice);
      const when = Engine.scheduleAt(note.at) + (App.trim + (App.room?.show?.calibrationEnabled ? me()?.timingTrim || 0 : 0) - Spatial.GRAPH_LATENCY_MS) / 1000;
      const decision = Spatial.scheduleDecision(Engine.ctx.currentTime, when);
      this.slack = decision.slackMs;
      Diagnostics.margin(decision.slackMs);
      if (!decision.play) this.late++;
      else {
        const hz = 440 * 2 ** ((note.midi - 69) / 12);
        const slot = this.voices.get(note.voice).find((voice) => voice.availableAt <= when);
        if (slot) {
          slot.synth.triggerAttackRelease(hz, note.duration, when, note.velocity * gain);
          slot.availableAt = when + note.duration + (note.voice === 'bell' ? 0.55 : 0.3);
          this.played++;
        } else this.overload = (this.overload || 0) + 1;
      }
    }
    if (!isHost()) { this.source = note.pos; this.drawSource(note.spread); }
    
    this.renderHealth();
  },
  play(index = this.selectedNote, pressure = 1) {
    if (!isHost() || !this.active() || !Clock.ready || !App.connected) return;
    if (!App.room.devices.some((d) => d.pos && d.instrumentReady && !d.muted)) {
      toast('Place and enable at least one speaker first'); return;
    }
    this.selectedNote = index;
    $$('#note-keys button').forEach((b, i) => b.setAttribute('aria-pressed', String(i === index)));
    send({ t: 'instrument-note', at: Clock.now() + Number($('#instrument-lead').value),
      pos: this.source, midi: this.notes[index], voice: $('#instrument-voice').value,
      duration: Number($('#instrument-duration').value), spread: Number($('#instrument-spread').value),
      velocity: Number($('#instrument-velocity').value) / 100 * pressure });
  },
  report() {
    if (!App.room || !App.connected) return;
    const ready = this.prepare() && Clock.ready && !document.hidden;
    const patch = { visualReady: Clock.ready && !document.hidden, metrics: Diagnostics.metrics(), instrumentReady: ready, notePlayed: this.played, noteLate: this.late,
      clockJitter: Number.isFinite(Clock.jitter()) ? Clock.jitter() : 0 };
    if (this.slack !== null) patch.noteSlack = this.slack;
    this.reportedReady = ready;
    pushState(patch);
    this.renderHealth();
  },
  renderHealth() {
    const ready = Engine.unlocked() && Clock.ready && !!this.context;
    $('#speaker-health').textContent = !Engine.unlocked() ? 'Audio needs a tap to start.' : !Clock.ready
      ? 'Listening to the room clock…'
      : `${this.played} scheduled · ${this.late} late${this.overload ? ` · ${this.overload} voice limit` : ''}${this.slack === null ? '' : ` · ${Math.round(this.slack)} ms last scheduling margin`}`;
    $('#instrument-local-mute').textContent = App.muted ? 'Unmute this speaker' : 'Mute this speaker';
    $('#instrument-local-mute').setAttribute('aria-pressed', String(App.muted));
    if (!App.room) return;
    const placed = App.room.devices.filter((d) => d.pos && d.instrumentReady && !d.muted).length;
    const unplaced = App.room.devices.filter((d) => !d.pos).length;
    const dropped = App.room.devices.reduce((s, d) => s + (d.noteLate || 0), 0);
    const text = !ready ? 'Preparing audio and clock…' : this.active()
      ? `${placed} speaker${placed === 1 ? '' : 's'} ready · ${Number($('#instrument-lead').value)} ms gesture lead${dropped ? ` · ${dropped} late notes — increase lead` : ''}${this.rejected ? ` · ${this.rejected} gestures rejected (${this.rejectionReason})` : ''}`
      : 'Ready when you are. Place the speakers, then start the instrument.';
    const status = isHost() ? text : (this.active() ? 'Listening to the host. Keep this page visible and the screen awake.' : 'Ready. The host will start the instrument.');
    $('#instrument-status').textContent = status + (unplaced ? ` ${unplaced} device${unplaced === 1 ? '' : 's'} still need placement.` : '');
  },
  render() {
    if (!App.room) return;
    const host = isHost();
    $('#instrument-toggle').hidden = !host;
    $('#instrument-panic').hidden = !host;
    $('#performance-controls').hidden = !host;
    $('#placement-controls').hidden = !host;
    $('#placement-toggle').hidden = !host;
    $('#place-circle').hidden = !host;
    $('#note-keys').hidden = !host;
    $('#field-help').hidden = !host;
    $('#instrument-description').textContent = host
      ? 'Place each phone where it sits. Touch the field to send a note through the space.'
      : 'Your phone is part of the instrument. Its position shapes what you hear.';
    $('#instrument-toggle').textContent = this.active() ? 'Stop instrument' : 'Start instrument';
    $('#instrument-toggle').disabled = !Clock.ready || !App.connected;
    $('#instrument-panic').disabled = !this.active();
    $$('#note-keys button').forEach((b) => { b.disabled = !this.active(); });
    $('#use-acoustic').disabled = !Ranger.map;
    if (!host) this.placing = false;
    const select = $('#speaker-select');
    const signature = App.room.devices.map((d) => `${d.id}:${d.name}`).join('|');
    if (signature !== this.rosterSignature) {
      this.rosterSignature = signature;
      const selected = select.value;
      select.replaceChildren(...App.room.devices.map((d, i) => new Option(`${i + 1}. ${d.name}`, d.id)));
      if (App.room.devices.some((d) => d.id === selected)) select.value = selected;
      this.readCoordinates();
    }
    const selectedDevice = App.room.devices.find((d) => d.id === select.value);
    const coordinateSignature = JSON.stringify([select.value, selectedDevice && selectedDevice.pos]);
    if (!this.coordinatesDirty && coordinateSignature !== this.coordinateSignature) this.readCoordinates();
    this.renderMap();
    this.renderHealth();
  },
  point(p) { return { x: 300 + p.x / this.halfSpan * 300, y: 300 + p.y / this.halfSpan * 300 }; },
  positionFromEvent(e) {
    const rect = $('#sound-field').getBoundingClientRect();
    return { x: clamp(((e.clientX - rect.left) / rect.width * 2 - 1) * this.halfSpan, -this.halfSpan, this.halfSpan),
      y: clamp(((e.clientY - rect.top) / rect.height * 2 - 1) * this.halfSpan, -this.halfSpan, this.halfSpan) };
  },
  drawSource(spread = Number($('#instrument-spread').value)) {
    const p = this.point(this.source);
    $('#field-source').setAttribute('transform', `translate(${p.x} ${p.y})`);
    $('#field-spread').setAttribute('r', spread / this.halfSpan * 300);
  },
  renderMap() {
    if (!App.room) return;
    // Auto-fit reported geometry, but hold the scale stable during a drag.
    if (!this.drag) this.halfSpan = Math.max(5, ...App.room.devices.filter((d) => d.pos).map((d) => Math.max(Math.abs(d.pos.x), Math.abs(d.pos.y)) * 1.3));
    $('#field-scale').textContent = `${(this.halfSpan * 2).toFixed(1)} × ${(this.halfSpan * 2).toFixed(1)} m`;
    const step = this.halfSpan > 10 ? 5 : 1;
    const gridSize = step / this.halfSpan * 300;
    $('#metre-grid').setAttribute('width', gridSize);
    $('#metre-grid').setAttribute('height', gridSize);
    $('#metre-grid path').setAttribute('d', `M${gridSize} 0H0V${gridSize}`);
    const ns = 'http://www.w3.org/2000/svg';
    const unitsPerPixel = 600 / Math.max(1, $('#sound-field').getBoundingClientRect().width);
    const nodes = App.room.devices.flatMap((d, i) => {
      if (!d.pos) return [];
      const p = this.point(this.drag && this.drag.id === d.id ? this.drag.pos : d.pos);
      const group = document.createElementNS(ns, 'g');
      group.dataset.speaker = d.id;
      group.setAttribute('transform', `translate(${p.x} ${p.y})`);
      const title = document.createElementNS(ns, 'title');
      title.textContent = `${i + 1}. ${d.name} · ${d.posSource || 'manual'} position · ${d.instrumentReady ? 'ready' : 'waiting for audio'}`;
      const hit = document.createElementNS(ns, 'circle'); hit.setAttribute('r', Math.max(27, 22 * unitsPerPixel)); hit.setAttribute('fill', 'transparent');
      const circle = document.createElementNS(ns, 'circle'); circle.setAttribute('r', Math.max(19, 14 * unitsPerPixel));
      circle.setAttribute('class', `speaker-dot${d.instrumentReady ? ' ready' : ''}${d.muted ? ' muted' : ''}`);
      const number = document.createElementNS(ns, 'text'); number.setAttribute('class', 'speaker-number'); number.textContent = i + 1;
      const name = document.createElementNS(ns, 'text'); name.setAttribute('class', 'speaker-name'); name.setAttribute('y', '41'); name.textContent = d.name.slice(0, 14);
      number.style.fontSize = `${Math.max(18, 14 * unitsPerPixel)}px`;
      name.style.fontSize = `${Math.max(13, 12 * unitsPerPixel)}px`;
      name.setAttribute('y', Math.max(41, 32 * unitsPerPixel));
      group.append(title, hit, circle, number, name); return [group];
    });
    $('#field-speakers').replaceChildren(...nodes);
    this.drawSource();
  },
  pulse(pos) {
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    const p = this.point(pos);
    circle.setAttribute('cx', p.x); circle.setAttribute('cy', p.y); circle.setAttribute('r', '18'); circle.setAttribute('class', 'note-pulse');
    $('#field-pulses').append(circle);
    setTimeout(() => circle.remove(), 180);
  },
  readCoordinates() {
    const d = App.room && App.room.devices.find((d) => d.id === $('#speaker-select').value);
    this.coordinatesDirty = false;
    this.coordinateSignature = JSON.stringify([$('#speaker-select').value, d && d.pos]);
    $('#speaker-x').value = d && d.pos ? d.pos.x.toFixed(1) : 0;
    $('#speaker-y').value = d && d.pos ? d.pos.y.toFixed(1) : 0;
  },
  place(id, pos, posSource = 'manual') {
    if (!isHost() || !Spatial.position(pos)) return;
    send({ t: 'device', id, pos, posSource });
  },
  importMap() {
    if (!Ranger.map || !isHost()) return;
    Ranger.map.ids.forEach((id, i) => this.place(id, Ranger.map.points[i], 'acoustic'));
    toast('Acoustic positions loaded. Check the map against the room.');
  },
  async toggleMotion() {
    const btn = $('#instrument-motion');
    if (this.motion) {
      window.removeEventListener('devicemotion', this.motion); this.motion = null;
      btn.textContent = 'Detect movement'; btn.setAttribute('aria-pressed', 'false'); return;
    }
    if (!window.isSecureContext || typeof DeviceMotionEvent === 'undefined') {
      $('#movement-hint').textContent = 'Movement detection needs HTTPS and a phone with motion sensors. You can place speakers manually.'; return;
    }
    try {
      if (typeof DeviceMotionEvent.requestPermission === 'function' && await DeviceMotionEvent.requestPermission() !== 'granted') throw new Error('Motion access was not granted.');
      this.motion = (e) => {
        const a = e.acceleration;
        if (!a || ![a.x, a.y, a.z].every(Number.isFinite)) return;
        const now = performance.now();
        if (Math.hypot(a.x, a.y, a.z) > 2.5) this.movementCount++;
        else this.movementCount = 0;
        if (this.movementCount >= 3 && now - this.lastMotion > 8000) {
          this.lastMotion = now; this.movementCount = 0;
          $('#movement-hint').textContent = 'Movement detected. Ask the host to update this phone’s position. Motion is not a position measurement.';
          send({ t: 'relay', to: 'host', payload: { k: 'instrument-moved' } });
        }
      };
      window.addEventListener('devicemotion', this.motion);
      btn.textContent = 'Stop detecting movement'; btn.setAttribute('aria-pressed', 'true');
      $('#movement-hint').textContent = 'Movement detection enabled. Positions are still set by placement or acoustic mapping.';
    } catch (error) { $('#movement-hint').textContent = `${error.message} Manual placement is available.`; }
  },
  init() {
    $('#invite-phones').addEventListener('click', () => {
      Desk.open();
      $('#btn-copy').focus({ preventScroll: true });
    });
    $('#note-keys').replaceChildren(...this.notes.map((midi, i) => {
      const b = document.createElement('button'); b.className = 'note-key'; b.setAttribute('aria-pressed', String(i === 0));
      b.setAttribute('aria-label', `Play ${this.labels[i]} (${this.keys[i].toUpperCase()})`);
      const label = document.createElement('span'); label.textContent = this.labels[i];
      const key = document.createElement('kbd'); key.textContent = this.keys[i].toUpperCase(); b.append(label, key);
      b.addEventListener('click', () => this.play(i)); return b;
    }));
    $('#instrument-toggle').addEventListener('click', () => {
      if (!isHost()) return;
      if (Live.sending) { toast('Stop live streaming before starting the instrument'); return; }
      if (Ranger.running) { toast('Wait for acoustic mapping to finish'); return; }
      if (!this.active() && !App.room.devices.some((d) => d.pos && d.instrumentReady && !d.muted)) {
        toast('Arrange or place an enabled speaker first'); return;
      }
      send({ t: 'instrument-mode', on: !this.active() });
    });
    $('#instrument-panic').addEventListener('click', () => {
      this.silence(); if (isHost()) send({ t: 'instrument-panic' });
    });
    $('#instrument-local-mute').addEventListener('click', () => $('#btn-mute').click());
    $('#instrument-motion').addEventListener('click', () => this.toggleMotion());
    $('#place-circle').addEventListener('click', () => {
      const devices = App.room.devices;
      devices.forEach((d, i) => {
        const angle = i / devices.length * Math.PI * 2;
        this.place(d.id, devices.length === 1 ? { x: 0, y: -2.5 } : { x: Math.sin(angle) * 3, y: -Math.cos(angle) * 3 });
      });
      toast('Circle assigned. Adjust each position to match the real room.');
    });
    $('#use-acoustic').addEventListener('click', () => this.importMap());
    $('#speaker-select').addEventListener('change', () => this.readCoordinates());
    for (const id of ['#speaker-x', '#speaker-y']) $(id).addEventListener('input', () => { this.coordinatesDirty = true; });
    $('#place-coordinate').addEventListener('click', () => {
      const x = $('#speaker-x'), y = $('#speaker-y');
      if (!x.reportValidity() || !y.reportValidity() || x.value === '' || y.value === '') return;
      this.coordinatesDirty = false;
      this.place($('#speaker-select').value, { x: Number(x.value), y: Number(y.value) });
    });
    $('#placement-toggle').addEventListener('click', () => {
      this.placing = !this.placing;
      $('#placement-toggle').setAttribute('aria-pressed', String(this.placing));
      $('#placement-toggle').textContent = this.placing ? 'Finish placement' : 'Place speakers';
      $('#field-mode').textContent = this.placing ? 'Drag a numbered speaker' : 'Sound field';
      $('#sound-field').classList.toggle('placing', this.placing);
    });
    for (const [id, output, format] of [
      ['spread', 'spread-value', (v) => `${Number(v).toFixed(1)} m`],
      ['duration', 'duration-value', (v) => `${Number(v).toFixed(1)} s`],
      ['velocity', 'velocity-value', (v) => `${v}%`], ['lead', 'lead-value', (v) => `${v} ms`],
    ]) $('#instrument-' + id).addEventListener('input', (e) => { $('#' + output).textContent = format(e.target.value); this.drawSource(); this.renderHealth(); });
    $('#instrument-recommend').addEventListener('click', () => {
      const lead = Spatial.recommendedLead(App.room.devices, App.room.hostId);
      $('#instrument-lead').value = Math.min(1000, lead);
      $('#instrument-lead').dispatchEvent(new Event('change'));
      $('#lead-hint').textContent = `Estimated starting point: ${lead} ms. Based on reported network, output and clock timing. Play notes and watch the late count; this does not measure speaker-to-ear latency.`;
    });
    const field = $('#sound-field');
    field.addEventListener('pointerdown', (e) => {
      if (!isHost() || this.drag || e.button > 0) return;
      const pos = this.positionFromEvent(e);
      const speaker = e.target.closest('[data-speaker]');
      if (this.placing && !speaker) return;
      this.drag = { pointerId: e.pointerId, id: this.placing ? speaker.dataset.speaker : null, pos, last: 0 };
      field.setPointerCapture(e.pointerId); field.focus();
      if (!this.placing) { this.source = pos; this.drawSource(); this.play(); this.drag.last = performance.now(); }
    });
    field.addEventListener('pointermove', (e) => {
      if (!this.drag || this.drag.pointerId !== e.pointerId) return;
      this.drag.pos = this.positionFromEvent(e);
      if (this.drag.id) { this.renderMap(); return; }
      this.source = this.drag.pos; this.drawSource();
      if (performance.now() - this.drag.last > 110) {
        this.drag.last = performance.now();
        this.play(this.selectedNote, e.pointerType === 'pen' && e.pressure > 0 ? Math.max(0.2, e.pressure) : 1);
      }
    });
    const end = (e) => {
      if (!this.drag || this.drag.pointerId !== e.pointerId) return;
      if (this.drag.id && e.type !== 'pointercancel') {
        this.coordinatesDirty = false;
        this.place(this.drag.id, this.drag.pos); $('#speaker-select').value = this.drag.id;
        $('#speaker-x').value = this.drag.pos.x.toFixed(1); $('#speaker-y').value = this.drag.pos.y.toFixed(1);
      }
      this.drag = null;
    };
    field.addEventListener('pointerup', end); field.addEventListener('pointercancel', end); field.addEventListener('lostpointercapture', end);
    document.addEventListener('keydown', (e) => {
      if (!isHost() || e.target.matches('input, select, textarea') || e.ctrlKey || e.altKey || e.metaKey) return;
      const index = this.keys.indexOf(e.key.toLowerCase());
      if (index >= 0 && !e.repeat) { e.preventDefault(); this.play(index); }
      if (e.key === 'Escape') { this.silence(); send({ t: 'instrument-panic' }); }
      if (e.target === field) {
        const deltas = { ArrowLeft: [-0.25, 0], ArrowRight: [0.25, 0], ArrowUp: [0, -0.25], ArrowDown: [0, 0.25] };
        const delta = deltas[e.key];
        if (delta) { e.preventDefault(); this.source = { x: clamp(this.source.x + delta[0], -this.halfSpan, this.halfSpan), y: clamp(this.source.y + delta[1], -this.halfSpan, this.halfSpan) }; this.drawSource(); }
        if (e.key === 'Enter' && !e.repeat) { e.preventDefault(); this.play(); }
      }
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { this.silence(); if (isHost() && this.active()) send({ t: 'instrument-panic' }); }
      this.report();
    });
    setInterval(() => this.report(), 1500);
  },
};
