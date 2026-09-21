'use strict';
const Stage = {
  queue: [], activity: new Map(), next: [0, 0, 0], revision: '', inStage: false,
  soft: matchMedia('(prefers-reduced-motion: reduce)').matches, localBrightness: 0.8,
  visualCount: 0, visualLate: 0, skipped: 0, lastFrame: 0, lastDraw: 0, lastSeq: 0,
  show() { return (App.room && App.room.show) || ShowCore.defaults(); },
  clear() { this.queue.length = 0; this.activity.clear(); },
  receive(event) {
    if (event.t === 'instrument-panic') { this.clear(); return; }
    if (!Number.isSafeInteger(event.seq) || event.seq <= this.lastSeq) return;
    this.lastSeq = event.seq;
    const gains = event.t === 'visual-cue' ? event.gains : event.visualGains || event.gains;
    if (!gains || !Number.isFinite(event.at)) return;
    if (this.queue.length >= 256) this.queue.shift();
    this.queue.push({ at: event.at, gains, palette: event.palette || this.show().palette,
      duration: Math.min(2, Math.max(0.4, event.duration || 0.8)), pos: event.pos || null, lane: event.lane });
    this.queue.sort((a, b) => a.at - b.at);
  },
  pump() {
    if (!isHost() || !App.connected || !Clock.ready || !Instrument.active() || document.hidden) return;
    const show = this.show();
    if (!show.running || Diagnostics.testing) return;
    const signature = `${show.revision}:${show.anchor}`;
    if (signature !== this.revision) { this.revision = signature; this.next = [0, 0, 0]; }
    const now = Clock.now(), horizon = now + show.lead + 250;
    for (let lane = 0; lane < (show.metronome ? 3 : 2); lane++) {
      const divisions = lane === 0 ? show.a : lane === 1 ? show.b : show.beats;
      const step = 60000 / show.bpm * show.beats / divisions;
      const minimum = Math.max(0, Math.ceil((now + show.lead - show.anchor) / step));
      if (this.next[lane] < minimum) { this.skipped += minimum - this.next[lane]; this.next[lane] = minimum; }
      for (let n = 0; n < 16 && ShowCore.rhythm(show, lane, this.next[lane]) <= horizon; n++) {
        const index = this.next[lane]++;
        const pos = lane === 2 ? { x: 0, y: 0 } : ShowCore.source(show, lane, index);
        send({ t: 'instrument-note', at: ShowCore.rhythm(show, lane, index), pos,
          midi: lane === 2 ? 84 : Instrument.notes[(index + lane * 3) % Instrument.notes.length],
          voice: lane === 0 ? 'sine' : lane === 1 ? 'bell' : 'triangle',
          duration: lane === 2 ? 0.06 : 0.18, velocity: lane === 2 ? 0.22 : 0.65,
          spread: lane === 2 ? 6 : Number($('#instrument-spread').value),
          palette: lane === 0 ? show.palette : lane === 1 ? 'ember' : 'mint', lane });
      }
    }
  },
  frame(timestamp) {
    requestAnimationFrame((t) => this.frame(t));
    if (this.lastFrame && !document.hidden && App.room) Diagnostics.frame(timestamp - this.lastFrame);
    this.lastFrame = timestamp;
    if (!App.room || document.hidden || !Clock.ready) return;
    const now = Clock.now();
    // Cues activate on their scheduled room time, not on packet arrival.
    for (let i = this.queue.length - 1; i >= 0; i--) {
      const cue = this.queue[i];
      if (cue.at > now) continue;
      this.queue.splice(i, 1);
      if (now - cue.at > 300) { if ((cue.gains[App.id] || 0) > 0.03) this.visualLate++; continue; }
      for (const [id, gain] of Object.entries(cue.gains)) {
        if (!Number.isFinite(gain) || gain < 0.03) continue;
        const device = App.room.devices.find((d) => d.id === id);
        const at = cue.at + ((device && device.trim) || 0);
        const last = this.activity.get(id);
        // A later delivery should not replace a newer scheduled cue.
        if (!last || at >= last.at) this.activity.set(id, { ...cue, at, gain });
        if (id === App.id) { this.visualCount++; if (now - at > 50) this.visualLate++; }
      }
    }
    if (timestamp - this.lastDraw < 32) return;
    this.lastDraw = timestamp;
    const show = this.show();
    if (this.inStage) this.paint($('#stage-canvas'), this.activity.get(App.id), now, show, true);
    if (isHost()) {
      this.drawRhythm(now, show);
      const nodes = new Map([...$('#field-speakers').children].map(el => [el.dataset.speaker, el]));
      const previews = new Map([...$('#phone-wall').children].map(el => [el.dataset.id, el]));
      for (const d of App.room.devices) {
        const cue = this.activity.get(d.id);
        const level = this.level(cue, now, show);
        const node = nodes.get(d.id);
        if (node) {
          const screen = node.querySelector('canvas');
          if (screen) this.paint(screen, cue, now, show, false);
          const circle = node.querySelector('.speaker-dot');
          circle.style.fill = level > 0.01 ? (ShowCore.COLORS[cue.palette] || ShowCore.COLORS.ocean) : '';
          circle.style.fillOpacity = level > 0.01 ? 0.15 + level * 0.85 : '';
          circle.style.strokeWidth = level > 0.01 ? 2 + level * 6 : '';
        }
        const preview = previews.get(d.id);
        if (preview) this.paint(preview.querySelector('canvas'), cue, now, show, false);
      }
    }
  },
  level(cue, now, show) {
    if (!cue || show.blackout || now < cue.at) return 0;
    const age = (now - cue.at) / 1000;
    if (age > cue.duration + 0.8) return 0;
    // Slow onset and release blend overlapping pulses instead of hard flashing.
    return Math.min(1, age / 0.18) * Math.exp(-Math.max(0, age - 0.18) / 0.55) * cue.gain * show.brightness;
  },
  paint(canvas, cue, now, show, full) {
    const rect = canvas.getBoundingClientRect();
    const ratio = Math.min(devicePixelRatio || 1, full ? 1.5 : 1);
    const width = Math.max(1, Math.round(rect.width * ratio)), height = Math.max(1, Math.round(rect.height * ratio));
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#090b10'; ctx.fillRect(0, 0, width, height);
    const soft = this.soft || matchMedia('(prefers-reduced-motion: reduce)').matches;
    const level = this.level(cue, now, show) * (full ? this.localBrightness : 1);
    if (level < 0.001) return;
    const color = ShowCore.COLORS[cue.palette] || ShowCore.COLORS.ocean;
    const age = Math.max(0, (now - cue.at) / 1000);
    ctx.globalAlpha = level;
    if (soft || show.style === 'bloom') {
      const gradient = ctx.createRadialGradient(width / 2, height * 0.45, 0, width / 2, height * 0.45, Math.max(width, height) * 0.9);
      gradient.addColorStop(0, color); gradient.addColorStop(1, '#090b10');
      ctx.fillStyle = gradient; ctx.fillRect(0, 0, width, height);
    } else if (show.style === 'rings') {
      ctx.strokeStyle = color; ctx.lineWidth = Math.max(3, width * 0.045);
      for (let i = 0; i < 4; i++) {
        const radius = (0.1 + i * 0.16 + Math.min(age, 1) * 0.1) * Math.min(width, height);
        ctx.beginPath(); ctx.arc(width / 2, height / 2, radius, 0, Math.PI * 2); ctx.stroke();
      }
    } else {
      ctx.fillStyle = color;
      for (let i = 0; i < 5; i++) {
        const x = (i / 5 + Math.sin(age * 1.2 + i) * 0.04) * width;
        ctx.globalAlpha = level * (0.4 + i * 0.12);
        ctx.fillRect(x, 0, width * 0.11, height);
      }
    }
    ctx.globalAlpha = 1;
  },
  drawRhythm(now, show) {
    const canvas = $('#rhythm-dial'), ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const light = matchMedia('(prefers-color-scheme: light)').matches;
    const phase = show.running && now >= show.anchor ? ((now - show.anchor) / (60000 / show.bpm * show.beats)) % 1 : 0;
    for (let lane = 0; lane < 2; lane++) {
      const cx = lane === 0 ? 76 : 204, cy = 77, radius = 52, count = lane === 0 ? show.a : show.b;
      const color = lane === 0 ? '#57b9ef' : '#e79c67';
      ctx.strokeStyle = light ? '#dddfe4' : '#2c303a'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(cx, cy, radius, 0, Math.PI * 2); ctx.stroke();
      for (let i = 0; i < count; i++) {
        const angle = i / count * Math.PI * 2 - Math.PI / 2;
        const hit = show.running && Math.abs(phase * count - i) < 0.18;
        ctx.fillStyle = color; ctx.globalAlpha = hit ? 1 : 0.45; ctx.beginPath(); ctx.arc(cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius, hit ? 8 : 5, 0, Math.PI * 2); ctx.fill();
      }
      ctx.globalAlpha = 1; ctx.fillStyle = light ? '#20222a' : '#edf0f5'; ctx.font = '26px sans-serif'; ctx.textAlign = 'center'; ctx.fillText(String(count), cx, cy + 9);
      if (show.running) { ctx.strokeStyle = color; ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.sin(phase * Math.PI * 2) * 37, cy - Math.cos(phase * Math.PI * 2) * 37); ctx.stroke(); }
    }
    const beat = Math.floor(phase * show.beats) + 1;
    ctx.fillStyle = light ? '#62626d' : '#b9becb'; ctx.font = '13px sans-serif'; ctx.fillText(show.running ? `BEAT ${beat} / ${show.beats}` : 'SHARED CYCLE', 140, 164);
    $('#show-beat-readout').textContent = show.running ? `Beat ${beat} / ${show.beats} · ${show.a} : ${show.b}` : `Stopped · ${show.a} : ${show.b}`;
  },
  render() {
    if (!App.room) return;
    const host = isHost(), show = this.show();
    $('#show-desk').hidden = !host; $('#diagnostics-panel').hidden = !host;
    $('#phone-wall').hidden = !host;
    $('#enter-stage').textContent = host ? 'Preview screen' : 'Go fullscreen';
    $('#enter-stage').classList.toggle('primary', !host);
    $('#show-run').textContent = show.running ? 'Restart polyrhythm' : 'Start polyrhythm';
    $('#show-blackout').textContent = show.blackout ? 'Restore screens' : 'Blackout screens';
    $('#show-blackout').setAttribute('aria-pressed', String(show.blackout));
    for (const key of ['bpm', 'beats', 'a', 'b', 'master', 'brightness', 'path', 'style', 'palette']) {
      const el = $('#show-' + key); if (el !== document.activeElement) el.value = show[key];
    }
    $('#show-metronome').checked = show.metronome; $('#show-auto-guard').checked = show.autoGuard;
    $('#show-master-value').textContent = Math.round(show.master * 100) + '%';
    $('#show-brightness-value').textContent = Math.round(show.brightness * 100) + '%';
    if ($('#instrument-lead') !== document.activeElement) {
      $('#instrument-lead').value = show.lead; $('#lead-value').textContent = show.lead + ' ms';
    }
    Instrument.updateGain();
    const signature = App.room.devices.map((d) => `${d.id}:${d.name}`).join('|');
    if (signature !== this.rosterSignature) {
      this.rosterSignature = signature;
      const target = $('#cue-target').value;
      $('#cue-target').replaceChildren(new Option('Every screen', 'all'), ...App.room.devices.map((d, i) => new Option(`${i + 1}. ${d.name}`, d.id)));
      if (App.room.devices.some((d) => d.id === target)) $('#cue-target').value = target;
      $('#phone-wall').replaceChildren(...App.room.devices.map((d, i) => {
        const button = document.createElement('button'); button.className = 'phone-preview'; button.dataset.id = d.id;
        button.setAttribute('aria-label', `Select screen ${i + 1}: ${d.name}`); button.setAttribute('aria-pressed', 'false');
        const canvas = document.createElement('canvas'); const number = document.createElement('span'); number.className = 'phone-id'; number.textContent = String(i + 1);
        const name = document.createElement('span'); name.textContent = d.name; const ready = document.createElement('small'); ready.textContent = 'waiting';
        button.append(canvas, number, name, ready); button.addEventListener('click', () => { $('#cue-target').value = d.id; this.selectTarget(); }); return button;
      }));
    }
    for (const button of $('#phone-wall').children) {
      const d = App.room.devices.find((d) => d.id === button.dataset.id);
      button.querySelector('small').textContent = d.instrumentReady ? (d.muted ? 'visual only' : 'ready') : 'audio off';
    }
    const selfIndex = App.room.devices.findIndex((d) => d.id === App.id);
    $('#stage-identity').textContent = `ENSEMBLE · ${App.room.code} · ${selfIndex + 1}`;
    $('#stage-mute').textContent = App.muted ? 'Unmute sound' : 'Mute sound';
    $('#stage-soft').setAttribute('aria-pressed', String(this.soft));
    $('#stage-status').textContent = !App.connected ? 'Connection lost — reconnecting…' : show.blackout ? 'Screens are resting' : show.running ? `You are part of the rhythm · ${show.a} : ${show.b}` : 'Ready for the next cue';
    this.selectTarget();
    Diagnostics.render();
  },
  selectTarget() { for (const b of $('#phone-wall').children) b.setAttribute('aria-pressed', String(b.dataset.id === $('#cue-target').value)); },
  async enter() {
    await Engine.unlock();
    $('#phone-stage').hidden = false; this.inStage = true; document.body.classList.add('in-stage');
    try { if ($('#phone-stage').requestFullscreen) await $('#phone-stage').requestFullscreen({ navigationUI: 'hide' }); }
    catch { /* Immersive CSS is the fallback when a browser declines native fullscreen. */ }
    if (!document.fullscreenElement) $('#stage-status').textContent = 'Immersive view · Add to Home Screen for standalone mode on iPhone';
    if (Sensors.wakeWanted) Sensors.acquireWake();
    $('#exit-stage').focus();
  },
  async exit() {
    if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
    $('#phone-stage').hidden = true; this.inStage = false; document.body.classList.remove('in-stage'); $('#enter-stage').focus();
  },
  init() {
    $('#enter-stage').addEventListener('click', () => this.enter());
    $('#exit-stage').addEventListener('click', () => this.exit());
    $('#stage-mute').addEventListener('click', () => { $('#btn-mute').click(); this.render(); });
    $('#stage-soft').addEventListener('click', () => { this.soft = !this.soft; this.render(); });
    $('#stage-local-brightness').addEventListener('input', (e) => { this.localBrightness = Number(e.target.value); });
    $('#show-run').addEventListener('click', () => {
      if (!isHost() || !Clock.ready) return;
        if (Live.sending || Ranger.running || Timing.running) { toast('Stop streaming or finish microphone measurements first'); return; }
      if (!App.room.devices.some((d) => d.pos && d.instrumentReady)) { toast('Place an enabled phone first'); return; }
      Diagnostics.stopTest(); send({ t: 'show-run', on: true });
    });
    $('#show-stop').addEventListener('click', () => { Diagnostics.stopTest(); Instrument.silence(); this.clear(); send({ t: 'show-run', on: false }); });
    $('#show-blackout').addEventListener('click', () => send({ t: 'show-config', patch: { blackout: !this.show().blackout } }));
    for (const key of ['bpm', 'beats', 'a', 'b', 'master', 'brightness', 'path', 'style', 'palette']) {
      $('#show-' + key).addEventListener('change', (e) => {
        if (!isHost() || !e.target.reportValidity()) return;
        send({ t: 'show-config', patch: { [key]: ['path', 'style', 'palette'].includes(key) ? e.target.value : Number(e.target.value) } });
      });
    }
    $('#show-metronome').addEventListener('change', (e) => send({ t: 'show-config', patch: { metronome: e.target.checked } }));
    $('#show-auto-guard').addEventListener('change', (e) => send({ t: 'show-config', patch: { autoGuard: e.target.checked } }));
    $('#instrument-lead').addEventListener('change', (e) => isHost() && send({ t: 'show-config', patch: { lead: Number(e.target.value) } }));
    $('#cue-target').addEventListener('change', () => this.selectTarget());
    $('#send-cue').addEventListener('click', () => isHost() && send({ t: 'visual-cue', target: $('#cue-target').value, palette: this.show().palette, at: Clock.now() + this.show().lead + 100 }));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && this.inStage) this.exit(); });
    document.addEventListener('visibilitychange', () => { if (document.hidden) { this.clear(); this.lastFrame = 0; } });
    setInterval(() => this.pump(), 25);
    requestAnimationFrame((t) => this.frame(t));
  },
};
