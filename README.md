# Distributed Systems

A collection of projects for studying distributed systems.

## Enterprise Simulator

The deterministic refund workflow and enterprise queue simulator is in [`enterprise-simulator/`](enterprise-simulator/). It simulates its infrastructure locally and makes no external service calls at runtime.

Requirements: Node.js 22.18 or newer.

```powershell
Set-Location enterprise-simulator
npm ci
npm test
npm run typecheck
npm run serve
```

See [`enterprise-simulator/README.md`](enterprise-simulator/README.md) for scenarios, API details, and troubleshooting.
