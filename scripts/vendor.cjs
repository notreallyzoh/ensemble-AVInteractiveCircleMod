const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
for (const [from, to] of [
  ['build/Tone.js', 'Tone.js'], ['build/Tone.js.LICENSE.txt', 'Tone.js.LICENSE.txt'], ['LICENSE.md', 'Tone.LICENSE.md'],
]) fs.copyFileSync(path.join(root, 'node_modules/tone', from), path.join(root, 'public/vendor', to));
console.log('Vendored Tone.js 15.1.22 with its licenses. Static and offline hosting are ready.');
