$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$backendScript = Join-Path $root 'backend\start-backend.ps1'
$frontend = Join-Path $root 'index.html'

Write-Host "Starting Portfolio Analyzer backend for Batch 1 v1.1.30.6..." -ForegroundColor Cyan
Write-Host "A new PowerShell window will open for the backend. Keep it running while you use the site." -ForegroundColor Yellow
Start-Process powershell -ArgumentList @('-NoExit', '-ExecutionPolicy', 'Bypass', '-File', $backendScript)

Write-Host ""
Write-Host "Frontend file:" -ForegroundColor Cyan
Write-Host $frontend
Write-Host ""
Write-Host "Then open the site with Live Server in VS Code and click 'Test Backend' in Settings." -ForegroundColor Green
