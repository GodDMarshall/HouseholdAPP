# House Control - start the hub by itself whenever this PC is switched on and you sign in.
#
#   powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1
#
# Remove it again with scripts\remove-autostart.ps1.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node -ErrorAction Stop).Source
$log = Join-Path $root 'data\hub.log'
New-Item -ItemType Directory -Force (Join-Path $root 'data') | Out-Null

if (-not (Test-Path (Join-Path $root 'node_modules'))) { throw 'Run "Start House Control.cmd" once first, so everything is installed.' }
if (-not (Test-Path (Join-Path $root 'app\dist\index.html'))) { throw 'Run "Start House Control.cmd" once first, so the phone app is built.' }

# A hidden window that restarts the hub if it ever stops.
$inner = "Set-Location -LiteralPath '$root\hub'; while (`$true) { & '$node' --no-warnings=ExperimentalWarning --import tsx src/index.ts *>> '$log'; Start-Sleep -Seconds 5 }"
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -Command `"$inner`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName 'House Control hub' -Action $action -Trigger $trigger -Settings $settings -Description 'Runs the House Control hub in the background.' -Force | Out-Null
Start-ScheduledTask -TaskName 'House Control hub'

Write-Host 'Done. The hub now starts by itself at sign-in and is running now.'
Write-Host "Log file: $log"
Write-Host 'Open http://localhost:8080 to check.'
