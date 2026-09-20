/* Pure spatial and timing math, shared by the browser, room authority and tests. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Spatial = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  const finite = (n) => typeof n === 'number' && Number.isFinite(n);
  // Web Audio's DynamicsCompressorNode (inside Tone.Limiter) has 6 ms lookahead.
  const GRAPH_LATENCY_MS = 6;
  function position(p) {
    if (!p || !finite(p.x) || !finite(p.y)) return null;
    return { x: clamp(p.x, -50, 50), y: clamp(p.y, -50, 50) };
  }
  function note(input) {
    if (!input || !position(input.pos) || !finite(input.at) ||
        !finite(input.midi) || !finite(input.velocity) || !finite(input.duration) ||
        !finite(input.spread) || !['sine', 'triangle', 'bell'].includes(input.voice)) return null;
    return { at: input.at, pos: position(input.pos), midi: Math.round(clamp(input.midi, 36, 96)),
      velocity: clamp(input.velocity, 0, 1), duration: clamp(input.duration, 0.05, 2),
      spread: clamp(input.spread, 0.3, 12), voice: input.voice };
  }
  // Gaussian distance panning, normalized in power. Subtract the nearest squared
  // distance before exponentiation to avoid underflow for distant sources.
  // This distributes energy across real speakers; it is not binaural rendering.
  function gains(devices, source, spread) {
    if (!position(source) || !finite(spread)) return {};
    const placed = devices.filter((d) => position(d.pos) && !d.muted && d.instrumentReady);
    if (!placed.length) return {};
    const distances = placed.map((d) => (d.pos.x - source.x) ** 2 + (d.pos.y - source.y) ** 2);
    const nearest = Math.min(...distances);
    const variance = Math.max(0.3, spread) ** 2;
    const weights = distances.map((d) => Math.exp(-(d - nearest) / (2 * variance)));
    const norm = Math.sqrt(weights.reduce((sum, w) => sum + w * w, 0));
    return Object.fromEntries(placed.map((d, i) => [d.id, weights[i] / norm]));
  }
  function recommendedLead(devices, hostId) {
    const host = devices.find((d) => d.id === hostId);
    const hostTrip = host && finite(host.rtt) ? host.rtt / 2 : 0;
    return Math.ceil(Math.max(60, ...devices.filter((d) => d.instrumentReady && !d.muted).map((d) =>
      25 + GRAPH_LATENCY_MS + hostTrip + (d.rtt || 0) / 2 + (d.lat || 0) + 3 * (d.clockJitter || 0) + Math.max(0, -(d.trim || 0)))) / 10) * 10;
  }
  // Late notes are dropped, never played on arrival: a gap is preferable to an echo.
  function scheduleDecision(contextNow, targetTime) {
    if (!finite(contextNow) || !finite(targetTime)) return { play: false, slackMs: null };
    const slackMs = (targetTime - contextNow) * 1000;
    return { play: slackMs >= 5, slackMs };
  }
  return { GRAPH_LATENCY_MS, position, note, gains, recommendedLead, scheduleDecision };
}));
