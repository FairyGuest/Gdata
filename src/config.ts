export interface AppConfig {
  dbPath: string;
  host: string;
  port: number;
  loanToValueBps: number;
  liquidationLineBps: number;
  perTickBps: number;
  busTimeoutMs: number;
}

const DEFAULT_CONFIG: AppConfig = {
  dbPath: process.env.NFT_LOAN_DB ?? 'data/ledger.sqlite',
  host: process.env.NFT_LOAN_HOST ?? '127.0.0.1',
  port: Number(process.env.NFT_LOAN_PORT ?? 4731),
  loanToValueBps: 8000,
  liquidationLineBps: 10000,
  perTickBps: 5,
  busTimeoutMs: 15000,
};

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}
