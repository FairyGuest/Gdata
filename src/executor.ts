import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CaseResult, executionFailed, invalidInput, resourceExhausted } from './contracts';
import { adaptCaseOutcome } from './statusAdapter';

/**
 * 执行内核：
 * - 每个用例在独立子进程中执行（互不影响，可被单独终止）；
 * - 文件按依赖分层调度：同一层（无相互依赖）的文件并行，下一层等上一层完成；
 * - parallel=false 时严格按拓扑序逐文件、逐用例执行；
 * - 超时用 taskkill /T /F（Windows）或 SIGKILL 终止整棵进程树，不阻塞其他用例。
 * 注意：子进程输出通过临时文件捕获（部分运行环境不允许匿名管道）。
 */

export interface ExecuteOptions {
  dir: string;
  files: string[];
  /** 拓扑排序后的文件顺序 */
  orderedFiles: string[];
  /** 文件依赖：key 依赖 value 列表 */
  dependencies: Record<string, string[]>;
  parallel: boolean;
  concurrency: number;
  timeoutMs: number;
  maxConcurrency: number;
  onLog?: (msg: string) => void;
}

const HARNESS = path.join(__dirname, 'harness.js');

function killTree(pid: number): void {
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      /* 进程可能已退出 */
    }
  } else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* 已退出 */
      }
    }
  }
}

interface RawProc {
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
}

let tmpCounter = 0;

function runHarness(args: string[], timeoutMs: number): Promise<RawProc> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const stamp = process.pid + '-' + Date.now() + '-' + tmpCounter++;
    const outFile = path.join(os.tmpdir(), 'runner-' + stamp + '.out');
    const errFile = path.join(os.tmpdir(), 'runner-' + stamp + '.err');
    let outFd: number;
    let errFd: number;
    try {
      outFd = fs.openSync(outFile, 'w');
      errFd = fs.openSync(errFile, 'w');
    } catch (e) {
      reject(executionFailed('无法创建子进程输出临时文件: ' + (e as Error).message));
      return;
    }
    const cleanup = () => {
      try { fs.closeSync(outFd); } catch { /* 已关闭 */ }
      try { fs.closeSync(errFd); } catch { /* 已关闭 */ }
    };
    const readAndUnlink = (file: string): string => {
      try {
        const content = fs.readFileSync(file, 'utf8');
        fs.unlinkSync(file);
        return content;
      } catch {
        return '';
      }
    };
    const child = spawn(process.execPath, [HARNESS, ...args], {
      stdio: ['ignore', outFd, errFd],
      detached: process.platform !== 'win32',
    });
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) killTree(child.pid);
    }, timeoutMs);
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      readAndUnlink(outFile);
      readAndUnlink(errFile);
      reject(executionFailed('无法启动 harness 子进程: ' + e.message));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      resolve({
        exitCode: code,
        timedOut,
        durationMs: Date.now() - started,
        stdout: readAndUnlink(outFile),
        stderr: readAndUnlink(errFile),
      });
    });
  });
}

export async function listCasesInFile(absFile: string, timeoutMs: number): Promise<string[]> {
  const out = await runHarness(['list', absFile], timeoutMs);
  const line = out.stdout.split(/\r?\n/).filter((l) => l.trim()).pop();
  if (!line) {
    throw executionFailed('无法从 ' + absFile + ' 发现用例: ' + (out.stderr.split(/\r?\n/)[0] || '无输出'));
  }
  let parsed: { cases?: string[]; error?: string };
  try {
    parsed = JSON.parse(line);
  } catch {
    throw executionFailed('用例发现输出不是合法 JSON: ' + absFile);
  }
  if (!Array.isArray(parsed.cases)) {
    throw executionFailed('测试文件加载失败 ' + absFile + ': ' + (parsed.error ?? '未知原因'));
  }
  return parsed.cases;
}

export async function runOneCase(
  absFile: string,
  caseName: string,
  timeoutMs: number,
): Promise<CaseResult> {
  const raw = await runHarness(['run', absFile, caseName], timeoutMs);
  return adaptCaseOutcome({
    file: absFile,
    case: caseName,
    exitCode: raw.exitCode,
    timedOut: raw.timedOut,
    durationMs: raw.durationMs,
    stdout: raw.stdout,
    stderr: raw.stderr,
  });
}

interface Task {
  file: string;
  case: string;
}

/** 按依赖把文件分层：第 0 层无依赖，第 n 层依赖都在 n 层之前 */
export function layerFiles(
  orderedFiles: string[],
  dependencies: Record<string, string[]>,
): string[][] {
  const layerOf = new Map<string, number>();
  for (const f of orderedFiles) {
    const deps = (dependencies[f] ?? []).filter((d) => orderedFiles.includes(d));
    const layer = deps.length === 0 ? 0 : Math.max(...deps.map((d) => layerOf.get(d) ?? 0)) + 1;
    layerOf.set(f, layer);
  }
  const layers: string[][] = [];
  for (const f of orderedFiles) {
    const l = layerOf.get(f)!;
    if (!layers[l]) layers[l] = [];
    layers[l].push(f);
  }
  return layers;
}

async function runTasks(
  tasks: Task[],
  opts: ExecuteOptions,
  concurrency: number,
  results: CaseResult[],
  log: (msg: string) => void,
): Promise<void> {
  let cursor = 0;
  const worker = async () => {
    while (cursor < tasks.length) {
      const task = tasks[cursor++];
      const abs = path.join(path.resolve(opts.dir), task.file);
      const result = await runOneCase(abs, task.case, opts.timeoutMs);
      results.push(result);
      log(
        '[' + result.status + '] ' + task.file + ' :: ' + task.case +
          ' (' + result.durationMs + 'ms) - ' + result.reason,
      );
    }
  };
  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.max(1, concurrency); i++) workers.push(worker());
  await Promise.all(workers);
}

export async function executeAll(opts: ExecuteOptions): Promise<CaseResult[]> {
  const log = opts.onLog ?? (() => {});
  if (!Number.isInteger(opts.concurrency) || opts.concurrency < 1) {
    throw invalidInput('concurrency 必须 >= 1');
  }
  if (opts.concurrency > opts.maxConcurrency) {
    throw resourceExhausted(
      '请求的并发数 ' + opts.concurrency + ' 超过服务上限 ' + opts.maxConcurrency,
    );
  }

  // 1. 按拓扑序逐文件发现用例
  const casesByFile = new Map<string, string[]>();
  let total = 0;
  for (const rel of opts.orderedFiles) {
    const abs = path.join(path.resolve(opts.dir), rel);
    const cases = await listCasesInFile(abs, opts.timeoutMs);
    casesByFile.set(rel, cases);
    total += cases.length;
    log('发现 ' + rel + ' 含 ' + cases.length + ' 个用例: ' + (cases.join(', ') || '(无)'));
  }
  if (total === 0) {
    log('未发现任何用例');
    return [];
  }

  const results: CaseResult[] = [];
  if (!opts.parallel) {
    log('开始执行 ' + total + ' 个用例，模式=sequential（按依赖拓扑序） 超时=' + opts.timeoutMs + 'ms');
    for (const rel of opts.orderedFiles) {
      const tasks = (casesByFile.get(rel) ?? []).map((c) => ({ file: rel, case: c }));
      await runTasks(tasks, opts, 1, results, log);
    }
    return results;
  }

  // 2. 并行模式：按依赖分层，同层文件共享工作池，层间严格先后
  const layers = layerFiles(opts.orderedFiles, opts.dependencies);
  log(
    '开始执行 ' + total + ' 个用例，模式=parallel 并发=' + opts.concurrency +
      ' 依赖层数=' + layers.length + ' 超时=' + opts.timeoutMs + 'ms',
  );
  for (let i = 0; i < layers.length; i++) {
    const tasks: Task[] = [];
    for (const rel of layers[i]) {
      for (const c of casesByFile.get(rel) ?? []) tasks.push({ file: rel, case: c });
    }
    if (layers.length > 1) log('进入依赖层 ' + i + '，含文件: ' + layers[i].join(', '));
    await runTasks(tasks, opts, opts.concurrency, results, log);
  }
  return results;
}