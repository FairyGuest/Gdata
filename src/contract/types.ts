// 数据契约：模块间交换的所有数据结构在此定义。
export type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';

export const SEVERITY_ORDER: Record<Severity, number> = {
  CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, UNKNOWN: 4,
};

export interface PackageSpec {
  name: string;
  version: string; // 语义化版本 major.minor.patch
  dependencies?: Record<string, string>; // name -> 版本范围
}

export interface ScanOptions {
  maxNodes?: number;  // 依赖图节点上限，默认见 config
  maxDepth?: number;  // 依赖展开深度上限
  maxPaths?: number;  // 每个漏洞包最多输出的依赖路径数
}

export interface ScanRequest {
  scanId?: string;            // 客户端可选指定；重复则 STATE_CONFLICT
  roots: string[];            // 形如 "name@range" 的根包
  registry: PackageSpec[];    // 本地包注册表（合成夹具）
  options?: ScanOptions;
}

export interface Vulnerability {
  id: string;
  packageName: string;
  affectedRange: string; // 版本范围，如 ">=1.0.0 <2.0.0"
  severity: Severity;
  summary: string;
  fixedIn?: string;
}

export interface CycleEdge { from: string; to: string; } // "name@version"

export interface Finding {
  vulnerability: Vulnerability;
  packageName: string;
  packageVersion: string;
  paths: string[][]; // 从根包到漏洞包的依赖路径（节点为 "name@version"）
}

export interface ScanReport {
  scanId: string;
  runId: string;
  roots: string[];
  packageCount: number;
  cycles: CycleEdge[];
  findings: Finding[]; // 已按严重度排序
}

export interface ResolvedGraph {
  nodes: Map<string, PackageSpec>;        // key: "name@version"
  edges: Map<string, string[]>;           // adjacency, key -> resolved dep node keys
  cycles: CycleEdge[];
  truncated: boolean;
}
