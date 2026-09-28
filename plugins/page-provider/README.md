# Page Provider prototype

This Pi Package registers an **OpenCLI Page** provider in PI Desktop. It
deliberately contains no website selectors and does not bundle OpenCLI. A small
external executable owns the browser integration and communicates with the
extension over newline-delimited JSON on stdin/stdout.

## Install in current PI Desktop

1. Open **Settings → Plugins → Add Plugin**.
2. Enter this package directory as the source (not the `.piplug` file):
   `/Users/niugengtian/work/奇思妙想/pi-desktop-page-provider/examples/plugins/page-provider`.
3. Choose the global or project scope and click **Install**.
4. Install OpenCLI and keep OpenCLIApp running. Sign in to DeepSeek and/or
   ChatGPT in the browser connected to OpenCLI.
5. Reload the session, then select **OpenCLI Page / DeepSeek Chat**,
   **DeepSeek Reasoner**, or **ChatGPT Web**.
6. Use `/page-provider-status` to verify the browser connection.
7. After a completed web turn, use `/page-provider-binding` to inspect the
   verified remote conversation bound to the selected model, or
   `/page-provider-open` to restore that exact conversation in OpenCLI's browser.
   Use `/page-provider-conversation` to choose interactively between continuing
   an available binding and starting a new web conversation. The explicit forms
   are `/page-provider-conversation continue` and
   `/page-provider-conversation new`; `/page-provider-new` remains the force-new
   shortcut.
8. Use `/page-provider-task-status` to inspect the stable task ID, latest
   checkpoint, and the selected model's synchronization cursor. An unacknowledged
   handoff is blocked from automatic resend; `/page-provider-handoff-retry`
   explicitly permits one retry. If PI timed out after a site already completed
   an ordinary turn, retrying the same request recovers that exact web reply
   instead of sending the prompt again.

The package manifest is `package.json`; its `pi.extensions` entry loads
`extensions/page-provider.ts`. The legacy `manifest.json` and `.piplug` build
remain for the older trusted-extension prototype and are not the installation
format used by the current PI Desktop package screen.

The prototype accepts text and up to eight PNG, JPEG, WebP, or GIF images per
turn on DeepSeek and ChatGPT Web. Each image is limited to 15 MiB and the turn
total to 40 MiB. Its bundled
thin bridge locates the external OpenCLI installation and executes that
installation's `ask` adapter in memory. Inline image data is materialized
without modification in a private temporary directory only for the adapter
call and removed afterward.
OpenCLI owns page selection, authentication, input, response extraction, and
browser lifecycle. PI owns the native transcript and renders the returned
Markdown as an ordinary assistant message. A model without a task binding starts
a fresh remote conversation unless a new PI session explicitly chooses to
continue the previous PI session's remote binding. That choice is prompted on
first use and persisted. Later turns explicitly resume the bound conversation
instead of trusting the active browser tab. A completed turn may also return a
verified remote conversation ID and HTTPS URL. The extension stores a provisional
binding as soon as that URL appears, before waiting for the complete reply, so a
cancellation or timeout does not lose the new conversation. It never duplicates
the prompt or reply body. Each successful Page Provider turn also appends a bounded checkpoint with
transcript references, hashes, and short summaries. When a target web model is
behind, the next request carries only checkpoints after that model's cursor and
requires a structured acknowledgement before advancing it. No OpenCLI source or
dependency is bundled into the plugin.

## Bridge contract

By default PI starts the bundled thin bridge with its Node runtime. Set
`PI_PAGE_PROVIDER_BRIDGE` only to replace that bridge with another compatible
executable; overrides are started as:

```text
$PI_PAGE_PROVIDER_BRIDGE --stdio
```

It sends exactly one request, then closes stdin:

```json
{
  "id": "<turn UUID>",
  "method": "turn.send",
  "params": {
    "text": "Hello",
    "mode": "chat",
    "attachments": [{ "kind": "image", "mimeType": "image/png", "data": "<base64>" }]
  }
}
```

The bridge writes NDJSON events. Supported lifecycle events are:

```json
{"type":"provider.state","state":"ready"}
{"type":"turn.status","status":"waiting"}
{"type":"turn.delta","markdown":"partial Markdown"}
{"type":"turn.completed","message":{"markdown":"final Markdown"},"remote":{"site":"deepseek","mode":"chat","conversationId":"optional","conversationUrl":"optional verified HTTPS URL"}}
```

A typed failure uses:

```json
{
  "type": "turn.failed",
  "error": { "code": "LOGIN_REQUIRED", "message": "Sign in to the page first", "recoverable": true }
}
```

`site` selects the external adapter (`deepseek`, `chatgpt`, or `gemini`) per
request. For DeepSeek, `mode` is `chat` or `reasoner` and maps to the adapter's
`think` flag. Both fields have backward-compatible DeepSeek Chat defaults.

Lifecycle states are `attaching`, `ready`, `sending`, `waiting`, `streaming`,
`completed`, `loginRequired`, `interrupted`, and `failed`. The extension maps
these events onto PI's native working-message surface and clears that status at
the end of the turn. A later panel can expose the same states without changing
this protocol.

The executable must accept prompts through stdin. Do not put prompt text in
shell command strings or process arguments. The bundled bridge dynamically
loads the installed OpenCLI execution module and selected adapter, so it is
version-coupled to OpenCLI's current package layout and fails explicitly when
that layout is unavailable. A private adapter at
`~/.opencli/clis/<site>/<command>.js` takes precedence over the packaged copy,
matching OpenCLI's normal local-override convention. Browser credentials remain
in the browser/OpenCLI session and must never appear in protocol events.

## Test

```bash
node --test examples/plugins/page-provider/test/*.test.mjs
```
