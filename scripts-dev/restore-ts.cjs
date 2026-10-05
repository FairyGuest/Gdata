const fs = require('fs');
const path = require('path');
const idx = JSON.parse(fs.readFileSync('F:/.pnpm-store/v10/index/a7/57625ba4ea2fd2f4ee7371bd130cee130cc387395cea3fd626cbe1a0081a64-typescript@5.8.3.json', 'utf8'));
const store = 'F:/.pnpm-store/v10/files';
const dest = path.join(__dirname, '..', 'node_modules', 'typescript');
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
console.log('restored', n, 'files');
