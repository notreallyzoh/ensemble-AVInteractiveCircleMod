'use strict';
const Extras = {
  recording: false, replaying: false, notes: [], started: 0, replayAt: 0, index: 0, cycle: 0, duration: 0, roleSignature: '',
  enabled(key) { return !!App.room?.show?.[key]; },
  capture(message) {
    if (!this.recording || !this.enabled('gesturesEnabled') || message.t !== 'instrument-note' || Number.isInteger(message.lane) || message.replay || Diagnostics.testing || Timing.running) return;
    const note = Spatial.note(message); if (!note) return;
    const offset = Clock.now() - this.started;
    if (offset > 60000 || this.notes.length >= 256) { this.stop(); return; }
    this.notes.push({ ...note, at: 0, offset }); this.status();
  },
  save() { store.set('ensemble.phrase', JSON.stringify({ notes:this.notes, duration:this.duration })); },
  stop() {
    if (this.recording) { this.duration = Math.max(250, Math.min(60000, Clock.now()-this.started)); this.save(); }
    const wasReplaying = this.replaying;
    this.recording = this.replaying = false;
    if (wasReplaying) send({ t:'instrument-panic' });
    this.status();
  },
  status() {
    $('#gesture-record').textContent = this.recording ? 'Finish recording' : 'Record phrase';
    $('#gesture-status').textContent = this.recording ? `Recording · ${this.notes.length} notes` : this.replaying ? `Replaying · ${this.notes.length} notes` : `${this.notes.length} notes · ${(this.duration/1000).toFixed(1)} seconds`;
  },
  pump() {
    if (!this.enabled('gesturesEnabled') || !App.connected || !isHost() || !Instrument.active() || document.hidden) {
      if (this.recording || this.replaying) this.stop(); return;
    }
    if (this.recording && Clock.now()-this.started >= 60000) this.stop();
    if (!this.replaying) return;
    const now = Clock.now(), lead = Stage.show().lead;
    for (let n = 0; n < 16; n++) {
      if (this.index >= this.notes.length) {
        const end = this.replayAt + (this.cycle+1)*this.duration;
        if (!$('#gesture-loop').checked) { if (now < end) return; this.replaying = false; this.status(); return; }
        if (now + lead + 250 < end) return;
        this.index = 0; this.cycle++;
      }
      const note = this.notes[this.index], at = this.replayAt + this.cycle*this.duration + note.offset;
      if (at > now + lead + 250) return;
      this.index++;
      if (at < now + 10) continue;
      send({ ...note, at, t:'instrument-note', replay:true });
      Instrument.source = note.pos; Instrument.drawSource(note.spread);
    }
  },
  render() {
    $('#extensions').hidden = !!App.room && !isHost();
    for (const [name, key, area] of [['gestures','gesturesEnabled','gesture-controls'],['roles','rolesEnabled','role-controls'],['calibration','calibrationEnabled','timing-controls']]) {
      $('#enable-'+name).checked = this.enabled(key); $('#'+area).hidden = !this.enabled(key);
    }
    if (!this.enabled('gesturesEnabled') && (this.recording || this.replaying)) this.stop();
    if ((!this.enabled('calibrationEnabled') || !isHost()) && Timing.running) Timing.cancel();
    if (!App.room) return;
    $('.playback-details').inert = Timing.running || Simulation.active;
    $('#timing-reset').disabled = Timing.running || playback().mode !== 'idle';
    const signature = App.room.devices.map(d => `${d.id}:${d.name}`).join('|');
    if (signature !== this.roleSignature) {
      this.roleSignature = signature;
      $('#role-devices').replaceChildren(...App.room.devices.map(d => {
        const row = document.createElement('div'); row.className = 'role-row'; row.dataset.id = d.id;
        const label = document.createElement('label'), select = document.createElement('select'), check = document.createElement('input'); check.type = 'checkbox';
        label.append(check, document.createTextNode(d.name));
        select.setAttribute('aria-label', `Musical role for ${d.name}`);
        for (const [i,role] of ShowExtensions.ROLES.entries()) select.add(new Option(['Full ensemble','Melody · A + hands','Bass · octave below','Pulse · B + beat','Visual only'][i],role));
        select.addEventListener('change', () => send({t:'device',id:d.id,role:select.value})); row.append(label,select); return row;
      }));
    }
    for (const row of $('#role-devices').children) {
      const select = row.querySelector('select'); if (select !== document.activeElement) select.value = App.room.devices.find(d => d.id===row.dataset.id)?.role || 'all';
    }
    $('#timing-apply').disabled = Timing.running || !Timing.results.length || playback().mode !== 'idle';
  },
  init() {
    try {
      const saved = JSON.parse(store.get('ensemble.phrase') || 'null');
      if (saved && Number.isFinite(saved.duration) && saved.duration >= 250 && saved.duration <= 60000 && Array.isArray(saved.notes)) {
        this.notes = saved.notes.slice(0,256).filter(n => Spatial.note(n) && Number.isFinite(n.offset) && n.offset >= 0 && n.offset <= saved.duration).sort((a,b)=>a.offset-b.offset); this.duration = saved.duration;
      }
    } catch {}
    for (const [name,key] of [['gestures','gesturesEnabled'],['roles','rolesEnabled'],['calibration','calibrationEnabled']]) $('#enable-'+name).addEventListener('change', e => send({t:'show-config',patch:{[key]:e.target.checked}}));
    $('#gesture-record').addEventListener('click', () => {
      if (this.recording) { this.stop(); return; }
      if (!Instrument.active()) { toast('Start the instrument first'); return; }
      this.stop(); this.notes = []; this.duration = 0; this.started = Clock.now(); this.recording = true; this.status();
    });
    $('#gesture-replay').addEventListener('click', () => {
      if (this.replaying) { this.stop(); return; }
      if (!Instrument.active() || !this.notes.length) { toast('Start the instrument and record a phrase first'); return; }
      this.stop(); this.replaying = true; this.index = this.cycle = 0; this.replayAt = Clock.now()+Stage.show().lead+300; this.status();
    });
    $('#gesture-stop').addEventListener('click', () => this.stop());
    $('#gesture-clear').addEventListener('click', () => { this.stop(); this.notes=[];this.duration=0;this.save();this.status(); });
    $('#role-assign').addEventListener('click', () => { for (const row of $('#role-devices').children) if(row.querySelector('input').checked) send({t:'device',id:row.dataset.id,role:$('#role-bulk').value}); });
    $('#timing-measure').addEventListener('click', () => Timing.measure());
    $('#timing-cancel').addEventListener('click', () => Timing.cancel());
    $('#timing-apply').addEventListener('click', () => { if (!Timing.running && Timing.results.length) { send({t:'timing-apply', results:Timing.results}); $('#timing-status').textContent='Offsets sent to the room. Disable this option to return to manual trims only.'; } });
    $('#timing-reset').addEventListener('click', () => { send({t:'timing-reset'}); Timing.results=[]; $('#timing-results').replaceChildren(); this.render(); });
    document.addEventListener('visibilitychange', () => { if(document.hidden) { this.stop(); Timing.cancel(); } });
    setInterval(() => this.pump(),25); this.status();
  },
};

const Timing = {
  running:false, run:null, results:[], ack:null, cancelled:false,
  cancel() {
    if (!this.running) return;
    this.cancelled = true; this.ack?.(false); this.ack = null;
    Acoustic.finishCapture(); Acoustic.close();
    send({t:'timing-end',run:this.run});
    $('#timing-status').textContent='Measurement cancelled. Existing offsets are unchanged.';
  },
  async measure() {
    if (this.running || !isHost() || !Extras.enabled('calibrationEnabled')) return;
    if (!Acoustic.supported()) { $('#timing-status').textContent=Acoustic.unsupportedReason(); return; }
    if (!Clock.ready || playback().mode !== 'idle' || Live.sending || Ranger.running || Acoustic.busy || Acoustic.node || Engine.calibrating) { toast('Stop all sound and finish other microphone measurements first'); return; }
    const devices = App.room.devices.filter(d => d.instrumentReady && !d.muted && d.volume > 0 && d.pos && (!Extras.enabled('rolesEnabled') || d.role !== 'visual'));
    if (devices.length < 2 || devices.length > 12) { toast('Place and enable 2–12 speakers for this measurement'); return; }
    for (const id of ['#timing-x','#timing-y']) if (!$(id).reportValidity() || $(id).value==='') return;
    const mic = {x:Number($('#timing-x').value),y:Number($('#timing-y').value)};
    this.running=true;this.cancelled=false;this.run=crypto.randomUUID();this.results=[]; Extras.render();
    const rows=[];
    try {
      await Acoustic.open();
      if (this.cancelled) return;
      const acknowledged = new Promise(resolve => { this.ack=resolve;setTimeout(()=>resolve(false),5000); });
      send({t:'timing-begin',run:this.run});
      if (!await acknowledged) throw new Error('The room did not start calibration. Stop playback and retry.');
      for (const device of devices) {
        const hits=[];
        for(let round=0;round<3;round++) {
          if(this.cancelled || !App.connected || !isHost() || !Extras.enabled('calibrationEnabled')) return;
          $('#timing-status').textContent=`Listening for ${device.name} · chirp ${round+1} of 3. Keep the microphone still.`;
          const at=Clock.now()+Stage.show().lead+700;
          const recording=Acoustic.record(2400);
          send({t:'timing-chirp',id:device.id,at,run:this.run});
          const rec=await recording;
          if(this.cancelled) return;
          const hit=rec.startCtx == null ? null : Acoustic.detect(rec,Engine.scheduleAt(at)-0.025);
          if(hit) hits.push({dt:Acoustic.serverTimeOfCtx(hit.ctxTime)-at,conf:hit.conf});
        }
        rows.push({...device,hits});
      }
      this.results=ShowExtensions.calibration(rows,mic);
      $('#timing-results').replaceChildren(...this.results.map(r=> {const p=document.createElement('p');p.textContent=`${r.name}: +${r.offset.toFixed(1)} ms · confidence ${r.confidence.toFixed(1)} · spread ${r.spread.toFixed(1)} ms`;return p;}));
      $('#timing-status').textContent='Measurement ready. Review the proposed offsets, then apply them. Repeat after moving phones or changing their audio outputs.';
    } catch(error) { $('#timing-status').textContent=error.message || 'Microphone measurement failed. No offsets changed.'; }
    finally { Acoustic.finishCapture();Acoustic.close();send({t:'timing-end',run:this.run});this.running=false;this.ack=null;Extras.render(); }
  },
};
