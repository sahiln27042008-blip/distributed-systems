import http from "node:http";
import type { AddressInfo } from "node:net";
import { PRESETS, RefundScenario } from "./refund.ts";
import { exportTrace } from "./trace.ts";
import { exportLangChainJsonl } from "./auditor-export.ts";
import { SharedEnterpriseScenario } from "./enterprise.ts";
import { EnterpriseChaosScenario } from "./chaos.ts";
import { CSP, PAGE } from "./ui.ts";
import { UnsupportedTraceError } from "./auditor-export.ts";

export interface ServerOptions {
  host?: string; // loopback only
  port?: number; // 0 = pick a free port
  tickMs?: number; // wall-clock pacing of autoplay only; never feeds virtual time
  maxBodyBytes?: number;
  maxEventsShown?: number;
  scenarioBase?: Record<string, unknown>; // extra scenario config (e.g. limits), validated by parseConfig; test/dev hook
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);
const AUDITOR = {
  connected: false, // this server never runs the auditor (no command execution); run the CLI on the exported file
  reason: `findings come from the auditor CLI, not this page. Export a refund langchain-callback-jsonl/1 file, then run: agent-invariants audit <file.jsonl> --json`,
};

class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

type Json = Record<string, unknown>;

// Exact-key validation: reject anything not explicitly allowed.
function only(body: Json, allowed: string[]): void {
  for (const k of Object.keys(body)) if (!allowed.includes(k)) throw new HttpError(400, "bad_field", `unknown field: ${k}`);
}

export async function startServer(opts: ServerOptions = {}) {
  const host = opts.host ?? "127.0.0.1";
  if (!LOOPBACK.has(host)) throw new Error(`refusing to bind non-loopback host: ${host}`);
  const tickMs = opts.tickMs ?? 250;
  const maxBody = opts.maxBodyBytes ?? 2048;
  const maxShown = opts.maxEventsShown ?? 500;

  const base = opts.scenarioBase ?? {};
  type Scenario = RefundScenario | SharedEnterpriseScenario | EnterpriseChaosScenario;
  let scenarioKind: "refund" | "enterprise" | "chaos" = "refund";
  let scenario: Scenario = new RefundScenario({ ...base, ...PRESETS.healthy });
  let timer: NodeJS.Timeout | undefined;
  let port = 0;

  const buildScenario = (kind: "refund" | "enterprise" | "chaos", preset: string, idempotency?: boolean, config?: Json): Scenario => {
    if (kind === "chaos") {
      if (config?.mode !== "naive" && config?.mode !== "resilient") throw new HttpError(400, "bad_field", "mode must be naive or resilient");
      const seed = config.seed === undefined ? 7 : config.seed;
      const runId = config.runId === undefined ? `chaos-${seed}` : config.runId;
      if (typeof seed !== "number" || !Number.isInteger(seed) || seed < 0 || seed > 0xffff_ffff) throw new HttpError(400, "bad_field", "seed must be an integer in [0, 4294967295]");
      if (typeof runId !== "string") throw new HttpError(400, "bad_field", "runId must be a string");
      return new EnterpriseChaosScenario({ mode: config.mode, seed, runId });
    }
    if (kind === "enterprise") {
      const mode = preset === "fault" ? "fault" : "healthy";
      return new SharedEnterpriseScenario({ seed: typeof base.seed === "number" ? Number(base.seed) : 7, mode, queueCapacity: typeof base.queueCapacity === "number" ? Number(base.queueCapacity) : 2, workerCount: typeof base.workerCount === "number" ? Number(base.workerCount) : 2 });
    }
    const next: Record<string, unknown> = { ...base, ...PRESETS[preset as keyof typeof PRESETS] };
    if (idempotency !== undefined) next.idempotency = idempotency;
    if (base.seed !== undefined) next.seed = base.seed;
    return new RefundScenario(next);
  };

  const stopTimer = () => {
    if (timer) clearInterval(timer);
    timer = undefined;
  };
  const startTimer = () => {
    if (timer) return;
    timer = setInterval(() => {
      if (!scenario.step()) stopTimer();
    }, tickMs);
    timer.unref();
  };
  const requireLife = (life: string) => {
    if (scenario.life !== life) throw new HttpError(409, "bad_state", `operation needs lifecycle "${life}", currently "${scenario.life}"`);
  };

  const state = () => {
    if (scenarioKind === "chaos" && scenario instanceof EnterpriseChaosScenario) {
      const snap = scenario.snapshot();
      return {
        model: "chaos",
        scenario: "chaos",
        config: { ...scenario.cfg },
        life: snap.life,
        now: snap.virtualTimeMs,
        pending: scenario.sim.pending(),
        autoplay: timer !== undefined,
        error: snap.error,
        services: [...scenario.sim.services].map(([name, kind]) => ({ name, kind })),
        links: [...scenario.sim.links],
        eventTotal: snap.eventsCount,
        events: snap.events.slice(-maxShown),
        chaos: snap,
        auditor: AUDITOR,
      };
    }
    if (scenarioKind === "enterprise" && scenario instanceof SharedEnterpriseScenario) {
      const snap: any = scenario.snapshot();
      const log = scenario.sim.log;
      return {
        model: "enterprise",
        scenario: "enterprise",
        config: { ...scenario.cfg, scenario: "enterprise" },
        life: snap.life,
        now: snap.now,
        pending: scenario.sim.pending(),
        autoplay: timer !== undefined,
        error: scenario.error,
        refundState: snap.workflows.map((w: any) => `${w.name}:${w.status}`).join(" | "),
        services: [...scenario.sim.services].map(([name, kind]) => ({ name, kind })),
        links: [...scenario.sim.links],
        eventTotal: log.length,
        events: log.slice(-maxShown),
        m6: snap,
        queue: snap.queue,
        workers: snap.workers,
        sharedResource: snap.sharedResource,
        deadLetters: snap.deadLetters,
        workflows: snap.workflows,
        derived: { deadLetters: snap.deadLetters.length, queueDepth: snap.queue.length },
        auditor: AUDITOR,
      };
    }

    const refundScenario = scenario as RefundScenario;
    const snap: any = refundScenario.snapshot();
    const log = refundScenario.sim.log;
    return {
      model: "refund",
      scenario: "refund",
      config: refundScenario.cfg,
      life: snap.life,
      now: snap.now,
      pending: refundScenario.sim.pending(),
      autoplay: timer !== undefined,
      refundState: snap.refundState,
      error: snap.error,
      services: [...refundScenario.sim.services].map(([name, kind]) => ({ name, kind })),
      links: [...refundScenario.sim.links],
      eventTotal: log.length,
      events: log.slice(-maxShown),
      refunds: snap.refunds,
      operations: snap.operations,
      derived: snap.derived,
      auditor: AUDITOR,
    };
  };

  // Whitelisted operations. Anything else is rejected before touching state.
  const ops: Record<string, (b: Json) => void> = {
    configure(b) {
      only(b, ["op", "preset", "idempotency", "seed", "scenario", "queueCapacity", "workerCount", "mode", "runId"]);
      requireLife("idle");
      const requested = typeof b.scenario === "string" ? b.scenario : "refund";
      const preset = typeof b.preset === "string" ? b.preset : "healthy";
      let sc: Scenario;
      const normalizePreset = (value: string) => value === "m6-healthy" ? "healthy" : value === "m6-fault" ? "fault" : value;
      const effectivePreset = normalizePreset(preset);
      try {
        if (requested === "chaos") {
          scenarioKind = "chaos";
          sc = buildScenario("chaos", preset, undefined, b);
        } else if (requested === "enterprise") {
          if (!Object.hasOwn({ healthy: true, fault: true }, effectivePreset)) throw new HttpError(400, "bad_field", "preset must be healthy or fault");
          scenarioKind = "enterprise";
          sc = buildScenario("enterprise", effectivePreset, b.idempotency === undefined ? undefined : Boolean(b.idempotency));
        } else {
          scenarioKind = "refund";
          if (!Object.hasOwn(PRESETS, effectivePreset)) throw new HttpError(400, "bad_field", "preset must be healthy or timeout");
          const next: Json = { ...base, ...PRESETS[effectivePreset as keyof typeof PRESETS] };
          if (b.idempotency !== undefined) next.idempotency = b.idempotency;
          if (b.seed !== undefined) next.seed = b.seed;
          sc = new RefundScenario(next);
        }
      } catch (e) {
        if (e instanceof HttpError) throw e;
        throw new HttpError(400, "bad_config", e instanceof Error ? e.message : "invalid config");
      }
      scenario.dispose();
      scenario = sc;
    },
    start(b) {
      only(b, ["op"]);
      requireLife("idle");
      scenario.start();
      startTimer();
    },
    play(b) {
      only(b, ["op"]);
      requireLife("running");
      startTimer();
    },
    pause(b) {
      only(b, ["op"]);
      stopTimer();
    },
    step(b) {
      only(b, ["op"]);
      requireLife("running");
      stopTimer();
      scenario.step();
    },
    advance(b) {
      only(b, ["op", "ms"]);
      requireLife("running");
      const ms = b.ms;
      if (typeof ms !== "number" || !Number.isInteger(ms) || ms < 1 || ms > 60_000) throw new HttpError(400, "bad_field", "ms must be an integer in [1, 60000]");
      stopTimer();
      scenario.advance(ms);
    },
    stop(b) {
      only(b, ["op"]);
      requireLife("running");
      stopTimer();
      if (scenarioKind === "refund") {
        (scenario as RefundScenario).stop();
        return;
      }
      throw new HttpError(409, "bad_state", `${scenarioKind} scenario does not support stop`);
    },
    reset(b) {
      only(b, ["op"]);
      stopTimer();
      scenario.reset();
    },
  };

  const allowedHosts = () => new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  const allowedOrigins = () => new Set([...allowedHosts()].map((h) => `http://${h}`));

  const send = (res: http.ServerResponse, status: number, body: string, type: string, extra: Record<string, string> = {}) => {
    res.writeHead(status, {
      "Content-Type": type,
      "Content-Length": Buffer.byteLength(body),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": CSP,
      ...extra,
    });
    res.end(body);
  };
  const sendJson = (res: http.ServerResponse, status: number, obj: unknown, extra: Record<string, string> = {}) =>
    send(res, status, JSON.stringify(obj), "application/json; charset=utf-8", extra);

  const readBody = (req: http.IncomingMessage): Promise<string> =>
    new Promise((resolve, reject) => {
      const declared = req.headers["content-length"];
      if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > maxBody)) {
        reject(new HttpError(413, "too_large", `body over ${maxBody} bytes`));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size > maxBody) {
          req.pause();
          reject(new HttpError(413, "too_large", `body over ${maxBody} bytes`));
          return;
        }
        chunks.push(c);
      });
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      req.on("error", () => reject(new HttpError(400, "bad_request", "request stream error")));
    });

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    // DNS-rebinding guard: Host must be our own loopback name:port.
    if (!req.headers.host || !allowedHosts().has(req.headers.host)) throw new HttpError(403, "bad_host", "host not allowed");
    const origin = req.headers.origin;
    const url = new URL(req.url ?? "/", "http://x");
    if (req.url !== url.pathname + url.search) throw new HttpError(404, "not_found", "not found"); // reject non-canonical paths
    const method = req.method ?? "";

    if (url.pathname === "/" && method === "GET") return send(res, 200, PAGE, "text/html; charset=utf-8");
    if (url.pathname === "/api/state" && method === "GET") {
      if (origin !== undefined && !allowedOrigins().has(origin)) throw new HttpError(403, "bad_origin", "origin not allowed");
      return sendJson(res, 200, state());
    }
    if (url.pathname === "/api/trace" && method === "GET") {
      if (origin !== undefined && !allowedOrigins().has(origin)) throw new HttpError(403, "bad_origin", "origin not allowed");
      const trace = scenarioKind === "chaos" && scenario instanceof EnterpriseChaosScenario
        ? scenario.exportTrace()
        : scenarioKind === "enterprise" && scenario instanceof SharedEnterpriseScenario
          ? scenario.exportTrace()
          : exportTrace((scenario as RefundScenario).sim.log, `sim-${(scenario as RefundScenario).cfg.seed}-${(scenario as RefundScenario).cfg.orderId}`, (scenario as RefundScenario).snapshot().derived);
      return sendJson(res, 200, trace);
    }
    if (url.pathname === "/api/auditor-export" && method === "GET") {
      if (origin !== undefined && !allowedOrigins().has(origin)) throw new HttpError(403, "bad_origin", "origin not allowed");
      if (scenarioKind !== "refund") throw new HttpError(409, "unsupported_trace", `auditor export is unavailable for ${scenarioKind === "chaos" ? "M7 chaos" : "M6 enterprise"} traces`);
      const trace = exportTrace((scenario as RefundScenario).sim.log, `sim-${(scenario as RefundScenario).cfg.seed}-${(scenario as RefundScenario).cfg.orderId}`, (scenario as RefundScenario).snapshot().derived);
      if (trace.spans.length === 0) throw new HttpError(409, "no_trace", "nothing to export yet: step the scenario first");
      try {
        return send(res, 200, exportLangChainJsonl(trace), "application/x-ndjson; charset=utf-8");
      } catch (e) {
        if (e instanceof UnsupportedTraceError) throw new HttpError(409, e.code, e.message);
        throw e;
      }
    }
    if (url.pathname === "/api/op") {
      if (method !== "POST") throw new HttpError(405, "bad_method", "use POST", );
      // CSRF boundary: browsers always send Origin on POST; require an exact local match.
      if (origin === undefined || !allowedOrigins().has(origin)) throw new HttpError(403, "bad_origin", "origin not allowed");
      if (!/^application\/json(\s*;.*)?$/i.test(req.headers["content-type"] ?? "")) throw new HttpError(415, "bad_content_type", "content-type must be application/json");
      const raw = await readBody(req);
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        throw new HttpError(400, "bad_json", "body is not valid JSON");
      }
      if (typeof body !== "object" || body === null || Array.isArray(body)) throw new HttpError(400, "bad_json", "body must be a JSON object");
      const b = body as Json;
      if (typeof b.op !== "string" || !Object.hasOwn(ops, b.op)) throw new HttpError(400, "unknown_op", "unknown operation");
      ops[b.op]!(b);
      return sendJson(res, 200, state());
    }
    throw new HttpError(url.pathname === "/" || url.pathname.startsWith("/api/") ? 405 : 404, url.pathname === "/" || url.pathname.startsWith("/api/") ? "bad_method" : "not_found", "not found or method not allowed");
  };

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      const known = e instanceof HttpError;
      // Unknown errors never leak details.
      const status = known ? e.status : 500;
      sendJson(res, status, { error: known ? e.code : "internal", message: known ? e.message : "internal error" }, status === 413 ? { Connection: "close" } : {});
    });
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, host, () => resolve());
  });
  port = (server.address() as AddressInfo).port;

  return {
    server,
    host,
    port,
    url: `http://${host === "::1" ? "[::1]" : host}:${port}/`,
    close: () =>
      new Promise<void>((resolve) => {
        stopTimer();
        server.close(() => {
          scenario.dispose();
          resolve();
        });
        server.closeAllConnections();
      }),
  };
}
