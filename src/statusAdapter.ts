import { CaseResult, FailureKind } from './contracts';

/**
 * 状态适配层：把 harness 子进程的原始退出信息映射为统一的 CaseResult。
 * 绝不把未知状态吞成成功：无法解析的输出一律归为 failed/crash。
 */

export interface RawCaseOutcome {
  file: string;
  case: string;
  /** 子进程退出码；被信号/强制终止时为 null */
  exitCode: number | null;
  /** 是否因超时被内核终止 */
  timedOut: boolean;
  /** 实际耗时（毫秒） */
  durationMs: number;
  /** 标准输出（约定最后一行非空行为 JSON 结果） */
  stdout: string;
  stderr: string;
}

interface HarnessPayload {
  ok?: boolean;
  kind?: string;
  error?: string;
}

function lastJsonLine(stdout: string): HarnessPayload | undefined {
  const lines = stdout.split(/\r?\n/).filter((l) => l.trim().length > 0);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i]) as HarnessPayload;
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      // 测试文件自己的 console.log 输出，跳过
    }
  }
  return undefined;
}

function firstLine(text: string | undefined): string | undefined {
  if (!text) return undefined;
  return text.split(/\r?\n/)[0];
}

export function adaptCaseOutcome(raw: RawCaseOutcome): CaseResult {
  const base = { file: raw.file, case: raw.case, durationMs: raw.durationMs };

  if (raw.timedOut) {
    return {
      ...base,
      status: 'timeout',
      failureKind: 'timeout',
      error: '超过超时时间被强制终止',
      reason: '用例执行超过超时上限，进程被终止（exitCode=' + String(raw.exitCode) + '）',
    };
  }

  const payload = lastJsonLine(raw.stdout);
  if (!payload) {
    return {
      ...base,
      status: 'failed',
      failureKind: 'crash' as FailureKind,
      error: firstLine(raw.stderr) ?? '进程异常退出且无结果输出',
      reason: '子进程退出码 ' + String(raw.exitCode) + ' 且未产生可解析的结果，判定为崩溃',
    };
  }

  if (payload.ok === true) {
    if (raw.exitCode !== 0) {
      return {
        ...base,
        status: 'failed',
        failureKind: 'crash',
        error: '用例体通过但进程以非零码退出: ' + String(raw.exitCode),
        reason: '结果与退出码冲突，按失败处理（不掩盖未知状态）',
      };
    }
    return { ...base, status: 'passed', reason: '用例正常返回，退出码 0' };
  }

  const kind: FailureKind = payload.kind === 'assertion' ? 'assertion' : 'runtime';
  return {
    ...base,
    status: 'failed',
    failureKind: kind,
    error: firstLine(payload.error) ?? '未知错误',
    reason: kind === 'assertion' ? '断言失败（AssertionError）' : '用例抛出未捕获异常',
  };
}