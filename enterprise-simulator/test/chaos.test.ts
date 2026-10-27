import test from "node:test";
import assert from "node:assert/strict";
import { CHAOS_TENANTS, EnterpriseChaosScenario, paymentIdempotencyKey } from "../src/chaos.ts";

function completed(mode: "naive" | "resilient", config: Record<string, unknown> = {}) {
  const scenario = new EnterpriseChaosScenario({ mode, ...config });
  scenario.start();
  scenario.run();
  return scenario;
}

test("M7 standard runs register ten scheduled workflows and deterministic traces", () => {
  const a = completed("resilient", { runId: "determinism-1", seed: 44 });
  const b = completed("resilient", { runId: "determinism-1", seed: 44 });
  assert.equal(a.snapshot().life, "finished");
  assert.equal(a.snapshot().workflows.length, 10);
  assert.equal(a.snapshot().eventsCount, a.sim.log.length);
  assert.deepEqual(a.snapshot(), b.snapshot());
  assert.deepEqual(a.sim.log, b.sim.log);
  assert.deepEqual(a.snapshot().workflows.map((workflow) => workflow.tenantId), CHAOS_TENANTS.map((tenant) => tenant.tenantId));
});

test("M7 naive mode demonstrates pool starvation, host crash, batch abort, duplicate charge, and orphan", () => {
  const scenario = completed("naive", { runId: "naive-acceptance" });
  const snap = scenario.snapshot();
  assert.equal(snap.life, "finished");
  assert.ok(snap.metrics.poolAcquisitionTimeouts > 0);
  assert.ok(snap.metrics.peakActiveDbConnections <= 5);
  assert.equal(snap.metrics.activeDbConnections, 0);
  assert.ok(snap.metrics.totalDbConnectionHoldMs >= 5 * 30_000);
  assert.ok(snap.metrics.mainHostCrashes >= 1);
  assert.equal(snap.metrics.innocentBatchTasksAborted, 49);
  assert.equal(snap.metrics.duplicateDollarsCharged, 50);
  assert.equal(snap.metrics.orphanedAwsInstances, 1);
  assert.equal(snap.metrics.tokensConsumed, 0);
  assert.ok(scenario.sim.log.some((event) => event.kind === "llm.tokens.aborted"));
  assert.ok(snap.workflows.some((workflow) => workflow.status === "host_unavailable"));
  assert.equal(scenario.sim.log.filter((event) => event.kind === "workflow.terminal").length, 10);
  assert.ok(scenario.sim.log.some((event) => event.kind === "process.main_host.crashed"));
  assert.equal(scenario.sim.log.filter((event) => event.kind.startsWith("batch.item.")).length, 50);
  assert.equal(new Set(scenario.sim.log.filter((event) => event.kind.startsWith("batch.item.")).map((event) => event.data.item)).size, 50);
});

test("M7 resilient mode leases zero-hold reads, contains worker fault, unrolls batch, deduplicates payment, and rolls back", () => {
  const scenario = completed("resilient", { runId: "resilient-acceptance" });
  const snap = scenario.snapshot();
  assert.equal(snap.life, "finished");
  assert.equal(snap.metrics.poolAcquisitionTimeouts, 0);
  assert.ok(snap.metrics.peakActiveDbConnections <= 5);
  assert.equal(snap.metrics.activeDbConnections, 0);
  assert.ok(snap.metrics.totalDbConnectionHoldMs <= 10 * 2);
  assert.ok(snap.metrics.measurementWindowMs > 0);
  assert.ok(snap.metrics.dbPoolUtilizationPercent > 0);
  assert.ok(snap.metrics.dbPoolUtilizationPercent < 1);
  assert.equal(snap.metrics.mainHostCrashes, 0);
  assert.equal(snap.metrics.containedWorkerCrashes, 1);
  assert.equal(snap.host.state, "online");
  assert.equal(snap.workers[0]!.state, "crashed");
  assert.equal(snap.metrics.innocentBatchTasksAborted, 0);
  assert.equal(snap.metrics.batchItemsSucceeded, 49);
  assert.equal(snap.metrics.batchItemsFailed, 1);
  assert.equal(snap.metrics.duplicateDollarsCharged, 0);
  assert.equal(snap.metrics.paymentAcceptedCharges, 1);
  const paymentKeys = scenario.sim.log.filter((event) => event.kind === "payment.attempt").map((event) => event.data.key);
  assert.equal(paymentKeys.length, 2);
  assert.equal(paymentKeys[0], paymentKeys[1]);
  assert.equal(snap.metrics.orphanedAwsInstances, 0);
  assert.deepEqual(snap.saga.compensationOrder, ["configure_network", "attach_storage", "allocate_compute"]);
  assert.equal(snap.metrics.sagaCompensationsSucceeded, 3);
  for (const taskId of ["task-acme", "task-nexus", "task-apex", "task-omni", "task-vortex"]) {
    assert.equal(snap.workflows.find((workflow) => workflow.taskId === taskId)?.status, "completed");
  }
  assert.equal(snap.metrics.tokensConsumed, 5000);
});

test("M7 payment keys are deterministic and scoped by run and logical operation", () => {
  const payload = { amount: 50, nested: { b: 2, a: 1 } };
  assert.equal(paymentIdempotencyKey("run-a", "step-1", payload), paymentIdempotencyKey("run-a", "step-1", { nested: { a: 1, b: 2 }, amount: 50 }));
  assert.notEqual(paymentIdempotencyKey("run-a", "step-1", payload), paymentIdempotencyKey("run-b", "step-1", payload));
  assert.notEqual(paymentIdempotencyKey("run-a", "step-1", payload), paymentIdempotencyKey("run-a", "step-2", payload));
});

test("M7 config bounds are checked and reset removes old scheduled state", () => {
  assert.throws(() => new EnterpriseChaosScenario({ poolCapacity: 0 }), /poolCapacity/);
  assert.throws(() => new EnterpriseChaosScenario({ maxRetries: 6 }), /maxRetries/);
  assert.throws(() => new EnterpriseChaosScenario({ runId: "bad run id" }), /runId/);
  const scenario = new EnterpriseChaosScenario({ mode: "resilient", runId: "reset-case" });
  scenario.start();
  scenario.step();
  assert.ok(scenario.sim.pending() > 0);
  scenario.reset();
  assert.equal(scenario.life, "idle");
  assert.equal(scenario.sim.pending(), 0);
  assert.equal(scenario.snapshot().eventsCount, 0);
  scenario.start();
  scenario.run();
  assert.equal(scenario.snapshot().life, "finished");
});

test("M7 snapshots are copies and event history is capped independently of event count", () => {
  const scenario = completed("resilient", { eventHistoryLimit: 100, maxEvents: 2000 });
  const first = scenario.snapshot();
  assert.ok(first.eventsCount > 100);
  assert.equal(first.events.length, 100);
  first.workflows[0]!.tenant = "corrupted";
  first.metrics.tokensConsumed = -1;
  first.events[0]!.data.mode = "corrupted";
  const second = scenario.snapshot();
  assert.notEqual(second.workflows[0]!.tenant, "corrupted");
  assert.equal(second.metrics.tokensConsumed, 5000);
  assert.notEqual(second.events[0]!.data.mode, "corrupted");
});

test("M7 pool waiter queue remains bounded and overflows deterministically", () => {
  const scenario = completed("naive", { runId: "tiny-pool", poolCapacity: 1, poolQueueCapacity: 1 });
  const snap = scenario.snapshot();
  assert.equal(snap.metrics.peakActiveDbConnections, 1);
  assert.ok(snap.metrics.dbWaitQueueLength <= 1);
  assert.ok(snap.metrics.poolAcquisitionTimeouts >= 8);
  assert.equal(snap.metrics.activeDbConnections, 0);
  assert.equal(scenario.sim.log.filter((event) => event.kind === "db.pool.timeout" && event.data.reason === "wait_queue_full").length, 8);
});

test("M7 failed saga compensation leaves actual orphan state and reports failure", () => {
  const scenario = completed("resilient", { runId: "compensation-fails", sagaCompensationFails: true });
  const snap = scenario.snapshot();
  const saga = snap.workflows.find((workflow) => workflow.taskId === "task-dunmore");
  assert.equal(saga?.status, "failed");
  assert.equal(snap.metrics.sagaCompensationsFailed, 1);
  assert.equal(snap.metrics.orphanedAwsInstances, 1);
  assert.ok(scenario.sim.log.some((event) => event.kind === "saga.compensation.failed"));
});

test("M7 event limit stops execution safely and remains resettable", () => {
  const scenario = new EnterpriseChaosScenario({ mode: "resilient", runId: "event-bound", maxEvents: 100 });
  scenario.start();
  scenario.run();
  assert.equal(scenario.life, "error");
  assert.match(scenario.error ?? "", /event limit/);
  assert.equal(scenario.sim.log.length, 100);
  scenario.reset();
  assert.equal(scenario.life, "idle");
  assert.equal(scenario.sim.pending(), 0);
});

test("M7 naive payment retry uses a fresh key and resilient workflows progress after contained worker fault", () => {
  const naive = completed("naive", { runId: "naive-key-check" });
  const keys = naive.sim.log.filter((event) => event.kind === "payment.attempt").map((event) => event.data.key);
  assert.equal(keys.length, 2);
  assert.notEqual(keys[0], keys[1]);

  const resilient = completed("resilient", { runId: "post-worker-progress" });
  const exit = resilient.sim.log.find((event) => event.kind === "worker.exit");
  assert.ok(exit);
  for (const taskId of ["task-acme", "task-nexus", "task-apex", "task-omni", "task-vortex"]) {
    const terminal = resilient.sim.log.find((event) => event.kind === "workflow.terminal" && event.data.taskId === taskId);
    assert.ok(terminal);
    assert.ok(terminal.t > exit.t);
    assert.equal(terminal.data.status, "completed");
  }
});