import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PRESETS, RefundScenario } from "../src/refund.ts";
import { exportTrace } from "../src/trace.ts";
import { exportLangChainJsonl, UnsupportedTraceError } from "../src/auditor-export.ts";
import { SharedEnterpriseScenario } from "../src/enterprise.ts";

const CASES: Record<string, Record<string, unknown>> = {
  "healthy-on": { ...PRESETS.healthy, idempotency: true },
  "healthy-off": { ...PRESETS.healthy, idempotency: false },
  "timeout-on": { ...PRESETS.timeout, idempotency: true },
  "timeout-off": { ...PRESETS.timeout, idempotency: false },
  "bounded-off": { ...PRESETS.timeout, idempotency: false, timeoutAttempts: 10, maxRetries: 2 },
};
function exported(name: string): string {
  const s = new RefundScenario(CASES[name]);
  s.start();
  s.run();
  return exportLangChainJsonl(exportTrace(s.sim.log, "t", s.snapshot().derived));
}
const parse = (t: string) => t.trim().split("\n").map((l) => JSON.parse(l) as Record<string, any>);

test("export follows the adapter's structural rules (re-stated; real proof is the CLI test below)", () => {
  for (const name of Object.keys(CASES)) {
    const recs = parse(exported(name));
    const ids = recs.map((r) => r.event_id);
    assert.equal(new Set(ids).size, ids.length, `${name}: unique event_id`);
    for (const r of recs) {
      assert.ok(["tool_start", "tool_end", "chain_start", "chain_end"].includes(r.event));
      assert.ok(typeof r.run_id === "string" && r.run_id);
      assert.ok(Number.isFinite(Date.parse(r.start_time ?? r.end_time)), "valid timestamp");
      assert.deepEqual(Object.keys(r.metadata).filter((k) => !["source", "source_event_ids"].includes(k)), [], "metadata allowlist");
      assert.match(r.metadata.source, /SIMULATED/);
    }
    assert.equal(recs.filter((r) => r.event === "chain_start" && !r.parent_run_id).length, 1, "single root");
    const startIds = new Set(recs.filter((r) => r.event.endsWith("_start")).map((r) => r.run_id));
    for (const r of recs) if (r.parent_run_id) assert.ok(startIds.has(r.parent_run_id), "parent exists");
  }
});

test("retry evidence is explicit; replay is not claimed as a retry; no invented cost/tokens", () => {
  const off = parse(exported("timeout-off")).filter((r) => r.event === "tool_start" && r.side_effect === "POST") as [Record<string, any>, Record<string, any>];
  assert.equal(off.length, 2);
  assert.equal(off[0].retry_count, 0);
  assert.equal(off[0].attempt_of, undefined);
  assert.equal(off[1].retry_count, 1);
  assert.equal(off[1].attempt_of, off[0].run_id);
  assert.equal(off[1].idempotency_key, null, "policy off => explicit absent key");
  assert.equal(off[0].body_hash, off[1].body_hash);
  assert.match(off[0].body_hash, /^sha256:[0-9a-f]{64}$/);
  const on = parse(exported("timeout-on")).filter((r) => r.event === "tool_start" && r.side_effect === "POST");
  assert.ok(on.every((r) => typeof r.idempotency_key === "string"));
  const replay = parse(exported("healthy-off")).filter((r) => r.event === "tool_start" && r.side_effect === "POST")[1]!;
  assert.equal(replay.attempt_of, undefined);
  assert.equal(replay.retry_count, undefined);
  for (const name of Object.keys(CASES)) for (const r of parse(exported(name))) for (const k of ["tokens", "cost", "total_cost", "declared_budget", "prompt_tokens"]) assert.equal(r[k], undefined, `${name}: no ${k}`);
});

test("timed-out attempt does not leak the server-side refund id into client output", () => {
  const recs = parse(exported("timeout-off"));
  const first = recs.find((r) => r.event === "tool_end" && r.error);
  assert.ok(first);
  assert.match(first.error, /client timeout after 1000 virtual ms/);
  assert.equal(first.output, undefined);
});

test("export is deterministic", () => {
  assert.equal(exported("timeout-off"), exported("timeout-off"));
});

test("M6 enterprise traces are rejected as unsupported", () => {
  const s = new SharedEnterpriseScenario({ mode: "healthy", seed: 7 });
  s.start();
  s.run();
  assert.throws(() => exportLangChainJsonl(s.exportTrace()), UnsupportedTraceError);
});

// Real compatibility proof: runs the actual auditor CLI. Needs the repo on disk.
// PowerShell:  $env:SIM_AUDITOR_REPO = "C:\path\to\resilient-agent-invariants"
const REPO = process.env.SIM_AUDITOR_REPO;
const tsnode = REPO ? join(REPO, "node_modules", "ts-node", "dist", "bin.js") : "";
const live = !!REPO && existsSync(tsnode) && existsSync(join(REPO, "bin", "agent-invariants.ts"));

test("REAL auditor CLI: accepts JSONL exports and reports unkeyed mutations", { skip: live ? false : "set SIM_AUDITOR_REPO to a resilient-agent-invariants checkout with node_modules to run" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "sim-aud-"));
  try {
    const audit = (name: string) => {
      const f = join(dir, `${name}.jsonl`);
      writeFileSync(f, exported(name));
      const r = spawnSync(process.execPath, [tsnode, join(REPO!, "bin", "agent-invariants.ts"), "audit", f, "--json"], { cwd: REPO, encoding: "utf8", timeout: 120000 });
      assert.ok(r.status !== null, `${name}: auditor did not exit: ${r.error?.message ?? r.stderr}`);
      assert.ok(r.stdout.trim(), `${name}: auditor returned no JSON: ${r.stderr.slice(0, 500)}`);
      const findings = JSON.parse(r.stdout) as Array<{ rule: string; severity: string; source: string }>;
      return { exit: r.status, idempotency: findings.filter((x) => x.rule === "idempotency-guard" && x.source === "trace") };
    };
    const to = audit("timeout-off");
    assert.equal(to.idempotency.length, 2, "both unkeyed POST attempts are reported");
    assert.ok(to.idempotency.every((finding) => finding.severity === "CRITICAL"));
    assert.equal(to.exit, 1, "critical findings use the auditor's exit code 1");
    assert.equal(audit("bounded-off").idempotency.length, 3, "initial attempt and two retries are reported");
    assert.equal(audit("timeout-on").idempotency.length, 0, "keyed attempts are not reported");
    assert.equal(audit("healthy-on").idempotency.length, 0);
    assert.equal(audit("healthy-off").idempotency.length, 2, "the generic rule reports both unkeyed writes, including a replay");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
