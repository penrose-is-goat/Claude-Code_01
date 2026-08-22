Set-Location -LiteralPath $PSScriptRoot
$pythonCommand = Get-Command python -ErrorAction Stop
Write-Host "Using $($pythonCommand.Source)"
& $pythonCommand.Source .\serve.py --doctor
if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "Network preflight failed. The app was not opened with a backend that cannot reach its sources." -ForegroundColor Red
    Read-Host "Press Enter to close"
    exit $LASTEXITCODE
}
& $pythonCommand.Source .\serve.py
