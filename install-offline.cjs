// Offline dependency installer for this sandboxed environment (npm registry unreachable).
// Extracts cached tarballs from the local npm cache into node_modules. Not needed with normal npm install.
const fs = require('fs');
const path = require('path');
const NPM_DIR = 'D:/nodejs/node_modules/npm/node_modules';
const cacache = require(NPM_DIR + '/cacache');
const tar = require(NPM_DIR + '/tar');
const semver = require(NPM_DIR + '/semver');
const CACHE = 'C:/Users/97010/AppData/Local/npm-cache/_cacache';
const NM = path.resolve('node_modules');

async function listCache() {
  const entries = await cacache.ls(CACHE);
  return new Map(Object.entries(entries));
}

function tarballKey(name, version) {
  const short = name.startsWith('@') ? name.split('/')[1] : name;
  const enc = name.startsWith('@') ? name.replace('@','%40') : name;
  return 'make-fetch-happen:request-cache:https://cdn.npmmirror.com/packages/' + enc + '/' + version + '/' + short + '-' + version + '.tgz';
}

function findVersion(cacheMap, name, range) {
  const cands = [];
  const enc = name.startsWith('@') ? name.replace('@','%40') : name;
  const prefix = 'make-fetch-happen:request-cache:https://cdn.npmmirror.com/packages/' + enc + '/';
  for (const key of cacheMap.keys()) {
    if (!key.startsWith(prefix)) continue;
    const version = key.slice(prefix.length).split('/')[0];
    if (semver.valid(version) && (range === '*' || semver.satisfies(version, range))) cands.push(version);
  }
  cands.sort((a, b) => semver.rcompare(a, b));
  return cands[0] || null;
}

async function extract(cacheMap, name, version, dest) {
  const key = tarballKey(name, version);
  if (!cacheMap.has(key)) throw new Error('not in cache: ' + key);
  const tmp = path.join(require('os').tmpdir(), 'pkg-' + Math.random().toString(36).slice(2) + '.tgz');
  await cacache.get.copy(CACHE, key, tmp);
  fs.mkdirSync(dest, { recursive: true });
  await tar.x({ file: tmp, cwd: dest, strip: 1 });
  fs.unlinkSync(tmp);
}

async function install(cacheMap, name, range, dest) {
  const version = findVersion(cacheMap, name, range);
  if (!version) throw new Error('NO CACHED VERSION: ' + name + '@' + range);
  const pkgDir = path.join(dest, name);
  await extract(cacheMap, name, version, pkgDir);
  const pj = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
  console.log('installed', name + '@' + version);
  return { name, version, pj, pkgDir };
}

async function main() {
  const cacheMap = await listCache();
  const queue = [
    { name: 'fastify', range: '5.12.5', dest: NM, optional: false },
    { name: 'typescript', range: '5.9.3', dest: NM, optional: false },
    { name: 'tsx', range: '4.23.15', dest: NM, optional: false },
    { name: '@types/node', range: '^24', dest: NM, optional: false },
  ];
  const topDone = new Map();
  while (queue.length) {
    const item = queue.shift();
    const isTop = item.dest === NM;
    if (isTop) {
      const topPath = path.join(NM, item.name, 'package.json');
      if (fs.existsSync(topPath)) {
        const v = JSON.parse(fs.readFileSync(topPath, 'utf8')).version;
        if (semver.satisfies(v, item.range)) { topDone.set(item.name, v); continue; }
      }
    }
    let res;
    try { res = await install(cacheMap, item.name, item.range, item.dest); }
    catch (e) {
      if (item.optional) { console.log('SKIP optional:', item.name, e.message); continue; }
      throw e;
    }
    if (isTop) topDone.set(item.name, res.version);
    const optDeps = new Set(Object.keys(res.pj.optionalDependencies || {}));
    for (const [dn, dr] of Object.entries(res.pj.dependencies || {})) {
      const optional = optDeps.has(dn);
      const topPath = path.join(NM, dn, 'package.json');
      if (fs.existsSync(topPath)) {
        const v = JSON.parse(fs.readFileSync(topPath, 'utf8')).version;
        if (semver.satisfies(v, dr)) continue;
        queue.push({ name: dn, range: dr, dest: path.join(res.pkgDir, 'node_modules'), optional });
        continue;
      }
      if (queue.some(q => q.name === dn && q.dest === NM)) continue;
      queue.push({ name: dn, range: dr, dest: NM, optional });
    }
  }
  console.log('DONE');
}
main().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
