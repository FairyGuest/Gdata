import { rmSync, mkdirSync, appendFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { buildServer, type RunningServer } from "../src/app.ts";
import { api, type ApiResponse } from "./client.ts";
import {
  buildCanonicalStream,
  buildOutOfOrderBatches,
  buildInvalidTransfer,
} from "./fixtures.ts";
import type { NftEvent } from "../src/contract/types.ts";
import { referenceProjection, stateView } from "./reference.ts";

interface StateBody {
  appliedSeq: number;
  ownership: Record<string, string>;
  stats: { volume: number; floor: number | null; lastSale: unknown };
}

interface ErrorBody { error: true; reason: string; message: string; runId?: string }

function reason(res: ApiResponse): string | null {
  const b = res.body as ErrorBody | undefined;
  return b && typeof b === "object" && "reason" in b ? b.reason : null;
}

class Reporter {
  readonly runId: string;
  readonly results: Array<{ name: string; pass: boolean; detail: string }> = [];
  private readonly logPath: string;

  constructor() {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    this.runId = `accept-${stamp}-${process.pid}`;
    this.logPath = resolve("accept-run.log");
    mkdirSync(resolve("data"), { recursive: true });
  }

  line(text: string): void {
    console.log(text);
    appendFileSync(this.logPath, text + "\n");
  }
  section(title: string): void {
    this.line("");
    this.line("=== " + title + " ===");
  }
  exchange(method: string, path: string, request: unknown, response: ApiResponse): void {
    this.line("  -> " + method + " " + path + " " + j(request));
    this.line("  <- " + response.status + " " + j(response.body));
  }
  check(name: string, pass: boolean, detail: string): void {
    this.results.push({ name, pass, detail });
    this.line((pass ? "  [PASS] " : "  [FAIL] ") + name + " :: " + detail);
    if (!pass) process.exitCode = 1;
  }
  info(): string {
    return this.logPath;
  }
}

function j(v: unknown): string {
  return JSON.stringify(v);
}

async function getState(base: string): Promise<ApiResponse<StateBody>> {
  return api<StateBody>(base, "GET", "/state");
}

async function postEvent(
  r: Reporter,
  base: string,
  event: NftEvent,
  note = ""
): Promise<ApiResponse<{ appliedSeq: number; commitSeq: number }>> {
  const res = await api(base, "POST", "/events", event);
  r.exchange("POST", "/events" + (note ? " " + note : ""), event, res);
  return res as ApiResponse<{ appliedSeq: number; commitSeq: number }>;
}

async function freshServer(r: Reporter, tag: string): Promise<{ server: RunningServer; base: string }> {
  const dir = join(tmpdir(), "nft-indexer-" + tag + "-" + process.pid);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const server = await buildServer({
    dbPath: join(dir, tag + ".sqlite"),
    port: 0,
    runId: r.runId + "-" + tag,
  });
  return { server, base: "http://127.0.0.1:" + server.port };
}



async function scenarioInputValidation(r: Reporter, base: string): Promise<void> {
  r.section("SCENARIO 1: contract parsing / 422 input errors");

  const badSeq = await api(base, "POST", "/events", { seq: -1, type: "mint", tokenId: "T", to: "a" });
  r.exchange("POST", "/events", { seq: -1, type: "mint" }, badSeq);
  r.check("422 invalid_field non-positive seq", badSeq.status === 422 && reason(badSeq) === "invalid_field",
    "status=" + badSeq.status + " reason=" + reason(badSeq));

  const badType = await api(base, "POST", "/events", { seq: 1, type: "burn", tokenId: "T", to: "a" });
  r.exchange("POST", "/events", { seq: 1, type: "burn" }, badType);
  r.check("422 unsupported_type", badType.status === 422 && reason(badType) === "unsupported_type",
    "status=" + badType.status + " reason=" + reason(badType));

  const badPrice = await api(base, "POST", "/events", { seq: 1, type: "sale", tokenId: "T", from: "a", to: "b", price: -3 });
  r.exchange("POST", "/events", { price: -3 }, badPrice);
  r.check("422 invalid_field negative price", badPrice.status === 422 && reason(badPrice) === "invalid_field",
    "status=" + badPrice.status + " reason=" + reason(badPrice));

  const notJson = await api(base, "POST", "/events", { nested: "object-ok", seq: 0, type: "mint" } as unknown);
  r.check("422 invalid_field for seq=0", notJson.status === 422 && reason(notJson) === "invalid_field",
    "status=" + notJson.status + " reason=" + reason(notJson));
}

async function scenarioGapAndInvalid(r: Reporter): Promise<void> {
  r.section("SCENARIO 2: strict contiguity (event_gap) + invalid_transition");
  const { server, base } = await freshServer(r, "gap");
  try {
    const stream = buildCanonicalStream();

    const first = await postEvent(r, base, stream.events[0], "seq1 mint");
    r.check("apply seq1 mint", first.status === 200 && first.body.appliedSeq === 1,
      "status=" + first.status + " appliedSeq=" + first.body.appliedSeq);

    const gap = await api(base, "POST", "/events", stream.events[2]);
    r.exchange("POST", "/events", "gap seq3 while at 1", gap);
    r.check("409 event_gap on 1->3", gap.status === 409 && reason(gap) === "event_gap",
      "status=" + gap.status + " reason=" + reason(gap));

    let state = await getState(base);
    r.exchange("GET", "/state", "after gap", state);
    r.check("appliedSeq unchanged at 1", state.body.appliedSeq === 1, "appliedSeq=" + state.body.appliedSeq);

    const sale2 = await postEvent(r, base, stream.events[1], "seq2 sale @100");
    r.check("apply seq2 sale @100", sale2.status === 200 && sale2.body.appliedSeq === 2,
      "appliedSeq=" + sale2.body.appliedSeq);

    const mint3 = await postEvent(r, base, stream.events[2], "seq3 mint T2");
    r.check("apply seq3 mint T2", mint3.status === 200 && mint3.body.appliedSeq === 3,
      "appliedSeq=" + mint3.body.appliedSeq);

    const invalid = buildInvalidTransfer(4);
    const inv = await api(base, "POST", "/events", invalid);
    r.exchange("POST", "/events", "invalid transfer erin->dave", inv);
    r.check("409 invalid_transition rejected wholesale", inv.status === 409 && reason(inv) === "invalid_transition",
      "status=" + inv.status + " reason=" + reason(inv));

    state = await getState(base);
    r.check("appliedSeq stays 3", state.body.appliedSeq === 3, "appliedSeq=" + state.body.appliedSeq);
    r.check("T2 owner remains carol", state.body.ownership.T2 === "carol", "T2=" + state.body.ownership.T2);

    const legal4 = await postEvent(r, base, stream.events[3], "legal seq4 carol->dave");
    r.check("legal seq4 applies after rejection", legal4.status === 200 && legal4.body.appliedSeq === 4,
      "appliedSeq=" + legal4.body.appliedSeq);
    state = await getState(base);
    r.check("T2 owner now dave", state.body.ownership.T2 === "dave", "T2=" + state.body.ownership.T2);
  } finally {
    await server.close();
  }
}

async function scenarioConcurrentDuplicate(r: Reporter): Promise<void> {
  r.section("SCENARIO 3: concurrent duplicate of same seq (commit-seq arbitration)");
  const { server, base } = await freshServer(r, "dup");
  try {
    const event = buildCanonicalStream().events[0];
    r.line("  firing 2 concurrent identical POST /events");
    const [a, b] = await Promise.all([
      api(base, "POST", "/events", event),
      api(base, "POST", "/events", event),
    ]);
    r.exchange("POST", "/events#A", event, a);
    r.exchange("POST", "/events#B", event, b);
    const statuses = [a.status, b.status].sort((x, y) => x - y).join(",");
    const exactlyOne200 = (a.status === 200) !== (b.status === 200);
    const oneDup = [a, b].some((x) => x.status === 409 && reason(x) === "duplicate_event");
    r.check("exactly one 200 and one 409 duplicate_event", exactlyOne200 && oneDup, "statuses=[" + statuses + "]");

    const tampered = JSON.parse(JSON.stringify(event)) as NftEvent;
    (tampered as { to: string }).to = "mallory";
    const diff = await api(base, "POST", "/events", tampered);
    r.exchange("POST", "/events", "same seq, changed to=mallory", diff);
    r.check("same seq diff content -> 409 duplicate_event", diff.status === 409 && reason(diff) === "duplicate_event",
      "status=" + diff.status + " reason=" + reason(diff));

    const state = await getState(base);
    r.exchange("GET", "/state", "after concurrent duplicates", state);
    r.check("T1 still alice (no overwrite)", state.body.ownership.T1 === "alice", "T1=" + state.body.ownership.T1);
    r.check("volume not double counted", state.body.stats.volume === 0, "volume=" + state.body.stats.volume);
    r.check("floor still null", state.body.stats.floor === null, "floor=" + String(state.body.stats.floor));
    r.check("appliedSeq exactly 1", state.body.appliedSeq === 1, "appliedSeq=" + state.body.appliedSeq);
  } finally {
    await server.close();
  }
}

async function scenarioRebuild(r: Reporter): Promise<void> {
  r.section("SCENARIO 4: out-of-order/duplicate fixture replay + rebuild equality");
  const { server, base } = await freshServer(r, "rebuild");
  try {
    const { batches, stream } = buildOutOfOrderBatches();
    const observed: Array<{ label: string; seq: number; status: number; why: string | null }> = [];
    for (const batch of batches) {
      for (const event of batch.events) {
        const res = await api(base, "POST", "/events", event);
        observed.push({ label: batch.label, seq: event.seq, status: res.status, why: reason(res) });
      }
    }
    for (const o of observed) {
      r.line("    [" + o.label + "] seq=" + o.seq + " status=" + o.status + " reason=" + (o.why ?? "-"));
    }
    const gapRejected = observed.some((o) => o.seq === 2 && o.status === 409 && o.why === "event_gap");
    const dupRejected = observed.filter((o) => o.seq === 3).some((o) => o.status === 409 && o.why === "duplicate_event");
    r.check("early out-of-order seq2 -> event_gap", gapRejected, "event_gap observed before seq1");
    r.check("duplicate seq3 -> duplicate_event", dupRejected, "duplicate seq3 conflicted");

    const incremental = await getState(base);
    r.exchange("GET", "/state", "incremental final", incremental);
    r.check("incremental appliedSeq=8", incremental.body.appliedSeq === 8, "appliedSeq=" + incremental.body.appliedSeq);
    r.check("incremental volume=370", incremental.body.stats.volume === 370, "volume=" + incremental.body.stats.volume);
    r.check("incremental floor=30", incremental.body.stats.floor === 30, "floor=" + String(incremental.body.stats.floor));
    r.check("incremental ownership {T1:alice,T2:bob}",
      incremental.body.ownership.T1 === "alice" && incremental.body.ownership.T2 === "bob",
      j(incremental.body.ownership));

    for (const height of [3, 8] as const) {
      const expected = stateView(referenceProjection(stream.events.slice(0, height)));
      const rebuilt = await api<StateBody>(base, "POST", "/rebuild", { toSeq: height });
      r.exchange("POST", "/rebuild", { toSeq: height }, rebuilt);
      r.check("rebuild(" + height + ") appliedSeq matches", rebuilt.status === 200 && rebuilt.body.appliedSeq === height,
        "appliedSeq=" + rebuilt.body.appliedSeq);
      r.check("rebuild(" + height + ") ownership byte-equal to reference",
        j(rebuilt.body.ownership) === j(expected.ownership),
        "got=" + j(rebuilt.body.ownership) + " want=" + j(expected.ownership));
      r.check("rebuild(" + height + ") volume/floor/lastSale byte-equal",
        j(rebuilt.body.stats) === j(expected.stats),
        "got=" + j(rebuilt.body.stats) + " want=" + j(expected.stats));
    }

    const current = await getState(base);
    r.check("post-rebuild live state equals height-8 snapshot",
      j(current.body) === j(incremental.body),
      "live projection consistent with incremental final");
  } finally {
    await server.close();
  }
}

async function scenarioDiagnostics(r: Reporter): Promise<void> {
  r.section("SCENARIO 5: diagnostics record rejection reasons");
  const { server, base } = await freshServer(r, "diag");
  try {
    await api(base, "POST", "/events", { seq: 5, type: "mint", tokenId: "X", to: "a" });
    const diag = await api(base, "GET", "/diag/rejections");
    r.exchange("GET", "/diag/rejections", undefined, diag);
    const list = (diag.body as { rejections: Array<{ reason: string; status: number }> }).rejections;
    r.check("rejection logged with event_gap reason",
      Array.isArray(list) && list.some((x) => x.reason === "event_gap" && x.status === 409),
      "count=" + (Array.isArray(list) ? list.length : "n/a"));

    const health = await api(base, "GET", "/health");
    r.check("health carries runId", health.status === 200 && typeof (health.body as { runId?: string }).runId === "string",
      "status=" + health.status);
  } finally {
    await server.close();
  }
}



async function main(): Promise<void> {
  const r = new Reporter();
  r.section("BOOT runId=" + r.runId);
  const boot = await freshServer(r, "input");
  const base = boot.base;
  try {
    await scenarioInputValidation(r, base);
    await scenarioGapAndInvalid(r);
    await scenarioConcurrentDuplicate(r);
    await scenarioRebuild(r);
    await scenarioDiagnostics(r);
  } catch (err) {
    r.line("FATAL scenario crashed: " + j(err));
    process.exitCode = 1;
  } finally {
    await boot.server.close();
  }
  r.section("SUMMARY runId=" + r.runId);
  const passed = r.results.filter((x) => x.pass).length;
  for (const x of r.results) {
    r.line((x.pass ? "PASS " : "FAIL ") + x.name + " -- " + x.detail);
  }
  r.line("total " + r.results.length + " passed " + passed + " failed " + (r.results.length - passed));
  r.line("log file: " + r.info());
  if (passed !== r.results.length) {
    const failed = r.results.filter((x) => !x.pass).map((x) => x.name);
    r.line("FAILED SCENARIOS: " + failed.join("; "));
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("accept harness crashed", err);
  process.exit(1);
});

