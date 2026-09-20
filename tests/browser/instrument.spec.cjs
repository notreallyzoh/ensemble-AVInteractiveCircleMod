const { test, expect } = require('@playwright/test');
async function start(page, name) {
  await page.goto('/');
  await page.locator('#device-name').fill(name);
  await page.locator('#btn-host').click();
  await expect(page.locator('#session')).toBeVisible();
  await page.waitForFunction(() => Clock.ready && App.room.devices.some((d) => d.instrumentReady));
  return page.locator('#room-code').innerText();
}
async function join(page, code) {
  await page.goto('/#' + code);
  await page.locator('#device-name').fill('Phone');
  await page.locator('#btn-join').click();
  await expect(page.locator('#session')).toBeVisible();
  await page.waitForFunction(() => Clock.ready && me().instrumentReady);
}
test('two independent browsers receive sound events, pan, mute, drop late notes and panic', async ({ page, browser }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const code = await start(page, 'Host');
  const guestContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const guest = await guestContext.newPage();
  guest.on('pageerror', (e) => errors.push(e.message));
  await join(guest, code);
  await page.waitForFunction(() => App.room.devices.length === 2 && App.room.devices.every((d) => d.instrumentReady));
  await page.locator('#place-circle').click();
  await page.waitForFunction(() => App.room.devices.every((d) => !!d.pos));
  await page.locator('#instrument-toggle').click();
  await guest.waitForFunction(() => Instrument.active());
  // Budget generously on a CI machine; this verifies scheduling, not physical latency.
  await page.locator('#instrument-lead').fill('300');
  // Start observing PCM before the gesture: a short note can finish while remote
  // assertions run, especially with the Workers emulator sharing the CPU.
  await guest.evaluate(() => {
    window.heardPCM = false;
    const timer = setInterval(() => {
      const data = new Float32Array(Engine.analyser.fftSize); Engine.analyser.getFloatTimeDomainData(data);
      if (data.some(v => Math.abs(v) > 0.001)) { window.heardPCM = true; clearInterval(timer); }
    }, 10);
    setTimeout(() => clearInterval(timer), 10000);
  });
  await page.getByRole('button', { name: 'Play D3 (A)', exact: true }).click();
  await page.waitForFunction(() => Instrument.played === 1);
  await guest.waitForFunction(() => Instrument.played === 1);
  await expect(guest.locator('#instrument-toggle')).toBeHidden();
  await expect(guest.locator('#note-keys')).toBeHidden();
  const schedules = await Promise.all([page, guest].map((p) => p.evaluate(() => [...Instrument.voices.get('sine')].filter((v) => v.availableAt > 0).length)));
  expect(schedules).toEqual([1, 1]);
  // Verify actual nonzero PCM in the local audio graph, rather than UI counters alone.
  await guest.waitForFunction(() => window.heardPCM);
  await guest.locator('#instrument-local-mute').click();
  await page.waitForFunction(() => App.room.devices.find((d) => !d.isHost).muted);
  await page.getByRole('button', { name: 'Play F3 (S)', exact: true }).click();
  await page.waitForFunction(() => Instrument.played === 2);
  expect(await guest.evaluate(() => Instrument.played)).toBe(1);
  await guest.locator('#instrument-local-mute').click();
  await page.waitForFunction(() => !App.room.devices.find((d) => !d.isHost).muted);
  // A delayed delivery must not fire a stale note immediately.
  await guest.evaluate(() => Instrument.receive({ t: 'instrument-note', seq: Instrument.sequence + 1,
    at: Clock.now() - 200, pos: { x: 0, y: 0 }, midi: 62, voice: 'sine', spread: 1,
    duration: 0.2, velocity: 0.5, gains: { [App.id]: 1 } }));
  expect(await guest.evaluate(() => Instrument.late)).toBe(1);
  await page.locator('#instrument-panic').click();
  await expect.poll(() => page.evaluate(() => Instrument.voices.size)).toBe(0);
  await page.locator('#instrument-toggle').click();
  await guest.waitForFunction(() => !Instrument.active());
  await page.locator('#instrument-toggle').click();
  await guest.waitForFunction(() => Instrument.active());
  // A suspended/disconnected network must cancel notes queued into the future.
  await guest.evaluate(() => onDisconnected());
  expect(await guest.evaluate(() => Instrument.voices.size)).toBe(0);
  await page.locator('#instrument-toggle').click();
  await guest.waitForFunction(() => !Instrument.active());
  await page.screenshot({ path: 'test-results/host-desktop.png', fullPage: true });
  await guest.screenshot({ path: 'test-results/phone.png', fullPage: true });
  expect(await guest.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
  await guestContext.close();
});
test('manual coordinates, keyboard playing, map import and existing file playback', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await start(page, 'Solo');
  await page.locator('#speaker-x').fill('-2');
  await page.locator('#speaker-y').fill('1.5');
  await page.locator('#place-coordinate').click();
  await page.waitForFunction(() => me().pos && me().pos.x === -2 && me().pos.y === 1.5);
  // Exercise the actual import button with a known solved map.
  await page.evaluate(() => {
    Ranger.map = { ids: [App.id], points: [{ x: 1, y: -2 }], roles: { [App.id]: 'mono' },
      delays: { [App.id]: 0 }, coverage: 1, stress: 0 };
    Instrument.render();
  });
  await page.locator('#use-acoustic').click();
  await page.waitForFunction(() => me().posSource === 'acoustic' && me().pos.x === 1);
  await expect(page.locator('#speaker-x')).toHaveValue('1.0');
  await expect(page.locator('#speaker-y')).toHaveValue('-2.0');
  await page.evaluate(() => { Ranger.map = null; });
  await page.locator('#instrument-toggle').click();
  await page.locator('#instrument-lead').fill('300');
  await page.locator('#sound-field').focus();
  await page.keyboard.press('ArrowRight');
  expect(await page.evaluate(() => Instrument.source.x)).toBe(0.25);
  await page.keyboard.press('a');
  await page.waitForFunction(() => Instrument.played === 1);
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => Instrument.voices.size)).toBe(0);
  // Disposal of scheduled oscillators must prevent a delayed attack after panic.
  await page.locator('#instrument-lead').fill('800');
  await page.locator('#sound-field').focus();
  await page.keyboard.press('a');
  await page.waitForFunction(() => Instrument.played === 2);
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => Instrument.voices.size)).toBe(0);
  await page.locator('#invite-phones').click();
  await expect(page.locator('#qr svg')).toBeVisible();
  // A tiny generated PCM file makes the preserved legacy player test self-contained.
  const frames = 48000, wav = Buffer.alloc(44 + frames * 2);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(48000, 24); wav.writeUInt32LE(96000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i++) wav.writeInt16LE(Math.round(Math.sin(i / 48000 * 440 * 2 * Math.PI) * 1000), 44 + i * 2);
  await page.locator('#file-input').setInputFiles({ name: 'test.wav', mimeType: 'audio/wav', buffer: wav });
  await expect(page.locator('#btn-play')).toBeEnabled();
  await page.locator('#btn-play').click();
  await page.waitForFunction(() => playback().mode === 'playing' && !!Engine.source);
  expect(await page.evaluate(() => Instrument.active())).toBe(false);
  expect(errors).toEqual([]);
});
test('host controls fit a small phone and motion degrades clearly', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await start(page, 'Phone host');
  await page.locator('#place-circle').click();
  await page.locator('#instrument-motion').click();
  await page.screenshot({ path: 'test-results/host-mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  for (const id of ['#instrument-toggle', '#place-circle', '#place-coordinate', '#instrument-motion']) {
    const box = await page.locator(id).boundingBox(); expect(box.height).toBeGreaterThanOrEqual(44);
  }
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await page.screenshot({ path: 'test-results/host-mobile-dark.png', fullPage: true });
});
