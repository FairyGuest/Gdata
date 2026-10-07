// Structured JSON-line logger. Every line carries the run id so a failing
// acceptance run can be replayed from its logs alone.
export type LogFn = (event: string, fields?: Record<string, unknown>) => void;

export function makeLogger(runId: string, sink: (line: string) => void = (l) => console.log(l)): LogFn {
  return (event, fields = {}) => {
    sink(JSON.stringify({ ts: new Date().toISOString(), runId, event, ...fields }));
  };
}

export const nullLogger: LogFn = () => {};
