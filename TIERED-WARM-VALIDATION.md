# TIER-03 — reviewed incremental Flash warm prototype

## Scope

On independent `feat/tiered-context-compare`, following `6fb43c9`. Default OFF. No installed app/config/rollback/Web changes, downloads, real histories/auth copies, or real Flash requests in this stage. Formal ASAR remains `f02e50f06b9d0382443e986d4449c971df290d1490c96c71855632f736881825`.

This is SDK/native-range wiring and **extractive quotation facts**, NOT an autonomous semantic task-state database or accepted real-Flash quality benchmark. Codex/Responses/Sol remain unsupported by the opted-in budget prototype. Still no packaged comparison `.app` or Electron GUI acceptance.

## One owner, exact incremental source

- The same budget controller owns `session_before_compact`; Flash replaces ONLY the native prepared summary operation, not session/projection/cut selection.
- `buildWarmPlan()` maps canonical projected contributions up to the native cut to entry/message IDs and SHA256 fingerprints. Its flattened messages must exactly equal SDK `messagesToSummarize + turnPrefixMessages`. Ambiguous/corrupt ranges refuse.
- Only this newly covered delta goes to Flash. Previous structured facts are merged locally; previous opaque native summary is preserved locally unchanged. Neither old warm text nor already-covered cold history is sent again.
- Complete tool-call/result batches can be reviewed. Pending/orphan tools, unsupported roles, images/reasoning blocks, overlarge source or corrupt previous fact metadata refuse, never truncate. This intentionally avoids SDK `serializeConversation()`'s tool-result truncation.
- The prepared plan is recursively frozen. Native source file/branch/session/generation/cut checks remain in place. Settings consent epoch is also bound across preview/request/result/append; close-and-restore same settings bytes cannot revive a pending approved attempt.

## Permission and dispatch

`/tiered-warm-flash` requires an already approved budget, idle UI and a registered processor. It **selects**, does not authorize or send. `/tiered-warm-native` explicitly restores native selected-model summaries and cancels an in-flight compaction; it is not an error fallback. Budget disable/navigation/replacement/shutdown revoke selection; model switches cancel the old attempt.

Every native prepared attempt needs TWO distinct reviews:

1. Full exact SYSTEM/USER source preview and fixed official target, no automatic redaction; only that one payload is approved for dispatch. Text/tool data is explicitly included, unlike the older text-only task-memory grant. Local export, budget, task-memory and website permissions are not inherited.
2. After structural validation, full candidate + source omission review BEFORE context promotion. Decline or stale identity cancels native compaction and retains original hot. Tests simulate these UI answers; no actual Electron/human semantic review has been observed yet.

`createFlashWarmRunner()` reuses public `ModelRuntime.completeSimple`; authentication stays inside SDK. It only accepts standard `deepseek/deepseek-flash`, `openai-completions`, exact `https://api.deepseek.com`. Custom stream/native-provider overrides are refused. Thinking OFF, output ≤2048, no tools, cache writes, retries, probes, redirect or alternative endpoint. Both payload callback and FINAL serialized fetch JSON verify model/off/no reasoning_effort/two exact messages/output/window. Provider/auth diagnostics are sanitized. Model lookup errors are inside the sanitizer too.

Transport injection is for isolated mock tests only; production RPC passes the SDK runtime and ordinary fetch, never a loopback fallback. Actual routing/proxy is Desktop/OS-controlled, not promised mainland/local-only. Already-dispatched cancellation/epoch invalidation does not prove provider stopped computing/billing, and epoch checks do not promise immediate abort on every external settings-file change.

An explicit Flash selection prohibits native summary stream dispatch if an extension error were to fail open. The native append guard also requires the EXACT reviewed candidate/details and `fromHook`, preventing a substituted fallback candidate. All caught source/processor/quality errors return cancellation, not undefined/default-summary fallback. Failed attempts latch automatic compaction paused; later ordinary turns are not implicit retry approval. If retained original hot still fits, the already-authorized ordinary main request may continue; that is NOT a summary fallback.

## Fact contract and honest limits

Output is strict JSON `{sourceHash, facts:[{sourceId, quote}]}`. Facts must reference the exact delta and quote contiguous literal text, in source/quote order. Every nonempty record needs evidence. Distinct numeric tokens are checked lexically (not `"1"` substring in `"17"`); book/backtick names and selected explicit negation/plan phrases must remain. Role/tool-error labels are derived locally, not inferred by Flash. No paraphrasing, tool execution, invented completion/risk/advice or inferred round counts are admitted as new prose.

These checks **do not prove semantic completeness**, arbitrary proper-name/order preservation or contradiction resolution. Numeric/negative phrase guards are intentionally narrow. Human omission review is mandatory, `semanticCompleteness: not-proven`; accepted records are `human-approved-not-proven`, not lossless. This stage does not produce goal/decision/current-status schemas or automatically supersede old quotations. If source/draft/budget cannot fit, refuse and keep source rather than silently prune facts.

Facts/version/parent/source/delta/review data live in the ONE authoritative native `CompactionEntry.details.tieredWarm`. The main warm summary is rendered deterministically from prior opaque text plus cumulative quoted evidence. No Markdown file is a second editable authority and no agents.md rules are promoted into system. Native file-operation metadata is carried locally, not represented as newly executed tool work.

Workspace export now derives `warm/facts.jsonl` from recognized reviewed native records; unrecognized ordinary native compactions still have empty facts/not-extracted. Manifest identifies processor/version and `human-reviewed-extractive-not-lossless`. Existing file permissions, manual-edit/source/lock safeguards are unchanged.

Bounds: source 12000 characters (NOT tokens), response 6000 characters, rendered summary 4000 characters plus TIER-02 warm-envelope guard, ≤128 delta records / ≤80 cumulative facts / ≤128 tracked file paths. No destructive overflow cleanup. Sources/quotes/file lists can hit these limits; long-term compaction/reduction remains future work. Provider token framing is still a conservative, uncalibrated estimate, not exact counting.

## Observed acceptance

**70/70 focused checks passed**: 11 new (4 real-SDK integration cases, 5 native-preparation/contract cases, 2 remote-dispatch guards) plus 59 prior related checks. `/tmp/pi-tiered03-final-check.log`. No full suite.

- Real SDK services/session + ordinary loopback HTTP main provider; separate real SDK DeepSeek marshaller with transport replaced by an in-memory SSE Response. Official-shaped serialized JSON is captured, but **zero real DeepSeek HTTP**. No global fetch replacement in the new tests.
- First approved delta: one mocked Flash dispatch + one ordinary main request, no selected-model summary. Native compaction is `fromHook`, main model stays A, raw native history prefix unchanged. Workspace fact export reflects the native record.
- Second explicit native compaction: only new delta sent, no older fact/raw source/previous summary resend; local facts retained in version 2.
- Source refusal: zero mocked Flash dispatch. Malformed/empty facts or promotion-review refusal: one attempted mock, no compaction append, no native summary fallback, no automatic repeat on later normal input.
- Model switch while mock transport is held: no late compaction or small-window B request. Consent epoch changes without branch/model change likewise reject the old warm candidate.
- Complete synthetic tool batch includes error provenance and local file-operation metadata; pending tools/media refuse instead of source truncation. Foreign citation/hash, missing record/number/title, invention, reordered quotes, altered prepared range and overlarge source refuse.
- Wrong domain/userinfo/query, post-callback serialized thinking/tool/reasoning/message/output changes, custom provider, revoked results and duplicate dispatch are blocked. Fake provider key-error strings are not exposed.
- Default OFF still has complete wire equality to native A→B→A; prior local workspace/background/Flash cancellation/consent regressions remain passing.

Local ESLint/Prettier/diff, Host/Renderer TypeScript and offline Main/Preload/Agent Host build passed. Existing Node MODULE_TYPELESS_PACKAGE_JSON and plugin-worker unused-import warnings remain.

## Failures corrected, not counted as passes

- Pure fixture `keepRecentTokens=20` accidentally selected a split old span; assumptions of two delta records then failed. Fixture now calculates the native latest-span hint via SDK estimateTokens, keeping the exact intended boundary; production still uses native preparation, not a custom slicer.
- Node Response existed at runtime but project ESLint globals rejected bare `Response`; fixture uses `globalThis.Response`.
- Host TypeScript initially rejected a cyclic inferred type through controller→services→memoryRuntime→runner closure. Explicit controller/ModelRuntime annotations broke the inference cycle; checks were rerun to actual exit 0. Node tests were not substituted for this acceptance.
- An initially non-unique exact-edit target was rejected by the edit tool; no file modification occurred until the unique import region was read and edited.

## Next

Independent isolated Electron comparison package and actual approval/cancellation/source/payload GUI acceptance; standard Codex/Responses budget guard before claiming main Sol usability. Real Flash synthetic quality request needs separately previewed payload authorization; real histories and Web sends remain separately gated. Cold incremental storage and structured state/contradiction reduction still pending. No production deployment from this report.
