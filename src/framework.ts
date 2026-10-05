/**
 * 提供给被测测试文件的微型测试框架。
 * 测试文件通过 require('.../framework') 拿到 test() 注册用例。
 */

export type TestFn = () => unknown | Promise<unknown>;

export interface RegisteredCase {
  name: string;
  fn: TestFn;
}

const registry: RegisteredCase[] = [];

export function test(name: string, fn: TestFn): void {
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error('test() 需要非空的用例名');
  }
  if (typeof fn !== 'function') {
    throw new Error('test("' + name + '") 需要函数作为用例体');
  }
  if (registry.some((c) => c.name === name)) {
    throw new Error('重复的用例名: ' + name);
  }
  registry.push({ name, fn });
}

export function listCases(): string[] {
  return registry.map((c) => c.name);
}

export async function runCase(name: string): Promise<void> {
  const found = registry.find((c) => c.name === name);
  if (!found) throw new Error('用例不存在: ' + name);
  await found.fn();
}