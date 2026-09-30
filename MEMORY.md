# Local task memory

JSONL remains the transcript authority. Derived files live in the agent directory's
`task-memory-vault/hot` and `warm` folders. Compilation uses Pi's effective branch
projection, preserves source IDs/hashes, and refuses to overwrite edited Markdown.
The schema-v2 ledger stores summary metadata and cursor IDs/hashes, **not** another
copy of raw messages. Unchanged stages survive Host restart without regeneration.

## Local commands

- `/task-memory-preview`: preview the locally generated summary.
- `/task-memory-refresh`: verify/rebuild the current branch locally.
- `/task-memory-search QUERY`: search and open derived Markdown.
- `/task-memory-search cold QUERY`: search the current session's ancestor JSONL
  branch, including pre-compaction messages. Opening revalidates source hashes.

Failed/unconfirmed turns, model-selection entries and echoed handoff protocols do
not become task decisions. Repeated facts are deduplicated before local summarizing.
The memory model is configured independently; only explicitly configured loopback
models are allowed. Failure never falls back to sending a transcript externally.

## Delivery boundary

The actual `ModelRuntime.streamSimple` dispatch is guarded, not just an extension
hook. Same-model API requests within a known budget retain native Pi context.
Model switches, unknown/over-budget context and Web requests require a bounded
snapshot and an exact per-call preview. Web receives only a minimal system message,
the approved summary, uncovered recent completed text, and the current request.
Raw tool output, thinking, old images and the Pi system prompt remain local.

Cancel, abort, missing UI, stale branch/model, edits during approval, unsupported
attachments/tool exchanges or oversized payloads close the request without dispatch.
Web prompts are capped at 24,000 characters. The Page Provider update must accompany
the Desktop update: its one-shot receipt validates the target/session/prompt hash
and prevents another checkpoint/context envelope being appended.

## Optional QMD

Set `PI_DESKTOP_QMD_MODULE` to an explicitly installed absolute QMD SDK entry path.
The adapter owns only this vault's `.index/qmd.sqlite` and `pi-hot`/`pi-warm`
collections, calling `update()` and `searchLex()` (BM25). No embed, reranker, hybrid
query or model download is invoked. Missing/unavailable QMD falls back to local
keyword search. Native dependency/desktop runtime compatibility still requires a
real installed SDK test; mock SDK tests are not that acceptance test.

## Validation and packaging status

Module tests cover cold provenance, incremental resume, single-use approvals,
abort races and 30 repeated model switches with bounded, non-growing prompts.
`scripts/test-memory-e2e.mjs` uses only a fictional project and isolated agent data.
Optionally set `PI_MEMORY_E2E_PAGE_EXTENSION` to the companion plugin extension to
verify real registration and Desktop receipts against a **fake bridge**, never a
real website. This is not real logged-in Web or installed-application acceptance.

Local `--dir` bundles without `app-update.yml` disable automatic update checks;
production bundles with release metadata keep the existing update policy. Updater
production dependencies are explicitly included in the packaging configuration.
Source implementation, validated candidate packages and installed application
versions must be reported separately.
