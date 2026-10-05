export type FaultType = 'latency' | 'connection_reset' | 'error_status' | 'truncate';

export const FAULT_TYPES: readonly FaultType[] = [
  'latency',
  'connection_reset',
  'error_status',
  'truncate',
];

export interface FaultParams {
  /** latency: milliseconds added before forwarding */
  delayMs?: number;
  /** error_status: HTTP status returned to the client */
  statusCode?: number;
  /** truncate: fraction of the upstream body that is kept, 0 < ratio < 1 */
  keepRatio?: number;
}

export interface StartInjectionInput {
  faultType: FaultType;
  probability: number;
  /** auto-stop after this many ms; null means manual stop only */
  durationMs: number | null;
  params: FaultParams;
}

export type InjectionStatus = 'active' | 'stopped' | 'expired';

export interface InjectionSession {
  id: string;
  faultType: FaultType;
  probability: number;
  durationMs: number | null;
  params: FaultParams;
  status: InjectionStatus;
  startedAt: number;
  endsAt: number | null;
  endedAt: number | null;
}

export interface FaultDecision {
  sessionId: string;
  faultType: FaultType;
  params: FaultParams;
}

export interface FaultEventRecord {
  id: number;
  requestId: string;
  sessionId: string;
  faultType: FaultType;
  timestamp: number;
  durationMs: number;
  detail: string;
}

export interface InjectionStats {
  sessionId: string;
  faultType: FaultType;
  status: InjectionStatus;
  startedAt: number;
  endedAt: number | null;
  affectedRequests: number;
  totalRequestsDuringSession: number;
}

export interface ServiceConfig {
  port: number;
  host: string;
  targetUrl: string;
  dbPath: string;
  maxActiveInjections: number;
  maxDelayMs: number;
}