'use strict';
const Desk = {
  ready:false,
  open() { $('#room-panel').hidden=false; $('#room-panel-toggle').setAttribute('aria-expanded','true'); },
  close() { $('#room-panel').hidden=true; $('#room-panel-toggle').setAttribute('aria-expanded','false'); $('#room-panel-toggle').focus(); },
  refresh() {
    if(!this.ready) return;
    const joined=!!App.room && App.connected;
    $('#session').hidden=false; $('#landing').hidden=joined; $('.invite').hidden=!joined;
    $('#desk-controls').disabled=!joined;
    $('#desk-intro').hidden=joined;
    $('#room-panel-title').textContent=joined ? `Room ${App.room.code}` : 'Create or join a room';
    $('#btn-leave').hidden=!joined; $('#enter-stage').hidden=!joined; $('#sync-pill').hidden=!joined; $('#invite-phones').hidden=!joined;
    if(!App.room) { $('#show-desk').hidden=false; $('#diagnostics-panel').hidden=true; $('#show-title').textContent='Ensemble control desk'; }
    Extras.render();
  },
  init() {
    const panel=document.createElement('aside');panel.id='room-panel';panel.setAttribute('aria-labelledby','room-panel-title');
    const header=document.createElement('div');header.className='panel-heading';
    const title=document.createElement('h2');title.id='room-panel-title';title.textContent='Create or join a room';
    const close=document.createElement('button');close.className='btn ghost';close.textContent='Close';close.addEventListener('click',()=>this.close());header.append(title,close);
    panel.append(header,$('#landing'),$('.invite'));document.body.append(panel);
    $('#landing .wordmark').hidden=true; $('#landing .lede').textContent='Give this device a name, then invite your ensemble or join their room.';
    $('#btn-host').textContent='Create room';
    const toggle=document.createElement('button');toggle.id='room-panel-toggle';toggle.className='btn primary';toggle.textContent='Room & sharing';toggle.setAttribute('aria-controls','room-panel');toggle.setAttribute('aria-expanded','true');toggle.addEventListener('click',()=>panel.hidden?this.open():this.close());
    $('.topbar').insertBefore(toggle,$('#invite-phones'));
    const intro=document.createElement('p');intro.id='desk-intro';intro.textContent='Your control desk is ready. Create a room in the side panel to enable sound and invite phones.';$('.topbar').after(intro);
    const controls=document.createElement('fieldset');controls.id='desk-controls';controls.setAttribute('aria-label','Performance controls');
    for(const child of [...$('#session').children]) if(child!==$('.topbar')&&child!==intro) controls.append(child);
    $('#session').append(controls);this.ready=true;this.refresh();
    document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!panel.hidden&&!Stage.inStage)this.close();});
  },
};
