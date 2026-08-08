# vendor/

Offline files for machines without internet. Every installer checks this
folder **first** and copies your files (no download), and falls back to it if a
download fails.

> Runtime copies land in the git-ignored `bin/` folder; this `vendor/` folder is
> the source you distribute with the repo (commit it, or ship it alongside).

## Layout

```
vendor/
  opencode/                    # opencode CLI (optional; auto-downloaded if absent)
    <archive or binary for your OS>
  agent-browser/               # agent-browser MCP binary
    <platform binary>
  chromium/                    # Chromium (Chrome for Testing)
    chrome-<platform>.zip      #  OR  extracted folder (e.g. chrome-win64/chrome.exe)
```

## Platform file names

| OS          | opencode                                   | agent-browser                      | chromium zip           |
| ----------- | ------------------------------------------ | ---------------------------------- | ---------------------- |
| Windows x64 | `opencode-windows-x64.zip` or `opencode.exe` | `agent-browser-win32-x64.exe`        | `chrome-win64.zip`     |
| macOS arm64 | `opencode-darwin-arm64.zip` or `opencode`  | `agent-browser-darwin-arm64`        | `chrome-mac-arm64.zip` |
| macOS x64   | `opencode-darwin-x64.zip` or `opencode`    | `agent-browser-darwin-x64`          | `chrome-mac-x64.zip`   |
| Linux x64   | `opencode-linux-x64.tar.gz` or `opencode`  | `agent-browser-linux-x64`           | `chrome-linux64.zip`   |
| Linux arm64 | `opencode-linux-arm64.tar.gz` or `opencode` | `agent-browser-linux-arm64`        | `chrome-linux-arm64.zip` |

## How to prepare (one-time, on an internet-connected machine)

```bash
# produce everything for your OS
node scripts/install-opencode.js
node scripts/install-agent-browser.js

# copy the runtime files back into vendor/
mkdir -p vendor/opencode vendor/agent-browser vendor/chromium
cp bin/opencode.exe* vendor/opencode/            # or bin/opencode on macOS/Linux
cp bin/agent-browser/bin/agent-browser* vendor/agent-browser/
cp -r bin/agent-browser/chromium/* vendor/chromium/
```

Then distribute the repo (with `vendor/`) to the offline machine. Running
`npm run dev` (or `npm run agent-browser:install`) there copies everything from
`vendor/` without needing the network.
