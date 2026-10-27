import type { SimEvent } from "./kernel.ts";

// Standalone trace format ("sim-trace/0"). NOT the agent-runtime-invariants schema:
// that repo is not available here, so an adapter must be written against its real types.
export interface Span {
  spanId: string;
  parentSpanId: string | null;
  name: string;
  startMs: number; // virtual ms
  endMs: number;
  status: "ok" | "timeout" | "unfinished";
  attrs: Record<string, unknown>;
  links: Array<{ type: "retry_of"; spanId: string }>;
  events: Array<{ t: number; name: string; attrs: Record<string, unknown> }>;
}

export interface Trace {
  schema: "sim-trace/0";
  simulated: true;
  virtualTime: true;
  traceId: string;
  spans: Span[]; // observed facts only
  derived: Record<string, unknown>; // conclusions computed from state, kept separate
}

export function exportTrace(events: SimEvent[], traceId: string, derived: Record<string, unknown>): Trace {
  const byId = new Map(events.map((e) => [e.id, e]));
  const lastT = events.reduce((m, e) => Math.max(m, e.t), 0);
  const sid = (id: string) => `s-${id}`;

  // Walk causal parents up to the owning payment attempt.
  const attemptOf = (e: SimEvent): SimEvent | undefined => {
    for (let cur: SimEvent | undefined = e; cur; cur = cur.parent ? byId.get(cur.parent) : undefined) {
      if (cur.kind === "payment.attempt.sent") return cur;
    }
    return undefined;
  };
  const rootEv = events.find((e) => e.kind === "request.received");
  const rootId = rootEv ? sid(rootEv.id) : null;

  const spans: Span[] = [];
  for (const e of events) {
    const base = { spanId: sid(e.id), links: [] as Span["links"], events: [] as Span["events"] };
    if (e.kind === "request.received") {
      spans.push({
        ...base,
        parentSpanId: null,
        name: "refund.request",
        startMs: e.t,
        endMs: lastT,
        status: "ok",
        attrs: { corr: e.corr, ...e.data },
        events: events.filter((x) => x.kind === "state.transition").map((x) => ({ t: x.t, name: "state.transition", attrs: x.data })),
      });
    } else if (e.kind === "account.call") {
      const res = events.find((x) => x.kind === "account.result" && x.parent === e.id);
      spans.push({ ...base, parentSpanId: rootId, name: "account.lookup", startMs: e.t, endMs: res ? res.t : e.t, status: res ? "ok" : "unfinished", attrs: res ? { ...res.data } : {} });
    } else if (e.kind === "payment.attempt.sent") {
      const mine = events.filter((x) => attemptOf(x)?.id === e.id);
      const end = mine.find((x) => x.kind === "payment.response.received" || x.kind === "client.timeout");
      const late = mine.find((x) => x.kind === "payment.response.late_ignored");
      const server = mine.find((x) => x.kind === "payment.refund.created" || x.kind === "payment.idempotent_replay");
      const { retryOf, ...rest } = e.data as { retryOf?: string };
      const span: Span = {
        ...base,
        parentSpanId: rootId,
        name: "payment.attempt",
        startMs: e.t,
        endMs: end ? end.t : e.t,
        status: !end ? "unfinished" : end.kind === "client.timeout" ? "timeout" : "ok",
        attrs: {
          ...rest,
          ...(server ? { serverProcessedAtMs: server.t, serverResult: server.kind, refundId: server.data.refundId } : {}),
          ...(late ? { lateResponseAtMs: late.t } : {}),
        },
      };
      if (typeof retryOf === "string") span.links.push({ type: "retry_of", spanId: sid(retryOf) });
      spans.push(span);
    } else if (e.kind === "db.write") {
      const a = attemptOf(e);
      spans.push({ ...base, parentSpanId: a ? sid(a.id) : rootId, name: `db.${String(e.data.table)}.${String(e.data.op)}`, startMs: e.t, endMs: e.t, status: "ok", attrs: { ...e.data } });
    }
  }
  return { schema: "sim-trace/0", simulated: true, virtualTime: true, traceId, spans, derived };
}
