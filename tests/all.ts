// 进程内测试入口：node:test 默认会为每个文件 spawn 子进程，
// 受限环境下直接在本进程导入全部测试文件执行。
import "./aggregate.test.ts";
import "./compare.test.ts";
import "./store.test.ts";

