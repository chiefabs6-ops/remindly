# Update the Tether app installed on this PC without running the installer.
# Builds only tether.exe (no installer), closes Tether, swaps the file, and starts it again.
# Your data (%APPDATA%\ie.tether.app) is not touched; database updates run when the app starts.
#
#   npm run update-app
#
# Install Tether once with the installer first: this script only replaces an existing install.

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$target = Join-Path $env:LOCALAPPDATA 'Tether\tether.exe'
$built = Join-Path $repo 'apps\desktop\src-tauri\target\release\tether.exe'

if (-not (Test-Path $target)) {
    throw "Tether is not installed at $target. Run the installer once (npm run build), then use this."
}

Write-Host '1/3 Building tether.exe (no installer)...'
# Quick local build: skip the slow whole-program optimisation the installer build uses (lto, 1 codegen
# unit) and reuse earlier work, so an update takes a minute or two instead of several. Only affects
# this run; npm run build still makes the fully optimised installer.
$env:CARGO_PROFILE_RELEASE_LTO = 'false'
$env:CARGO_PROFILE_RELEASE_CODEGEN_UNITS = '16'
$env:CARGO_PROFILE_RELEASE_INCREMENTAL = 'true'
Push-Location $repo
try {
    # Cargo writes progress to stderr; judge the build by its exit code, not by stderr.
    $ErrorActionPreference = 'Continue'
    npm run tauri build -w apps/desktop -- --no-bundle
    $ErrorActionPreference = 'Stop'
    if ($LASTEXITCODE -ne 0) { throw "Build failed (exit $LASTEXITCODE). The installed app was not changed." }
} finally {
    Pop-Location
}
if (-not (Test-Path $built)) { throw "Build finished but $built is missing. The installed app was not changed." }

Write-Host '2/3 Closing Tether...'
$running = Get-Process -Name 'tether' -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $target }
$wasRunning = [bool]$running
foreach ($p in $running) {
    Stop-Process -Id $p.Id -Force
    if (-not $p.WaitForExit(10000)) { throw "Could not close Tether. Close it from the tray and run this again." }
}

Write-Host '3/3 Replacing the app...'
$backup = "$target.bak"
Copy-Item $target $backup -Force
try {
    # The file can stay locked for a moment after the process exits.
    $tries = 0
    while ($true) {
        try { Copy-Item $built $target -Force; break }
        catch {
            if (++$tries -ge 10) { throw }
            Start-Sleep -Milliseconds 500
        }
    }
} catch {
    $why = $_.Exception.Message
    try { Copy-Item $backup $target -Force }
    catch { throw "Could not replace $target ($why), and could not put the old version back. Copy $backup over $target by hand." }
    throw "Could not replace $target ($why). The old version was put back."
}

Start-Process -FilePath $target -WorkingDirectory (Split-Path $target)
$note = if ($wasRunning) { 'restarted' } else { 'started' }
Write-Host "Done. Tether was updated and $note."
Write-Host "The previous app file is kept at $backup. It can only open your data if this update added no database change."

