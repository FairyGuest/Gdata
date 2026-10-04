
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const CACHE = 'C:/Users/97010/AppData/Local/npm-cache/_cacache';

const entries = new Map();
function walk(dir){
  for(const e of fs.readdirSync(dir,{withFileTypes:true})){
    const p = path.join(dir,e.name);
    if(e.isDirectory()) walk(p);
    else {
      for(const line of fs.readFileSync(p,'utf8').split('\n')){
        if(!line.trim()) continue;
        const json = line.slice(line.indexOf('\t')+1);
        try{ const o = JSON.parse(json); if(o.key && o.integrity) entries.set(o.key, o.integrity); }catch{}
      }
    }
  }
}
walk(path.join(CACHE,'index-v5'));
const pkgs = new Map();
for(const [key, integrity] of entries){
  const m = key.match(/request-cache:https:\/\/cdn\.npmmirror\.com\/packages\/(.+?)\/([\d][^\/]*)\/[^\/]+\.tgz$/);
  if(!m) continue;
  const name = decodeURIComponent(m[1]);
  const version = m[2];
  if(!pkgs.has(name)) pkgs.set(name,new Map());
  pkgs.get(name).set(version,{url:key.replace(/^make-fetch-happen:request-cache:/,''), integrity});
}
console.log('indexed packages:', pkgs.size);

function parse(v){ const m=v.match(/^(\d+)\.(\d+)\.(\d+)/); return m?[ +m[1],+m[2],+m[3] ]:null; }
function cmp(a,b){ for(let i=0;i<3;i++){ if(a[i]!=b[i]) return a[i]-b[i]; } return 0; }
function satisfiesOne(v, range){
  range = range.trim();
  if(range==='*'||range===''||range==='latest') return true;
  const p = parse(v); if(!p) return false;
  if(range.startsWith('^')){
    const b = parse(range.slice(1)); if(!b) return false;
    if(cmp(p,b)<0) return false;
    if(b[0]>0) return p[0]===b[0];
    if(b[1]>0) return p[0]===0&&p[1]===b[1];
    return p[0]===0&&p[1]===0&&p[2]===b[2];
  }
  if(range.startsWith('~')){
    const b = parse(range.slice(1)); if(!b) return false;
    return cmp(p,b)>=0 && p[0]===b[0] && p[1]===b[1];
  }
  let m = range.match(/^>=\s*(\S+)/); if(m){ const b=parse(m[1]); return b&&cmp(p,b)>=0; }
  m = range.match(/^(\d+)\.x$/); if(m) return p[0]===+m[1];
  m = range.match(/^(\d+)\.(\d+)\.x$/); if(m) return p[0]===+m[1]&&p[1]===+m[2];
  const b = parse(range); return b && cmp(p,b)===0;
}
function satisfies(v, range){
  return range.split('||').some(alt => alt.trim().split(/\s+/).filter(Boolean).every(r=>satisfiesOne(v,r)));
}
function resolve(name, range){
  const vers = pkgs.get(name);
  if(!vers) return null;
  const ok = [...vers.keys()].filter(v=>satisfies(v,range)).sort((a,b)=>cmp(parse(b),parse(a)));
  return ok.length? {version:ok[0], ...vers.get(ok[0])} : null;
}
function contentPath(integrity){
  const hex = Buffer.from(integrity.split('-')[1],'base64').toString('hex');
  return path.join(CACHE,'content-v2','sha512',hex.slice(0,2),hex.slice(2,4),hex.slice(4));
}
function readPkgJsonFromTar(tgzPath){
  const data = zlib.gunzipSync(fs.readFileSync(tgzPath));
  let off = 0;
  while(off + 512 <= data.length){
    const name = data.toString('utf8', off, off+100).replace(/\0.*$/,'');
    const size = parseInt(data.toString('utf8', off+124, off+136).replace(/\0.*$/,'').trim(), 8) || 0;
    if(/^[^\/]+\/package\.json$/.test(name)){
      return JSON.parse(data.toString('utf8', off+512, off+512+size));
    }
    off += 512 + Math.ceil(size/512)*512;
  }
  return null;
}

// tree resolution with nesting on conflict
const lockPkgs = {};
const installed = new Map(); // dirPrefix + '|' + name -> version
const missing = [];
function ancestorsOf(dirPrefix){
  // dirPrefix like '' or 'node_modules/a/' or 'node_modules/a/node_modules/b/'
  const out = [];
  let p = dirPrefix;
  while(true){ out.push(p); const i = p.lastIndexOf('node_modules/'); if(i<0) break; p = p.slice(0,i) ; }
  return out;
}
function install(name, range, dirPrefix){
  for(const anc of ancestorsOf(dirPrefix)){
    const v = installed.get(anc+name);
    if(v && satisfies(v, range)) return;
  }
  const r = resolve(name, range);
  if(!r){ missing.push(name+'@'+range+' (needed under '+dirPrefix+')'); return; }
  const existing = installed.get(dirPrefix+name);
  if(existing === r.version) return;
  installed.set(dirPrefix+name, r.version);
  const pj = readPkgJsonFromTar(contentPath(r.integrity));
  if(!pj){ missing.push(name+'(no pkgjson)'); return; }
  const key = dirPrefix+'node_modules/'+name;
  const entry = { version: r.version, resolved: r.url, integrity: r.integrity };
  if(pj.bin) entry.bin = pj.bin;
  if(pj.engines) entry.engines = pj.engines;
  const deps = pj.dependencies || {};
  if(Object.keys(deps).length) entry.dependencies = deps;
  lockPkgs[key] = entry;
  const childPrefix = key + '/';
  for(const [d,dr] of Object.entries(deps)) install(d, dr, childPrefix);
}
install('fastify','^5.12.5','');
install('typescript','^5.9.3','');
install('@types/node','^22.20.4','');
console.log('resolved', Object.keys(lockPkgs).length, 'packages');
if(missing.length){ console.log('MISSING:', JSON.stringify(missing)); process.exitCode = 1; }
const lock = {
  name: 'api-key-quota-service', version: '1.0.0', lockfileVersion: 3, requires: true,
  packages: Object.assign({ '': { name:'api-key-quota-service', version:'1.0.0',
    dependencies:{fastify:'^5.12.5'},
    devDependencies:{typescript:'^5.9.3','@types/node':'^22.20.4'} } }, lockPkgs)
};
fs.writeFileSync(process.cwd() + '/package-lock.json', JSON.stringify(lock,null,2));
console.log('lockfile written');


