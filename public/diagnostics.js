'use strict';
const Diagnostics = {
  frames: [], margins: [], longTasks: 0, history: [], baselines: new Map(),
  testing: false, testStart: 0, testNext: 0, lastGuard: 0, lastRecord: 0,
  frame(ms) { if (ms > 0 && ms < 10000) { this.frames.push(ms); if (this.frames.length > 240) this.frames.shift(); } },
  margin(ms) { if (Number.isFinite(ms)) { this.margins.push(ms); if (this.margins.length > 120) this.margins.shift(); } },
  metrics() {
    const delays = Clock.samples.slice(-60).map((s) => s.delay);
    const frame = ShowCore.percentile(this.frames, 0.5);
    return { rttP50: ShowCore.percentile(delays, 0.5), rttP95: ShowCore.percentile(delays, 0.95),
      jitter: Clock.jitter(), outputMs: Engine.ctx ? Engine.outLatency() * 1000 : 0,
      slackP05: ShowCore.percentile(this.margins, 0.05), frameP95: ShowCore.percentile(this.frames, 0.95),
      fps: frame ? 1000 / frame : 0, played: Instrument.played, late: Instrument.late,
      overload: Instrument.overload || 0, longTasks: this.longTasks,
      visualLate: Stage.visualLate, visualCount: Stage.visualCount,
      sampleRate: Engine.ctx ? Engine.ctx.sampleRate : 0, audioState: Engine.ctx ? Engine.ctx.state : 'none',
      hidden: document.hidden, fullscreen: !!document.fullscreenElement || Stage.inStage, reducedMotion: Stage.soft };
  },
  guard() {
    if (!App.room || !isHost() || !Clock.ready || !App.connected) return;
    const show = Stage.show(), recommendation = ShowCore.recommend(App.room);
    if (!show.autoGuard || (!Instrument.active() && !this.testing) || performance.now() - this.lastGuard < 4000) return;
    let newLate = 0;
    for (const d of App.room.devices) {
      const value = (d.metrics || {}).late || d.noteLate || 0;
      if (this.baselines.has(d.id)) newLate += Math.max(0, value - this.baselines.get(d.id));
      this.baselines.set(d.id, value);
    }
    const lead = Math.min(1000, Math.max(recommendation.leadMs, newLate ? show.lead + 40 : show.lead));
    if (lead > show.lead) {
      this.lastGuard = performance.now();
      send({ t: 'show-config', patch: { lead } });
      $('#diagnostic-test-status').textContent = `Timing guard increased gesture lead to ${lead} ms${newLate ? ' after missed deadlines' : ' for measured network/output headroom'}.`;
    }
  },
  render() {
    if (!App.room || !isHost()) return;
    const rec = ShowCore.recommend(App.room);
    $('#diagnostic-summary').textContent = `${rec.ready} audio-ready · ${rec.notes} scheduled · ${rec.late} late · suggested lead ${rec.leadMs} ms`;
    const ms = (v) => Number.isFinite(v) ? `${v.toFixed(1)} ms` : '—';
    $('#diagnostic-devices').replaceChildren(...App.room.devices.map((d) => {
      const m = d.metrics || {}, row = document.createElement('tr');
      for (const value of [d.name, m.audioState || 'waiting', ms(m.rttP95), ms(m.jitter), ms(m.slackP05), `${m.late || 0} / ${m.played || 0}`, ms(m.frameP95)]) {
        const cell = document.createElement('td'); cell.textContent = value; row.append(cell);
      }
      return row;
    }));
    $('#diagnostic-warnings').replaceChildren(...rec.warnings.map((warning) => { const li = document.createElement('li'); li.textContent = warning; return li; }));
    if (performance.now() - this.lastRecord > 5000) {
      this.lastRecord = performance.now();
      this.history.push({ at: Clock.now(), ...rec }); if (this.history.length > 360) this.history.shift();
    }
    this.guard();
  },
  startTest() {
    if (!isHost() || !Clock.ready) return;
    if (Live.sending || Ranger.running) { toast('Stop streaming or finish mapping before soundcheck'); return; }
    if (!App.room.devices.some((d) => d.pos && d.instrumentReady)) { toast('Place and enable the phones first'); return; }
    if (this.testing) { this.stopTest(); return; }
    send({ t: 'instrument-mode', on: true });
    send({ t: 'diagnostic-mark', kind: 'soundcheck-start' });
    this.testing = true; this.testStart = Clock.now() + 1000; this.testNext = 0;
    $('#run-soundcheck').textContent = 'Stop soundcheck';
  },
  stopTest() {
    if (!this.testing) return;
    this.testing = false;
    $('#run-soundcheck').textContent = 'Run 30-second soundcheck';
    $('#diagnostic-test-status').textContent = 'Soundcheck ended. Device reports and tuning history are ready to inspect.';
    if (isHost()) { send({ t: 'diagnostic-mark', kind: 'soundcheck-end' }); send({ t: 'instrument-panic' }); }
  },
  pumpTest() {
    if (!this.testing) return;
    if (!isHost() || !App.connected || document.hidden) { this.stopTest(); return; }
    const now = Clock.now(), lead = Stage.show().lead;
    if (now > this.testStart + 30000) { this.stopTest(); return; }
    if (!Instrument.active()) return;
    $('#diagnostic-test-status').textContent = `Soundcheck: ${Math.max(0, Math.ceil((this.testStart + 30000 - now) / 1000))} seconds left · one gentle note per second; automatic timing guard ${Stage.show().autoGuard ? 'on' : 'off'}.`;
    const at = this.testStart + this.testNext * 1000;
    if (at <= now + lead + 250 && this.testNext < 30) {
      this.testNext++;
      if (at < now + lead) return;
      send({ t: 'instrument-note', at, pos: { x: 0, y: 0 }, midi: 74, voice: 'sine',
        duration: 0.12, velocity: 0.3, spread: 12, palette: 'mint' });
    }
  },
  export(report) {
    const content = { ...report, localTestHistory: this.history, exportedAt: new Date().toISOString() };
    const url = URL.createObjectURL(new Blob([JSON.stringify(content, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = `ensemble-${App.room.code}-diagnostics.json`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },
  init() {
    if (typeof PerformanceObserver !== 'undefined') {
      try { new PerformanceObserver((list) => { this.longTasks += list.getEntries().length; }).observe({ type: 'longtask', buffered: true }); } catch {}
    }
    $('#run-soundcheck').addEventListener('click', () => this.startTest());
    $('#download-diagnostics').addEventListener('click', () => send({ t: 'diagnostics-request' }));
    setInterval(() => this.pumpTest(), 50);
  },
};
