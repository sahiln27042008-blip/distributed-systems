import { Sim, type SimEvent } from "./kernel.ts";
import type { Span, Trace } from "./trace.ts";

export type WorkflowName = "refund" | "document" | "crm";

export interface RetryRequest {
  attempt: number;
  retryable: boolean;
}

export interface RetryPolicyConfig {
  maxAttempts: number;
  baseDelayMs: number;
  multiplier: number;
}

export class RetryPolicy {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly multiplier: number;

  constructor(config: Partial<RetryPolicyConfig> = {}) {
    this.maxAttempts = config.maxAttempts ?? 3;
    this.baseDelayMs = config.baseDelayMs ?? 100;
    this.multiplier = config.multiplier ?? 2;
  }

  delayFor(attempt: number): number {
    if (!Number.isInteger(attempt) || attempt < 1) throw new RangeError(`attempt must be >= 1, got ${attempt}`);
    return this.baseDelayMs * this.multiplier ** (attempt - 1);
  }

  shouldRetry(req: RetryRequest): boolean {
    return req.retryable && req.attempt < this.maxAttempts;
  }
}

export class BoundedQueue<T> {
  readonly capacity: number;
  readonly items: T[] = [];

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError(`capacity must be integer >= 1, got ${capacity}`);
    this.capacity = capacity;
  }

  get length(): number {
    return this.items.length;
  }

  get isFull(): boolean {
    return this.items.length >= this.capacity;
  }

  enqueue(item: T): boolean {
    if (this.isFull) return false;
    this.items.push(item);
    return true;
  }

  dequeue(): T | undefined {
    return this.items.shift();
  }

  peek(): T | undefined {
    return this.items[0];
  }

  clear(): void {
    this.items.length = 0;
  }
}

export interface WorkerState {
  id: string;
  state: "idle" | "busy" | "crashed";
  jobId?: string;
}

export class WorkerPool {
  readonly workers = new Map<string, WorkerState>();

  constructor(size: number) {
    if (!Number.isInteger(size) || size < 1) throw new RangeError(`worker pool size must be integer >= 1, got ${size}`);
    for (let i = 0; i < size; i++) {
      const id = `w${i + 1}`;
      this.workers.set(id, { id, state: "idle" });
    }
  }

  get idleWorkers(): string[] {
    return [...this.workers.keys()].filter((id) => this.workers.get(id)!.state === "idle");
  }

  get busyWorkers(): string[] {
    return [...this.workers.keys()].filter((id) => this.workers.get(id)!.state === "busy");
  }

  stateOf(workerId: string): WorkerState {
    const state = this.workers.get(workerId);
    if (!state) throw new Error(`unknown worker ${workerId}`);
    return state;
  }

  assign(jobId: string): string | undefined {
    const workerId = this.idleWorkers[0];
    if (!workerId) return undefined;
    const state = this.workers.get(workerId)!;
    state.state = "busy";
    state.jobId = jobId;
    return workerId;
  }

  release(workerId: string): void {
    const state = this.workers.get(workerId);
    if (!state) throw new Error(`unknown worker ${workerId}`);
    if (state.state === "crashed") return;
    state.state = "idle";
    state.jobId = undefined;
  }

  crash(workerId: string): void {
    const state = this.workers.get(workerId);
    if (!state) throw new Error(`unknown worker ${workerId}`);
    state.state = "crashed";
  }

  recover(workerId: string): void {
    const state = this.workers.get(workerId);
    if (!state) throw new Error(`unknown worker ${workerId}`);
    if (state.state !== "crashed") return;
    state.state = "idle";
    state.jobId = undefined;
  }
}

export interface DeadLetterRecord {
  workflow: WorkflowName | string;
  jobId: string;
  reason: string;
  at: number;
}

export class DeadLetterQueue {
  readonly entries: DeadLetterRecord[] = [];

  record(rec: Omit<DeadLetterRecord, "at">, at: number = 0): DeadLetterRecord {
    const entry: DeadLetterRecord = { ...rec, at };
    this.entries.push(entry);
    return entry;
  }
}

export interface SharedResourceConfig {
  capacity: number;
  maxQueue: number;
}

export class SharedResource {
  readonly capacity: number;
  readonly maxQueue: number;
  private waiting: string[] = [];
  private readonly active = new Set<string>();
  state: "healthy" | "failed" = "healthy";
  failureReason?: string;

  constructor(config: Partial<SharedResourceConfig> = {}) {
    this.capacity = config.capacity ?? 1;
    this.maxQueue = config.maxQueue ?? 3;
    if (!Number.isInteger(this.capacity) || this.capacity < 1) throw new RangeError(`capacity must be integer >= 1`);
    if (!Number.isInteger(this.maxQueue) || this.maxQueue < 1) throw new RangeError(`maxQueue must be integer >= 1`);
  }

  get inUse(): number {
    return this.active.size;
  }

  get waitDepth(): number {
    return this.waiting.length;
  }

  acquire(jobId: string): boolean {
    if (this.active.has(jobId)) return true;
    const alreadyWaiting = this.waiting.includes(jobId);
    if (this.state === "failed") {
      if (!alreadyWaiting && this.waiting.length < this.maxQueue) this.waiting.push(jobId);
      return false;
    }
    if (this.active.size >= this.capacity) {
      if (!alreadyWaiting && this.waiting.length < this.maxQueue) this.waiting.push(jobId);
      return false;
    }
    this.active.add(jobId);
    this.waiting = this.waiting.filter((id) => id !== jobId);
    return true;
  }

  release(jobId: string): void {
    if (!this.active.has(jobId)) return;
    this.active.delete(jobId);
    if (this.state !== "healthy" || this.waiting.length === 0) return;
    const next = this.waiting.shift();
    if (next) this.active.add(next);
  }

  fail(reason: string): void {
    this.state = "failed";
    this.failureReason = reason;
  }

  recover(): void {
    this.state = "healthy";
    this.failureReason = undefined;
  }

  reset(): void {
    this.waiting.length = 0;
    this.active.clear();
    this.state = "healthy";
    this.failureReason = undefined;
  }
}

export interface WorkflowJob {
  id: string;
  workflow: WorkflowName;
  label: string;
  attempts: number;
  payload: Record<string, unknown>;
  retryable: boolean;
  status: "queued" | "processing" | "retrying" | "completed" | "dead_letter" | "failed";
}

export interface WorkflowSnapshot {
  name: WorkflowName;
  status: string;
  jobs: WorkflowJob[];
}

export interface SharedEnterpriseScenarioConfig {
  seed: number;
  mode: "healthy" | "fault";
  maxEvents: number;
  queueCapacity: number;
  workerCount: number;
}

const defaultScenarioConfig: SharedEnterpriseScenarioConfig = {
  seed: 7,
  mode: "healthy",
  maxEvents: 2000,
  queueCapacity: 2,
  workerCount: 2,
};

export class SharedEnterpriseScenario {
  readonly cfg: SharedEnterpriseScenarioConfig;
  sim: Sim;
  queue: BoundedQueue<WorkflowJob>;
  retryPolicy: RetryPolicy;
  deadLetterQueue: DeadLetterQueue;
  pool: WorkerPool;
  resource: SharedResource;
  workflows: Record<WorkflowName, WorkflowSnapshot>;
  life: "idle" | "running" | "finished" | "stopped" | "error" = "idle";
  error?: string;
  private seq = 0;
  private rootEvent?: string;

  constructor(input: Partial<SharedEnterpriseScenarioConfig> = {}) {
    this.cfg = { ...defaultScenarioConfig, ...input };
    this.sim = this.buildSim();
    this.queue = new BoundedQueue<WorkflowJob>(this.cfg.queueCapacity);
    this.retryPolicy = new RetryPolicy({ maxAttempts: 3, baseDelayMs: 50, multiplier: 2 });
    this.deadLetterQueue = new DeadLetterQueue();
    this.pool = new WorkerPool(this.cfg.workerCount);
    this.resource = new SharedResource({ capacity: 1, maxQueue: 3 });
    this.workflows = {
      refund: { name: "refund", status: "idle", jobs: [] },
      document: { name: "document", status: "idle", jobs: [] },
      crm: { name: "crm", status: "idle", jobs: [] },
    };
  }

  private buildSim(): Sim {
    const sim = new Sim(this.cfg.seed, { maxEvents: this.cfg.maxEvents, maxSteps: 20000 });
    sim.register("client", "client");
    sim.register("queue", "bounded-queue");
    sim.register("worker-pool", "worker-pool");
    sim.register("shared-resource", "shared-resource");
    sim.register("db", "sqlite");
    return sim;
  }

  private emit(kind: string, data: Record<string, unknown>, parent?: string): string {
    const id = this.sim.emit(kind, `enterprise:${this.cfg.seed}:${this.cfg.mode}`, data, parent);
    return id;
  }

  private actionId(prefix: string): string {
    this.seq += 1;
    return `${prefix}-${this.seq}`;
  }

  private addJob(workflow: WorkflowName, label: string, payload: Record<string, unknown>): WorkflowJob {
    const job: WorkflowJob = {
      id: this.actionId(workflow),
      workflow,
      label,
      attempts: 0,
      payload,
      retryable: true,
      status: "queued",
    };
    const wf = this.workflows[workflow];
    wf.jobs.push(job);
    wf.status = "queued";
    return job;
  }

  private markWorkflowStatus(workflow: WorkflowName, status: string): void {
    this.workflows[workflow].status = status;
  }

  private deadLetter(job: WorkflowJob, reason: string, parent?: string): void {
    this.resource.release(job.id); // drop any held or queued resource claim so it cannot leak
    this.deadLetterQueue.record({ workflow: job.workflow, jobId: job.id, reason }, this.sim.now);
    this.emit("dead_letter.record", { jobId: job.id, workflow: job.workflow, reason, attempt: job.attempts }, parent);
    job.status = "dead_letter";
    this.markWorkflowStatus(job.workflow, "dead_letter");
  }

  private enqueueJob(job: WorkflowJob, parent?: string): boolean {
    const ok = this.queue.enqueue(job);
    const submit = this.emit("queue.submit", { jobId: job.id, workflow: job.workflow, label: job.label, length: this.queue.length }, parent);
    if (!ok) {
      const full = this.emit("queue.full", { jobId: job.id, workflow: job.workflow }, submit);
      this.deadLetter(job, "queue.full", full);
      return false;
    }
    return true;
  }

  private drainQueue(parent?: string): void {
    while (this.queue.length > 0 && this.pool.idleWorkers.length > 0) {
      const job = this.queue.dequeue();
      if (!job) break;
      const workerId = this.pool.assign(job.id);
      if (!workerId) break;
      job.status = "processing";
      this.markWorkflowStatus(job.workflow, "processing");
      const assign = this.emit("worker.assign", { workerId, jobId: job.id, workflow: job.workflow }, parent);
      this.sim.at(30, `worker.process.${job.id}`, () => this.processJob(job, workerId, assign));
    }
  }

  // Bounded retry with deterministic backoff; exhaustion (or a full queue on re-entry) goes to the dead-letter queue.
  private retryOrDeadLetter(job: WorkflowJob, exhaustedReason: string, parent: string): void {
    if (!this.retryPolicy.shouldRetry({ attempt: job.attempts, retryable: job.retryable })) {
      this.deadLetter(job, exhaustedReason, parent);
      return;
    }
    const delay = this.retryPolicy.delayFor(job.attempts);
    job.status = "retrying";
    this.markWorkflowStatus(job.workflow, "retrying");
    this.sim.at(delay, `retry.${job.id}`, () => {
      const retry = this.emit("retry.schedule", { jobId: job.id, workflow: job.workflow, delayMs: delay, attempt: job.attempts }, parent);
      if (!this.queue.enqueue(job)) {
        const full = this.emit("queue.full", { jobId: job.id, workflow: job.workflow }, retry);
        this.deadLetter(job, "queue.full", full);
        return;
      }
      this.drainQueue(retry);
    });
  }

  private processJob(job: WorkflowJob, workerId: string, assign: string): void {
    job.attempts += 1;
    if (this.resource.state === "failed") {
      this.pool.release(workerId);
      const blocked = this.emit("resource.blocked", { jobId: job.id, workflow: job.workflow, reason: this.resource.failureReason ?? "shared-resource-failed", attempt: job.attempts }, assign);
      this.retryOrDeadLetter(job, "retry-exhausted", blocked);
      this.drainQueue();
      return;
    }

    if (!this.resource.acquire(job.id)) {
      this.pool.release(workerId);
      const waiting = this.emit("resource.waiting", { jobId: job.id, workflow: job.workflow, capacity: this.resource.capacity, queued: this.resource.waitDepth }, assign);
      this.retryOrDeadLetter(job, "resource-contention", waiting);
      this.drainQueue();
      return;
    }

    const acquire = this.emit("resource.acquire", { jobId: job.id, workflow: job.workflow, resource: "shared-resource", attempt: job.attempts }, assign);
    this.sim.at(50, `worker.finish.${job.id}`, () => {
      if (this.resource.state === "failed") {
        // Outage hit while this job held the resource: the work did not complete.
        this.resource.release(job.id);
        this.pool.release(workerId);
        const failure = this.emit("resource.failure", { jobId: job.id, workflow: job.workflow, reason: this.resource.failureReason ?? "shared-resource-failed", attempt: job.attempts }, acquire);
        this.retryOrDeadLetter(job, "retry-exhausted", failure);
        this.drainQueue();
        return;
      }
      this.resource.release(job.id);
      const release = this.emit("resource.release", { jobId: job.id, workflow: job.workflow, resource: "shared-resource" }, acquire);
      job.status = "completed";
      this.markWorkflowStatus(job.workflow, "completed");
      this.pool.release(workerId);
      this.emit("job.complete", { jobId: job.id, workflow: job.workflow, label: job.label, attempts: job.attempts }, release);
      this.drainQueue();
    });
  }

  start(): void {
    if (this.life !== "idle") throw new Error(`cannot start from ${this.life}`);
    this.life = "running";
    this.rootEvent = this.emit("scenario.start", {
      mode: this.cfg.mode,
      seed: this.cfg.seed,
      queueCapacity: this.cfg.queueCapacity,
      workerCount: this.cfg.workerCount,
    });
    const refund = this.addJob("refund", "refund-sync", { orderId: "ord-3001", amountCents: 4000 });
    const document = this.addJob("document", "document-ingest", { docId: "doc-42", status: "ready" });
    const crm = this.addJob("crm", "customer-enrichment", { crmId: "lead-22", status: "pending" });
    this.emit("workflow.submit", { workflow: "refund", jobId: refund.id }, this.rootEvent);
    this.emit("workflow.submit", { workflow: "document", jobId: document.id }, this.rootEvent);
    this.emit("workflow.submit", { workflow: "crm", jobId: crm.id }, this.rootEvent);
    this.enqueueJob(refund, this.rootEvent);
    this.enqueueJob(document, this.rootEvent);
    this.enqueueJob(crm, this.rootEvent);
    this.drainQueue(this.rootEvent);
    if (this.cfg.mode === "fault") {
      this.sim.at(120, "resource.fail", () => {
        this.resource.fail("shared-resource downstream outage");
        this.emit("resource.fail", { reason: this.resource.failureReason, state: this.resource.state });
      });
      this.sim.at(260, "resource.recover", () => {
        this.resource.recover();
        this.emit("resource.recover", { state: this.resource.state });
      });
    }
    this.sim.at(500, "scenario.finish", () => {
      this.life = "finished";
      this.emit("scenario.finish", { mode: this.cfg.mode, queueDepth: this.queue.length });
    });
  }

  step(): boolean {
    if (this.life !== "running") return false;
    try {
      if (this.sim.step()) return true;
      this.life = "finished";
      return false;
    } catch (e) {
      this.life = "error";
      this.error = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  advance(ms: number): void {
    if (this.life !== "running") return;
    try {
      this.sim.advanceTo(this.sim.now + ms);
      if (this.sim.pending() === 0) this.life = "finished";
    } catch (e) {
      this.life = "error";
      this.error = e instanceof Error ? e.message : String(e);
    }
  }

  run(): void {
    while (this.sim.step()) {
      if (this.life === "finished" || this.life === "error") break;
    }
    if (this.life === "running") this.life = "finished";
  }

  reset(): void {
    this.queue = new BoundedQueue<WorkflowJob>(this.cfg.queueCapacity);
    this.deadLetterQueue = new DeadLetterQueue();
    this.pool = new WorkerPool(this.cfg.workerCount);
    this.resource = new SharedResource({ capacity: 1, maxQueue: 3 });
    this.workflows = {
      refund: { name: "refund", status: "idle", jobs: [] },
      document: { name: "document", status: "idle", jobs: [] },
      crm: { name: "crm", status: "idle", jobs: [] },
    };
    this.sim = this.buildSim();
    this.life = "idle";
    this.error = undefined;
    this.rootEvent = undefined;
    this.seq = 0;
  }

  snapshot() {
    return {
      life: this.life,
      now: this.sim.now,
      queue: {
        length: this.queue.length,
        capacity: this.queue.capacity,
        items: this.queue.items.map((job) => ({ id: job.id, workflow: job.workflow, status: job.status })),
      },
      workers: [...this.pool.workers.values()].map((state) => ({ ...state })),
      sharedResource: {
        state: this.resource.state,
        capacity: this.resource.capacity,
        inUse: this.resource.inUse,
        waitDepth: this.resource.waitDepth,
        failureReason: this.resource.failureReason,
      },
      deadLetters: [...this.deadLetterQueue.entries],
      workflows: Object.values(this.workflows).map((entry) => ({ ...entry, jobs: entry.jobs.map((job) => ({ ...job })) })),
    };
  }

  dispose(): void {
    this.sim.log.length = 0;
  }

  exportTrace(): Trace {
    const spans: Span[] = [];
    const byId = new Map<string, SimEvent>();
    for (const event of this.sim.log) byId.set(event.id, event);

    for (const event of this.sim.log) {
      const parent = event.parent ? byId.get(event.parent) : undefined;
      const parentId = parent ? `s-${parent.id}` : null;
      spans.push({
        spanId: `s-${event.id}`,
        parentSpanId: parentId,
        name: event.kind,
        startMs: event.t,
        endMs: event.t,
        status: "ok",
        attrs: { ...event.data },
        links: [],
        events: [],
      });
    }

    return {
      schema: "sim-trace/0",
      simulated: true,
      virtualTime: true,
      traceId: `enterprise-${this.cfg.seed}-${this.cfg.mode}`,
      spans,
      derived: {
        queueDepth: this.queue.length,
        deadLetters: this.deadLetterQueue.entries.length,
        workflows: this.workflows,
      },
    };
  }
}

export const DEFAULT_M6_SCENARIOS = {
  healthy: { seed: 7, mode: "healthy" },
  fault: { seed: 7, mode: "fault" },
} as const;
