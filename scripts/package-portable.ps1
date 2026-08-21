param([switch]$SkipDocTools)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$release = Join-Path $root 'release'

Write-Output '[package 1/6] frontend build'
pnpm run build:frontend
if ($LASTEXITCODE -ne 0) { throw 'frontend build failed' }

Write-Output '[package 2/6] backend single-exe compile'
bun build --compile --target=bun backend/src/index.ts --outfile (Join-Path $release 'opencode-webui.exe')
if ($LASTEXITCODE -ne 0) { throw 'backend compile failed' }

Write-Output '[package 3/6] frontend dist copy'
New-Item -ItemType Directory -Force -Path (Join-Path $release 'frontend') | Out-Null
Copy-Item -Recurse -Force (Join-Path $root 'frontend\dist') (Join-Path $release 'frontend\dist')

Write-Output '[package 4/6] bin copy (opencode / agent-browser)'
New-Item -ItemType Directory -Force -Path (Join-Path $release 'bin') | Out-Null
Copy-Item -Force (Join-Path $root 'bin\opencode.exe') (Join-Path $release 'bin\opencode.exe')
if (Test-Path (Join-Path $root 'bin\agent-browser')) {
  Copy-Item -Recurse -Force (Join-Path $root 'bin\agent-browser') (Join-Path $release 'bin\agent-browser')
}

Write-Output '[package 5/6] doc tools exe'
if (-not (Test-Path (Join-Path $release 'scripts\doc-reader.exe')) -and -not $SkipDocTools) {
  & (Join-Path $PSScriptRoot 'build-doc-tools.ps1')
}

Write-Output '[package 6/6] launcher scripts'
Copy-Item -Force (Join-Path $PSScriptRoot 'start_opencode_webui_exe.sh') $release
Copy-Item -Force (Join-Path $PSScriptRoot 'start_opencode_webui_exe.bat') $release
$bat = Join-Path $release 'start_opencode_webui_exe.bat'
(Get-Content $bat) | Set-Content $bat -Encoding ASCII
Remove-Item (Join-Path $release 'START.bat') -Force -ErrorAction SilentlyContinue

Write-Output ''
Write-Output 'Portable package ready:'
Get-ChildItem $release | ForEach-Object { Write-Output ("  {0}" -f $_.Name) }
