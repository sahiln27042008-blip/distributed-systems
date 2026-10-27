# enterprise-simulator

Standalone deterministic simulator for a refund workflow, M6 enterprise queue/worker/resource scenarios, and M7 Enterprise Chaos Lab. All infrastructure is simulated.

**Everything is simulated.** The virtual clock, mock services, and in-memory SQLite do not measure real infrastructure. The app, demo, and default tests need no credentials, paid APIs, or cloud services. Dependency installation may contact the npm registry; after installation, the simulator itself makes no external network requests. Server tests verify that test traffic stays on loopback.

## Requirements

- **Node.js >= 22.18** (Node runs the `.ts` entry points directly; `node:sqlite` is built in). Release checks here use Node v24.16.0.
- **Node 18 / 20 are NOT supported** (no built-in `node:sqlite`, no native TypeScript). Check with `node -v`.
- Runtime has **zero third-party dependencies**. `typescript` and `@types/node` are development dependencies used by typecheck.
- Windows, macOS, Linux. Docker not needed.

## Setup and Verification (Windows PowerShell)

```powershell
Set-Location 'C:\path\to\enterprise-simulator'
node -v                                      # v22.18.0 or newer
npm ci                                       # install exactly from package-lock.json
npm run typecheck                            # tsc --noEmit
npm test                                     # complete test suite
node --test test/auditor-export.test.ts      # focused exporter tests
npm run demo                                 # simulated refund outputs under out\
npm run serve                                # starts the local UI
```

`npm ci` may need the npm registry if the locked packages are not cached. After installation, the simulator and default tests require no external service. Open the URL printed by `npm run serve`, normally <http://127.0.0.1:8787/>. Stop the server with `Ctrl+C`.

To use another port: `$env:SIM_PORT = "9000"; npm run serve` (clear it with `Remove-Item Env:SIM_PORT`). Port `0` asks the OS for an available port; the actual URL is printed at startup.

The CLI demo runs the refund presets with idempotency on and off. It writes paired `*.trace.json` and `*.langchain.jsonl` examples under `out\`; it does not run M6 or M7. Generated outputs are ignored by Git.

## Workflows and Replay

Choose a scenario while idle, then select **Start**. The refund scenarios are **healthy** and **timeout + retry**; M6 scenarios are **M6 healthy** and **M6 fault**. M6 submits refund, document, and CRM jobs to a bounded queue and worker pool that contend for one shared resource. The fault scenario injects a temporary resource failure and recovery.

M7 adds **M7 chaos naive** and **M7 chaos resilient**. Both schedule ten tenants: Brightwater Health, Halvorsen Logistics, Cobalt Freight, Dunmore Capital, Eastgate Retail, Acme, Nexus, Apex, Omni, and Vortex. The fixed acceptance incidents simulate pool starvation, payment `ECONNRESET`, child-process `SIGSEGV`/exit 139, downstream saga failure, and Eastgate's 50-item batch with invalid UTF-8 item 27. Naive mode demonstrates failures; resilient mode uses short DB leases, stable payment keys, child-worker containment, batch unrolling, and LIFO compensation. These are logical simulated outcomes only; the Node process, network, payment systems, and cloud are never crashed or contacted.

M7 snapshot gauges are current active connections and waiters. Counters are cumulative events/outcomes (timeouts, crashes, duplicate dollars, orphaned instances, tokens, batch results, and compensation results). DB hold time and occupied-connection time are virtual milliseconds. Pool utilization is calculated as active-connection virtual milliseconds divided by capacity times the recorded measurement window; it is not a preset percentage. Workflow states are `queued`, `running`, `completed`, `completed_with_item_failures`, `compensated`, `failed`, or `host_unavailable`.

The refund simulator defaults to seed `1`; M6 and M7 default to seed `7`. M7's default run ID is `chaos-run-7`. **Reset** rebuilds the scheduler and workflow state and returns to idle while preserving the selected scenario configuration. Starting again with the same scenario, run ID, and seed reproduces the same events and final state. The UI uses the default M7 seed/run ID; the API accepts explicit `seed` and `runId` during configuration.

To run M7 in the UI, start the server with `npm run serve`, choose **M7 chaos naive** or **M7 chaos resilient**, then select **Start**. To configure through the local API (include the exact local Origin):

```powershell
$Origin = 'http://127.0.0.1:8787'
$Headers = @{ Origin = $Origin }
$Body = '{"op":"configure","scenario":"chaos","mode":"resilient","seed":7,"runId":"chaos-demo-7"}'
Invoke-RestMethod -Method Post -Uri "$Origin/api/op" -Headers $Headers -ContentType 'application/json' -Body $Body
Invoke-RestMethod -Method Post -Uri "$Origin/api/op" -Headers $Headers -ContentType 'application/json' -Body '{"op":"start"}'
Invoke-RestMethod -Method Get -Uri "$Origin/api/state" -Headers $Headers
```

| Control | Engine action |
|---|---|
| Scenario select, idempotency checkbox | `configure` (only while idle) |
| Start | schedule the scenario and begin autoplay |
| Play / Pause | start / stop autoplay (wall-clock pacing only; virtual time is independent) |
| Step | execute exactly the next scheduled event |
| Advance 500 ms | run all events due in the next 500 virtual ms |
| Stop | refund scenarios only; lifecycle becomes `stopped` and pending events are dropped. Disabled for M6 and M7 because those scenario APIs do not implement Stop. |
| Reset | discard simulator state, rebuild fresh workflow/kernel state, and return to idle; same scenario/seed replays identically |
| Export trace JSON | downloads `sim-trace/0` for the current refund, M6, or M7 run |
| Export for auditor (JSONL) | refund traces only; disabled in M6 and M7 |

Topology nodes come from the services the kernel registered; edges appear only once a call between two services actually happened. The timeline and workflow tables are live server state, not precomputed.

## HTTP interface (local only)

| Route | Notes |
|---|---|
| `GET /` | the page (single inline HTML, strict CSP with hashes, no external resources) |
| `GET /api/state` | model-specific state: lifecycle, virtual time, services, bounded events, and refund/M6/M7 snapshot data |
| `GET /api/trace` | current trace as `sim-trace/0` |
| `GET /api/auditor-export` | refund JSONL only; 409 before any trace exists and for unsupported M6/M7 traces |
| `POST /api/op` | `{ "op": ... }`; ops: `configure`, `start`, `play`, `pause`, `step`, `advance`, `stop` (refund only), `reset`. M7 configure allows only `scenario`, `mode`, `seed`, and `runId` in addition to `op`/preset fields. |

Everything else: 404/405. The server never reads files per request and runs no commands.

Security boundary verified by server tests: binds to loopback only; validates request `Host` against its own loopback host/port; requires an exact local `Origin` and JSON content type on POST; sends no CORS headers; caps request bodies at 2048 bytes; strictly parses JSON objects and whitelists operation fields. The page uses a hash-based CSP and no external resources. The server serves only its inline page/API and does not read arbitrary files or run commands. Non-browser clients must send a matching `Origin` header on POST (e.g. `curl -H "Origin: http://127.0.0.1:8787" -H "Content-Type: application/json" -d '{"op":"step"}' http://127.0.0.1:8787/api/op`).

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Cannot find module 'node:sqlite'` or `Unknown file extension ".ts"` | Node too old. Install Node 22.18+. |
| `ExperimentalWarning: SQLite is an experimental feature` | Expected on Node 22; harmless. Silence: `node --no-warnings src/main.ts`. |
| `EADDRINUSE` | Port taken. `$env:SIM_PORT="9000"` and relaunch. |
| `refusing to bind non-loopback host` | Intentional. Only 127.0.0.1 / localhost / ::1 are allowed. |
| Browser shows `host not allowed` | Use exactly the URL printed at startup (`127.0.0.1` or `localhost` with the same port). |
| `origin not allowed` from a script | Add `Origin: http://127.0.0.1:<port>` to POST requests. |
| `npm test` finds no tests on old npm/shell | Run `node --test "test/**/*.test.ts"` directly. |
| `npm run typecheck` cannot find node types | `npm ci` (needs registry access once if locked dev dependencies are not cached). |
| UI shows `ENGINE ERROR: event limit ...` | Limit hit by design; press Reset. |

## Auditor Compatibility

The simulator exports refund traces as `sim-to-langchain-callback-jsonl/1`. The `resilient-agent-invariants` CLI accepts this JSONL through its `.jsonl` input adapter, which maps observed `tool_start` side effects and idempotency keys into its existing trace rule model. It reports `idempotency-guard` findings, not the previously documented r04 schema; each unkeyed mutating attempt is reported. M6 and M7 traces remain unsupported by the refund exporter.

The live integration test was run against `G:\guthubs\resilient-agent-invariants`; it passed after adding the JSONL adapter there. No r04-specific finding/status contract is claimed.

To run the live integration test against that checkout:

```powershell
Set-Location 'G:\fuckmoey\enterprise-simulator'
$env:SIM_AUDITOR_REPO = 'G:\guthubs\resilient-agent-invariants'
npm test
Remove-Item Env:SIM_AUDITOR_REPO
```

The demo writes refund examples named `healthy-idem-on`, `healthy-idem-off`, `timeout-idem-on`, and `timeout-idem-off` under `out\`, each with `.langchain.jsonl` and `.trace.json` extensions. UI auditor export is supported for refund traces only. M6 traces are rejected as unsupported; `sim-trace/0` export remains available for both models. The default test run, without `SIM_AUDITOR_REPO`, skips the external integration.

### Export Mapping (Locally Tested)

- Each payment attempt becomes a `tool_call` with `side_effect: "POST"`, a `body_hash` of the request body, and `retry_count`/`attempt_of` only for real retries.
- `idempotency_key` is the key the simulated client actually sent; `null` means it sent none (policy off). Never guessed.
- A timed-out attempt exports an `error` and **no** output, so the server-side refund id is not leaked into what the client observed.
- DB writes and the server-side duplicate are not exported (only client-observed calls are).
- Timestamps are virtual ms on a synthetic 2026-01-01 epoch; every line's `metadata.source` says SIMULATED.

### Limitation: replay semantics

The auditor's current generic idempotency rule flags every unkeyed mutating call, including a replay of a completed request. It does not distinguish retries from post-success replays or prove that a duplicate refund occurred; the simulator exporter retains retry linkage only for actual retries and does not overstate that evidence.

### Known limitations: what the exporter does not cover

- **Refund traces only.** The exporter maps `refund.request`, `account.lookup`, and `payment.attempt` spans. M6 shared-enterprise traces (queue/worker/resource/dead-letter events) have no `orderId`, `amountCents`, or payment attempts, so there is nothing observed to map. `exportLangChainJsonl` throws `UnsupportedTraceError` for them instead of emitting invented fields. `GET /api/auditor-export` must not be offered for M6 runs; `GET /api/trace` (`sim-trace/0`) remains available.
- **No M6 invariant signals.** Queue overflow, worker crash, retry exhaustion, and dead-letter counts are simulator facts, not auditor rules; none are exported as findings.
- **Unfinished refund spans.** If a refund run is stopped mid-flight, an unfinished `account.lookup` or `payment.attempt` is still exported with a `tool_end` at its start time and no output or error, and the root `chain_end` uses the last observed virtual time. Export completed refund runs for auditing.

## Layout

```
src/kernel.ts   virtual clock, seeded RNG, scheduler, bounded log, registry
src/refund.ts   refund workflow, mock services, SQLite, config validation
src/enterprise.ts M6 queue, workers, retry/dead-letter, shared-resource workflows
src/trace.ts    sim-trace/0 exporter
src/auditor-export.ts  sim-trace/0 -> auditor langchain-callback-jsonl
src/server.ts   node:http server + security boundary
src/ui.ts       inline page
src/main.ts     launcher     src/demo.ts  CLI demo
test/           node:test suites (kernel/refund/trace, M6, server, auditor export)
```
