# SDK-only repair on the rollback baseline

## Scope

Baseline: `db34fb3`. Port only the seven packaging files from `a8cc21e`; retain
node-pty, its lockfile records, and existing updater/Feishu restores. No memory
controller, delivery guard, or incremental compiler changes are included.

## Failure reproduction

The installed rollback ASAR (`6a5b5fea0287deaf5a9ab3f1fed9a50f7ba1f46725667c9eb6bf33f24fde9a9b`)
fails an Electron import of nested pi-ai's openai-completions adapter with
`ERR_MODULE_NOT_FOUND: Cannot find package 'openai'`. Archive inspection also
finds a missing Anthropic SDK. No model request was needed to reproduce this.

## Focused checks

Ten packaging-related tests passed: seven original SDK checks, one additional
rollback restore-preservation check, and two package entrypoint checks. Changed
scripts passed ESLint, changed files passed Prettier, and diff whitespace checks
passed. No full verify run was performed.

A full local mac-arm64 candidate was built with Electron 43.1.1, without downloads.
Its afterPack check verified 171 model runtime packages. Root and nested OpenAI
adapter imports passed on the first full candidate. The final candidate also
passed afterPack and local ad-hoc signature verification.

## Real desktop acceptance

The user submitted the fictional book-sorting task through the visible packaged
desktop, received `已记录`, and opened `/task-memory-preview`. The user confirmed
both the reply and summary; the pasted preview matched the recorded Markdown.

- Session: `01a0f320-a1d4-7740-9b74-767f628e145f`
- Session cwd: `/tmp/pi-sdk01-desktop-validation/home/pi-cwd-20260930`
- Main model and memory model: `ollama-local/pi-qwen3-4b-summary:q4km`
- Source: 103 characters; summary: 94 characters.
- Markdown: `hot/mem-f7ff013dac807edacff8a99b.md`
- Markdown SHA256: `da6c8c16c292c40fa4947cfc805f0b24989e4a9ae944b6c1175146bed5fc10ff`
- Session snapshot SHA256: `e1b654880dcf323b8b1ef94f455eab28869564bc17f2f5a98ba8b43bba542a53`
- Final candidate ASAR SHA256: `9a2989fb5f760fda2e6071524a5d68667fc6828fad82de08bd2996cdedc3757d`

The candidate lives under `/tmp/pi-sdk01-desktop-validation/dist/mac-arm64/`.
Validation-only metadata/bootstrap gives it a unique identity and fixed isolated
home, userData and logs. That generated bootstrap is not part of this production
SDK fix. No real credentials or historical sessions were copied.

## Timing and limitations

JSONL timestamps show 63.216 seconds from submission to the main reply, then
12.527 seconds to the memory ledger. Ollama reports about 53.465 seconds processing
the main prompt, about 1.240 seconds for memory health probing, and 11.258 seconds
for summary generation. Initial model loading and a session-title request also
appear in the logs. These are one-run observations, not a benchmark or a complete
attribution of perceived UI latency.

This closes the missing-SDK issue for this isolated short-text desktop path only.
The user reported slow performance, which is recorded separately. Long history,
images, tools, cancellation, concurrency, Web delivery, and terminal native
behavior have not been accepted here. Collector output noted missing
node-addon-api headers; no native rebuild or terminal acceptance was performed.

The production application remains unchanged and still has its old missing-SDK
problem. Formal installation requires separate user consent and a rollback plan.
