# Memory delivery development snapshot

This branch is a development candidate, not an installed or release-ready build.
No raw user session, credential, browser cookie or downloaded model is included.

## Recorded checks before this snapshot

- 51 targeted tests passed: branch/cold provenance, incremental resume,
  request-boundary aborts, source-only cursors, repeated paragraphs and 30
  model switches without prompt growth.
- Fictional Electron/Agent Host memory E2E passed, including local Ollama,
  hot/warm Markdown, exact preview, real Page Provider registration against a
  fake bridge, Host restart without rewriting unchanged memory, and edit
  protection. Log: `/tmp/pi-memory-page-e2e-diagnostic.log` on the development host.
- Companion Page Provider: 46 tests passed, including process-local receipts
  and fake-bridge integration.
- Companion ChatGPT adapter: 133 DOM/unit tests passed. These are candidate
  fixes, not proof of the user's original live-web failure being resolved.
- Repository quality gate: unit suite had 1,492 tests (1,489 passed, 3 skipped)
  and preceding static/build/integration stages passed, but **Browser real Agent
  E2E failed at read-authorization preflight**. Do not bypass this release gate.

## Remaining work for this delivery

1. Diagnose the Browser Agent E2E regression, rerun the complete quality gate.
2. Add opt-in, loopback-only Ollama startup that reuses external services, never
   downloads models, and cleans up only app-owned processes.
3. Build, sign and probe a candidate; deploy companion provider/adapter updates
   with backups and install the desktop through the external rollback-safe path.
4. Confirm the same browser/page with the user for live result recovery. Do not
   resend an existing user request, infer live acceptance from a fake bridge,
   or claim the original pending-desktop incident is fixed without evidence.

QMD remains optional and deferred: local keyword search is the current baseline.
Ego Lite shared-space alignment is a follow-up, not part of this delivery.
