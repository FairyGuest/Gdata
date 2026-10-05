/**
 * 子进程 harness：在独立进程中加载测试文件并执行。
 * 用法：
 *   node harness.js list <testFile>           -> 输出 JSON: {"cases":[...]}
 *   node harness.js run  <testFile> <case>    -> 输出 JSON: {"ok":true} 或 {"ok":false,"kind":"assertion|runtime","error":"..."}
 * 任何无法归为断言失败/运行时异常的崩溃都表现为非零退出且无 JSON 输出，
 * 由父进程的 statusAdapter 归类为 crash。
 */
import * as path from 'node:path';
import { listCases, runCase } from './framework';

function emit(payload: unknown): void {
  process.stdout.write(JSON.stringify(payload) + '\n');
}

async function main(): Promise<void> {
  const [, , mode, file, caseName] = process.argv;
  if (!mode || !file) {
    emit({ ok: false, kind: 'runtime', error: 'harness 参数不足' });
    process.exit(2);
  }
  const abs = path.resolve(file);
  try {
    require(abs);
  } catch (e) {
    const err = e as Error;
    emit({ ok: false, kind: 'load', error: String(err.stack ?? err.message ?? err) });
    process.exit(3);
  }
  if (mode === 'list') {
    emit({ cases: listCases() });
    process.exit(0);
  }
  if (mode === 'run') {
    try {
      await runCase(caseName);
      emit({ ok: true });
      // 显式退出：用例残留的定时器/句柄不应把进程吊住而被误判为超时
      process.exit(0);
    } catch (e) {
      const err = e as NodeJS.ErrnoException & { code?: string };
      const isAssertion = err && err.name === 'AssertionError';
      emit({
        ok: false,
        kind: isAssertion ? 'assertion' : 'runtime',
        error: String(err.stack ?? err.message ?? err),
      });
      process.exit(1);
    }
  }
  emit({ ok: false, kind: 'runtime', error: '未知 harness 模式: ' + mode });
  process.exit(2);
}

main().catch((e) => {
  emit({ ok: false, kind: 'runtime', error: String((e as Error).stack ?? e) });
  process.exit(1);
});