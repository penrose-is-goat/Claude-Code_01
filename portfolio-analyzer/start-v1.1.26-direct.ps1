$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$backendScript = Join-Path $root 'backend\start-backend.ps1'

Write-Host "Running Portfolio Analyzer backend for Batch 1 v1.1.26 in this PowerShell window..." -ForegroundColor Cyan
Write-Host "Keep this window open while you use the site." -ForegroundColor Yellow
Write-Host ""

& $backendScript
