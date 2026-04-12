$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

function Get-PythonLauncher {
  $py = Get-Command py -ErrorAction SilentlyContinue
  if ($py) {
    return [PSCustomObject]@{
      Command = 'py'
      Args = @('-3')
    }
  }
  $python = Get-Command python -ErrorAction SilentlyContinue
  if ($python) {
    return [PSCustomObject]@{
      Command = 'python'
      Args = @()
    }
  }
  return $null
}

$launcher = Get-PythonLauncher
if (-not $launcher) {
  Write-Error "Python is not installed or not on PATH. Install Python 3.11+ first, then run this script again."
}

$requirements = Join-Path $scriptDir 'requirements.txt'
$server = Join-Path $scriptDir 'server.py'
$checkArgs = @($launcher.Args + @('-c', 'import yfinance; print(yfinance.__version__)'))
$pipArgs = @($launcher.Args + @('-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', '-r', $requirements))
$serverArgs = @($launcher.Args + @($server))

Write-Host "Checking Python environment..." -ForegroundColor Cyan
$hasYFinance = $false
try {
  $versionOutput = & $launcher.Command @checkArgs 2>$null
  if ($LASTEXITCODE -eq 0) {
    $hasYFinance = $true
    if ($versionOutput) {
      Write-Host ("yfinance already installed: " + ($versionOutput | Select-Object -First 1)) -ForegroundColor Green
    } else {
      Write-Host "yfinance already installed." -ForegroundColor Green
    }
  }
} catch {}

if (-not $hasYFinance) {
  Write-Host "Installing backend dependencies..." -ForegroundColor Yellow
  & $launcher.Command @pipArgs
  if ($LASTEXITCODE -ne 0) {
    Write-Error "Dependency installation failed. Please review the pip output above."
  }
}

Write-Host "Starting backend server..." -ForegroundColor Cyan
& $launcher.Command @serverArgs
