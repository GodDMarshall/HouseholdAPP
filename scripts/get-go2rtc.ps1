# House Control - fetch go2rtc, the small program that turns camera video into
# something a phone browser can play. Run once:
#
#   powershell -ExecutionPolicy Bypass -File scripts\get-go2rtc.ps1
#
# It downloads the official Windows build from the go2rtc project on GitHub
# (MIT licence) into hub\bin. Restart the hub afterwards.
param(
  [string]$Version = 'v1.9.14'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$bin = Join-Path $root 'hub\bin'
$zip = Join-Path $env:TEMP "go2rtc_$Version.zip"
$url = "https://github.com/AlexxIT/go2rtc/releases/download/$Version/go2rtc_win64.zip"

New-Item -ItemType Directory -Force $bin | Out-Null
Write-Host "Downloading go2rtc $Version from $url"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
Expand-Archive -Path $zip -DestinationPath $bin -Force
Remove-Item $zip -Force

$exe = Join-Path $bin 'go2rtc.exe'
if (-not (Test-Path $exe)) { throw "go2rtc.exe was not found in the download." }
$shown = & $exe -version 2>&1 | Select-Object -First 1
Write-Host "Installed: $exe"
Write-Host "Reports:   $shown"
Write-Host ''
Write-Host 'Restart the hub. Settings in the app will then show "Live video: Running".'
Write-Host 'Optional: pictures cut from live video need ffmpeg on the PATH (winget install Gyan.FFmpeg).'
Write-Host 'Cameras that give their own still pictures do not need it.'
