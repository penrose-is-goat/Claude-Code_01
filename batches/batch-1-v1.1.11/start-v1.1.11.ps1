$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$backendScript = Join-Path $root 'backend\start-backend.ps1'
$frontend = Join-Path $root 'index.html'
$healthUrl = 'http://127.0.0.1:8765/api/health'

Write-Host "Starting Portfolio Analyzer backend..." -ForegroundColor Cyan
Write-Host "A new PowerShell window will open for the backend. Keep it running while you use the site." -ForegroundColor Yellow
Start-Process powershell -ArgumentList @('-NoExit', '-ExecutionPolicy', 'Bypass', '-File', $backendScript)

$started = $false
for ($i = 0; $i -lt 10; $i++) {
  Start-Sleep -Seconds 1
  try {
    $health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 2
    if ($health.ok) {
      $started = $true
      break
    }
  } catch {}
}

Write-Host ""
Write-Host "Frontend file:" -ForegroundColor Cyan
Write-Host $frontend
Write-Host ""
if ($started) {
  Write-Host "Backend is reachable at $healthUrl" -ForegroundColor Green
  Write-Host "Then open the site with Live Server in VS Code and click 'Test Backend' in Settings." -ForegroundColor Green
} else {
  Write-Host "Backend did not become reachable at $healthUrl." -ForegroundColor Red
  Write-Host "If no second PowerShell window appeared, run this directly so you can see the real error:" -ForegroundColor Yellow
  Write-Host "powershell -ExecutionPolicy Bypass -File `"$root\start-v1.1.11-direct.ps1`"" -ForegroundColor Yellow
}
