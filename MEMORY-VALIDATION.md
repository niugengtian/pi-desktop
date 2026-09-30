# Memory delivery candidate validation

This is a development candidate until the complete gate and packaged runtime
probes pass. The formal application has not yet been replaced. No real user
transcript, credential, browser cookie, or downloaded model is committed.

## Recorded checks

- Desktop memory/Ollama/UI-state targeted suite: 49 passed.
- ChatGPT/DeepSeek adapter suites: 275 passed. Regression fixtures cover rendered
  line breaks, block boundaries, decorative ellipsis, and recovery-only behavior.
- Same-page read-only investigation found the existing completed ChatGPT reply.
  The old extractor joined line/block boundaries; the corrected extractor
  associated the existing reply. No original question was resent or refreshed.
  This is not an installed Desktop end-to-end acceptance result.
- Page Provider targeted suite: 49 passed against a fake bridge.
- SDK packaging fix `a8cc21e` integrated as `55b84b3`; 9 related tests passed.
  Existing node-pty dependencies were retained when resolving the cherry-pick.
- Final isolated memory E2E passed: local Ollama, hot/warm Markdown, exact Desktop
  approval, real Page Provider registration against a fake bridge, Host restart
  with unchanged cursor, source search/open, and manual edit preservation.
  Evidence: `/tmp/pi-memory-sdk-integrated-e2e.log`, `MEMORY_E2E_EXIT=0`.
- Test-runner/terminal targeted regression: 17 passed. File workers are bounded;
  the rate-limit fixture uses a controlled clock without relaxing assertions.
- Memory test process lifecycle: 5 passed. The aggregate budget covers all bounded
  inference stages; timeout waits for child close before profile cleanup.
- The latest complete quality gate is pending. Earlier failure evidence remains:
  file-watch smoke timeout, and an oversubscribed terminal startup/rate fixture.
  Independent file-watch smoke passed; no production watcher behavior changed.

## Packaging and installation acceptance

Keep the beforePack dependency-closure restoration and afterPack archive-only
resolution/version checks. Build the complete application, not the minimal SDK
packaging fixture. Independently import root and nested model adapters from its
ASAR and invoke the existing local model. Then verify signatures and perform a
backed-up, atomic desktop/provider/adapter replacement with rollback.

Opt-in Ollama startup never installs/downloads models and cleans only app-owned
process groups. Recovery requires a bound conversation and capable adapter;
missing or ambiguous replies refuse resubmission.

QMD remains optional and deferred. Ego Lite shared-space alignment is follow-up.
