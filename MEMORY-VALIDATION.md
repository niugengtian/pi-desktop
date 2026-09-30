# Memory delivery development snapshot

This branch is a development candidate, not an installed or release-ready build.
No raw user session, credential, browser cookie or downloaded model is included.

## Recorded checks

- Desktop memory/Ollama/UI-state targeted suite: 49 tests passed.
- Repository unit suite: 1,504 tests, 1,501 passed and 3 skipped.
- Browser Agent authorization E2E passed independently after the fictional
  provider's window was made consistent with the conservative unknown-usage
  budget. Permission checks were not weakened.
- Fictional Electron/Agent Host memory E2E passed before the latest recovery
  changes: local Ollama, hot/warm Markdown, exact preview, real Page Provider
  registration against a fake bridge, Host restart and manual edit protection.
- Companion Page Provider: 49 tests passed, including receipt propagation and
  recovery capability checks against a fake bridge.
- Companion ChatGPT/DeepSeek targeted adapters: 160 tests passed. This is not
  proof that the user's live pending-desktop incident has been resolved.
- Static checks, architecture, unit and build stages passed in the latest full
  gate, but Electron smoke timed out waiting for `files.changed`. The complete
  gate is therefore still **failed**, not release-ready.

## Implemented but not installed

Opt-in Ollama startup reuses a running loopback service, never installs/downloads
models, and tracks/cleans only app-owned process groups. Web retry intent survives
curated context through a one-shot receipt. `turn.recover` requires a bound remote
conversation and a capable adapter; missing/ambiguous replies refuse resubmission.

## Remaining work

1. Diagnose the file-watch smoke failure and rerun the complete quality gate.
2. Obtain same-page evidence for the live ChatGPT result-recovery failure without
   sending the original question again.
3. Rerun memory E2E against the final source, build/sign/probe a candidate, and
   install desktop/provider/adapter updates with backups and rollback.

QMD is optional and deferred; local keyword search is the current baseline.
Ego Lite shared-space alignment remains a follow-up.
