import { mkdirSync, writeFileSync } from "node:fs";
import { PRESETS, RefundScenario } from "./refund.ts";
import { exportTrace } from "./trace.ts";
import { exportLangChainJsonl } from "./auditor-export.ts";

mkdirSync("out", { recursive: true });
for (const [name, preset] of Object.entries(PRESETS)) {
  for (const idempotency of [true, false]) {
    const s = new RefundScenario({ ...preset, idempotency });
    s.start();
    s.run();
    const snap = s.snapshot();
    const label = `${name}-idem-${idempotency ? "on" : "off"}`;
    const trace = exportTrace(s.sim.log, `sim-${s.cfg.seed}-${s.cfg.orderId}`, snap.derived);
    writeFileSync(`out/${label}.trace.json`, JSON.stringify(trace, null, 2));
    writeFileSync(`out/${label}.langchain.jsonl`, exportLangChainJsonl(trace));
    console.log(label.padEnd(22), snap.life, snap.refundState, `refunds=${snap.refunds.length}`, `dupes=${snap.derived.duplicateRefunds}`, `events=${s.sim.log.length}`, `t=${snap.now}ms`);
    s.reset();
  }
}
