import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { startServer } from "../src/server.ts";
import { exportLangChainJsonl } from "../src/auditor-export.ts";

// Record every outbound socket connect made anywhere in this process.
const connects: string[] = [];
const serverPorts = new Set<string>(); // ports of every server this file starts
const origConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (this: net.Socket, ...a: unknown[]) {
  // net passes either options or a pre-normalized [options, cb] array
  const first = Array.isArray(a[0]) ? a[0][0] : a[0];
  const o = first as { host?: string; port?: number } | number | string;
  connects.push(typeof o === "object" && o !== null ? `${o.host}:${o.port}` : String(o));
  return (origConnect as (...x: unknown[]) => net.Socket).apply(this, a);
} as typeof origConnect;
after(() => { net.Socket.prototype.connect = origConnect; });

interface R { status: number; headers: http.IncomingHttpHeaders; text: string; json: () => any }
function req(port: number, method: string, path: string, o: { headers?: Record<string, string>; body?: string; origin?: string | null; host?: string; json?: boolean } = {}): Promise<R> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { ...(o.headers ?? {}) };
    headers.Host = o.host ?? `127.0.0.1:${port}`;
    if (o.origin !== null) headers.Origin = o.origin ?? `http://127.0.0.1:${port}`;
    if (o.json !== false && o.body !== undefined && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
    const r = http.request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (text += c));
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, text, json: () => JSON.parse(text) }));
    });
    r.on("error", reject);
    if (o.body !== undefined) r.write(o.body);
    r.end();
  });
}
const op = (port: number, body: unknown, o = {}) => req(port, "POST", "/api/op", { body: JSON.stringify(body), ...o });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// manual-stepping server: autoplay tick is effectively never
const slow = await startServer({ tickMs: 100000 });
const fast = await startServer({ tickMs: 1 });
after(async () => { await slow.close(); await fast.close(); });
const P = slow.port;
serverPorts.add(String(slow.port)); serverPorts.add(String(fast.port));

test("binds loopback only by default; refuses non-loopback host", async () => {
  assert.equal((slow.server.address() as net.AddressInfo).address, "127.0.0.1");
  await assert.rejects(startServer({ host: "0.0.0.0" }), /non-loopback/);
});

test("page: served, self-contained, strict CSP, no external URLs", async () => {
  const r = await req(P, "GET", "/", { origin: null });
  assert.equal(r.status, 200);
  assert.match(String(r.headers["content-type"]), /text\/html/);
  const csp = String(r.headers["content-security-policy"]);
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'sha256-/);
  assert.ok(!/unsafe-inline|unsafe-eval/.test(csp));
  assert.ok(!/(src|href)\s*=\s*["']?https?:/i.test(r.text), "no external resources");
  assert.ok(!/\sstyle\s*=/.test(r.text), "no inline style attributes (CSP)");
  assert.ok(!/innerHTML|eval\(/.test(r.text));
  assert.equal(r.headers["x-content-type-options"], "nosniff");
});

test("routing: unknown paths 404, traversal and non-canonical paths never read files", async () => {
  for (const p of ["/etc/passwd", "/../package.json", "/%2e%2e/package.json", "/src/server.ts", "/api/../package.json", "//etc/passwd", "/api/nope"]) {
    const r = await req(P, "GET", p, { origin: null });
    assert.ok([404, 405].includes(r.status), `${p} -> ${r.status}`);
    assert.ok(!r.text.includes("enterprise-simulator\""), p);
    assert.ok(!r.text.includes("import "), p);
  }
  assert.equal((await req(P, "DELETE", "/api/op")).status, 405);
  assert.equal((await req(P, "PUT", "/")).status, 405);
});

test("CORS: preflight gets no allow headers", async () => {
  const r = await req(P, "OPTIONS", "/api/op", { origin: "http://evil.example", headers: { "Access-Control-Request-Method": "POST" } });
  assert.ok(r.status >= 400);
  assert.equal(r.headers["access-control-allow-origin"], undefined);
});

test("Host header must be local (DNS rebinding)", async () => {
  assert.equal((await req(P, "GET", "/api/state", { origin: null, host: "evil.example" })).status, 403);
  assert.equal((await req(P, "GET", "/api/state", { origin: null, host: `127.0.0.1:${P + 1}` })).status, 403);
  assert.equal((await req(P, "GET", "/api/state", { origin: null, host: `localhost:${P}` })).status, 200);
});

test("Origin: exact local match required on POST; checked on GET when present", async () => {
  const b = { op: "pause" };
  for (const origin of ["http://evil.example", "null", `http://127.0.0.1:${P + 1}`, `https://127.0.0.1:${P}`, `http://127.0.0.1.evil.example:${P}`, "", `http://127.0.0.1:${P}/`]) {
    const r = await op(P, b, { origin });
    assert.equal(r.status, 403, `origin=${origin}`);
    assert.equal(r.json().error, "bad_origin");
  }
  assert.equal((await op(P, b, { origin: null })).status, 403, "missing Origin rejected on POST");
  assert.equal((await op(P, b, { origin: `http://127.0.0.1:${P}` })).status, 200);
  assert.equal((await op(P, b, { origin: `http://localhost:${P}` })).status, 200);
  assert.equal((await req(P, "GET", "/api/state", { origin: "http://evil.example" })).status, 403);
  assert.equal((await req(P, "GET", "/api/trace", { origin: "http://evil.example" })).status, 403);
});

test("malformed requests: content-type, JSON, shape, unknown op, bad fields -> safe errors", async () => {
  const cases: Array<[string, Parameters<typeof req>[3], number, string]> = [
    ["wrong content-type", { body: '{"op":"pause"}', headers: { "Content-Type": "text/plain" } }, 415, "bad_content_type"],
    ["no content-type", { body: '{"op":"pause"}', json: false }, 415, "bad_content_type"],
    ["invalid json", { body: "{op:" }, 400, "bad_json"],
    ["empty body", { body: "" }, 400, "bad_json"],
    ["array body", { body: "[]" }, 400, "bad_json"],
    ["string body", { body: '"pause"' }, 400, "bad_json"],
    ["null body", { body: "null" }, 400, "bad_json"],
    ["missing op", { body: "{}" }, 400, "unknown_op"],
    ["op wrong type", { body: '{"op":1}' }, 400, "unknown_op"],
    ["unknown op", { body: '{"op":"exec","cmd":"calc.exe"}' }, 400, "unknown_op"],
    ["proto op", { body: '{"op":"__proto__"}' }, 400, "unknown_op"],
    ["constructor op", { body: '{"op":"constructor"}' }, 400, "unknown_op"],
    ["extra field", { body: '{"op":"pause","path":"/etc/passwd"}' }, 400, "bad_field"],
    ["bad preset", { body: '{"op":"configure","preset":"chaos"}' }, 400, "bad_field"],
    ["inherited preset", { body: '{"op":"configure","preset":"toString"}' }, 400, "bad_field"],
    ["bad idempotency type", { body: '{"op":"configure","preset":"healthy","idempotency":"yes"}' }, 400, "bad_config"],
    ["bad seed", { body: '{"op":"configure","preset":"healthy","seed":-5}' }, 400, "bad_config"],
  ];
  for (const [name, o, status, code] of cases) {
    const r = await req(P, "POST", "/api/op", o);
    assert.equal(r.status, status, name);
    const j = r.json();
    assert.equal(j.error, code, name);
    assert.deepEqual(Object.keys(j).sort(), ["error", "message"], `${name}: no extra/leaky fields`);
    assert.ok(!/at .*\.ts|node_modules|\/home\//.test(r.text), `${name}: no stack/path leak`);
  }
});

test("payload limits: declared and streamed bodies over cap -> 413, server keeps working", async () => {
  const big = JSON.stringify({ op: "pause", pad: "x".repeat(3000) });
  const a = await req(P, "POST", "/api/op", { body: big });
  assert.equal(a.status, 413);
  const b = await req(P, "POST", "/api/op", { body: big, headers: { "Transfer-Encoding": "chunked" } });
  assert.equal(b.status, 413);
  const lie = await req(P, "POST", "/api/op", { body: "{}", headers: { "Content-Length": "999999" } }).catch(() => ({ status: 0 }));
  assert.ok([413, 0].includes(lie.status));
  assert.equal((await req(P, "GET", "/api/state", { origin: null })).status, 200);
});

test("lifecycle: step-by-step run matches state, DB, and trace", async () => {
  assert.equal((await op(P, { op: "reset" })).status, 200);
  assert.equal((await op(P, { op: "configure", preset: "timeout", idempotency: false })).status, 200);
  assert.equal((await op(P, { op: "step" })).status, 409, "cannot step before start");
  let s = (await op(P, { op: "start" })).json();
  assert.equal(s.life, "running");
  assert.equal(s.eventTotal, 0, "start schedules, does not execute");
  assert.equal((await op(P, { op: "configure", preset: "healthy" })).status, 409, "configure only when idle");
  assert.equal((await op(P, { op: "start" })).status, 409, "no double start");
  const before = s.eventTotal;
  s = (await op(P, { op: "step" })).json();
  assert.ok(s.eventTotal > before, "step executes next scheduled event");
  assert.equal(s.autoplay, false);
  s = (await op(P, { op: "play" })).json();
  assert.equal(s.autoplay, true);
  s = (await op(P, { op: "pause" })).json();
  assert.equal(s.autoplay, false);
  const t0 = s.now;
  s = (await op(P, { op: "advance", ms: 500 })).json();
  assert.ok(s.now >= t0 + 500 || s.life === "finished");
  assert.equal((await op(P, { op: "advance", ms: 0 })).status, 400);
  assert.equal((await op(P, { op: "advance", ms: 1.5 })).status, 400);
  assert.equal((await op(P, { op: "advance", ms: 999999 })).status, 400);
  for (let i = 0; i < 200 && s.life === "running"; i++) s = (await op(P, { op: "step" })).json();
  assert.equal(s.life, "finished");
  assert.equal(s.refundState, "completed");
  assert.equal(s.refunds.length, 2, "idempotency off + timeout => duplicate");
  assert.equal(s.derived.duplicateRefunds, 1);
  const dbWrites = s.events.filter((e: any) => e.kind === "db.write" && e.data.table === "refunds").map((e: any) => e.data.rowId);
  assert.deepEqual(dbWrites, s.refunds.map((r: any) => r.id), "event log == DB");
  const tr = (await req(P, "GET", "/api/trace", { origin: null })).json();
  assert.equal(tr.schema, "sim-trace/0");
  assert.equal(tr.simulated, true);
  assert.equal(tr.spans.filter((x: any) => x.name === "payment.attempt").length, s.events.filter((e: any) => e.kind === "payment.attempt.sent").length);
  assert.equal(tr.spans.filter((x: any) => x.name === "db.refunds.insert").length, s.refunds.length);
  assert.equal(tr.derived.duplicateRefunds, 1);
  assert.deepEqual(s.links.sort(), ["client>account", "client>payment", "payment>db"]);
  assert.deepEqual(s.services.map((x: any) => x.name).sort(), ["account", "client", "db", "payment"]);
  assert.equal(s.auditor.connected, false);
  assert.match(s.auditor.reason, /langchain-callback-jsonl/);
  // auditor export endpoint agrees with the trace endpoint and the state
  const ex = await req(P, "GET", "/api/auditor-export", { origin: null });
  assert.equal(ex.status, 200);
  assert.equal(ex.text, exportLangChainJsonl(tr));
  const recs = ex.text.trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(recs.filter((r: any) => r.side_effect === "POST" && r.event === "tool_start").length, s.events.filter((e: any) => e.kind === "payment.attempt.sent").length);
  assert.equal((await req(P, "GET", "/api/auditor-export", { origin: "http://evil.example" })).status, 403);
});

test("reset after finish: clean state, same scenario replays identically", async () => {
  const first = (await req(P, "GET", "/api/state", { origin: null })).json();
  let s = (await op(P, { op: "reset" })).json();
  assert.equal(s.life, "idle");
  assert.equal(s.eventTotal, 0);
  assert.equal(s.refunds.length, 0);
  assert.equal(s.operations.length, 0);
  assert.equal(s.autoplay, false);
  await op(P, { op: "start" });
  for (let i = 0; i < 200 && s.life !== "finished"; i++) s = (await op(P, { op: "step" })).json();
  assert.deepEqual(s.events, first.events);
  assert.deepEqual(s.refunds, first.refunds);
});

test("stop: lifecycle stopped, steps refused, reset recovers", async () => {
  await op(P, { op: "reset" });
  await op(P, { op: "start" });
  await op(P, { op: "step" });
  const s = (await op(P, { op: "stop" })).json();
  assert.equal(s.life, "stopped");
  assert.equal(s.autoplay, false);
  assert.equal((await op(P, { op: "step" })).status, 409);
  assert.equal((await op(P, { op: "reset" })).json().life, "idle");
});

test("auditor export refused before any event exists", async () => {
  await op(P, { op: "reset" });
  const r = await req(P, "GET", "/api/auditor-export", { origin: null });
  assert.equal(r.status, 409);
  assert.equal(r.json().error, "no_trace");
});

test("shown events are capped while total stays accurate", async () => {
  const tiny = await startServer({ tickMs: 100000, maxEventsShown: 3 });
  serverPorts.add(String(tiny.port));
  try {
    await op(tiny.port, { op: "start" });
    let s: any;
    for (let i = 0; i < 100; i++) { const r = await op(tiny.port, { op: "step" }); if (r.status !== 200) break; s = r.json(); }
    assert.equal(s.events.length, 3);
    assert.ok(s.eventTotal > 3);
  } finally { await tiny.close(); }
});

test("engine failure (event limit) is surfaced in state and recoverable by reset", async () => {
  const lim = await startServer({ tickMs: 100000, scenarioBase: { maxEvents: 10 } });
  serverPorts.add(String(lim.port));
  try {
    await op(lim.port, { op: "start" });
    let s: any;
    for (let i = 0; i < 30; i++) { const r = await op(lim.port, { op: "step" }); if (r.status !== 200) break; s = r.json(); if (s.life === "error") break; }
    assert.equal(s.life, "error");
    assert.match(s.error, /event limit/);
    assert.equal(s.eventTotal, 10);
    assert.equal((await op(lim.port, { op: "step" })).status, 409);
    const r = (await op(lim.port, { op: "reset" })).json();
    assert.equal(r.life, "idle");
    assert.equal(r.error, undefined);
  } finally { await lim.close(); }
});

test("autoplay runs a scenario to completion on its own", async () => {
  const p = fast.port;
  await op(p, { op: "configure", preset: "healthy", idempotency: true });
  await op(p, { op: "start" });
  let s: any;
  for (let i = 0; i < 200; i++) { await sleep(10); s = (await req(p, "GET", "/api/state", { origin: null })).json(); if (s.life === "finished") break; }
  assert.equal(s.life, "finished");
  assert.equal(s.refunds.length, 1);
  assert.equal(s.autoplay, false, "timer stops itself when finished");
});

test("M6 enterprise scenario is runnable through the same API and exposes shared-resource state", async () => {
  const page = await req(P, "GET", "/", { origin: null });
  assert.ok(page.text.includes('$("stop").disabled=!run||isEnterprise;'));
  await op(P, { op: "configure", scenario: "enterprise", preset: "fault" });
  let s = (await op(P, { op: "start" })).json();
  assert.equal(s.model, "enterprise");
  assert.equal(s.config.mode, "fault");
  assert.ok(s.m6);
  assert.ok(s.m6.sharedResource);
  assert.equal((await op(P, { op: "stop" })).status, 409);
  for (let i = 0; i < 200 && s.life === "running"; i++) {
    s = (await op(P, { op: "step" })).json();
  }
  assert.ok(s.m6.deadLetters.length >= 0);
  assert.equal((await op(P, { op: "reset" })).json().life, "idle");
});

test("M7 chaos modes are selectable through the UI/API and expose safe trace/state contracts", async () => {
  const page = await req(P, "GET", "/", { origin: null });
  assert.match(page.text, /M7 chaos naive/);
  assert.match(page.text, /M7 chaos resilient/);

  assert.equal((await op(P, { op: "configure", scenario: "chaos", mode: "unknown" })).status, 400);
  assert.equal((await op(P, { op: "configure", scenario: "chaos", mode: "naive", runId: "bad run" })).status, 400);

  let s = (await op(P, { op: "configure", scenario: "chaos", mode: "resilient", seed: 12, runId: "api-chaos-12" })).json();
  assert.equal(s.model, "chaos");
  assert.equal(s.chaos.mode, "resilient");
  assert.equal(s.chaos.workflows.length, 10);
  s = (await op(P, { op: "start" })).json();
  assert.equal(s.life, "running");
  s = (await op(P, { op: "advance", ms: 6 })).json();
  assert.ok(s.chaos.eventsCount > 0);
  assert.ok(s.chaos.virtualTimeMs >= 6);
  assert.equal((await op(P, { op: "stop" })).status, 409);
  assert.equal((await req(P, "GET", "/api/auditor-export", { origin: null })).status, 409);
  assert.equal((await req(P, "GET", "/api/trace", { origin: null })).json().schema, "sim-trace/0");

  for (let i = 0; i < 500 && s.life === "running"; i++) s = (await op(P, { op: "step" })).json();
  assert.equal(s.life, "finished");
  assert.equal(s.chaos.metrics.containedWorkerCrashes, 1);
  assert.equal((await op(P, { op: "reset" })).json().life, "idle");
  await op(P, { op: "start" });
  let replay: any;
  for (let i = 0; i < 500; i++) {
    replay = (await op(P, { op: "step" })).json();
    if (replay.life !== "running") break;
  }
  assert.equal(replay.life, "finished");
  assert.equal(replay.chaos.eventsCount, s.chaos.eventsCount);
  assert.deepEqual(replay.events, s.events);
});

test("no unexpected outbound connections: every socket connect targeted this test's loopback servers", () => {
  assert.ok(connects.length > 0);
  const ports = new Set([String(slow.port), String(fast.port)]);
  for (const c of connects) {
    const [h, p] = c.split(":");
    assert.equal(h, "127.0.0.1", `unexpected host in ${c}`);
    assert.ok(ports.has(p!) || serverPorts.has(p!), `unexpected port in ${c}`);
  }
});
