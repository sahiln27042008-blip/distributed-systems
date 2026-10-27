import { DatabaseSync } from "node:sqlite";
import { Sim } from "./kernel.ts";

export interface RefundConfig {
  seed: number;
  orderId: string;
  amountCents: number;
  mode: "healthy" | "timeout";
  idempotency: boolean; // server honors the idempotency key
  maxRetries: number; // retries after the first attempt
  timeoutMs: number; // client timeout per attempt
  latencyMs: number; // base one-way latency
  jitterMs: number; // seeded jitter added to latency
  timeoutAttempts: number; // timeout mode: first N attempts get a response slower than timeoutMs
  replay: boolean; // after success, client resends the same request once
  maxEvents: number;
}

const DEFAULTS: Record<keyof RefundConfig, unknown> = {
  seed: 1,
  orderId: "ord-1001",
  amountCents: 2500,
  mode: "healthy",
  idempotency: true,
  maxRetries: 2,
  timeoutMs: 1000,
  latencyMs: 50,
  jitterMs: 20,
  timeoutAttempts: 1,
  replay: false,
  maxEvents: 2000,
};

export const PRESETS = {
  healthy: { mode: "healthy", replay: true },
  timeout: { mode: "timeout", replay: false },
} as const;

const RANGES: Record<string, [number, number]> = {
  seed: [0, 4294967295],
  amountCents: [1, 10_000_000],
  maxRetries: [0, 5],
  timeoutMs: [1, 60_000],
  latencyMs: [0, 10_000],
  jitterMs: [0, 10_000],
  timeoutAttempts: [0, 10],
  maxEvents: [10, 100_000],
};

// Trust boundary: strict validation, unknown keys rejected.
export function parseConfig(input: unknown): RefundConfig {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new TypeError("config must be an object");
  const cfg: Record<string, unknown> = { ...DEFAULTS };
  for (const [k, v] of Object.entries(input)) {
    if (!(k in DEFAULTS)) throw new TypeError(`unknown field: ${k}`);
    if (typeof v !== typeof DEFAULTS[k as keyof RefundConfig]) throw new TypeError(`bad type for ${k}`);
    const r = RANGES[k];
    if (r && (!Number.isInteger(v) || (v as number) < r[0] || (v as number) > r[1])) throw new RangeError(`${k} must be integer in [${r[0]}, ${r[1]}]`);
    cfg[k] = v;
  }
  if (cfg.mode !== "healthy" && cfg.mode !== "timeout") throw new RangeError("mode must be healthy or timeout");
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(cfg.orderId as string)) throw new RangeError("orderId must match [A-Za-z0-9_-]{1,32}");
  return cfg as unknown as RefundConfig;
}

export type Lifecycle = "idle" | "running" | "finished" | "stopped" | "error";
type AttemptKind = "initial" | "retry" | "replay";
interface Processed {
  refundId: string;
  replayed: boolean;
  eventId: string;
}

export class RefundScenario {
  readonly cfg: RefundConfig;
  sim!: Sim;
  db!: DatabaseSync;
  life: Lifecycle = "idle";
  refundState = "none";
  error: string | undefined;
  #corr = "";

  constructor(input: unknown = {}) {
    this.cfg = parseConfig(input);
    this.#build();
  }

  // Fresh kernel + fresh in-memory DB. Only simulator-owned resources are touched.
  #build(): void {
    this.sim = new Sim(this.cfg.seed, { maxEvents: this.cfg.maxEvents });
    this.db = new DatabaseSync(":memory:");
    this.db.exec(
      `CREATE TABLE refunds(id INTEGER PRIMARY KEY AUTOINCREMENT, order_id TEXT NOT NULL, amount_cents INTEGER NOT NULL, idem_key TEXT NOT NULL, attempt INTEGER NOT NULL, created_t INTEGER NOT NULL);
       CREATE TABLE operations(id INTEGER PRIMARY KEY AUTOINCREMENT, corr TEXT NOT NULL, state TEXT NOT NULL, refund_id INTEGER, t INTEGER NOT NULL);`,
    );
    this.sim.register("client", "client");
    this.sim.register("account", "mock-service");
    this.sim.register("payment", "mock-service");
    this.sim.register("db", "sqlite");
    this.life = "idle";
    this.refundState = "none";
    this.error = undefined;
    this.#corr = `refund:${this.cfg.orderId}`;
  }

  reset(): void {
    this.db.close();
    this.#build();
  }

  start(): void {
    if (this.life !== "idle") throw new Error(`cannot start from ${this.life}`);
    this.life = "running";
    this.sim.at(0, "request", () => this.#request());
  }

  stop(): void {
    if (this.life === "running") this.life = "stopped";
  }

  // Execute the next scheduled event. Returns false when nothing ran.
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

  run(): void {
    while (this.step());
  }

  // Run every event due within the next `ms` virtual ms.
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

  // Release the simulator-owned DB. Scenario is unusable afterwards.
  dispose(): void {
    this.db.close();
  }

  snapshot() {
    const refunds = this.db.prepare("SELECT * FROM refunds ORDER BY id").all().map((r) => ({ ...r }));
    const operations = this.db.prepare("SELECT * FROM operations ORDER BY id").all().map((r) => ({ ...r }));
    return {
      life: this.life,
      now: this.sim.now,
      refundState: this.refundState,
      error: this.error,
      refunds,
      operations,
      // derived from DB rows, not observed by any service
      derived: { duplicateRefunds: Math.max(0, refunds.length - 1) },
    };
  }

  // ---- workflow ----

  #lat(): number {
    return this.cfg.latencyMs + this.sim.rng.int(0, this.cfg.jitterMs);
  }

  #e(kind: string, data: Record<string, unknown>, parent?: string): string {
    return this.sim.emit(kind, this.#corr, data, parent);
  }

  #go(to: string): void {
    if (to === this.refundState) return;
    this.#e("state.transition", { from: this.refundState, to });
    this.refundState = to;
  }

  #request(): void {
    const root = this.#e("request.received", { orderId: this.cfg.orderId, amountCents: this.cfg.amountCents });
    this.#go("requested");
    this.sim.link("client", "account");
    const call = this.#e("account.call", { orderId: this.cfg.orderId }, root);
    this.sim.at(this.#lat(), "account.result", () => {
      const res = this.#e("account.result", { customerId: `cust-${this.cfg.orderId}`, eligible: true }, call);
      this.#go("account_verified");
      this.#attempt(1, undefined, "initial", res);
    });
  }

  #attempt(n: number, retryOf: string | undefined, kind: AttemptKind, parent: string): void {
    const c = this.cfg;
    const key = c.idempotency ? `idem-${c.orderId}` : null; // policy off => client sends no key
    this.sim.link("client", "payment");
    const sent = this.#e("payment.attempt.sent", { attempt: n, kind, key, idempotencyEnabled: c.idempotency, ...(retryOf ? { retryOf } : {}) }, parent);
    if (kind !== "replay") this.#go(n === 1 ? "payment_pending" : "payment_retrying");

    let timedOut = false;
    let responded = false;
    const toServer = this.#lat();
    const slow = c.mode === "timeout" && kind !== "replay" && n <= c.timeoutAttempts;
    const back = slow ? c.timeoutMs + 500 : this.#lat(); // slow => response always lands after the client gave up

    this.sim.at(toServer, "payment.server", () => {
      this.sim.link("payment", "db");
      const r = this.#process(n, key, sent);
      this.sim.at(back, "payment.response", () => {
        if (timedOut) {
          this.#e("payment.response.late_ignored", { attempt: n, refundId: r.refundId }, r.eventId);
          return;
        }
        responded = true;
        const rec = this.#e("payment.response.received", { attempt: n, refundId: r.refundId, replayed: r.replayed }, r.eventId);
        this.#complete(n, kind, r, rec);
      });
    });

    this.sim.at(c.timeoutMs, "client.timeout", () => {
      if (responded) return;
      timedOut = true;
      const to = this.#e("client.timeout", { attempt: n, timeoutMs: c.timeoutMs }, sent);
      if (kind === "replay") return;
      if (n - 1 < c.maxRetries) {
        this.sim.at(100 * 2 ** (n - 1), "client.retry", () => this.#attempt(n + 1, sent, "retry", to));
      } else {
        this.#op("failed_outcome_unknown", null, to);
        this.#go("failed");
      }
    });
  }

  // Mock payment server. Honors the idempotency key only when enabled.
  #process(n: number, key: string | null, sent: string): Processed {
    if (key !== null) {
      const row = this.db.prepare("SELECT id FROM refunds WHERE idem_key = ?").get(key) as { id: number } | undefined;
      if (row) {
        const eventId = this.#e("payment.idempotent_replay", { attempt: n, key, refundId: `rf-${row.id}` }, sent);
        return { refundId: `rf-${row.id}`, replayed: true, eventId };
      }
    }
    const res = this.db
      .prepare("INSERT INTO refunds(order_id, amount_cents, idem_key, attempt, created_t) VALUES(?,?,?,?,?)")
      .run(this.cfg.orderId, this.cfg.amountCents, key ?? "", n, this.sim.now);
    const id = Number(res.lastInsertRowid);
    const eventId = this.#e("payment.refund.created", { attempt: n, key, refundId: `rf-${id}` }, sent);
    this.#e("db.write", { table: "refunds", op: "insert", rowId: id }, eventId);
    return { refundId: `rf-${id}`, replayed: false, eventId };
  }

  #op(state: string, refundRowId: number | null, parent: string): void {
    const res = this.db.prepare("INSERT INTO operations(corr, state, refund_id, t) VALUES(?,?,?,?)").run(this.#corr, state, refundRowId, this.sim.now);
    this.#e("db.write", { table: "operations", op: "insert", rowId: Number(res.lastInsertRowid), state }, parent);
  }

  #complete(n: number, kind: AttemptKind, r: Processed, parent: string): void {
    this.#op(kind === "replay" ? "replay_observed" : "completed", Number(r.refundId.slice(3)), parent);
    if (kind === "replay") return;
    this.#go("completed");
    if (this.cfg.replay) {
      this.sim.at(1000, "client.replay", () => {
        const rp = this.#e("request.replayed", { orderId: this.cfg.orderId }, parent);
        this.#attempt(n + 1, undefined, "replay", rp);
      });
    }
  }
}
