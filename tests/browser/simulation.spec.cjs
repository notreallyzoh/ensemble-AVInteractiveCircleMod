const {test,expect}=require('@playwright/test');
test.setTimeout(180000);

test('rehearsal uses no room transport, renders screens and produces monitor audio',async({page})=>{
  const errors=[], sockets=[], rooms=[];
  page.on('pageerror',e=>errors.push(e.message));
  page.on('websocket',s=>sockets.push(s.url()));
  page.on('request',r=>{if(r.method()==='POST'&&r.url().includes('/api/rooms')) rooms.push(r.url());});
  await page.goto('/');
  await page.locator('#room-panel .panel-heading button').click();
  await page.locator('#simulation-count').fill('12');
  await page.locator('#simulation-start').click();
  await page.waitForFunction(()=>Simulation.active&&Instrument.active()&&Clock.ready);
  expect(await page.evaluate(()=>App.room.devices.length)).toBe(12);
  await expect(page.locator('#field-speakers canvas')).toHaveCount(12);
  await expect(page.locator('#diagnostics-panel')).toBeHidden();
  await expect(page.locator('#enable-calibration')).toBeDisabled();
  await page.evaluate(()=>{
    window.monitorPeak=0;
    const values=new Float32Array(Engine.analyser.fftSize);
    window.monitorTimer=setInterval(()=>{Engine.analyser.getFloatTimeDomainData(values);for(const v of values)window.monitorPeak=Math.max(window.monitorPeak,Math.abs(v));},10);
  });
  await page.locator('#show-run').click();
  await page.waitForFunction(()=>Instrument.played>=3&&window.monitorPeak>.001);
  await page.waitForFunction(()=>[...document.querySelectorAll('#field-speakers canvas')].some(c=>{
    const pixel=c.getContext('2d').getImageData(Math.floor(c.width/2),Math.floor(c.height/2),1,1).data;return pixel[2]>30;
  }));
  await page.screenshot({path:'test-results/simulation-space.png',fullPage:true});
  await page.locator('#show-stop').click();
  await page.waitForFunction(()=>!App.room.show.running&&Stage.queue.length===0&&Instrument.voices.size===0);
  for(const count of [1,64]) {
    await page.locator('#simulation-count').fill(String(count));await page.locator('#simulation-start').click();
    await page.waitForFunction(n=>App.room.devices.length===n,count);
    await expect(page.locator('#field-speakers canvas')).toHaveCount(count);
  }
  await page.locator('#simulation-count').fill('65');await page.locator('#simulation-start').click();
  expect(await page.evaluate(()=>App.room.devices.length)).toBe(64);
  expect(sockets).toEqual([]);expect(rooms).toEqual([]);expect(errors).toEqual([]);
});

test('live transition preserves settings and assigns rehearsal slots to arriving phones',async({page,browser})=>{
  await page.goto('/');await page.locator('#room-panel .panel-heading button').click();
  await page.locator('#simulation-count').fill('3');await page.locator('#simulation-start').click();
  await page.waitForFunction(()=>Simulation.active&&Instrument.active());
  await page.evaluate(()=>{send({t:'show-config',patch:{bpm:123,a:5,b:7,rolesEnabled:true,gesturesEnabled:true}});send({t:'device',id:'virtual-1',pos:{x:-2,y:1},role:'bass'});});
  await page.waitForFunction(()=>App.room.show.bpm===123&&App.room.devices[0].role==='bass');
  const mix=await page.evaluate(()=>Simulation.monitor({midi:60,voice:'bell',gains:{'virtual-1':1},parts:{'virtual-1':{midi:48,voice:'sine'}}}));
  expect(mix[0].note.midi).toBe(48);expect(mix[0].pan).toBeLessThan(0);
  await page.locator('#room-panel-toggle').click();await page.locator('#btn-host').click();
  await page.waitForFunction(()=>!Simulation.active&&App.connected&&App.room?.show.bpm===123);
  expect(await page.evaluate(()=>({running:App.room.show.running,mode:playback().mode,pos:me().pos,a:App.room.show.a,b:App.room.show.b}))).toEqual({running:false,mode:'idle',pos:null,a:5,b:7});
  const code=await page.locator('#room-code').innerText();
  const context=await browser.newContext();const phone=await context.newPage();
  await phone.goto('/#'+code);await phone.locator('#btn-join').click();
  await page.waitForFunction(()=>App.room.devices.some(d=>!d.isHost&&d.role==='bass'&&d.pos?.x===-2));
  await expect(page.locator('#simulation-transfer')).toContainText('1 / 3');
  await expect(page.locator('#qr svg')).toBeVisible();
  await context.close();
});
