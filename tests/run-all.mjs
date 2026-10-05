// 聚合入口：node --test 的进程隔离模式在某些环境不可用，
// 这里在单进程内依次导入各测试文件，node:test 会自动执行并汇总。
import './discovery.test.mjs';
import './statusAdapter.test.mjs';
import './store.test.mjs';
import './executor.test.mjs';
import './api.test.mjs';