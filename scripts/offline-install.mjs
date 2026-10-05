// Offline installer: resolves dependencies from the npm cache (_cacache) and
// unpacks tarballs into node_modules. This environment has no network access;
// the npm cache was pre-populated with full registry metadata.
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { Readable } from 'node:stream';

const require = createRequire('D:/nodejs/node_modules/npm/package.json');
const cacache = require('cacache');
const semver = require('semver');
const tar = require('tar');

const CACHE = path.join(process.env.LOCALAPPDATA, 'npm-cache', '_cacache');
const REG = 'https://registry.npmmirror.com/';
const CDN = 'https://cdn.npmmirror.com/packages/';

const encName = (name) => name.replace('/', '%2f');

async function readMeta(name) {
  const key = 'make-fetch-happen:request-cache:' + REG + encName(name);
  const { data } = await cacache.get(CACHE, key);
  return JSON.parse(data.toString('utf8'));
}

async function fetchTarball(name, version) {
  const base = name.startsWith('@') ? name.split('/')[1] : name;
  const cdnName = name.startsWith('@') ? '%40' + name.slice(1) : name;
  const url = CDN + cdnName + '/' + version + '/' + base + '-' + version + '.tgz';
  const { data } = await cacache.get(CACHE, 'make-fetch-happen:request-cache:' + url);
  return data;
}

const installed = new Map();

async function installPkg(name, range) {
  const meta = await readMeta(name);
  const version = semver.maxSatisfying(Object.keys(meta.versions), range);
  if (!version) throw new Error('no cached version of ' + name + ' satisfies ' + range);
  if (installed.has(name)) return;
  installed.set(name, version);
  const dest = path.join('node_modules', ...name.split('/'));
  fs.mkdirSync(dest, { recursive: true });
  const tgz = await fetchTarball(name, version);
  await new Promise((res, rej) => Readable.from(tgz).pipe(tar.x({ cwd: dest, strip: 1 })).on('finish', res).on('error', rej));
  console.log('installed', name + '@' + version);
  const pkg = JSON.parse(fs.readFileSync(path.join(dest, 'package.json'), 'utf8'));
  for (const [d, r] of Object.entries(pkg.dependencies || {})) await installPkg(d, r);
  for (const [d, r] of Object.entries(pkg.optionalDependencies || {})) {
    try { await installPkg(d, r); } catch { /* platform optional dep not cached */ }
  }
}

const roots = JSON.parse(fs.readFileSync('scripts/offline-deps.json', 'utf8'));
for (const [name, range] of Object.entries(roots)) await installPkg(name, range);
console.log('done:', installed.size, 'packages');
