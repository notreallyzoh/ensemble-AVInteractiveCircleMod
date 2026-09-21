# Ensemble crowd A/V stage

Everyone opens the same site, joins the host's four-letter room and taps to enable audio. Keep the phones in the foreground. The laptop hosts the show; each phone synthesizes its own sound with Tone.js, so the performance sends small timestamped events rather than a continuous audio stream.

## First room test

1. Start with 3–5 phones on the same Wi-Fi, with Bluetooth audio disconnected. Set moderate hardware volume.
2. Create a room on the laptop and join its code on the phones. Choose **Go fullscreen** on each phone. On iPhone, Add to Home Screen provides standalone display where native fullscreen is unavailable.
3. Place the phones on the spatial map: use the circle as a starting point, then drag each node to its real position in metres. Sensors do not automatically provide reliable indoor coordinates; acoustic mapping remains experimental.
4. Run the 30-second soundcheck. Watch p95 network delay, clock jitter, scheduling margin, late notes and rendering time. Automatic timing guard raises lead time when needed; it never quietly lowers it mid-show.
5. Start the polyrhythm. Lane A and B divide one shared bar independently, initially 3 against 4. Change tempo, divisions, source movement, master level, palette and visual style. The metronome can add an audible shared beat.
6. Use the host's keyboard/pads or spatial surface for live gestures. Phone previews and map nodes show scheduled visual activity. A separate cue can light one screen or the whole crowd even without a note.
7. **Stop** cancels queued synthesis; **Blackout screens** leaves audio playing. Each participant retains local mute, brightness and reduced-motion controls.

## Optional performance tools

The host control desk opens immediately. **Room & sharing** opens its side panel for creating a room, joining one, and sharing its QR code. On phones the panel closes after joining. Performance controls remain disabled until a room is connected.

All three options below start **unchecked** for every new room. They are host-controlled and independent.

- **Record spatial gestures:** Start the instrument, enable this option, then record pad/keyboard/sound-field notes. Finish recording and replay the phrase, optionally looping it. The phrase stores positions, pitches, voices, spread, duration and velocity; it is limited to 60 seconds/256 notes and saved only in this browser. Disabling the feature or using silence stops replay. It does not record the automatic polyrhythm or microphone audio.
- **Assign musical roles to groups:** Select phones and assign one role together, or change each role individually. Full ensemble receives everything. Melody follows Lane A and manual gestures. Bass follows the same material one octave lower with a sine voice. Pulse follows Lane B and the audible metronome. Visual-only nodes keep light cues without instrument audio. With the checkbox off, the normal full-ensemble routing returns; saved assignments are ignored.
- **Microphone timing calibration:** Stop all sound, place 2–12 unmuted audio-ready speakers, enter the reference microphone's room coordinates, then press Measure on the laptop. Only that button requests microphone permission. Keep the microphone and phones still while three chirps per speaker are measured. At least two confident detections with no more than 15 ms spread are required per speaker. The calculation subtracts mapped sound-travel distance, retains manual trims, and estimates extra delay for faster speakers relative to the slowest. Review the results and explicitly apply them. Offsets affect the Tone.js instrument only; disabling the checkbox bypasses them, and Clear offsets removes them. Microphone audio is processed locally and discarded when capture ends.

Calibration is experimental: a shared microphone avoids comparing unrelated input delays, but echoes, unknown microphone processing and inaccurate coordinates can bias estimates. Its confidence threshold is a chirp detection heuristic, not a certified accuracy estimate. Test with real devices and listen after applying results. Existing live-stream calibration and acoustic mapping remain separate; finish one measurement before starting another. Changing routing/calibration options cancels queued instrument notes to prevent old settings from sounding after the change.

## Diagnostics accessible from this chat

Tell the assistant your room code and ask it to inspect the current test. This workspace can run:

```powershell
npm run diagnostics -- ABCD
# Explicit local server instead of the saved cloud deployment:
npm run diagnostics -- ABCD http://localhost:8080
```

The read-only API uses a private bearer token kept in `.local/diagnostics-token` and a Cloudflare Worker secret named `DIAGNOSTICS_KEY`. Neither is included in the repository or browser. It returns connected-device metrics and the last 120 room configuration/test events, not microphones or raw audio. The host can also download JSON, including its in-tab measurement history. This is on-demand access; the chat does not silently monitor you between messages.

Measurements describe browser scheduling and rendering, not measured speaker-to-ear latency, physical display scanout or sample-accurate synchronization. Different phone audio paths still need acoustic calibration/listening checks. Cloudflare adds an Internet round trip even on shared Wi-Fi. For the lowest latency, use the included local Node server; use HTTPS for mobile sensor/microphone permissions. The cloud app is convenient and secure to join, with adaptive scheduling lead rather than a promise of zero latency.

## Cloud deployment

```powershell
npm ci
npm test
npm run test:browser
npx wrangler login
npm run deploy
# Provision a secret using a securely generated local token, never commit it:
npx wrangler secret put DIAGNOSTICS_KEY
```

The account ID in `wrangler.jsonc` belongs to this installation; change it when forking. One SQLite-backed Durable Object coordinates each room and uses hibernating WebSockets. Room controls and private connection attachments survive hibernation. Closed host connections stop the sequencer; a surviving participant is promoted. Deployment disconnects sockets, so deploy between shows. Empty rooms expire after up to 24 hours from the next cleanup alarm. Cloud rooms accept 64 WebSockets and tracks up to 16 MB; LAN uploads support 200 MB. Track upload is host-authenticated. The public four-letter code is a participation invitation, not a private-room password.

To test the cloud runtime locally: `npm run dev:cloud`, then set `TEST_URL=http://127.0.0.1:8092` when running Playwright. The existing GitHub Pages workflow remains a separate P2P fallback; its rooms are not shared with the Worker and its diagnostics are exported from the host UI.

## Next experiments

- Record and replay spatial gestures as phrases, with quantization to either rhythm lane.
- Give groups different musical roles—bass, pulse, texture, light—while participants can opt into visual-only performance.
- Add a calibration ritual: identify each phone with a soft tone/colour, measure relative arrival with a reference microphone, and store per-device timing trims with confidence scores.
- Build scene transitions and a conductor timeline for rehearsable shows, while retaining live improvisation.
- Test a camera-visible fiducial marker on each phone for periodic position correction; treat motion sensors as expressive controls between fixes, not reliable indoor tracking.
- Measure battery/network/load at increasing crowd sizes before attempting large public performances.

References: [Cloudflare hibernating WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/), [Worker static assets](https://developers.cloudflare.com/workers/static-assets/routing/worker-script/), [Fullscreen API](https://developer.mozilla.org/en-US/docs/Web/API/Fullscreen_API), [Tone.js](https://tonejs.github.io/).
