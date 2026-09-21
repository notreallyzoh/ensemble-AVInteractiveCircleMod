const { test } = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../public/room-core.js');
const Extra = require('../public/extensions-core.js');
function fixture() {
  const room=Core.createRoom('TEST'), events=[];
  const ctx={now:()=>1000,send:(id,m)=>events.push(m),broadcast:m=>events.push(m)};
  const host=Core.join(room,ctx,{id:'h',key:'host'}), phone=Core.join(room,ctx,{id:'p',key:'phone'});
  for(const d of [host,phone]) {d.pos={x:0,y:0};d.instrumentReady=d.visualReady=true;}
  return {room,events,ctx,host,phone,send:(m,d=host)=>Core.handle(room,d,m,ctx)};
}
test('optional roles preserve existing gains when disabled and route both sound and visuals when enabled',()=>{
  const f=fixture(); assert.equal(f.room.show.rolesEnabled,false);assert.equal(f.room.show.gesturesEnabled,false);assert.equal(f.room.show.calibrationEnabled,false);
  f.send({t:'device',id:'p',role:'visual'});f.send({t:'instrument-mode',on:true});
  const note={t:'instrument-note',at:1300,pos:{x:0,y:0},midi:60,voice:'bell',velocity:.5,duration:.2,spread:2};
  f.send(note);assert.ok(f.events.at(-1).gains.p>0);
  f.send({t:'show-config',patch:{rolesEnabled:true}});f.send(note);
  assert.equal(f.events.at(-1).gains.p,undefined);assert.ok(f.events.at(-1).visualGains.p>0);
  f.send({t:'device',id:'p',role:'bass'});f.send(note);assert.deepEqual(f.events.at(-1).parts.p,{midi:48,voice:'sine'});
  f.send({t:'device',id:'p',role:'pulse'});f.send({...note,lane:0});assert.equal(f.events.at(-1).gains.p,undefined);
  f.send({...note,lane:1});assert.ok(f.events.at(-1).gains.p>0);
});
test('reference microphone removes shared input delay and distance without erasing manual trim',()=>{
  const hits=dt=>[dt-1,dt,dt+1].map(dt=>({dt,conf:12}));
  const result=Extra.calibration([{id:'a',pos:{x:3.43,y:0},trim:5,hits:hits(110)},{id:'b',pos:{x:0,y:0},trim:0,hits:hits(130)}],{x:0,y:0});
  assert.equal(result[0].offset,25);assert.equal(result[1].offset,0);
  assert.throws(()=>Extra.calibration([{pos:{x:0,y:0},hits:[{dt:10,conf:2}]},{pos:{x:0,y:0},hits:hits(20)}],{x:0,y:0}),/inconsistent/);
  const f=fixture();f.host.trim=17;
  f.send({t:'timing-apply',results:[{id:'h',pos:{x:0,y:0},offset:25},{id:'p',pos:{x:0,y:0},offset:0}]});assert.equal(f.host.timingTrim,0);
  f.send({t:'show-config',patch:{calibrationEnabled:true}});
  f.send({t:'timing-apply',results:[{id:'h',pos:{x:0,y:0},offset:25},{id:'p',pos:{x:0,y:0},offset:0}]});assert.equal(f.host.timingTrim,25);assert.equal(f.host.trim,17);
  f.send({t:'show-config',patch:{calibrationEnabled:false}});assert.equal(f.host.trim,17);
});
test('calibration is host-controlled, quiet, bounded and rejects stale positions',()=>{
  const f=fixture();f.send({t:'show-config',patch:{calibrationEnabled:true}});
  f.send({t:'timing-begin',run:'guest'},f.phone);assert.equal(f.room.calibrationRun,undefined);
  f.send({t:'timing-begin',run:'run'});assert.equal(f.room.calibrationRun,'run');
  f.send({t:'show-run',on:true});assert.equal(f.room.show.running,false);
  f.send({t:'timing-chirp',run:'run',id:'p',at:1500});assert.equal(f.events.at(-1).t,'timing-chirp');
  f.send({t:'timing-end',run:'run'});assert.equal(f.room.calibrationUntil,0);
  f.send({t:'timing-apply',results:[{id:'h',pos:{x:4,y:0},offset:25},{id:'p',pos:{x:0,y:0},offset:0}]});assert.equal(f.host.timingTrim,0);
});
