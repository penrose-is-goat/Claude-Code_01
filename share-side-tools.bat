@echo off
setlocal
cd /d "%~dp0"

set "PORT=8017"
if not "%~1"=="" set "PORT=%~1"
set "CLOUDFLARED=%~dp0tools\cloudflared.exe"

if not exist "%CLOUDFLARED%" (
  echo Cloudflare Tunnel is not installed. Downloading the official portable version...
  if not exist "%~dp0tools" mkdir "%~dp0tools"
  powershell.exe -NoProfile -Command "$path='%CLOUDFLARED%'; Invoke-WebRequest -UseBasicParsing 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' -OutFile $path; $signature=Get-AuthenticodeSignature -LiteralPath $path; if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notlike '*Cloudflare, Inc.*') { Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue; throw 'The Cloudflare executable did not have the expected valid publisher signature.' }"
  if errorlevel 1 (
    echo.
    echo Cloudflare Tunnel could not be downloaded and verified.
    pause
    exit /b 1
  )
)

powershell.exe -NoProfile -Command "try { $response=Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:%PORT%/api/health' -TimeoutSec 4; if ($response.StatusCode -ne 200) { exit 1 } } catch { exit 1 }"
if errorlevel 1 (
  echo.
  echo Side Tools is not responding at http://127.0.0.1:%PORT%.
  echo Start it in the first window with: python .\serve.py --no-open
  echo Then run this launcher again.
  pause
  exit /b 1
)

echo.
python "%~dp0share_side_tools.py" --port %PORT%
if errorlevel 1 (
  echo.
  echo The public link could not be created or verified.
  pause
  exit /b 1
)

echo.
echo The temporary sharing link is now closed.
pause
