import { createHash } from "node:crypto";
import { Sim, type SimEvent } from "./kernel.ts";
import type { Trace } from "./trace.ts";

export type ChaosMode = "naive" | "resilient";
export type ChaosWorkflowStatus = "queued" | "running" | "completed" | "completed_with_item_failures" | "compensated" | "failed" | "host_unavailable";

export interface ChaosConfig {
  seed: number;
  mode: ChaosMode;
  runId: string;
  poolCapacity: number;
  poolQueueCapacity: number;
  poolAcquireTimeoutMs: number;
  dbReadMs: number;
  tokenStreamMs: number;
  tokensPerWorkflow: number;
  maxRetries: number;
  maxEvents: number;
  maxSteps: number;
  eventHistoryLimit: number;
  sagaCompensationFails: boolean;
}

const DEFAULTS: ChaosConfig = {
  seed: 7,
  mode: "resilient",
  runId: "chaos-run-7",
  poolCapacity: 5,
  poolQueueCapacity: 10,
  poolAcquireTimeoutMs: 100,
  dbReadMs: 2,
  tokenStreamMs: 30_000,
  tokensPerWorkflow: 500,
  maxRetries: 2,
  maxEvents: 2000,
  maxSteps: 5000,
  eventHistoryLimit: 2000,
  sagaCompensationFails: false,
};

export const CHAOS_TENANTS = [
  { tenant: "Brightwater Health", tenantId: "T-90210", taskId: "task-brightwater", incident: "pool" },
  { tenant: "Halvorsen Logistics", tenantId: "T-88121", taskId: "task-halvorsen", incident: "payment" },
  { tenant: "Cobalt Freight", tenantId: "T-71002", taskId: "task-cobalt", incident: "process" },
  { tenant: "Dunmore Capital", tenantId: "T-55507", taskId: "task-dunmore", incident: "saga" },
  { tenant: "Eastgate Retail", tenantId: "T-66322", taskId: "task-eastgate", incident: "batch" },
  { tenant: "Acme", tenantId: "T-ACME", taskId: "task-acme", incident: "ordinary" },
  { tenant: "Nexus", tenantId: "T-NEXUS", taskId: "task-nexus", incident: "ordinary" },
  { tenant: "Apex", tenantId: "T-APEX", taskId: "task-apex", incident: "ordinary" },
  { tenant: "Omni", tenantId: "T-OMNI", taskId: "task-omni", incident: "ordinary" },
  { tenant: "Vortex", tenantId: "T-VORTEX", taskId: "task-vortex", incident: "ordinary" },
] as const;

type TenantSpec = (typeof CHAOS_TENANTS)[number];
interface ChaosWorkflow {
  taskId: string;
  tenant: string;
  tenantId: string;
  incident: TenantSpec["incident"];
  status: ChaosWorkflowStatus;
  dbHeldMs: number;
  retries: number;
  failed: boolean;
  dbDone: boolean;
  incidentDone: boolean;
  terminalRecorded: boolean;
  waitToken?: string;
}

export interface ChaosMetrics {
  activeDbConnections: number;
  dbWaitQueueLength: number;
  poolAcquisitionTimeouts: number;
  duplicateDollarsCharged: number;
  orphanedAwsInstances: number;
  mainHostCrashes: number;
  containedWorkerCrashes: number;
  innocentBatchTasksAborted: number;
  tokensConsumed: number;
  peakActiveDbConnections: number;
  totalDbConnectionHoldMs: number;
  dbConnectionOccupancyMs: number;
  dbPoolUtilizationPercent: number;
  measurementWindowMs: number;
  batchItemsSucceeded: number;
  batchItemsFailed: number;
  paymentAcceptedCharges: number;
  sagaCompensationsSucceeded: number;
  sagaCompensationsFailed: number;
}

export interface ChaosSnapshot {
  virtualTimeMs: number;
  mode: ChaosMode;
  activeConnections: number;
  waitQueue: number;
  metrics: ChaosMetrics;
  workflows: Array<{
    taskId: string;
    tenant: string;
    tenantId: string;
    status: ChaosWorkflowStatus;
    dbHeldMs: number;
    retries: number;
  }>;
  eventsCount: number;
  life: "idle" | "running" | "finished" | "error";
  runId: string;
  seed: number;
  host: { state: "online" | "crashed" };
  workers: Array<{ id: string; state: "idle" | "busy" | "crashed" }>;
  batch: { total: number; succeeded: number; failed: number; aborted: number };
  saga: { forwardSteps: string[]; compensationOrder: string[]; compensated: string[]; resourcesAllocated: number };
  payment: { receipts: number; attempts: number };
  error?: string;
  events: SimEvent[];
}

interface Waiter { token: string; workflow: ChaosWorkflow; requestedAt: number; acquiredAt?: number; active: boolean }

export class MockPgPool {
  readonly capacity: number;
  readonly queueCapacity: number;
  activeConnections = 0;
  peakActiveConnections = 0;
  poolAcquisitionTimeouts = 0;
  totalHoldMs = 0;
  readonly waiting: Waiter[] = [];
  readonly active = new Map<string, Waiter>();

  constructor(capacity: number, queueCapacity: number) {
    this.capacity = capacity;
    this.queueCapacity = queueCapacity;
  }

  acquire(waiter: Waiter): "acquired" | "queued" | "full" {
    if (this.activeConnections < this.capacity) {
      this.activate(waiter);
      return "acquired";
    }
    if (this.waiting.length >= this.queueCapacity) return "full";
    this.waiting.push(waiter);
    return "queued";
  }

  activate(waiter: Waiter, now: number = waiter.requestedAt): void {
    waiter.active = true;
    waiter.acquiredAt = now;
    this.active.set(waiter.token, waiter);
    this.activeConnections += 1;
    this.peakActiveConnections = Math.max(this.peakActiveConnections, this.activeConnections);
  }

  removeWaiting(waiter: Waiter): boolean {
    const index = this.waiting.indexOf(waiter);
    if (index < 0) return false;
    this.waiting.splice(index, 1);
    return true;
  }

  release(waiter: Waiter, now: number): number {
    if (!this.active.delete(waiter.token)) return 0;
    waiter.active = false;
    this.activeConnections -= 1;
    const heldMs = now - (waiter.acquiredAt ?? waiter.requestedAt);
    this.totalHoldMs += heldMs;
    return heldMs;
  }
}

export class MockPaymentGateway {
  readonly receipts = new Map<string, { receiptId: string; amountDollars: number }>();

  accept(key: string, amountDollars: number, candidateReceiptId: string): { receiptId: string; replayed: boolean } {
    const prior = this.receipts.get(key);
    if (prior) return { receiptId: prior.receiptId, replayed: true };
    this.receipts.set(key, { receiptId: candidateReceiptId, amountDollars });
    return { receiptId: candidateReceiptId, replayed: false };
  }

  reset(): void {
    this.receipts.clear();
  }
}

export class MockProcessSupervisor {
  hostState: "online" | "crashed" = "online";
  workerState: "idle" | "busy" | "crashed" = "idle";
  mainHostCrashes = 0;
  containedWorkerCrashes = 0;

  failNative(mode: ChaosMode): { hostState: "online" | "crashed"; workerId: string; contained: boolean } {
    if (mode === "naive") {
      this.hostState = "crashed";
      this.mainHostCrashes += 1;
      return { hostState: this.hostState, workerId: "main-host", contained: false };
    }
    this.workerState = "busy";
    this.workerState = "crashed";
    this.containedWorkerCrashes += 1;
    return { hostState: this.hostState, workerId: "native-worker-1", contained: true };
  }

  reset(): void {
    this.hostState = "online";
    this.workerState = "idle";
    this.mainHostCrashes = 0;
    this.containedWorkerCrashes = 0;
  }
}

export class MockToolGateway {
  readonly totalItems = 50;
  readonly poisonItem = 27;
  readonly malformedUtf8 = Buffer.from([0xc3, 0x28]);

  validatesPoison(): boolean {
    return this.malformedUtf8.toString("utf8").includes("\uFFFD");
  }
}

function canonical(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value !== "object") return JSON.stringify(value);
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}

export function paymentIdempotencyKey(runId: string, stepId: string, payload: Record<string, unknown>): string {
  return `sha256:${createHash("sha256").update(canonical({ runId, stepId, payload })).digest("hex")}`;
}

export class EnterpriseChaosScenario {
  readonly cfg: ChaosConfig;
  sim: Sim;
  pool: MockPgPool;
  life: ChaosSnapshot["life"] = "idle";
  error?: string;
  private workflows = new Map<string, ChaosWorkflow>();
  private metrics = this.emptyMetrics();
  readonly paymentGateway = new MockPaymentGateway();
  readonly processSupervisor = new MockProcessSupervisor();
  readonly toolGateway = new MockToolGateway();
  private paymentAttempts = 0;
  private batchSucceeded = 0;
  private batchFailed = 0;
  private batchAborted = 0;
  private sagaForward: string[] = [];
  private sagaCompensation: string[] = [];
  private sagaCompensated: string[] = [];
  private allocatedInstances = 0;
  private seq = 0;
  private completedWorkflows = 0;
  private poolGaugeTime = 0;
  private poolOccupiedMs = 0;

  constructor(input: Partial<ChaosConfig> = {}) {
    this.cfg = { ...DEFAULTS, ...input };
    this.validateConfig();
    this.sim = this.buildSim();
    this.pool = new MockPgPool(this.cfg.poolCapacity, this.cfg.poolQueueCapacity);
    this.resetWorkflowState();
  }

  private validateConfig(): void {
    if (!Number.isInteger(this.cfg.seed) || this.cfg.seed < 0 || this.cfg.seed > 0xffff_ffff) throw new RangeError("seed must be an integer in [0, 4294967295]");
    if (this.cfg.mode !== "naive" && this.cfg.mode !== "resilient") throw new RangeError("mode must be naive or resilient");
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(this.cfg.runId)) throw new RangeError("runId must be 1-64 safe identifier characters");
    for (const [name, value, min, max] of [
      ["poolCapacity", this.cfg.poolCapacity, 1, 20],
      ["poolQueueCapacity", this.cfg.poolQueueCapacity, 1, 100],
      ["poolAcquireTimeoutMs", this.cfg.poolAcquireTimeoutMs, 1, 60_000],
      ["dbReadMs", this.cfg.dbReadMs, 1, 1000],
      ["tokenStreamMs", this.cfg.tokenStreamMs, 1, 60_000],
      ["tokensPerWorkflow", this.cfg.tokensPerWorkflow, 1, 1_000_000],
      ["maxRetries", this.cfg.maxRetries, 0, 5],
      ["maxEvents", this.cfg.maxEvents, 100, 10_000],
      ["maxSteps", this.cfg.maxSteps, 100, 20_000],
      ["eventHistoryLimit", this.cfg.eventHistoryLimit, 100, 10_000],
    ] as const) {
      if (!Number.isInteger(value) || value < min || value > max) throw new RangeError(`${name} must be an integer in [${min}, ${max}]`);
    }
    if (typeof this.cfg.sagaCompensationFails !== "boolean") throw new TypeError("sagaCompensationFails must be a boolean");
  }

  private buildSim(): Sim {
    const sim = new Sim(this.cfg.seed, { maxEvents: this.cfg.maxEvents, maxSteps: this.cfg.maxSteps, maxPayloadBytes: 2048 });
    sim.register("chaos-orchestrator", "simulated-orchestrator");
    sim.register("mock-pg-pool", "bounded-database-pool");
    sim.register("mock-payment-gateway", "simulated-payment-gateway");
    sim.register("mock-process-supervisor", "simulated-process-supervisor");
    sim.register("mock-tool-gateway", "simulated-batch-gateway");
    sim.register("mock-cloud", "simulated-resource-ledger");
    return sim;
  }

  private emptyMetrics(): ChaosMetrics {
    return {
      activeDbConnections: 0, dbWaitQueueLength: 0, poolAcquisitionTimeouts: 0,
      duplicateDollarsCharged: 0, orphanedAwsInstances: 0, mainHostCrashes: 0,
      containedWorkerCrashes: 0, innocentBatchTasksAborted: 0, tokensConsumed: 0,
      peakActiveDbConnections: 0, totalDbConnectionHoldMs: 0, measurementWindowMs: 0,
      dbConnectionOccupancyMs: 0, dbPoolUtilizationPercent: 0,
      batchItemsSucceeded: 0, batchItemsFailed: 0, paymentAcceptedCharges: 0,
      sagaCompensationsSucceeded: 0, sagaCompensationsFailed: 0,
    };
  }

  private resetWorkflowState(): void {
    this.workflows = new Map(CHAOS_TENANTS.map((tenant) => [tenant.taskId, {
      taskId: tenant.taskId, tenant: tenant.tenant, tenantId: tenant.tenantId, incident: tenant.incident,
      status: "queued", dbHeldMs: 0, retries: 0, failed: false, dbDone: false, incidentDone: false, terminalRecorded: false,
    }]));
    this.metrics = this.emptyMetrics();
    this.processSupervisor.reset();
    this.paymentGateway.reset();
    this.paymentAttempts = 0;
    this.batchSucceeded = 0;
    this.batchFailed = 0;
    this.batchAborted = 0;
    this.sagaForward = [];
    this.sagaCompensation = [];
    this.sagaCompensated = [];
    this.allocatedInstances = 0;
    this.seq = 0;
    this.completedWorkflows = 0;
    this.poolGaugeTime = 0;
    this.poolOccupiedMs = 0;
  }

  private emit(kind: string, workflow?: ChaosWorkflow, metadata: Record<string, unknown> = {}, parent?: string): string {
    const data = {
      runId: this.cfg.runId,
      seed: this.cfg.seed,
      mode: this.cfg.mode,
      ...(workflow ? { taskId: workflow.taskId, tenantId: workflow.tenantId } : {}),
      ...metadata,
    };
    return this.sim.emit(kind, `${this.cfg.runId}:${this.cfg.seed}:${this.cfg.mode}`, data, parent);
  }

  private schedule(delayMs: number, label: string, fn: () => void): void {
    this.sim.at(delayMs, label, fn);
  }

  private recordPoolOccupancy(): void {
    this.poolOccupiedMs += this.pool.activeConnections * (this.sim.now - this.poolGaugeTime);
    this.poolGaugeTime = this.sim.now;
    this.metrics.dbConnectionOccupancyMs = this.poolOccupiedMs;
  }

  private completePart(workflow: ChaosWorkflow, failed = false): void {
    workflow.failed ||= failed;
    if (workflow.status === "host_unavailable") {
      if (!workflow.terminalRecorded) {
        workflow.terminalRecorded = true;
        this.completedWorkflows += 1;
        this.emit("workflow.terminal", workflow, { status: workflow.status, dbHeldMs: workflow.dbHeldMs, retries: workflow.retries });
      }
      return;
    }
    if (!workflow.dbDone || !workflow.incidentDone) return;
    workflow.status = workflow.failed ? "failed" : workflow.status === "completed_with_item_failures" ? "completed_with_item_failures" : workflow.status === "compensated" ? "compensated" : "completed";
    if (workflow.terminalRecorded) return;
    workflow.terminalRecorded = true;
    this.completedWorkflows += 1;
    this.emit("workflow.terminal", workflow, { status: workflow.status, dbHeldMs: workflow.dbHeldMs, retries: workflow.retries });
    if (this.completedWorkflows === CHAOS_TENANTS.length) this.finishIfIdle();
  }

  private finishIfIdle(): void {
    if (this.life === "running" && this.sim.pending() === 0) this.life = "finished";
  }

  private beginWorkflow(workflow: ChaosWorkflow): void {
    if (this.processSupervisor.hostState === "crashed") {
      workflow.status = "host_unavailable";
      workflow.failed = true;
    } else {
      workflow.status = "running";
    }
    const begin = this.emit("workflow.begin", workflow, { status: workflow.status, workloadTier: this.sim.rng.int(1, 3) });
    this.acquireDb(workflow, begin);
    this.startIncident(workflow, begin);
  }

  private acquireDb(workflow: ChaosWorkflow, parent: string): void {
    if (this.processSupervisor.hostState === "crashed") {
      workflow.dbDone = true;
      workflow.failed = true;
      this.completePart(workflow, true);
      return;
    }
    const waiter: Waiter = { token: `${workflow.taskId}:db`, workflow, requestedAt: this.sim.now, active: false };
    this.recordPoolOccupancy();
    const result = this.pool.acquire(waiter);
    this.metrics.activeDbConnections = this.pool.activeConnections;
    this.metrics.dbWaitQueueLength = this.pool.waiting.length;
    if (result === "full") {
      this.emit("db.pool.timeout", workflow, { reason: "wait_queue_full", statusCode: 500 }, parent);
      this.metrics.poolAcquisitionTimeouts += 1;
      workflow.dbDone = true;
      this.completePart(workflow, true);
      return;
    }
    if (result === "queued") {
      const queued = this.emit("db.pool.queued", workflow, { queueLength: this.pool.waiting.length }, parent);
      workflow.waitToken = waiter.token;
      this.schedule(this.cfg.poolAcquireTimeoutMs, `db.timeout.${workflow.taskId}`, () => {
        if (!this.pool.removeWaiting(waiter)) return;
        this.metrics.dbWaitQueueLength = this.pool.waiting.length;
        this.metrics.poolAcquisitionTimeouts += 1;
        workflow.dbDone = true;
        workflow.failed = true;
        this.emit("db.pool.timeout", workflow, { waitedMs: this.sim.now - waiter.requestedAt, statusCode: 500 }, queued);
        this.completePart(workflow, true);
      });
      return;
    }
    this.onDbAcquired(waiter, parent);
  }

  private onDbAcquired(waiter: Waiter, parent?: string): void {
    const workflow = waiter.workflow;
    workflow.waitToken = undefined;
    this.metrics.activeDbConnections = this.pool.activeConnections;
    this.metrics.dbWaitQueueLength = this.pool.waiting.length;
    this.metrics.peakActiveDbConnections = this.pool.peakActiveConnections;
    const acquired = this.emit("db.connection.acquired", workflow, { active: this.pool.activeConnections, capacity: this.pool.capacity }, parent);
    const holdMs = this.cfg.mode === "naive" ? this.cfg.tokenStreamMs : this.cfg.dbReadMs;
    if (this.cfg.mode === "naive") {
      this.emit("db.lease.streaming", workflow, { tokenStreamMs: this.cfg.tokenStreamMs, leaseHeld: true }, acquired);
    } else {
      this.emit("db.read.complete", workflow, { durationMs: this.cfg.dbReadMs, leaseHeld: true }, acquired);
    }
    this.schedule(holdMs, `db.release.${workflow.taskId}`, () => {
      this.recordPoolOccupancy();
      const actualHold = this.pool.release(waiter, this.sim.now);
      workflow.dbHeldMs += actualHold;
      this.metrics.activeDbConnections = this.pool.activeConnections;
      this.metrics.dbWaitQueueLength = this.pool.waiting.length;
      this.metrics.totalDbConnectionHoldMs = this.pool.totalHoldMs;
      const released = this.emit("db.connection.released", workflow, { heldMs: actualHold, active: this.pool.activeConnections }, acquired);
      if (this.cfg.mode === "resilient") {
        this.emit("llm.tokens.stream", workflow, { tokens: this.cfg.tokensPerWorkflow, leaseHeld: false }, released);
        this.schedule(this.cfg.tokenStreamMs, `tokens.finish.${workflow.taskId}`, () => {
          if (this.processSupervisor.hostState === "crashed") {
            workflow.failed = true;
            workflow.dbDone = true;
            this.emit("llm.tokens.aborted", workflow, { reason: "main_host_crashed", tokensConsumed: 0 }, released);
            this.completePart(workflow, true);
            return;
          }
          this.metrics.tokensConsumed += this.cfg.tokensPerWorkflow;
          this.emit("llm.tokens.consumed", workflow, { tokens: this.cfg.tokensPerWorkflow, leaseHeld: false }, released);
          workflow.dbDone = true;
          this.completePart(workflow);
        });
      } else {
        if (this.processSupervisor.hostState === "crashed") {
          workflow.failed = true;
          workflow.dbDone = true;
          this.emit("llm.tokens.aborted", workflow, { reason: "main_host_crashed", tokensConsumed: 0 }, acquired);
          this.completePart(workflow, true);
        } else {
          this.metrics.tokensConsumed += this.cfg.tokensPerWorkflow;
          this.emit("llm.tokens.consumed", workflow, { tokens: this.cfg.tokensPerWorkflow, leaseHeld: true }, acquired);
          workflow.dbDone = true;
          this.completePart(workflow);
        }
      }
      const next = this.processSupervisor.hostState === "online" ? this.pool.waiting.shift() : undefined;
      this.metrics.dbWaitQueueLength = this.pool.waiting.length;
      if (next) {
        this.recordPoolOccupancy();
        this.pool.activate(next, this.sim.now);
        this.onDbAcquired(next, released);
      }
      this.metrics.activeDbConnections = this.pool.activeConnections;
    });
  }

  private startIncident(workflow: ChaosWorkflow, parent: string): void {
    const delay = workflow.incident === "process" ? 10 : 5;
    const run = (label: string, action: () => void) => this.schedule(delay, label, () => {
      if (this.processSupervisor.hostState === "crashed") {
        workflow.status = "host_unavailable";
        workflow.failed = true;
        workflow.incidentDone = true;
        this.emit("workflow.host_unavailable", workflow, { cause: "main_host_crashed", hostState: this.processSupervisor.hostState }, parent);
        this.completePart(workflow, true);
        return;
      }
      action();
    });
    switch (workflow.incident) {
      case "payment": run("incident.payment", () => this.runPayment(workflow, parent)); break;
      case "process": run("incident.process", () => this.runProcessFailure(workflow, parent)); break;
      case "saga": run("incident.saga", () => this.runSaga(workflow, parent)); break;
      case "batch": run("incident.batch", () => this.runBatch(workflow, parent)); break;
      case "ordinary":
        run(`ordinary.complete.${workflow.taskId}`, () => {
          workflow.incidentDone = true;
          this.completePart(workflow, workflow.failed);
        });
        break;
      case "pool": workflow.incidentDone = true; break;
    }
  }

  private runPayment(workflow: ChaosWorkflow, parent: string): void {
    const amountDollars = 50;
    const stepId = "payment-reconciliation";
    const payload = { tenantId: workflow.tenantId, amountDollars };
    let previousReceipt: string | undefined;
    for (let attempt = 1; attempt <= 2; attempt++) {
      this.paymentAttempts += 1;
      const key = this.cfg.mode === "resilient"
        ? paymentIdempotencyKey(this.cfg.runId, stepId, payload)
        : `${this.cfg.runId}:${stepId}:attempt-${attempt}`;
      const result = this.paymentGateway.accept(key, amountDollars, `receipt-${this.cfg.runId}-${this.paymentAttempts}`);
      const receiptId = result.receiptId;
      if (!result.replayed) {
        this.metrics.paymentAcceptedCharges += 1;
        if (previousReceipt && this.cfg.mode === "naive") this.metrics.duplicateDollarsCharged += amountDollars;
      }
      const event = this.emit("payment.attempt", workflow, { attempt, key, amountDollars, receiptId, replayed: result.replayed }, parent);
      if (attempt === 1) {
        this.emit("payment.connection.reset", workflow, { signal: "ECONNRESET", gatewayAccepted: true, receiptId }, event);
        if (this.cfg.maxRetries < 1) {
          workflow.failed = true;
          break;
        }
        workflow.retries += 1;
        previousReceipt = receiptId;
      } else {
        this.emit("payment.receipt.returned", workflow, { receiptId, sameReceipt: receiptId === previousReceipt }, event);
      }
    }
    workflow.incidentDone = true;
    this.completePart(workflow, workflow.failed);
  }

  private runProcessFailure(workflow: ChaosWorkflow, parent: string): void {
    const failure = this.processSupervisor.failNative(this.cfg.mode);
    if (!failure.contained) {
      this.metrics.mainHostCrashes = this.processSupervisor.mainHostCrashes;
      this.emit("process.main_host.crashed", workflow, { signal: "SIGSEGV", exitCode: 139, simulated: true }, parent);
      for (const affected of this.workflows.values()) {
        if (affected.taskId === workflow.taskId || affected.status === "completed" || affected.status === "failed") continue;
        affected.status = "host_unavailable";
        affected.failed = true;
        this.emit("workflow.host_unavailable", affected, { cause: "main_host_crashed", hostState: this.processSupervisor.hostState }, parent);
        this.completePart(affected, true);
      }
    } else {
      this.metrics.containedWorkerCrashes = this.processSupervisor.containedWorkerCrashes;
      const worker = this.emit("worker.spawn", workflow, { workerId: failure.workerId, boundary: "simulated-child" }, parent);
      this.emit("worker.exit", workflow, { workerId: failure.workerId, signal: "SIGSEGV", exitCode: 139, contained: failure.contained }, worker);
      workflow.failed = true;
      this.emit("supervisor.fault.contained", workflow, { workerId: failure.workerId, mainHost: failure.hostState }, worker);
    }
    workflow.incidentDone = true;
    this.completePart(workflow, workflow.failed);
  }

  private runBatch(workflow: ChaosWorkflow, parent: string): void {
    const total = this.toolGateway.totalItems;
    const poisonIndex = this.toolGateway.poisonItem;
    const poison = this.toolGateway.malformedUtf8;
    const invalidUtf8 = this.toolGateway.validatesPoison();
    if (!invalidUtf8) throw new Error("configured malformed batch item did not fail UTF-8 validation");
    const rejected = this.emit("batch.item.rejected", workflow, { item: poisonIndex, statusCode: 400, reason: "invalid_utf8", bytesHex: poison.toString("hex") }, parent);
    if (this.cfg.mode === "naive") {
      this.batchFailed = 1;
      this.batchAborted = total - 1;
      this.metrics.batchItemsFailed = this.batchFailed;
      this.metrics.innocentBatchTasksAborted = this.batchAborted;
      this.emit("batch.rejected", workflow, { total, poisonItem: poisonIndex, innocentAborted: this.batchAborted, statusCode: 400 }, rejected);
      for (let item = 1; item <= total; item++) {
        if (item !== poisonIndex) this.emit("batch.item.aborted", workflow, { item, reason: "atomic_batch_rejected", poisonItem: poisonIndex }, rejected);
      }
      workflow.failed = true;
      workflow.incidentDone = true;
      this.completePart(workflow, true);
      return;
    }
    this.emit("batch.unrolled", workflow, { total, poisonItem: poisonIndex, bounded: true }, rejected);
    for (let item = 1; item <= total; item++) {
      this.schedule(0, `batch.item.${item}`, () => {
        if (item === poisonIndex) {
          this.batchFailed += 1;
          this.emit("batch.item.failed", workflow, { item, statusCode: 400, reason: "invalid_utf8" }, rejected);
        } else {
          this.batchSucceeded += 1;
          this.emit("batch.item.succeeded", workflow, { item, statusCode: 200 }, rejected);
        }
        this.metrics.batchItemsSucceeded = this.batchSucceeded;
        this.metrics.batchItemsFailed = this.batchFailed;
        if (this.batchSucceeded + this.batchFailed === total) {
          workflow.status = "completed_with_item_failures";
          workflow.incidentDone = true;
          this.completePart(workflow);
        }
      });
    }
  }

  private runSaga(workflow: ChaosWorkflow, parent: string): void {
    const steps = ["allocate_compute", "attach_storage", "configure_network"];
    let causalParent = parent;
    for (const step of steps) {
      if (step === "allocate_compute") this.allocatedInstances += 1;
      this.sagaForward.push(step);
      causalParent = this.emit("saga.forward.completed", workflow, { step, resourceCount: this.allocatedInstances }, causalParent);
      this.emit("saga.compensation.registered", workflow, { forwardStep: step, compensation: `release_${step}` }, causalParent);
    }
    const failure = this.emit("saga.downstream.failed", workflow, { step: "apply_downstream_configuration", simulated: true }, causalParent);
    workflow.failed = this.cfg.mode === "naive";
    if (this.cfg.mode === "naive") {
      this.metrics.orphanedAwsInstances = this.allocatedInstances;
      this.emit("saga.orphaned_resources", workflow, { orphanedInstances: this.allocatedInstances }, failure);
    } else {
      let compensationParent = failure;
      for (const step of [...steps].reverse()) {
        this.sagaCompensation.push(step);
          if (this.cfg.sagaCompensationFails && step === "allocate_compute") {
          this.metrics.sagaCompensationsFailed += 1;
          compensationParent = this.emit("saga.compensation.failed", workflow, { forwardStep: step, compensation: `release_${step}` }, compensationParent);
          continue;
        }
        this.sagaCompensated.push(step);
        if (step === "allocate_compute") this.allocatedInstances = Math.max(0, this.allocatedInstances - 1);
        this.metrics.sagaCompensationsSucceeded += 1;
        compensationParent = this.emit("saga.compensation.completed", workflow, { forwardStep: step, compensation: `release_${step}` }, compensationParent);
      }
      this.metrics.orphanedAwsInstances = this.allocatedInstances;
      workflow.status = this.metrics.sagaCompensationsFailed === 0 ? "compensated" : "failed";
      workflow.failed = this.metrics.sagaCompensationsFailed > 0;
      this.emit("saga.rollback.finished", workflow, { compensationOrder: [...this.sagaCompensation], orphanedInstances: this.allocatedInstances }, compensationParent);
    }
    workflow.incidentDone = true;
    this.completePart(workflow, this.cfg.mode === "naive" || this.metrics.sagaCompensationsFailed > 0);
  }

  start(): void {
    if (this.life !== "idle") throw new Error(`cannot start from ${this.life}`);
    this.life = "running";
    this.emit("scenario.start", undefined, { runId: this.cfg.runId, seed: this.cfg.seed, mode: this.cfg.mode, workflowCount: CHAOS_TENANTS.length });
    for (const spec of CHAOS_TENANTS) {
      const workflow = this.workflows.get(spec.taskId)!;
      this.emit("workflow.registered", workflow, { tenant: workflow.tenant });
      this.schedule(0, `workflow.begin.${workflow.taskId}`, () => this.beginWorkflow(workflow));
    }
    this.schedule(this.cfg.tokenStreamMs + this.cfg.poolAcquireTimeoutMs + 10, "scenario.measurement.end", () => {
      this.recordPoolOccupancy();
      this.metrics.measurementWindowMs = this.sim.now;
      this.metrics.dbPoolUtilizationPercent = this.cfg.poolCapacity === 0 || this.metrics.measurementWindowMs === 0
        ? 0
        : (this.poolOccupiedMs / (this.cfg.poolCapacity * this.metrics.measurementWindowMs)) * 100;
      this.emit("measurement.window.closed", undefined, { durationMs: this.metrics.measurementWindowMs });
    });
  }

  step(): boolean {
    if (this.life !== "running") return false;
    try {
      const didStep = this.sim.step();
      this.metrics.activeDbConnections = this.pool.activeConnections;
      this.metrics.dbWaitQueueLength = this.pool.waiting.length;
      this.metrics.peakActiveDbConnections = this.pool.peakActiveConnections;
      this.metrics.totalDbConnectionHoldMs = this.pool.totalHoldMs;
      if (!didStep) this.life = "finished";
      else if (this.sim.pending() === 0) this.life = "finished";
      return didStep;
    } catch (error) {
      this.life = "error";
      this.error = error instanceof Error ? error.message : String(error);
      return false;
    }
  }

  advance(ms: number): void {
    if (!Number.isInteger(ms) || ms < 1 || ms > 60_000) throw new RangeError("advance ms must be an integer in [1, 60000]");
    if (this.life !== "running") return;
    try {
      this.sim.advanceTo(this.sim.now + ms);
      this.metrics.activeDbConnections = this.pool.activeConnections;
      this.metrics.dbWaitQueueLength = this.pool.waiting.length;
      this.metrics.peakActiveDbConnections = this.pool.peakActiveConnections;
      this.metrics.totalDbConnectionHoldMs = this.pool.totalHoldMs;
      if (this.sim.pending() === 0) this.life = "finished";
    } catch (error) {
      this.life = "error";
      this.error = error instanceof Error ? error.message : String(error);
    }
  }

  run(): void {
    let count = 0;
    while (this.life === "running" && this.sim.pending() > 0) {
      if (++count > this.cfg.maxSteps) {
        this.life = "error";
        this.error = `chaos execution step limit ${this.cfg.maxSteps} reached`;
        return;
      }
      this.step();
    }
    if (this.life === "running") this.life = "finished";
  }

  reset(): void {
    this.sim = this.buildSim();
    this.pool = new MockPgPool(this.cfg.poolCapacity, this.cfg.poolQueueCapacity);
    this.resetWorkflowState();
    this.life = "idle";
    this.error = undefined;
  }

  dispose(): void {
    this.sim.log.length = 0;
  }

  snapshot(): ChaosSnapshot {
    this.recordPoolOccupancy();
    this.metrics.activeDbConnections = this.pool.activeConnections;
    this.metrics.dbWaitQueueLength = this.pool.waiting.length;
    this.metrics.peakActiveDbConnections = this.pool.peakActiveConnections;
    this.metrics.totalDbConnectionHoldMs = this.pool.totalHoldMs;
    const events = this.sim.log.slice(-this.cfg.eventHistoryLimit);
    return structuredClone({
      virtualTimeMs: this.sim.now,
      mode: this.cfg.mode,
      activeConnections: this.pool.activeConnections,
      waitQueue: this.pool.waiting.length,
      metrics: this.metrics,
      workflows: [...this.workflows.values()].map(({ taskId, tenant, tenantId, status, dbHeldMs, retries }) => ({ taskId, tenant, tenantId, status, dbHeldMs, retries })),
      eventsCount: this.sim.log.length,
      life: this.life,
      runId: this.cfg.runId,
      seed: this.cfg.seed,
      host: { state: this.processSupervisor.hostState },
      workers: [{ id: "native-worker-1", state: this.processSupervisor.workerState }],
      batch: { total: 50, succeeded: this.batchSucceeded, failed: this.batchFailed, aborted: this.batchAborted },
      saga: { forwardSteps: this.sagaForward, compensationOrder: this.sagaCompensation, compensated: this.sagaCompensated, resourcesAllocated: this.allocatedInstances },
      payment: { receipts: this.paymentGateway.receipts.size, attempts: this.paymentAttempts },
      ...(this.error ? { error: this.error } : {}),
      events,
    });
  }

  exportTrace(): Trace {
    const byId = new Map(this.sim.log.map((event) => [event.id, event]));
    const lastTime = this.sim.now;
    return {
      schema: "sim-trace/0",
      simulated: true,
      virtualTime: true,
      traceId: `chaos-${this.cfg.runId}-${this.cfg.seed}-${this.cfg.mode}`,
      spans: this.sim.log.map((event: SimEvent) => ({
        spanId: `s-${event.id}`,
        parentSpanId: event.parent && byId.has(event.parent) ? `s-${event.parent}` : null,
        name: event.kind,
        startMs: event.t,
        endMs: event.t,
        status: "ok" as const,
        attrs: { ...event.data },
        links: [],
        events: [],
      })),
      derived: { snapshot: this.snapshot(), measurementWindowMs: lastTime },
    };
  }
}

export { DEFAULTS as DEFAULT_CHAOS_CONFIG };