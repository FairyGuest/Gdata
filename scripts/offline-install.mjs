// Offline installer: resolves dependencies from the local npm cache
// (cacache) without network access. Only needed when npm install cannot
// reach a registry; on a networked machine plain npm install works.
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const npmDir = join(dirname(process.execPath), 'node_modules', 'npm', 'node_modules');
const require = createRequire(join(npmDir, 'index.js'));
const cacache = require('cacache');
const tar = require('tar');
const semver = require('semver');

const cache = process.env.OFFLINE_CACHE
  ? join(process.env.OFFLINE_CACHE, '_cacache')
  : join(os.homedir(), 'AppData', 'Local', 'npm-cache', '_cacache');
console.log('using cache:', cache);

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const NM = join(ROOT, 'node_modules');

const PINNED = {
  fastify: '5.12.5',
  typescript: '5.9.3',
  '@types/node': '24.19.0',
};

async function packument(name) {
  const key = 'make-fetch-happen:request-cache:https://registry.npmmirror.com/' + name.replace('/', '%2f');
  const { data } = await cacache.get(cache, key);
  return JSON.parse(data.toString());
}

async function resolveVersion(name, range) {
  const doc = await packument(name);
  const v = semver.maxSatisfying(Object.keys(doc.versions), range);
  if (!v) throw new Error('no cached version of ' + name + ' satisfying ' + range);
  return doc.versions[v];
}

const installed = new Map();

async function install(name, range) {
  const meta = await resolveVersion(name, range);
  const id = name + '@' + meta.version;
  if (installed.has(id)) return;
  installed.set(id, true);
  const file = meta.dist.tarball.split('/').pop();
  const cdn = 'https://cdn.npmmirror.com/packages/' + name.replace('@', '%40') + '/' + meta.version + '/' + file;
  const keys = [meta.dist.tarball, cdn].map((u) => 'make-fetch-happen:request-cache:' + u);
  let entry;
  for (const k of keys) {
    try { entry = await cacache.get(cache, k); break; } catch { /* try next */ }
  }
  if (!entry) throw new Error('MISSING tarball in cache: ' + id);
  const dest = join(NM, ...name.split('/'));
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  const tmp = join(os.tmpdir(), 'pkg-' + Math.random().toString(36).slice(2) + '.tgz');
  writeFileSync(tmp, entry.data);
  await tar.x({ file: tmp, cwd: dest, strip: 1 });
  rmSync(tmp, { force: true });
  console.log('installed', id);
  for (const [d, r] of Object.entries(meta.dependencies || {})) await install(d, r);
}

mkdirSync(NM, { recursive: true });
for (const [name, v] of Object.entries(PINNED)) await install(name, v);

const binDir = join(NM, '.bin');
mkdirSync(binDir, { recursive: true });
for (const [bin, rel] of [['tsc', 'typescript/bin/tsc'], ['tsserver', 'typescript/bin/tsserver']]) {
  writeFileSync(join(binDir, bin + '.cmd'), '@echo off\r\nnode "%~dp0..\\' + rel.replace(/\//g, '\\') + '" %*\r\n');
  writeFileSync(join(binDir, bin), '#!/bin/sh\nexec node "$(dirname "$0")/../' + rel + '" "$@"\n');
}
console.log('offline install complete');
