# v0.3.4 multi-account preview — partial implementation, not full acceptance

## Baseline

- Started from `pi-desktop/` main (`3a144db`, package version 0.3.0), with no tracked changes.
- Switched to new local branch `feat/multi-account-v034` based on official local release `b225cc2` (`release/pi-desktop-0.3.4-shared-terminal`).
- Did not modify the dirty `pi-context-repair` worktree or restore task teams.
- Pi SDK is 0.87.1. Codex uses the SDK's official subscription OAuth. Anthropic API keys are **not** Claude Code CLI accounts.

## Implemented

- Codex subscription and Anthropic API accounts: add, name, credential-presence status, official existing login/key UI, logout/re-login, default, removal, restart persistence.
- Credentials and optional model configuration are per-account files under the Pi agent directory's `accounts/<id>/`. SDK `ModelRuntime` owns credential writes, refresh locking and authentication. Metadata is credential-free; account directory permissions are 0700, auth files 0600.
- Names/provider IDs are stable. New account Provider aliases let the existing model picker select account + model without a second model/session stack. Account name appears in model names. There is not yet a separate three-level Provider/account/model picker.
- Migrated single stored Codex/Anthropic API credentials become default accounts. Legacy Provider IDs and JSONL binding keys remain intact. Migration does not rewrite original auth/config/history. Logout/removal uses SDK logout for the migrated compatibility credential too, leaving unrelated providers intact.
- Reuses existing `ModelSessions` persistence and `/model-session list|unbind|bind <id>`, image cursors and budget-controller SDK session IDs. A-B-A restores the binding ID; account-specific Provider IDs prevent same-model collisions. SDK Codex is a replay/stateless API path; its binding/cache ID is **not** represented as a Codex CLI remote conversation ID.
- Request ownership is locked across the full prompt, including warm generation and multiple image-transfer rounds. Model/account switches, detach/rebind and account credential mutations/removal are refused while owned requests are active. Account streaming also holds leases for auxiliary requests.
- Signed-out/removed accounts cannot use ambient keys or another account. Saved account models are explicitly restored even if unavailable so the SDK does not silently choose another account. Removed accounts retain tombstones and history. No replacement default is assigned automatically.
- Account dispatch errors are classified/redacted for auth expiry, quota/rate limits and other failures. Status enumeration never resolves secret-manager commands.
- Existing cool/warm/hot, Pi native compaction, original-image JSONL ledger, 10 MiB limit, eight-image batches, Web receipts/bindings remain on the baseline implementations.

## Evidence

All account automation uses temporary agent/session/Desktop stores and fictional credentials. No real account login, password entry, remote inference, real Flash request, Spark or real local-model inference was performed.

- `npm test`: **1662 tests; 1659 pass, 3 skip, 0 fail**. Web SDK tests enabled with `PI_TIERED_PAGE_PACKAGE=<repo>/plugins/page-provider`.
- New `src/agent-host/provider-accounts.test.mjs`: seven tests covering credential isolation, restart/default/name, legacy migration, two fictional Codex tokens resolved through official SDK auth, no fallback, active login/request guards, removal, account-specific binding IDs, real loopback Anthropic SDK SSE requests carrying prior text and original image A-B-A, simulated HTTP 401/429 classification/secret redaction, and a mocked failed Codex token refresh without account fallback.
- Existing tiered SDK regression tests verify text/image batching, incremental warm, long-context switching, API detach/rebind and Web no-regression using fictional/mock transports, not real remote providers.
- Typecheck, ESLint, Prettier, contract coverage (121 handlers), architecture, dependency contract, Pi compatibility, desktop security (82 invariants), production-artifact checks passed.
- Electron smoke passed with its own isolated stores. Initial run with an externally overridden session directory failed indexing its fixture; removing that conflicting override allowed the intended isolated smoke setup to pass.
- macOS arm64 DMG constructed with local Electron 43.1.1 and existing verified core/Herdr assets, no GitHub publishing, unsigned/unnotarized.
- Packaged physical ASAR integrity (42879 files) and 171 model-runtime packages verified.
- `scripts/test-packaged-accounts.mjs`: shipped Host RPC adds two Codex and two Anthropic API accounts, saves fictional API keys, defaults/names, exits/restarts, checks credentials/model aliases and removal. Receipts: `PACKAGED_ACCOUNTS_CREATE_DEFAULT_RENAME_OK`, `PACKAGED_ACCOUNTS_RESTART_CREDENTIALS_PROVIDERS_REMOVE_OK`.
- `scripts/test-packaged-host-startup.mjs`: shipped SDK/Host and built-in Web bridge/first-install model list pass.
- `scripts/test-packaged-terminal.mjs <app> --require-tmux`: `PACKAGED_PTY_SPAWN_OK`, `PACKAGED_SHARED_TERMINAL_ATTACH_WRITE_CAPTURE_REATTACH_OK`. This is a real packaged PTY/tmux RPC test with a temporary tmux session, **not** a claim that Desktop's currently displayed user CLI session was connected/reconnected manually.
- `scripts/verify-packaged-toolchains.mjs darwin-arm64 dist/multi-account-preview`: actual packaged startup/toolchains pass.

Logs: `/tmp/pi-multi-account-{fulltests,build,package,terminal,packaged-check,packaged-accounts,hoststartup,smoke}.log`.

## Outstanding / limitations

- **Claude Code CLI Provider, subscription account/environment isolation and real CC session resume are not implemented.** No `claude` executable was found in the inspected PATH/local tool locations. No substitute Anthropic auth is labelled CC. Official CLI installation/discovery plus the correct CLI transport needs separate completion and consent before any necessary large download.
- Actual user Codex/CC login, expiry/quota, image and long-context/Flash remote acceptance remain unperformed and require named-account/test authorization first.
- Dedicated Provider/account/model selectors and session-ID copy buttons are not added; current selection uses existing model aliases and ID inspection uses existing `/model-session` output.
- Account metadata uses atomic replacement in the single Desktop Host. Cross-process concurrent metadata edits are not validated/locked. Credential refresh locking remains SDK-owned.
- GUI account-management acceptance and the actual shared terminal for the user-visible CLI session remain pending. No current application installation or running user session was overwritten.
- The complete `verify` umbrella (including all Browser/managed-process E2E jobs) was not run; the checks above are the actual executed evidence.

## Packaging download disclosure

The packager unexpectedly downloaded `dmgbuild-bundle-arm64-75c8a6c.tar.gz` (~22 MiB) without a prior approval checkpoint. This was a process mistake. No Node/Electron/model download was performed. electron-builder's default source is GitHub's electron-userland/electron-builder-binaries release (no mirror override or HTTP/HTTPS/ALL_PROXY environment variable was set; system-level routing was not established). Its downloaded SHA-256 was independently checked against the checksum embedded in the installed upstream dmg-builder package:

`793404d0c96687e27d5ee40a668d498c92e36a64d6c2906df511031adb33cbeb`

Subsequent packaging explicitly sets `CUSTOM_DMGBUILD_PATH` to that already verified cached binary and uses local `electronDist`, avoiding further downloads. The artifact is a **preview**, not an assertion that the complete requested Codex + CC feature is finished.
