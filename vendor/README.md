# Offline vendoring (optional, git-ignored)

A normal clone needs no files here: the runtime binaries
(`bin/opencode.exe`, `bin/agent-browser/…`, the Chromium build) are already
tracked in the repo through **Git LFS** (see the main README). This folder only
exists for machines that want to ship the binaries as plain files instead of
LFS objects (e.g. copying the app to an air-gapped host).

The installers (`scripts/install-opencode.js`,
`scripts/install-agent-browser.js`) check `vendor/` **first** and copy the
files from here without downloading; they fall back to a download when
`vendor/` is empty. Put the files in the layout below and commit/push this
folder manually (it is git-ignored by default):

```
vendor/
  opencode/            # the opencode CLI archive or binary for the target OS
    opencode-windows-x64.zip   (or the extracted opencode.exe)
    opencode-linux-x64.zip
    ...
  agent-browser/       # the agent-browser binary for the target platform
    agent-browser-win32-x64.exe   (or the plain name agent-browser.exe)
    agent-browser-darwin-arm64
    agent-browser-linux-x64
    ...
  chromium/            # Chrome for Testing
    chrome-win64.zip   (or an extracted chrome-win64/ directory)
    chrome-linux64.zip
    ...
```

Prepare the files on a connected machine:

```bash
node scripts/install-opencode.js
node scripts/install-agent-browser.js
```

then copy the results from `bin/` back into `vendor/` in the layout above. The
platform/archive names match the release assets the installers download, so
any name shown in `bin/` or the installer output is valid here.

To track this folder in git, force-add it:

```bash
git add -f vendor
```
