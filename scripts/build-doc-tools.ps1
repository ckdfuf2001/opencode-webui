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

Write-Output '[doc-tools] building office-mcp.exe (doc-reader: office-mcp fork)'
python -m PyInstaller @common `
  --copy-metadata fastmcp `
  --copy-metadata mcp `
  --hidden-import extract_msg `
  --hidden-import olefile `
  --hidden-import docx `
  --hidden-import openpyxl `
  --hidden-import pptx `
  --hidden-import pypdf `
  --collect-submodules opencode_ext `
  --name office-mcp `
  (Join-Path $root 'vendor\office-mcp\server.py')
if ($LASTEXITCODE -ne 0) { throw 'office-mcp build failed' }

Write-Output '[doc-tools] building doc-converter.exe'
python -m PyInstaller @common `
  --hidden-import win32com.client `
  --hidden-import pythoncom `
  --hidden-import win32timezone `
  --hidden-import psutil `
  --hidden-import extract_msg `
  --hidden-import olefile `
  --hidden-import docx `
  --name doc-converter `
  (Join-Path $root 'backend\scripts\doc_converter.py')
if ($LASTEXITCODE -ne 0) { throw 'doc-converter build failed' }

Write-Output '[doc-tools] built:'
Get-ChildItem $dist | ForEach-Object { Write-Output ("  {0}  ({1:N1} MB)" -f $_.Name, ($_.Length / 1MB)) }
