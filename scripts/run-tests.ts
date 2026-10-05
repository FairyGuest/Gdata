// 进程内测试入口：node --test 会派生子进程，在受限环境下可能失败，
// 因此直接 import 各测试文件，由 node:test 在当前进程内执行并汇报。
import '../test/pattern.test.ts';
import '../test/engine.test.ts';
import '../test/recorder.test.ts';
import '../test/api.test.ts';
