export type Data = Record<string, unknown>;

export interface SimEvent {
  id: string; // e1, e2, ... stable per run
  t: number; // virtual ms
  kind: string;
  corr: string; // correlation id
  parent?: string; // causal parent event id
  data: Data;
}

export class LimitError extends Error {}

// mulberry32: tiny seeded PRNG, no Math.random anywhere.
export class Rng {
  #s: number;
  constructor(seed: number) {
    this.#s = seed >>> 0;
  }
  next(): number {
    let t = (this.#s += 0x6d2b79f5) >>> 0;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }
}

interface Task {
  t: number;
  seq: number;
  label: string;
  fn: () => void;
}

export interface SimLimits {
  maxEvents: number;
  maxPayloadBytes: number;
  maxSteps: number;
}

export class Sim {
  now = 0; // virtual clock, never reads wall time
  readonly rng: Rng;
  readonly log: SimEvent[] = [];
  readonly services = new Map<string, string>(); // name -> kind
  readonly links = new Set<string>(); // "from>to", recorded when a call actually happens
  readonly limits: SimLimits;
  #q: Task[] = [];
  #seq = 0;
  #steps = 0;

  constructor(seed: number, limits: Partial<SimLimits> = {}) {
    this.rng = new Rng(seed);
    this.limits = { maxEvents: 2000, maxPayloadBytes: 4096, maxSteps: 10000, ...limits };
  }

  register(name: string, kind: string): void {
    this.services.set(name, kind);
  }

  link(from: string, to: string): void {
    if (!this.services.has(from) || !this.services.has(to)) throw new Error(`unregistered service in link ${from}>${to}`);
    this.links.add(`${from}>${to}`);
  }

  // Schedule fn `delay` virtual ms from now. Tie-break: (time, insertion seq).
  // ponytail: sorted array insert O(n); swap for a heap if queues get large.
  at(delay: number, label: string, fn: () => void): void {
    if (!Number.isInteger(delay) || delay < 0) throw new RangeError(`bad delay for ${label}: ${delay}`);
    const t = this.now + delay;
    let i = this.#q.length;
    while (i > 0 && this.#q[i - 1]!.t > t) i--;
    this.#q.splice(i, 0, { t, seq: this.#seq++, label, fn });
  }

  emit(kind: string, corr: string, data: Data = {}, parent?: string): string {
    if (this.log.length >= this.limits.maxEvents) throw new LimitError(`event limit ${this.limits.maxEvents} reached`);
    if (JSON.stringify(data).length > this.limits.maxPayloadBytes) throw new LimitError(`payload over ${this.limits.maxPayloadBytes} bytes`);
    const id = `e${this.log.length + 1}`;
    const ev: SimEvent = { id, t: this.now, kind, corr, data };
    if (parent !== undefined) ev.parent = parent;
    this.log.push(ev);
    return id;
  }

  pending(): number {
    return this.#q.length;
  }

  // Run exactly one scheduled task (iterative: no recursion, no stack growth).
  step(): boolean {
    const task = this.#q.shift();
    if (!task) return false;
    if (++this.#steps > this.limits.maxSteps) throw new LimitError(`step limit ${this.limits.maxSteps} reached`);
    this.now = task.t;
    task.fn();
    return true;
  }

  // Advance virtual time to `t`, running every task due by then.
  advanceTo(t: number): void {
    while (this.#q.length && this.#q[0]!.t <= t) this.step();
    if (t > this.now) this.now = t;
  }
}
