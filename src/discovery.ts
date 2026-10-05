import * as fs from 'node:fs';
import * as path from 'node:path';
import { invalidInput, resourceExhausted } from './contracts';

/**
 * 契约解析 + 文件发现层：
 * 校验运行请求，按文件名模式（支持 * 与 **）在指定目录递归发现测试文件。
 */

export interface DiscoverOptions {
  dir: string;
  pattern: string;
  maxFiles: number;
}

/** 将 glob 模式（*、**、?）转为正则；其余字符按字面量处理 */
export function patternToRegExp(pattern: string): RegExp {
  if (!pattern || pattern.includes('..') || path.isAbsolute(pattern)) {
    throw invalidInput('非法的文件名模式: ' + JSON.stringify(pattern));
  }
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        re += '.*';
        i++;
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^{}()|[\]\\$]/g, '\\$&');
    }
  }
  return new RegExp('^' + re + '$');
}

export function discoverTestFiles(opts: DiscoverOptions): string[] {
  const absDir = path.resolve(opts.dir);
  if (!fs.existsSync(absDir)) {
    throw invalidInput('测试目录不存在: ' + absDir);
  }
  if (!fs.statSync(absDir).isDirectory()) {
    throw invalidInput('测试路径不是目录: ' + absDir);
  }
  const matcher = patternToRegExp(opts.pattern);
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        const rel = path.relative(absDir, full).split(path.sep).join('/');
        if (matcher.test(rel)) {
          found.push(rel);
          if (found.length > opts.maxFiles) {
            throw resourceExhausted(
              '发现的测试文件超过上限 ' + opts.maxFiles + '，请缩小目录或模式范围',
            );
          }
        }
      }
    }
  };
  walk(absDir);
  return found.sort();
}

/**
 * 按依赖关系拓扑排序。dependencies[file] = file 依赖的前置文件列表。
 * 未知依赖与循环依赖都属于输入错误。
 */
export function topoSort(files: string[], dependencies: Record<string, string[]>): string[] {
  const set = new Set(files);
  const indeg = new Map<string, number>();
  const edges = new Map<string, string[]>();
  for (const f of files) indeg.set(f, 0);
  for (const [file, deps] of Object.entries(dependencies)) {
    if (!set.has(file)) continue;
    for (const dep of deps) {
      if (!set.has(dep)) {
        throw invalidInput('文件 ' + file + ' 依赖了未被发现/不存在的测试文件 ' + dep);
      }
      if (dep === file) throw invalidInput('文件 ' + file + ' 不能依赖自身');
      indeg.set(file, (indeg.get(file) ?? 0) + 1);
      if (!edges.has(dep)) edges.set(dep, []);
      edges.get(dep)!.push(file);
    }
  }
  const queue = files.filter((f) => indeg.get(f) === 0).sort();
  const ordered: string[] = [];
  while (queue.length > 0) {
    const f = queue.shift()!;
    ordered.push(f);
    for (const next of edges.get(f) ?? []) {
      const d = indeg.get(next)! - 1;
      indeg.set(next, d);
      if (d === 0) queue.push(next);
    }
  }
  if (ordered.length !== files.length) {
    const remaining = files.filter((f) => !ordered.includes(f));
    throw invalidInput('测试文件依赖存在循环: ' + remaining.join(', '));
  }
  return ordered;
}