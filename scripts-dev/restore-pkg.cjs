const fs = require('fs');
const path = require('path');
const [,, idxPath, destDir] = process.argv;
const idx = JSON.parse(fs.readFileSync(idxPath, 'utf8'));
const store = 'F:/.pnpm-store/v10/files';
const dest = path.resolve(destDir);
let n = 0;
for (const [file, meta] of Object.entries(idx.files)) {
  const hex = Buffer.from(meta.integrity.slice(7), 'base64').toString('hex');
  let src = path.join(store, hex.slice(0, 2), hex.slice(2));
  if (!fs.existsSync(src)) src += '-exec';
  const out = path.join(dest, file);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.copyFileSync(src, out);
  n++;
}
console.log('restored', n, 'files to', dest);
