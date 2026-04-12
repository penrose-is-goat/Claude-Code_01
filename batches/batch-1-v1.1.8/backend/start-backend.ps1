$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
  Write-Error "Python is not installed or not on PATH. Install Python 3.11+ first, then run: python -m pip install -r `"$scriptDir\requirements.txt`""
}

python -m pip install -r (Join-Path $scriptDir 'requirements.txt')
python (Join-Path $scriptDir 'server.py')
