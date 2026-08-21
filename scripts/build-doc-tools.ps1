$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $root 'release\scripts'
$work = Join-Path $root 'build\pyinstaller'
New-Item -ItemType Directory -Force -Path $dist, $work | Out-Null

Write-Output '[doc-tools] ensuring python deps'
python -m pip install --quiet pyinstaller
python -m pip install --quiet -r (Join-Path $root 'backend\requirements.txt')
if ($LASTEXITCODE -ne 0) { throw 'pip install failed' }

$common = @('--onefile', '--clean', '--noconfirm', "--distpath=$dist", "--workpath=$work", "--specpath=$work")

Write-Output '[doc-tools] building doc-reader.exe'
python -m PyInstaller @common `
  --copy-metadata fastmcp `
  --copy-metadata mcp `
  --name doc-reader `
  (Join-Path $root 'backend\scripts\doc_reader_mcp.py')
if ($LASTEXITCODE -ne 0) { throw 'doc-reader build failed' }

Write-Output '[doc-tools] building doc-converter.exe'
python -m PyInstaller @common `
  --hidden-import win32com.client `
  --hidden-import pythoncom `
  --hidden-import win32timezone `
  --hidden-import psutil `
  --hidden-import extract_msg `
  --hidden-import docx `
  --name doc-converter `
  (Join-Path $root 'backend\scripts\doc_converter.py')
if ($LASTEXITCODE -ne 0) { throw 'doc-converter build failed' }

Write-Output '[doc-tools] built:'
Get-ChildItem $dist | ForEach-Object { Write-Output ("  {0}  ({1:N1} MB)" -f $_.Name, ($_.Length / 1MB)) }
