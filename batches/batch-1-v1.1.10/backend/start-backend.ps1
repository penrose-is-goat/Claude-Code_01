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
$pipArgs = @($launcher.Args + @('-m', 'pip', 'install', '-r', $requirements))
$serverArgs = @($launcher.Args + @($server))

& $launcher.Command @pipArgs
& $launcher.Command @serverArgs
