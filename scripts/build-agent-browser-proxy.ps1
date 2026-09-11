# Build the vendored agent-browser session proxy (mcp-server.mjs) into a
# standalone exe so portable installs work without node/bun on PATH.
# Output: bin/agent-browser-proxy/agent-browser-proxy.exe
$ErrorActionPreference = 'Stop'

function Test-Command($name) {
  return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

$root = Resolve-Path (Join-Path $PSScriptRoot '..')
$mjs = Join-Path $root 'backend/scripts/agent-browser-proxy/mcp-server.mjs'
$outDir = Join-Path $root 'bin/agent-browser-proxy'
$outExe = Join-Path $outDir 'agent-browser-proxy.exe'

if (-not (Test-Path $mjs)) { throw "proxy source not found: $mjs" }
if (-not (Test-Command bun)) { throw 'bun not found in PATH' }

New-Item -ItemType Directory -Force -Path $outDir | Out-Null
Write-Output "[proxy] compiling mcp-server.mjs -> $outExe"
& bun build --compile --target=bun "$mjs" --outfile "$outExe"
if ($LASTEXITCODE -ne 0) { throw 'proxy compile failed' }
if (-not (Test-Path $outExe)) { throw 'proxy compile did not produce exe' }
Write-Output '[proxy] ok'
