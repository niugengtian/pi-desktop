# TIER-04: Codex wire budget and isolated GUI comparison — 2026-10-01

## Status and scope

Follow-up 2026-10-02: see [TIERED-DIALOG-VALIDATION.md](TIERED-DIALOG-VALIDATION.md) for the reproduced offscreen/non-modal approval defect, installed Renderer fix and new durable evidence. This report's `/tmp` directory no longer exists; hashes/results below describe the historical TIER-04 run, not the latest package.

Independent `feat/tiered-context-compare`, following `66d84d2`. Standard **openai-codex-responses** is now handled by the opt-in budget controller, NOT arbitrary Responses/native/custom providers. Production app/configuration/rollback/Web were not changed. No dependencies/models downloaded, no real conversation or auth file copied.

`/Applications/Pi Agent Desktop Tier Compare.app` is an installed **arm64, ad-hoc signed, machine-specific comparison application**, not the production entry or a portable/notarized release. It uses a generated isolation entry, independent appId/HOME/userData/logs/cwd, and an in-process **127.0.0.1** fictional Codex fixture. Its two model names explicitly state that they are NOT real Sol/models. Synthetic SSE usage numbers are not real token measurement/billing.

**Still pending:** actual Sol provider/authentication acceptance, real Flash invocation/output quality, human final evidence review, cancellation/epoch/late-result GUI acceptance. Real GUI coverage below does not imply all those have passed. Flash source permission has NOT been approved; no real DeepSeek request occurred in this round.

## Codex boundaries

- Inspect actual Codex input/instructions/tools; convert only to a local budget-inspection view, never send that synthetic Completions view. Group contiguous simultaneous function/custom calls as one protected batch. Unsupported media/references/server-side state/unknown fields refuse, never slice.
- SDK Codex does not send an output cap. Reserve **the complete catalog maxTokens**, rather than falsely claiming a 2048-token enforced output cap. This can reject small-window models.
- Bind opaque reasoning items to canonical native thinking signatures by complete item hash. Reserve prior provider-reported output + reasoning per replay item; encrypted/base64 bytes are **not** text tokens. Unknown/missing/duplicate/unsafe usage refuses. This is a provider-output-derived reservation, NOT a calibrated tokenizer or proven replay-input upper bound. Output may already include reasoning, so summing can overreserve.
- Count opaque reservation in native scheduler hints, latest protected span, total and hot estimates. Existing byte-BPE/provider-framing limitations remain; this is fail-closed against the stated **estimated** policy, not proof of actual model input limits.
- Enabled requests use SSE, zero provider/session retries, no WebSocket/fallback/cache-warming attempts. OFF preserves the native path. Normal credential handling remains SDK-owned; fake auth in controlled tests is not actual OAuth-refresh validation.
- After final onPayload, inspect **actual serialized plain/zstd body** against its detached approved JSON and exact model-derived URL; only chatgpt.com or explicitly isolated loopback fixture targets, no userinfo/query/fragment. Recheck grant/generation/source before one POST; redirects error. No auth headers retained.

## Flash scope clarification

Incremental extraction organizes visible task text/completed tool evidence, not hidden reasoning. Each record declares omittedReasoning; native warm metadata records visible-task-only deltaScope. Source preview states that reasoning/signatures stay in authoritative cold history and leave active replay only after approved compaction. This is NOT reasoning-preserving or semantically lossless compression. Quotes/facts remain mandatory-human-review, semanticCompleteness not-proven.

Comparison-only SDK credential reuse is a path reference behind the existing memory-test flag, only used after source approval. Neither the main fictional runtime nor sandbox contains a copy of real credentials. New optional audit emits target/wire hash/status/reported usage only, no headers/key/source body, and is enabled only by the generated isolation environment.

## Focused checks

- **79/79**, 0 failed: TIER-04 adds 9 checks to TIER-03's 70 (5 Codex contract, 3 SDK Codex paths, 1 visible-only scope). Log `/tmp/pi-tiered04-final-check.log`.
- Actual SDK/marshaller + loopback: Codex A→B→A with opaque replay, catalog output reserve and zstd serialization; oversized final transform zero model HTTP; two actual synthetic tool callbacks execute and both tool results remain native, oversized continuation/summary zero dispatch.
- Pure contracts: whole parallel chains, unsupported/server-side/changed output fields, unknown encrypted items, actual plain/zstd endpoint/body mismatch refusal. SDK callbacks use fictional credentials; no actual Sol/Flash request.
- Local ESLint/Prettier, final Host typecheck, unchanged Renderer typecheck, offline Main/Preload/Agent Host/Renderer build passed. No full-suite verify. Existing MODULE_TYPELESS_PACKAGE_JSON/plugin-worker unused-import/large renderer warnings remain.

## Real Electron GUI evidence (fictional session only)

Session `01a0f738-5672-75ed-ab61-bc6ed10f4531`, cwd and data beneath `~/Library/Application Support/Pi Agent Desktop Tier Compare/`. Native source was generated using SessionManager, not copied from user history. Ego-browser cannot attach its task-space API to the installed Electron renderer; this acceptance used the candidate's own **127.0.0.1:9227 CDP**, not a substitute browser.

1. GUI Custom path selected the isolated project; the seeded native session opened. GUI local-workspace/budget confirmations exercised the real RPC UI path. Flash selection visibly said **NOT authorized**.
2. A real source dialog contained full SYSTEM/USER, official target, cold/reasoning exclusions and no-tools/no-retry conditions. Cancel clicked: **0 Flash dispatches, 0 compactions**, original hot stayed; one ordinary fictional main request was allowed. No selected-model summary fallback or later automatic summary retry.
3. Same native session switched to 4096-window B; real GUI showed preflight-envelope-reservation and **0 B dispatches**. Returned to A: one ordinary request. Pending local relay bindings kept remoteBinding:null, not actual Web handoff.
4. Full cold bytes equal latest native JSONL, facts still empty before promotion, 0700 directory/0600 files; 0 compactions. Local/handoff views do not become authority.
5. Explicit manual Compact opens the next full source approval. The agent did NOT click Confirm. Full source and actual SDK locally-marshalled payload were captured for user approval. That marshalling used fictional auth and aborted before fetch: **0 requests**.

Evidence: `/tmp/pi-tiered04-desktop-validation/{source-denied-result.json,model-round-result.json,storage-proof.json,real-source-preview.txt,real-source-preview.png,real-flash-payload-preview.json}`. Runtime fictional wire log and optional Flash audit live in the private comparison data root.

GUI/model HTTP total so far: **3 fictional A requests**, 0 B, 0 real Sol, 0 real Flash. One A request was an unexpected slash-command text with a trailing yen glyph during an earlier input/rAF run; it is retained, not erased or counted as a command success. Subsequent automation checks controlled textarea value before Send and uses observed readiness rather than background-paused rAF. A model-menu action before idle was ignored; only the unfinished A return was resumed, not the B turn resent. Failed assertion/selector/timeout runs were not acceptance successes.

## Packaging/isolation failures and correction

First package attempt failed because npm was absent from PATH; corrected to the existing Node/npm toolchain with npm offline, no install/download. Local tools/herdr artifacts were APFS-copied from the verified baseline.

First GUI candidate's old memory-test bootstrap indexed userData/sessions while the SDK wrote agent/sessions: empty list, not a pass. Generated comparison entry aligns index/watcher to SDK agent/sessions **after Main's old override and before ready/worker start**. No production Main source change. Initial native seed moved to SDK's encoded-cwd directory, not duplicated. That first comparison app quit normally; only the separate comparison bundle was atomically exchanged after exact native process-path/hash checks. Old comparison bundle retained; formal application never exchanged/stopped.

Final package preserves **171 runtime packages**, offline afterPack dependency closure and deep strict ad-hoc signature verified. ASAR:

- comparison: `292714030b0f75fe89dc74eacbadf83a9dadc91b1b954254fbedf22e3f3c9621`
- unchanged formal: `f02e50f06b9d0382443e986d4449c971df290d1490c96c71855632f736881825`

## Exact real-Flash approval boundary

Preview sourceHash `d3186466209e628787a520c3c1151122c9eba50f5f3330efa22f1b3e29fabcc7`: exactly two original fictional records, squirrel-captain plans/book order + fictional acknowledgement. Background sentence repeated 100 times; no real history/system/protocol/previous warm/reasoning/tools. Actual SDK local payload preview is **11039 UTF-8 bytes**, NOT 11039 tokens, max_tokens 2048, thinking disabled. Final transport revalidates the content/flags/target; only a fresh matching source approval permits one dispatch to api.deepseek.com. Desktop/OS proxy may route overseas; supplier retention/billing is not guaranteed by client flags/cancel.

Requesting completion/building/installing, LOCAL/budget permission or mock tests do not authorize this remote source. Source Confirm and final source/candidate omission review remain separate. Until user approves this payload, real Flash quality/commit/cancel GUI checks are blocked, not declared complete.
