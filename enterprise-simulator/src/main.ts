import { startServer } from "./server.ts";

const host = process.env.SIM_HOST ?? "127.0.0.1";
const port = Number(process.env.SIM_PORT ?? 8787);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`invalid SIM_PORT: ${process.env.SIM_PORT}`);
  process.exit(1);
}
try {
  const s = await startServer({ host, port });
  console.log(`enterprise-simulator listening on ${s.url} (simulated infrastructure only). Ctrl+C to stop.`);
  const down = () => void s.close().then(() => process.exit(0));
  process.on("SIGINT", down);
  process.on("SIGTERM", down);
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
