import { createHash } from "node:crypto";
import type { Trace } from "./trace.ts";

// Exporter: sim-trace/0 -> callback JSONL. The auditor CLI accepts this format
// through its .jsonl adapter, which maps observed tool_start mutations and keys
// into its existing trace idempotency rule.
export const AUDITOR_EXPORT_VERSION = "sim-to-langchain-callback-jsonl/1";

// Thrown when a trace is not a refund trace; callers should map it to a 4xx, not a 500.
export class UnsupportedTraceError extends Error {
  readonly code = "unsupported_trace";
}

// Virtual ms are mapped onto a fixed synthetic epoch. These are NOT wall-clock times.
const EPOCH_MS = Date.UTC(2026, 0, 1);
const iso = (virtualMs: number) => new Date(EPOCH_MS + virtualMs).toISOString();

// Same canonical form the auditor uses for hashes: sorted keys, "sha256:<hex>".
function canon(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canon(o[k])}`).join(",")}}`;
}
const sha = (v: unknown) => `sha256:${createHash("sha256").update(canon(v)).digest("hex")}`;

interface Line {
  t: number;
  order: number;
  rec: Record<string, unknown>;
}

export function exportLangChainJsonl(trace: Trace): string {
  const lines: Line[] = [];
  let order = 0;
  const push = (t: number, rec: Record<string, unknown>) => lines.push({ t, order: order++, rec });
  const source = `${AUDITOR_EXPORT_VERSION}; SIMULATED run (enterprise-simulator); timestamps are virtual ms offset from 2026-01-01T00:00:00Z; not real infrastructure`;
  const meta = (ids?: string[]) => ({ source, ...(ids ? { source_event_ids: ids } : {}) });

  const root = trace.spans.find((s) => s.parentSpanId === null);
  if (!root) throw new UnsupportedTraceError("trace has no root span");
  if (root.name !== "refund.request") throw new UnsupportedTraceError(`unsupported trace: root span must be refund.request, got ${root.name}`);
  if (root.attrs.orderId === undefined || root.attrs.amountCents === undefined) {
    throw new UnsupportedTraceError("unsupported trace: refund.request is missing orderId or amountCents");
  }
  const orderId = String(root.attrs.orderId);
  const amountCents = root.attrs.amountCents;
  const finalState = [...root.events].reverse().find((e) => e.name === "state.transition")?.attrs.to;

  push(root.startMs, { event_id: `${root.spanId}:start`, event: "chain_start", run_id: root.spanId, name: root.name, input: { orderId, amountCents }, start_time: iso(root.startMs), metadata: meta() });
  push(root.endMs, { event_id: `${root.spanId}:end`, event: "chain_end", run_id: root.spanId, output: { final_state: finalState ?? null }, end_time: iso(root.endMs), metadata: meta([`${root.spanId}:start`]) });

  for (const s of trace.spans) {
    if (s.name === "account.lookup") {
      push(s.startMs, { event_id: `${s.spanId}:start`, event: "tool_start", run_id: s.spanId, parent_run_id: root.spanId, name: s.name, resource: "mock://account/lookup", input: { orderId }, start_time: iso(s.startMs), metadata: meta() });
      push(s.endMs, { event_id: `${s.spanId}:end`, event: "tool_end", run_id: s.spanId, parent_run_id: root.spanId, ...(s.status === "ok" ? { output: { eligible: s.attrs.eligible ?? null } } : {}), end_time: iso(s.endMs), metadata: meta([`${s.spanId}:start`]) });
    } else if (s.name === "payment.attempt") {
      const attempt = Number(s.attrs.attempt);
      const kind = String(s.attrs.kind);
      const body = { orderId, amountCents };
      const retryOf = s.links.find((l) => l.type === "retry_of")?.spanId;
      const key = s.attrs.key; // string, or null when the simulated client sent no key
      const start: Record<string, unknown> = {
        event_id: `${s.spanId}:start`,
        event: "tool_start",
        run_id: s.spanId,
        parent_run_id: root.spanId,
        name: "payment.refund.create",
        resource: "mock://payment/refunds",
        side_effect: "POST",
        body_hash: sha(body),
        input: body,
        idempotency_key: key === null || key === undefined ? null : String(key),
        start_time: iso(s.startMs),
        metadata: meta(),
      };
      // Retry evidence only for real retries; a post-success replay is NOT claimed to be a retry.
      if (kind !== "replay") start.retry_count = attempt - 1;
      if (retryOf) start.attempt_of = retryOf;
      push(s.startMs, start);
      const end: Record<string, unknown> = { event_id: `${s.spanId}:end`, event: "tool_end", run_id: s.spanId, parent_run_id: root.spanId, end_time: iso(s.endMs), metadata: meta([`${s.spanId}:start`]) };
      if (s.status === "timeout") end.error = `client timeout after ${s.endMs - s.startMs} virtual ms`;
      else if (s.status === "ok") end.output = { refund_id: s.attrs.refundId ?? null, result: s.attrs.serverResult ?? null };
      push(s.endMs, end);
    }
  }

  lines.sort((a, b) => a.t - b.t || a.order - b.order);
  return lines.map((l) => JSON.stringify(l.rec)).join("\n") + "\n";
}
