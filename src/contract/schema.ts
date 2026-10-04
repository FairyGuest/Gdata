// Contract parsing: validates the inbound scan request against the public
// contract and normalizes it into the internal model used by the engine.
import { ScanError } from './errors.ts';

export interface PackageSpec {
  name: string;
  version: string;
  dependencies: Record<string, string>; // dep name -> exact version
}

export interface ScanRequest {
  idempotencyKey?: string;
  root: string; // "name@version"
  packages: PackageSpec[];
}

const NAME_RE = /^[a-zA-Z0-9._@/-]+$/;
const VERSION_RE = /^\d+\.\d+\.\d+$/;
const REF_RE = /^([a-zA-Z0-9._@/-]+)@(\d+\.\d+\.\d+)$/;

export function splitRef(ref: string): { name: string; version: string } {
  const m = REF_RE.exec(ref);
  if (!m) {
    throw new ScanError('INPUT_ERROR', 'Invalid package ref "' + ref + '"; expected "name@x.y.z"');
  }
  return { name: m[1], version: m[2] };
}

export function parseScanRequest(body: unknown): ScanRequest {
  if (body === null || typeof body !== 'object') {
    throw new ScanError('INPUT_ERROR', 'Request body must be a JSON object');
  }
  const b = body as Record<string, unknown>;
  if (typeof b.root !== 'string') {
    throw new ScanError('INPUT_ERROR', 'Field "root" is required and must be a "name@x.y.z" string');
  }
  splitRef(b.root); // validates format
  if (!Array.isArray(b.packages) || b.packages.length === 0) {
    throw new ScanError('INPUT_ERROR', 'Field "packages" must be a non-empty array');
  }
  if (b.idempotencyKey !== undefined && typeof b.idempotencyKey !== 'string') {
    throw new ScanError('INPUT_ERROR', 'Field "idempotencyKey" must be a string when present');
  }
  const seen = new Set<string>();
  const packages: PackageSpec[] = b.packages.map((raw, i) => {
    if (raw === null || typeof raw !== 'object') {
      throw new ScanError('INPUT_ERROR', 'packages[' + i + '] must be an object');
    }
    const p = raw as Record<string, unknown>;
    if (typeof p.name !== 'string' || !NAME_RE.test(p.name)) {
      throw new ScanError('INPUT_ERROR', 'packages[' + i + '].name is missing or invalid');
    }
    if (typeof p.version !== 'string' || !VERSION_RE.test(p.version)) {
      throw new ScanError('INPUT_ERROR', 'packages[' + i + '].version must be "x.y.z"');
    }
    const key = p.name + '@' + p.version;
    if (seen.has(key)) {
      throw new ScanError('INPUT_ERROR', 'Duplicate package entry "' + key + '"');
    }
    seen.add(key);
    const deps: Record<string, string> = {};
    if (p.dependencies !== undefined) {
      if (p.dependencies === null || typeof p.dependencies !== 'object' || Array.isArray(p.dependencies)) {
        throw new ScanError('INPUT_ERROR', 'packages[' + i + '].dependencies must be an object of name -> version');
      }
      for (const [dn, dv] of Object.entries(p.dependencies as Record<string, unknown>)) {
        if (!NAME_RE.test(dn)) {
          throw new ScanError('INPUT_ERROR', 'packages[' + i + '].dependencies has invalid dep name "' + dn + '"');
        }
        if (typeof dv !== 'string' || !VERSION_RE.test(dv)) {
          throw new ScanError('INPUT_ERROR', 'Dependency "' + dn + '" version must be "x.y.z"');
        }
        deps[dn] = dv;
      }
    }
    return { name: p.name, version: p.version, dependencies: deps };
  });
  if (!seen.has(b.root)) {
    throw new ScanError('INPUT_ERROR', 'Root package "' + b.root + '" is not present in "packages"');
  }
  return { idempotencyKey: b.idempotencyKey as string | undefined, root: b.root, packages };
}
