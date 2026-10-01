# House Control - stop starting the hub automatically.
#
#   powershell -ExecutionPolicy Bypass -File scripts\remove-autostart.ps1
$ErrorActionPreference = 'SilentlyContinue'
Stop-ScheduledTask -TaskName 'House Control hub'
Unregister-ScheduledTask -TaskName 'House Control hub' -Confirm:$false
Write-Host 'The hub no longer starts by itself. Use "Start House Control.cmd" to start it by hand.'
