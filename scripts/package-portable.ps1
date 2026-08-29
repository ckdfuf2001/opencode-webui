param(
  [switch]$SkipDocTools,
  [string]$VersionOverride = ""
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$release = Join-Path $root 'release'

function Test-Command($name) {
  return $null -ne (Get-Command $name -ErrorAction SilentlyContinue)
}
if (-not (Test-Command pnpm)) { throw 'pnpm not found in PATH' }
if (-not (Test-Command bun)) { throw 'bun not found in PATH' }

$version = if ($VersionOverride) { $VersionOverride } else { (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version }
if (-not $version -or $version -notmatch '^\d+\.\d+\.\d+') { throw "invalid version: $version" }
Write-Output "[package] version $version"

# 0. 사전 정리: 실행 중인 exe 락 방지, 이전 산출물 정리
$exePath = Join-Path $release 'opencode-webui.exe'
if (Test-Path $exePath) {
  try {
    # 실행 중이면 stop 스크립트로 종료 시도 (파일 락 해제)
    $running = Get-Process opencode-webui -ErrorAction SilentlyContinue
    if ($running) {
      Write-Output '[package 0/7] stopping running opencode-webui.exe...'
      & (Join-Path $PSScriptRoot 'stop_opencode_webui_exe.bat') | Out-Null
      Start-Sleep -Seconds 2
    }
    Remove-Item $exePath -Force -ErrorAction Stop
  } catch {
    throw "release/opencode-webui.exe is locked (is it running?). Stop it and retry. $_"
  }
}
# 이전 zip 정리 (두 네이밍 모두)
foreach ($old in @(
  (Join-Path $root "opencode-webui-v$version-portable.zip"),
  (Join-Path $root "opencode-webui-portable-$version-win-x64.zip"),
  (Join-Path $root "build/opencode-webui-portable-$version-win-x64.zip")
)) {
  if (Test-Path $old) { Remove-Item $old -Force; Write-Output "[package 0/7] removed old $old" }
}
# release에 잘못 들어간 런타임 데이터는 패키징에서 제외 (로그/데이터는 zip에 포함 안 함)
foreach ($dir in @('logs','data','workspace')) {
  $p = Join-Path $release $dir
  if (Test-Path $p) { Write-Output "[package 0/7] note: $dir exists in release (will be excluded from zip)" }
}

Write-Output '[package 1/7] frontend build'
pnpm run build:frontend
if ($LASTEXITCODE -ne 0) { throw 'frontend build failed' }
$dist = Join-Path $root 'frontend/dist'
if (-not (Test-Path (Join-Path $dist 'index.html'))) { throw 'frontend build succeeded but frontend/dist/index.html missing' }

Write-Output '[package 2/7] frontend embed manifest generation'
bun scripts/generate-frontend-embed.ts
if ($LASTEXITCODE -ne 0) { throw 'frontend embed generation failed' }
$embedFile = Join-Path $root 'backend/generated/frontend-embed.generated.ts'
if (-not (Test-Path $embedFile)) { throw 'frontend embed file not generated' }

Write-Output '[package 3/7] backend single-exe compile (temp static import for embed)'
$embedSrc = Join-Path $root 'backend/src/services/embedded-frontend.ts'
$embedBackup = $null
$didPatch = $false
try {
  $embedBackup = Get-Content $embedSrc -Raw -ErrorAction Stop
  if ($embedBackup -match "eval.*import") {
    $static = $embedBackup -replace "const embedPath = '../../generated/frontend-embed.generated'\s*\r?\n\s*const mod = await \(0, eval\)\('import'\)\(embedPath\)", "const mod = await import('../../generated/frontend-embed.generated')"
    if ($static -ne $embedBackup) {
      Set-Content -Path $embedSrc -Value $static -NoNewline
      $didPatch = $true
      Write-Output '[package 3/7] switched embedded-frontend to static import for compile'
    }
  }
} catch {
  Write-Output "[package 3/7] WARN: embed patch failed: $_"
}
bun build --compile --target=bun backend/src/index.ts --outfile $exePath
$compileExit = $LASTEXITCODE
if ($didPatch -and $embedBackup) {
  Set-Content -Path $embedSrc -Value $embedBackup -NoNewline
  Write-Output '[package 3/7] restored embedded-frontend to eval (dev)'
}
if ($compileExit -ne 0) { throw 'backend compile failed' }
if (-not (Test-Path $exePath)) { throw 'backend compile did not produce exe' }

Write-Output '[package 4/7] frontend is embedded in the exe'
Remove-Item (Join-Path $release 'frontend') -Recurse -Force -ErrorAction SilentlyContinue

Write-Output '[package 5/7] bin copy (opencode / agent-browser)'
$srcOpencode = Join-Path $root 'bin/opencode.exe'
if (-not (Test-Path $srcOpencode)) { throw 'bin/opencode.exe not found - run pnpm run opencode:install first' }
New-Item -ItemType Directory -Force -Path (Join-Path $release 'bin') | Out-Null
Copy-Item -Force $srcOpencode (Join-Path $release 'bin/opencode.exe')
$srcAB = Join-Path $root 'bin/agent-browser'
if (Test-Path $srcAB) {
  Copy-Item -Recurse -Force $srcAB (Join-Path $release 'bin/agent-browser')
} else {
  Write-Output '[package 5/7] WARN: bin/agent-browser missing - browser automation disabled in portable'
}

Write-Output '[package 6/7] doc tools exe'
$docReader = Join-Path $release 'scripts/doc-reader.exe'
$docConverter = Join-Path $release 'scripts/doc-converter.exe'
$needDocTools = (-not (Test-Path $docReader)) -or (-not (Test-Path $docConverter))
if ($needDocTools -and -not $SkipDocTools) {
  & (Join-Path $PSScriptRoot 'build-doc-tools.ps1')
  if ($LASTEXITCODE -ne 0) { throw 'doc-tools build failed' }
} elseif ($SkipDocTools) {
  Write-Output '[package 6/7] skipped (SkipDocTools)'
} else {
  Write-Output '[package 6/7] ok: doc tools already present'
}

Write-Output '[package 7/7] launcher scripts'
Copy-Item -Force (Join-Path $PSScriptRoot 'start_opencode_webui_exe.sh') $release
Copy-Item -Force (Join-Path $PSScriptRoot 'start_opencode_webui_exe.bat') $release
Copy-Item -Force (Join-Path $PSScriptRoot 'stop_opencode_webui_exe.sh') $release
Copy-Item -Force (Join-Path $PSScriptRoot 'stop_opencode_webui_exe.bat') $release
Copy-Item -Force (Join-Path $PSScriptRoot 'clear_opencode_webui_exe.sh') $release
Copy-Item -Force (Join-Path $PSScriptRoot 'clear_opencode_webui_exe.bat') $release
Copy-Item -Force (Join-Path $PSScriptRoot 'PORT-GUIDE.txt') $release
$bat = Join-Path $release 'start_opencode_webui_exe.bat'
# ASCII 변환 시 한글 깨짐 방지: 원본이 UTF8이면 그대로 유지, 불필요한 변환 제거
# (이전 코드는 Get-Content | Set-Content -Encoding ASCII 로 한글 주석을 깨뜨림)
Remove-Item (Join-Path $release 'START.bat') -Force -ErrorAction SilentlyContinue

Write-Output ''
Write-Output '[package zip] create versioned archive (excluding logs/data/workspace)'
# Compress-Archive는 release/* 를 그대로 압축하면 logs/data가 포함될 수 있어 임시 목록으로 필터링
$zipName = "opencode-webui-portable-$version-win-x64.zip"
$zipPathRoot = Join-Path $root $zipName
$zipPathBuild = Join-Path $root "build/$zipName"
foreach ($zp in @($zipPathRoot, $zipPathBuild)) { if (Test-Path $zp) { Remove-Item $zp -Force } }
# 제외할 항목 필터
$items = Get-ChildItem -Path $release -Force | Where-Object { $_.Name -notin @('logs','data','workspace') }
if (-not $items) { throw 'nothing to package in release/' }
$tempList = $items | ForEach-Object { $_.FullName }
Compress-Archive -Path $tempList -DestinationPath $zipPathRoot -Force
# build 폴더에도 복사 (기존 관성 유지)
New-Item -ItemType Directory -Force -Path (Join-Path $root 'build') | Out-Null
Copy-Item -Force $zipPathRoot $zipPathBuild
foreach ($zp in @($zipPathRoot, $zipPathBuild)) {
  $z = Get-Item $zp
  Write-Output ("  {0} ({1:N1} MB) -> {2}" -f $z.Name, ($z.Length / 1MB), $z.FullName)
}

Write-Output ''
Write-Output 'Portable package ready:'
Get-ChildItem $release | Where-Object { $_.Name -notin @('logs','data','workspace') } | ForEach-Object { Write-Output ("  {0}" -f $_.Name) }
Write-Output "Zip: $zipPathRoot"
