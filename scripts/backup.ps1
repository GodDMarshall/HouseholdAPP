# House Control - copy everything the hub knows (devices, WiFi passwords, PIN, keys)
# into one dated zip. Works while the hub is running.
# Keep the zip somewhere safe: whoever has it has the house.
#
#   powershell -ExecutionPolicy Bypass -File scripts\backup.ps1 [-To D:\Backups]
#
# To restore: stop the hub, unzip into the data folder (replace the files), start the hub.
param(
  [string]$To = (Join-Path (Split-Path -Parent $PSScriptRoot) 'backups'),
  [string]$Data = (Join-Path (Split-Path -Parent $PSScriptRoot) 'data')
)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path (Join-Path $Data 'house.db'))) { throw "No data to back up yet at $Data" }
New-Item -ItemType Directory -Force $To | Out-Null
$stamp = Get-Date -Format 'yyyy-MM-dd_HHmmss'
$staging = Join-Path $To "staging_$stamp"
$zip = Join-Path $To "house-control_$stamp.zip"

$summary = & node (Join-Path $PSScriptRoot 'backup.mjs') $Data $staging
if ($LASTEXITCODE -ne 0) {
  Remove-Item -Recurse -Force $staging -ErrorAction SilentlyContinue
  throw 'The backup failed. Nothing was written.'
}
Compress-Archive -Path (Join-Path $staging '*') -DestinationPath $zip -Force
Remove-Item -Recurse -Force $staging

Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::OpenRead($zip)
$names = $archive.Entries | ForEach-Object { $_.FullName }
$archive.Dispose()
if ($names -notcontains 'house.db' -or $names -notcontains 'secret.key') {
  Remove-Item -Force $zip
  throw 'The zip is missing the database or the key. Backup removed; nothing usable was written.'
}
Write-Host "Backed up to $zip"
Write-Host "Contains: $summary"
