import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { Sim, LimitError } from "../src/kernel.ts";
import { PRESETS, RefundScenario, parseConfig } from "../src/refund.ts";
import { exportTrace } from "../src/trace.ts";

const run = (cfg: Record<string, unknown>) => {
  const s = new RefundScenario(cfg);
  s.start();
  s.run();
  return s;
};
const kinds = (s: RefundScenario) => s.sim.log.map((e) => e.kind);
const norm = (s: RefundScenario) => JSON.stringify({ log: s.sim.log, snap: s.snapshot() });

test("1 virtual clock advances by schedule, not wall time", () => {
  const sim = new Sim(1);
  const wall = Date.now();
  sim.at(5000, "late", () => {});
  sim.at(10, "early", () => {});
  sim.step();
  assert.equal(sim.now, 10);
  sim.step();
  assert.equal(sim.now, 5000);
  assert.ok(Date.now() - wall < 1000, "5s of virtual time must not take 5s");
  sim.advanceTo(9000);
  assert.equal(sim.now, 9000);
});

test("2 same-timestamp events run in insertion order, nested same-time runs after", () => {
  const sim = new Sim(1);
  const order: string[] = [];
  sim.at(5, "a", () => { order.push("a"); sim.at(0, "a2", () => order.push("a2")); });
  sim.at(5, "b", () => order.push("b"));
  sim.at(5, "c", () => order.push("c"));
  while (sim.step());
  assert.deepEqual(order, ["a", "b", "c", "a2"]);
});

test("2b long chain does not overflow the stack", () => {
  const sim = new Sim(1, { maxSteps: 200000 });
  let n = 0;
  const tick = () => { if (++n < 100000) sim.at(1, "t", tick); };
  sim.at(0, "t", tick);
  while (sim.step());
  assert.equal(n, 100000);
});

test("3 same seed+config => identical log and state; different seed differs", () => {
  const a = run({ ...PRESETS.timeout, seed: 7 });
  const b = run({ ...PRESETS.timeout, seed: 7 });
  const c = run({ ...PRESETS.timeout, seed: 8 });
  assert.equal(norm(a), norm(b));
  assert.notEqual(norm(a), norm(c)); // jitter comes from the seed
});

test("4 different faults => different state", () => {
  const h = run({ ...PRESETS.healthy });
  const t = run({ ...PRESETS.timeout });
  assert.ok(!kinds(h).includes("client.timeout"));
  assert.ok(kinds(t).includes("client.timeout"));
  assert.equal(h.snapshot().refundState, "completed");
  assert.equal(t.snapshot().refundState, "completed");
  assert.equal(t.sim.log.filter((e) => e.kind === "payment.attempt.sent").length, 2);
});

test("5 retries are bounded", () => {
  const s = run({ ...PRESETS.timeout, timeoutAttempts: 10, maxRetries: 2, idempotency: false });
  const sent = s.sim.log.filter((e) => e.kind === "payment.attempt.sent");
  assert.equal(sent.length, 3); // 1 + maxRetries
  assert.equal(s.snapshot().refundState, "failed");
  assert.equal(s.snapshot().operations[0]!.state, "failed_outcome_unknown");
  const z = run({ ...PRESETS.timeout, timeoutAttempts: 10, maxRetries: 0 });
  assert.equal(z.sim.log.filter((e) => e.kind === "payment.attempt.sent").length, 1);
});

test("6 timeout fires after remote op already completed", () => {
  const s = run({ ...PRESETS.timeout });
  const created = s.sim.log.find((e) => e.kind === "payment.refund.created")!;
  const timeout = s.sim.log.find((e) => e.kind === "client.timeout")!;
  const late = s.sim.log.find((e) => e.kind === "payment.response.late_ignored")!;
  assert.ok(created.t < timeout.t, "server processed before client gave up");
  assert.ok(late.t > timeout.t, "response arrived after timeout and was ignored");
  assert.equal(s.snapshot().refunds.length >= 1, true);
});

test("7 idempotency off: timeout+retry duplicates refund", () => {
  const s = run({ ...PRESETS.timeout, idempotency: false });
  const snap = s.snapshot();
  assert.equal(snap.refunds.length, 2);
  assert.equal(snap.derived.duplicateRefunds, 1);
});

test("8 idempotency on: retry returns original, no second refund", () => {
  const s = run({ ...PRESETS.timeout, idempotency: true });
  const snap = s.snapshot();
  assert.equal(snap.refunds.length, 1);
  assert.equal(snap.derived.duplicateRefunds, 0);
  const rep = s.sim.log.find((e) => e.kind === "payment.idempotent_replay")!;
  assert.equal(rep.data.refundId, "rf-1");
  const healthy = run({ ...PRESETS.healthy, idempotency: true });
  assert.equal(healthy.snapshot().refunds.length, 1); // replay did not refund again
  assert.ok(kinds(healthy).includes("payment.idempotent_replay"));
  assert.equal(run({ ...PRESETS.healthy, idempotency: false }).snapshot().refunds.length, 2);
});

test("9 SQLite rows match event log", () => {
  for (const cfg of [PRESETS.healthy, PRESETS.timeout]) for (const idempotency of [true, false]) {
    const s = run({ ...cfg, idempotency });
    const snap = s.snapshot();
    for (const table of ["refunds", "operations"] as const) {
      const logged = s.sim.log.filter((e) => e.kind === "db.write" && e.data.table === table).map((e) => e.data.rowId);
      assert.deepEqual(logged, snap[table].map((r) => r.id), `${table} ${JSON.stringify(cfg)} idem=${idempotency}`);
    }
    const last = s.sim.log.filter((e) => e.kind === "state.transition").at(-1)!;
    assert.equal(last.data.to, snap.refundState);
  }
});

test("10 trace is self-consistent: unique ids, parents exist, retry linked, derived separate", () => {
  const s = run({ ...PRESETS.timeout, idempotency: false });
  const tr = exportTrace(s.sim.log, "t1", s.snapshot().derived);
  const ids = new Set(tr.spans.map((x) => x.spanId));
  assert.equal(ids.size, tr.spans.length);
  for (const sp of tr.spans) assert.ok(sp.parentSpanId === null || ids.has(sp.parentSpanId));
  assert.equal(tr.spans.filter((x) => x.parentSpanId === null).length, 1);
  const attempts = tr.spans.filter((x) => x.name === "payment.attempt");
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0]!.status, "timeout");
  assert.equal(attempts[1]!.status, "ok");
  assert.deepEqual(attempts[1]!.links, [{ type: "retry_of", spanId: attempts[0]!.spanId }]);
  assert.equal(typeof attempts[0]!.attrs.lateResponseAtMs, "number");
  assert.equal(tr.derived.duplicateRefunds, 1);
  assert.ok(!tr.spans.some((x) => "duplicateRefunds" in x.attrs)); // derived not mixed into observed
});

test("11 malformed config rejected", () => {
  for (const bad of [null, [], "x", { nope: 1 }, { seed: "1" }, { seed: -1 }, { seed: 1.5 }, { mode: "chaos" }, { orderId: "../etc" }, { maxRetries: 99 }, { timeoutMs: 0 }, { idempotency: "yes" }])
    assert.throws(() => parseConfig(bad), Error, JSON.stringify(bad));
  assert.doesNotThrow(() => parseConfig({}));
});

test("12 event and payload limits", () => {
  const s = run({ ...PRESETS.healthy, maxEvents: 10 });
  assert.equal(s.life, "error");
  assert.match(s.error!, /event limit/);
  assert.ok(s.sim.log.length <= 10);
  const sim = new Sim(1, { maxPayloadBytes: 20 });
  assert.throws(() => sim.emit("x", "c", { big: "y".repeat(100) }), LimitError);
});

test("13 reset cleans state and replay is identical", () => {
  const s = run({ ...PRESETS.timeout, idempotency: false });
  const first = norm(s);
  s.reset();
  assert.equal(s.life, "idle");
  assert.equal(s.sim.log.length, 0);
  assert.equal(s.snapshot().refunds.length, 0);
  assert.equal(s.snapshot().operations.length, 0);
  s.start();
  s.run();
  assert.equal(norm(s), first);
});

test("13b stop halts execution; step-by-step equals run", () => {
  const a = new RefundScenario({ ...PRESETS.healthy });
  a.start();
  a.step(); a.step();
  a.stop();
  assert.equal(a.step(), false);
  assert.equal(a.life, "stopped");
  const b = new RefundScenario({ ...PRESETS.healthy });
  b.start();
  while (b.step());
  assert.equal(norm(b), norm(run({ ...PRESETS.healthy })));
});

test("14 no outbound network connections", () => {
  const orig = net.Socket.prototype.connect;
  let calls = 0;
  net.Socket.prototype.connect = function (this: net.Socket, ...a: unknown[]) { calls++; return (orig as (...x: unknown[]) => net.Socket).apply(this, a); } as typeof orig;
  try {
    run({ ...PRESETS.healthy });
    run({ ...PRESETS.timeout, idempotency: false });
  } finally {
    net.Socket.prototype.connect = orig;
  }
  assert.equal(calls, 0);
});
