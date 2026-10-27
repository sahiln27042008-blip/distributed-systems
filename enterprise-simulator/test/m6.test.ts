import test from "node:test";
import assert from "node:assert/strict";

import {
  BoundedQueue,
  DeadLetterQueue,
  RetryPolicy,
  SharedEnterpriseScenario,
  SharedResource,
  WorkerPool,
} from "../src/enterprise.ts";

test("M6 queue capacity and full behavior", () => {
  const q = new BoundedQueue<string>(2);
  assert.equal(q.capacity, 2);
  assert.equal(q.length, 0);
  assert.equal(q.enqueue("a"), true);
  assert.equal(q.enqueue("b"), true);
  assert.equal(q.enqueue("c"), false);
  assert.equal(q.dequeue(), "a");
  assert.equal(q.length, 1);
  assert.equal(q.dequeue(), "b");
  assert.equal(q.dequeue(), undefined);
});

test("M6 worker pool concurrency limits and busy state", () => {
  const pool = new WorkerPool(2);
  assert.equal(pool.idleWorkers.length, 2);
  const a = pool.assign("job-a");
  const b = pool.assign("job-b");
  const c = pool.assign("job-c");
  assert.ok(a !== undefined);
  assert.ok(b !== undefined);
  assert.equal(c, undefined);
  assert.equal(pool.busyWorkers.length, 2);
  pool.release(a!);
  assert.equal(pool.idleWorkers.length, 1);
  pool.crash(b!);
  assert.equal(pool.stateOf(b!).state, "crashed");
});

test("M6 retry policy backoff is deterministic", () => {
  const policy = new RetryPolicy({ maxAttempts: 3, baseDelayMs: 100, multiplier: 2 });
  assert.deepEqual(policy.delayFor(1), 100);
  assert.deepEqual(policy.delayFor(2), 200);
  assert.deepEqual(policy.delayFor(3), 400);
  assert.equal(policy.shouldRetry({ attempt: 1, retryable: true }), true);
  assert.equal(policy.shouldRetry({ attempt: 3, retryable: true }), false);
  assert.equal(policy.shouldRetry({ attempt: 2, retryable: false }), false);
});

test("M6 dead-letter records exhausted jobs", () => {
  const dl = new DeadLetterQueue();
  dl.record({ workflow: "docs", jobId: "d-7", reason: "exhausted" });
  assert.equal(dl.entries.length, 1);
  assert.equal(dl.entries[0]!.workflow, "docs");
});

test("M6 shared resource fails and recovers with queued jobs", () => {
  const resource = new SharedResource({ capacity: 1, maxQueue: 3 });
  assert.equal(resource.acquire("job-1"), true);
  assert.equal(resource.acquire("job-2"), false);
  resource.fail("downstream outage");
  assert.equal(resource.state, "failed");
  resource.recover();
  assert.equal(resource.state, "healthy");
  resource.release("job-1");
  assert.equal(resource.acquire("job-2"), true);
});

test("M6 cross-workflow contention and healthy control are deterministic", () => {
  const healthy = new SharedEnterpriseScenario({ mode: "healthy", seed: 7 });
  healthy.start();
  healthy.run();
  const faulted = new SharedEnterpriseScenario({ mode: "fault", seed: 7 });
  faulted.start();
  faulted.run();

  assert.equal(healthy.snapshot().workflows.length, 3);
  assert.equal(faulted.snapshot().workflows.some((w) => w.status === "retrying" || w.status === "dead_letter"), true);
  assert.equal(healthy.snapshot().sharedResource.state, "healthy");
  assert.equal(faulted.snapshot().sharedResource.state, "healthy");

  const replayHealthy = new SharedEnterpriseScenario({ mode: "healthy", seed: 7 });
  replayHealthy.start();
  replayHealthy.run();
  assert.deepEqual(healthy.snapshot(), replayHealthy.snapshot());
});

test("M6 trace captures queue, worker, retry, and dead-letter causality", () => {
  const scenario = new SharedEnterpriseScenario({ mode: "fault", seed: 11 });
  scenario.start();
  scenario.run();
  const trace = scenario.exportTrace();
  assert.ok(trace.spans.some((s) => s.name === "queue.submit"));
  assert.ok(trace.spans.some((s) => s.name === "worker.assign"));
  assert.ok(trace.spans.some((s) => s.name === "resource.fail"));
  assert.ok(trace.spans.some((s) => s.name === "dead_letter.record"));
  assert.ok(trace.spans.every((s) => s.spanId.startsWith("s-")));
});
