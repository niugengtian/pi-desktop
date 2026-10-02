# Unified Web context: implementation and blocked website acceptance

## Implemented

Based on `6bb09f1`, in isolated branch `fix/unified-web-tier-context`.
Three profiles (`chatgpt-web`, `deepseek-chat`, `deepseek-reasoner`) consume the same SDK-owned visible-context constructor: existing one warm plus every visible hot message in source order, IDs, model provenance and complete visible tool-call/result evidence. No separate cut/summary, recent-only slice, legacy checkpoint acknowledgment or silent truncation in this path.

Each complete immutable final text needs a new source approval. Every permitted turn opens a fresh website conversation (old ones are not deleted). Updated Page/adapter capability is mandatory; incompatible/partial contract options refuse, never downgrade to legacy. Media, pending tools, truncated linked tool output and non-fitting full context refuse. System/tool declarations, cold, thinking/signatures and human workspace files are not separately exported. Transcript itself can contain sensitive text: complete review is necessary; no automatic redaction/semantic completeness guarantee.

The real composer is read back exactly before a bidirectional bundled bridge asks the parent for one final synchronous permit. Source/grant/model/projection/signal and complete request are rechecked; source data is immutable. A permitted driver's one body-free provisional binding is explicitly distinguished from successful receipt. Matched completed prompt/answer pair, SHA256, request ID and site/mode/URL are required before normal completion. `agent_end` links body-free `page-provider-tiered-delivery` to the actual native assistant entry; no legacy checkpoint/cursor is advanced. Parent cancellation also works without `AbortSignal.any` on older Electron Node.

Website window/output cap/usage are unmeasured. UTF-8 framing is only a conservative uncalibrated estimate; catalog output maximum is not an enforced website cap. SDK zero usage is a placeholder, not zero measured cost.

## Checks (NOT website acceptance)

- 90 relevant Desktop tier/memory checks, including 8 new Web checks, zero skipped; Host types and targeted lint pass.
- 42 Page continuity/bridge regression checks and standalone extension types pass.
- 206 focused ChatGPT/DeepSeek adapter checks, including actual DOM helper exact-readback/permission/click/final-answer-pair tests, pass.
- Real SDK + actual candidate extension + bundled bidirectional bridge with a **simulated adapter** validates three routes, native persistence, source rejection, mutated payload, source change at dispatch and late receipt. This is not real website evidence.
- Initial new ChatGPT DOM test found a duplicate `isVisible` lexical declaration in injected JavaScript. Fixed by scoped composer check; original failed log retained. No website send occurred.

Reproduce optional cross-repository SDK checks with `PI_TIERED_PAGE_PACKAGE=<candidate>/examples/plugins/page-provider` and Node 22 `--experimental-strip-types --test src/agent-host/memory/tiered-web*.test.mjs`. Without that explicit package, integration tests are visibly skipped, not silently claimed as passes.

## Actual attempt: BLOCKED, zero website operations

Evidence: `~/Desktop/Pi-Web统一上下文验收-20261003/实际网站结果.json` and private source review files/logs.

A new real SDK branch `01a0fde5-64a3-741d-88fe-d9b504d5eef3` retained the earlier genuinely approved Flash warm `f39ed413` and hot 4-box update. The previous original native file stayed byte-identical. Three native source dialogs each timed out without approval. All three refused with `TIERED_POLICY_REFUSED: web-source-not-approved` BEFORE provider invocation. Driver invocations, website submissions, new API generations: **0**. There is no actual website sent text, reply, receipt or successful native delivery from this attempt. Fixture quality was not tested, rather than a model-quality failure.

The final cold equals final new native bytes; the initial new native prefix is preserved. Metadata is restored to Sol. The final status is `blocked-on-unapproved-source`, `allThreePassed:false`. Original first report is retained separately; its empty-answer JSON parse must not be treated as model-quality evidence.

The SDK/native-dialog harness is not installed Electron Renderer/Host lifecycle acceptance. Formal app, installed Page package and four installed OpenCLI adapter files were NOT changed. No app build/install, site login, probe, send retry, provider fallback, new Flash warm or Sol generation occurred. Qwen/Ollama is out of scope. Legacy non-tiered formatter/checkpoint behavior remains legacy, including its previously identified omission risk; this work does not claim that old cursor algorithm is repaired.

## Remaining gate

Fresh explicit full-source approval, then one serial real website turn per target and independent exact-text/receipt/native-entry/fixture checks. Ambiguous sent attempts must be investigated read-only, never blindly resent. Only after actual website acceptance should the coordinated app + Page + adapter update be packaged/deployed using app-stopped, pinned, reversible installation. This implementation is not a claim of completed website or formal GUI delivery.
