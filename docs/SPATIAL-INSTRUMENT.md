# A room people can play

Study and first implementation, 21 September 2026. Foundation: upstream commit
`486ef00`; working branch `codex/spatial-instrument`.

The first setting is one physical room, one Wi-Fi network, one host performer,
and participants' phones acting as speakers. The artistic unit is the room:
joining, placing a phone, moving a sound and hearing its location become parts
of the work. A browser link keeps that participation inexpensive and immediate.

## What the foundation already does well

| Module | Existing responsibility | Why it matters |
| --- | --- | --- |
| `room-core.js` | Shared authoritative room state | Browser-hosted WebRTC and server-hosted WebSocket modes use the same rules. |
| `audio.js` | Clock offset/skew fit, output timestamp conversion, file playback and drift correction | The instrument can reuse an established clock instead of inventing another. |
| `net.js` / `server.js` | P2P or LAN room transport, file transfer | A local session needs neither an account nor a cloud audio service. |
| `live.js` / `mesh.js` | Buffered live audio and distribution tree | Useful for shared media, but audio encoding and buffering add delay to performance. |
| `acoustic.js` / `position.js` | Chirp detection, pairwise ranging, MDS layout and delay estimates | Promising initial geometry; it needs real-room validation. |
| `app.js` | Device controls, wake lock, battery, optional motion/haptics | Existing participation features can remain alongside the new instrument. |

Several claims in the original README are stronger than the available evidence.
Clock/cursor agreement is not acoustic agreement, and its Wi-Fi scaling argument
assumes a simplified airtime model. An infrastructure access point, retries,
power saving and multicast/unicast behavior change actual network load. Treat
the upstream figures as reports to reproduce, not capacities to promise.

## What changed

The host now plays a field with real device positions and a D-minor-pentatonic
note bank. Sine, triangle and FM bell voices are generated separately on every
participating phone using a vendored Tone.js build. The UI retains the original
functional visual language, adds keyboard alternatives and coordinate inputs,
and leaves denied sensors out of the critical joining path.

The control flow is:

```text
host gesture → timestamped note → room authority → every ready speaker
                                  │                    │
                          validate + compute gains     ├─ shared clock → audio time
                                                       └─ local Tone voice → speaker
```

The host chooses an audible deadline using the room clock plus a configurable
gesture lead. The authority accepts notes only from the current host, validates
and bounds their values, rejects obsolete/far-future deadlines, limits event
rate, and attaches one gain map computed from the current room geometry. It
does not broadcast a complete device roster for each musical event.

Each phone converts the deadline through the existing `getOutputTimestamp()`
bridge, applies its trim and compensates for the limiter graph's nominal 6 ms
lookahead. The output timestamp relates the audio clock to the performance
clock; it still does not measure sound travelling to a person's ears.
[MDN timing reference](https://developer.mozilla.org/en-US/docs/Web/API/AudioContext/getOutputTimestamp),
[Web Audio compressor specification](https://www.w3.org/TR/webaudio-1.0/#DynamicsCompressorNode).

Tone shares Ensemble's native AudioContext. The code uses direct `Synth` and
`FMSynth` voices with explicit times and a bounded pool, avoiding the deferred
voice-allocation path found in the installed PolySynth source. Explicit times
also avoid accidentally adding Tone's ordinary `now()` lookahead to the network
budget. [Tone performance guidance](https://github.com/Tonejs/Tone.js/wiki/Performance),
[Tone Context](https://tonejs.github.io/docs/15.1.22/classes/Context.html).

At most eight overlapping notes per timbre are allocated on a device. Overload
is shown separately from missed timing deadlines. Late notes are dropped instead
of firing immediately out of time. Panic disposes both current and scheduled
voices. Muting, leaving the foreground and losing the connection silence local
instrument output; the host can silence the room with Escape.

### Spatial meaning

For source position `s` and device position `p_i`, this version calculates
`w_i = exp(-distance(s, p_i)^2 / (2 × spread^2))`, then normalizes the gains so
`sum(g_i^2) = 1`. A numerical stabilization prevents distant sources from
underflowing. Unplaced, muted or audio-unready devices are excluded. A tighter
spread concentrates energy near a phone; a wider spread shares it across the room.

This is **distance-based amplitude panning across physical speakers**. It does
not reconstruct a wavefront or guarantee a phantom source at the exact drawn
point. Phone frequency response, volume settings, room reflections, correlated
signals and listener position affect what people hear. Power normalization is
an electrical mixing rule, not a guarantee of constant perceived loudness.

A sound's position applies to a new note at its onset. Dragging scatters short
notes along a path; it does not yet continuously move the tail of a sustained
voice. This is a deliberate first performance model. Continuous held voices
need timestamped trajectory automation and a separate interpolation design.

## Localization: make the uncertainty visible

| Method | Appropriate role | Current state |
| --- | --- | --- |
| Manual map, numbered phones, X/Y coordinates | Reliable baseline in any room; the host supplies geometry | Implemented. Circle layout is explicitly an assigned starting point. |
| Acoustic chirps | Estimate static distances from speakers/mics people already own | Existing experiment connected to the instrument; position persistence fixed. |
| Accelerometer / gyro | Detect a moved device; future tilt or gesture controls | Optional movement reminder implemented. No fictitious absolute tracking. |
| Camera + printed fiducial markers | Future repeatable anchor observations; shared room coordinate frame | Proposed next localization experiment; not implemented. |
| UWB / native AR | Higher capability installations with supported hardware and native software | Optional future adapter; not part of this web prototype. |
| GPS / browser geolocation | Geographic context, not the default source of room geometry | Not requested by the prototype. |
| Bluetooth | Optional peripheral integration | Not used as a universal phone-to-phone positioning system. |

Motion APIs report acceleration/rotation rather than a shared room coordinate.
Permissions and browser support vary; permission requests may require a direct
user action and HTTPS. The new movement button handles denial and unsupported
devices explicitly. [Motion permission reference](https://developer.mozilla.org/en-US/docs/Web/API/DeviceMotionEvent/requestPermission_static).

Browser geolocation provides geographic coordinates and an accuracy estimate;
it is not a shared indoor tracking API. Web Bluetooth exposes BLE peripherals
with limited browser availability, which makes it a poor baseline for arbitrary
participants' phones. [Geolocation](https://developer.mozilla.org/en-US/docs/Web/API/Geolocation_API),
[Web Bluetooth](https://developer.mozilla.org/en-US/docs/Web/API/Web_Bluetooth_API).

Apple's Nearby Interaction can expose distance/direction on supported UWB
devices through native frameworks. That is a possible enhancement, with a
separate native deployment and compatibility cost.
[Apple Nearby Interaction](https://developer.apple.com/documentation/nearbyinteraction).

The acoustic mapper's symmetrical range equation is a useful starting point,
but the present solver fills missing distances with an average and clamps
implausible values. Those inferred edges can yield a neat-looking, incorrect
map. A self-loop also includes microphone/input effects; it should not be
treated as a pure speaker latency measurement. Import coordinates separately
from trims and verify known distances before relying on automatic alignment.

Next improve that mapper with repeated bidirectional observations, confidence
thresholds, rejection of impossible ranges, graph connectivity checks and robust
stress fitting over measured edges only. Preserve manual anchor coordinates and
show per-node uncertainty. Distance-only geometry retains rotation/reflection
ambiguities, so a chosen front anchor and explicit mirror control are necessary.

Microphone access requires a secure context. The local server now supports
`TLS_CERT` and `TLS_KEY`; certificates must be trusted on every device. The
mapper releases microphone streams when the host finishes, and acoustic command
relays are accepted only from the host. No new recording upload is introduced.
[Microphone context requirements](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia).

## Latency: what to optimize, what to measure

Keep these quantities separate:

1. **Gesture delay:** hand action to sound. Smaller lead helps, until deliveries miss deadlines.
2. **Device alignment:** difference between phones sounding the same intended onset.
3. **Acoustic arrival:** when sound reaches a particular listener; geometry adds propagation time.
4. **Position error:** whether the stored speaker coordinates describe the real room.

The new instrument removes audio encoding, network audio chunking and decoding
from the gesture path. It does not remove Wi-Fi jitter or the phone output
pipeline. Browser `outputLatency` is an estimate; output-timestamp validity and
device-specific behavior still matter.
[Output latency reference](https://developer.mozilla.org/en-US/docs/Web/API/AudioContext/outputLatency).

The initial 100 ms lead is a starting value, not an achieved minimum. The
estimate button combines reported host/receiver half RTT, output latency, clock
jitter, negative trim and scheduling margin. Low RTT samples can hide bad tail
latency: play a representative passage and use actual deadline misses to tune.
The UI reports scheduled notes, late notes and last scheduling margin. It does
not label any of those as measured speaker-to-ear latency.

For repeatable pieces, a future sequencer can announce notes well ahead of time
while preserving exact rhythmic timing. For direct gestures, an optional local
monitor could feel more immediate, but must be explicitly separate from room
playback to avoid an unintended double attack. The present version schedules
the host through the same authority/deadline as every phone.

## Development sequence

1. **Characterize a small real room.** Three phones plus the host; built-in speakers;
   consistent volume and position. Establish measured onset spread and missed-note
   counts over at least ten minutes before lowering lead.
2. **Make calibration trustworthy.** Repair uncertain acoustic ranges and store
   confidence, residuals, timestamps and manual anchors. Detect route changes and
   stale positions rather than silently assuming measurements still hold.
3. **Make held sound move.** Add continuous voices, interpolated timestamped source
   trajectories, expression controls and recording/replay of gestures. Quantized
   loops should use future scheduling, independent of UI rendering.
4. **Extend participation.** Add opt-in visual/haptic event cues, remappable controls,
   alternative scales and a simple permission-free guest view. Keep muted devices
   meaningful participants. Test with participants using keyboard navigation,
   magnification and screen readers.
5. **Scale from evidence.** Test 6, 12 and 24 phones on the actual router. Measure
   event-delivery percentiles and CPU/battery behavior. If the existing reliable
   ordered channel blocks musical events behind file traffic, add a dedicated
   bounded performance channel and stale-event policy; do not assume a stream
   relay tree improves every note-control workload.

## In-room acceptance session

- Record phone models, OS/browser versions, connection type, volume and audio route.
- Measure three known inter-phone distances, repeat acoustic mapping, and compare
  error, missing observations and reflection/orientation ambiguity.
- Start at 150–200 ms lead and play isolated attacks, repeated notes and dense chords.
  Reduce lead deliberately; log late/rejected notes and clock/output diagnostics.
- Record the phones from fixed, known microphone positions. Compare acoustic
  onsets with propagation distance accounted for. A pair of phones at unequal
  distances from one mic will otherwise appear falsely misaligned.
- Move a phone, deny a sensor permission, mute/unmute, disconnect Wi-Fi, reconnect,
  switch audio route, background/foreground the page and test emergency silence.
- Ask listeners at several room positions to point toward the perceived source.
  This perceptual test evaluates the spatial experience, beyond clock numbers.

Automated tests cover the new math/protocol and actual browser audio-graph output.
They do not validate iOS/Android hardware, real acoustic ranging, Bluetooth routes,
P2P signaling availability, large crowds or artistic perception. Those remain
explicit field-test tasks, rather than implied guarantees.
