# Pi Agent Desktop 0.3.1 Web adapter repairs

These four OpenCLI adapter overrides were tested with OpenCLIApp's OpenCLI
1.8.6 runtime. OpenCLIApp must be installed and connected to a browser signed
in to ChatGPT and/or DeepSeek.

After extracting this archive, run `install.command` in Terminal:

```sh
/bin/zsh /path/to/Pi-OpenCLI-Web-Repairs-0.3.1/install.command
```

The installer checks SHA256 hashes, backs up existing `ask.js` and `utils.js`
overrides, then installs the repaired files under `~/.opencli/clis/`. It does
not install or upgrade OpenCLIApp. Restart Pi Agent Desktop afterward.

The repairs handle invisible DeepSeek attachment spinners, preserve identical
ChatGPT replies from separate turns, ignore hidden decorations in collapsed
prompts, and support the installed runtime's `page.wait` polling API.

Real website tests passed for both DeepSeek Web modes with an image, ChatGPT
Web with an image, and ChatGPT → DeepSeek → the original ChatGPT session.
The adapter regression suite passed 202 tests.

To undo the overrides, restore the backed-up files from
`~/.opencli/pi-web-repair-backups/`. For a file that did not previously exist,
remove the newly installed override to use OpenCLI's packaged adapter again.

Adapter code is from OpenCLI and is distributed under the included license.
