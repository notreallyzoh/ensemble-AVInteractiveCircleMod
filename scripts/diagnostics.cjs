'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..', '.local');
const code = process.argv[2];
if (!/^[A-Z0-9]{4}$/i.test(code || '')) { console.error('Usage: npm run diagnostics -- ROOM [https://deployment-or-localhost]'); process.exit(1); }
const saved = fs.existsSync(path.join(root, 'deployment.json')) ? JSON.parse(fs.readFileSync(path.join(root, 'deployment.json'))) : {};
const origin = process.argv[3] || saved.url || 'http://localhost:8080';
const token = process.env.DIAGNOSTICS_KEY || fs.readFileSync(path.join(root, 'diagnostics-token'), 'utf8').trim();
fetch(new URL(`/api/diagnostics?room=${code.toUpperCase()}`, origin), { headers: { Authorization: `Bearer ${token}` } })
  .then(async res => { if (!res.ok) throw new Error(`Diagnostics returned HTTP ${res.status}`); console.log(JSON.stringify(await res.json(), null, 2)); })
  .catch(err => { console.error(err.message); process.exitCode = 1; });
