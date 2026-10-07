#!/usr/bin/env node
/**
 * Offline installer: resolves the dependency tree from package.json using the
 * local npm cache (cacache) only. No network access is performed.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
const NM = path.join(ROOT, 'node_modules');

function globalNpmRoot() {
  return path.join(path.dirname(process.execPath), 'node_modules');
}

const npmRoot = globalNpmRoot();
const npmLib = (name) => require(path.join(npmRoot, 'npm', 'node_modules', name));
const cacache = npmLib('cacache');
const semver = npmLib('semver');
const tar = npmLib('tar');

const CACHE_ROOT = process.env.NPM_CACHE_DIR || path.join(os.homedir(), 'AppData', 'Local', 'npm-cache');
const CACHE = path.join(CACHE_ROOT, '_cacache');
const REGISTRY = 'https://registry.npmmirror.com';
const CDN = 'https://cdn.npmmirror.com/packages';

function cacheKey(url) {
  return 'make-fetch-happen:request-cache:' + url;
}

function tarballUrl(name, version) {
  const encoded = name.startsWith('@') ? '%40' + name.slice(1) : name;
  const base = name.includes('/') ? name.split('/')[1] : name;
  return CDN + '/' + encoded + '/' + version + '/' + base + '-' + version + '.tgz';
}

async function cachedEntry(url) {
  try {
    return await cacache.get(CACHE, cacheKey(url));
  } catch {
    return null;
  }
}

async function cachedVersions(name) {
  const entry = await cachedEntry(REGISTRY + '/' + name.replace('/', '%2f'));
  if (!entry) return null;
  const pack = JSON.parse(entry.data.toString('utf8'));
  return pack.versions || null;
}

async function resolveVersion(name, range) {
  const versions = await cachedVersions(name);
  if (!versions) {
    throw new Error('[offline-install] no cached packument for ' + name);
  }
  const candidates = Object.keys(versions).filter((v) => semver.satisfies(v, range, { includePrerelease: false }));
  if (candidates.length === 0) {
    throw new Error('[offline-install] no cached version of ' + name + ' satisfies ' + range);
  }
  candidates.sort(semver.rcompare);
  for (const v of candidates) {
    if (await cachedEntry(tarballUrl(name, v))) return { version: v, manifest: versions[v] };
  }
  throw new Error('[offline-install] no cached tarball for any version of ' + name + ' satisfying ' + range);
}

async function extractTarball(name, version, destDir) {
  const url = tarballUrl(name, version);
  const entry = await cachedEntry(url);
  if (!entry) {
    throw new Error('[offline-install] tarball not in cache: ' + url);
  }
  const tmp = path.join(os.tmpdir(), 'offline-' + name.replace(/[@/]/g, '_') + '-' + version + '.tgz');
  fs.writeFileSync(tmp, entry.data);
  fs.mkdirSync(destDir, { recursive: true });
  await tar.x({ file: tmp, cwd: destDir, strip: 1 });
  fs.rmSync(tmp, { force: true });
}

const dirMaps = new Map();
function mapFor(dir) {
  let m = dirMaps.get(dir);
  if (!m) { m = new Map(); dirMaps.set(dir, m); }
  return m;
}

async function installTree(name, range, baseDir, chain) {
  let dir = baseDir;
  const chainDirs = [];
  while (true) {
    chainDirs.push(dir);
    const parent = path.dirname(dir);
    if (parent === dir || chainDirs.length > 8) break;
    dir = parent;
  }
  for (const d of chainDirs) {
    const m = dirMaps.get(d);
    const v = m && m.get(name);
    if (v && semver.satisfies(v, range)) return null;
  }
  const resolved = await resolveVersion(name, range);
  const version = resolved.version;
  const manifest = resolved.manifest;
  let targetDir = null;
  for (const d of chainDirs) {
    const m = dirMaps.get(d);
    const existing = m && m.get(name);
    if (!existing) { targetDir = d; break; }
    if (existing === version) return null;
  }
  if (!targetDir) throw new Error('[offline-install] cannot place ' + name + '@' + version);
  const destDir = path.join(targetDir, 'node_modules', ...name.split('/'));
  console.log('  install ' + name + '@' + version + ' -> ' + path.relative(ROOT, destDir));
  await extractTarball(name, version, destDir);
  mapFor(targetDir).set(name, version);
  if (chain.includes(name)) return version;
  const nextChain = chain.concat(name);
  const required = manifest.dependencies || {};
  const optional = manifest.optionalDependencies || {};
  for (const dep of Object.keys(required)) {
    if (optional[dep]) continue;
    await installTree(dep, required[dep], destDir, nextChain);
  }
  for (const dep of Object.keys(optional)) {
    try {
      await installTree(dep, optional[dep], destDir, nextChain);
    } catch (err) {
      console.log('  skip optional ' + dep + ' (' + String(err.message).split('\n')[0] + ')');
    }
  }
  return version;
}

async function unpackBetterSqlite3Prebuild(version) {
  const prebuildsDir = path.join(CACHE_ROOT, '_prebuilds');
  if (!fs.existsSync(prebuildsDir)) {
    console.warn('  [warn] no _prebuilds cache; better-sqlite3 may need a source build');
    return;
  }
  const tag = 'better-sqlite3-v' + version + '-';
  const hit = fs.readdirSync(prebuildsDir).find((f) => f.includes(tag) && f.endsWith('.tar.gz'));
  if (!hit) {
    console.warn('  [warn] no cached prebuild for better-sqlite3@' + version);
    return;
  }
  const dest = path.join(NM, 'better-sqlite3');
  await tar.x({ file: path.join(prebuildsDir, hit), cwd: dest });
  console.log('  prebuild ' + hit + ' -> node_modules/better-sqlite3');
}

async function main() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  fs.mkdirSync(NM, { recursive: true });
  const roots = Object.assign({}, pkg.dependencies, pkg.devDependencies);
  console.log('[offline-install] resolving ' + Object.keys(roots).length + ' root dependencies from cache: ' + CACHE_ROOT);
  for (const name of Object.keys(roots)) {
    await installTree(name, roots[name], ROOT, []);
  }
  const rootMap = dirMaps.get(ROOT);
  const bsVersion = rootMap && rootMap.get('better-sqlite3');
  if (bsVersion) await unpackBetterSqlite3Prebuild(bsVersion);
  const Database = require(path.join(NM, 'better-sqlite3'));
  const db = new Database(':memory:');
  db.exec('CREATE TABLE t (x INTEGER)');
  db.close();
  console.log('[offline-install] OK: better-sqlite3 native binding verified');
}

main().catch((err) => {
  console.error('[offline-install] FAILED: ' + (err && err.stack || err));
  process.exit(1);
});





