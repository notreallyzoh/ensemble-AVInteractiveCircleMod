(function(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ShowExtensions = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  const ROLES = ['all', 'melody', 'bass', 'pulse', 'visual'];
  function accepts(role, lane) {
    if (!role || role === 'all') return true;
    if (role === 'visual') return false;
    if (role === 'pulse') return lane === 1 || lane === 2;
    return lane == null || lane === 0;
  }
  function calibration(rows, microphone) {
    if (rows.length < 2) throw new Error('Measure at least two speakers.');
    const measured = rows.map(row => {
      const hits = row.hits.filter(h => Number.isFinite(h.dt) && Math.abs(h.dt) < 600 && Number.isFinite(h.conf) && h.conf >= 6).sort((a,b) => a.dt-b.dt);
      if (hits.length < 2 || hits.at(-1).dt - hits[0].dt > 15) throw new Error(`${row.name}: inconsistent chirps. Keep the room quiet and retry.`);
      if (!row.pos || !Number.isFinite(row.pos.x) || !Number.isFinite(row.pos.y)) throw new Error('Place every measured speaker first.');
      const distance = Math.hypot(row.pos.x-microphone.x, row.pos.y-microphone.y);
      return { id:row.id, name:row.name, pos:row.pos, residual:hits[Math.floor(hits.length/2)].dt - distance/343*1000 + (row.trim || 0), confidence:Math.min(...hits.map(h => h.conf)), spread:hits.at(-1).dt-hits[0].dt };
    });
    const target = Math.max(...measured.map(r => r.residual));
    return measured.map(r => {
      const offset = Math.round((target-r.residual)*10)/10;
      if (offset > 500) throw new Error('Timing difference exceeds 500 ms. Check outputs and retry.');
      return { ...r, offset };
    });
  }
  return { ROLES, accepts, calibration };
});
