$ErrorActionPreference = "Stop"

$PilotClawDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$CopilotExtDir = Join-Path $HOME ".copilot\extensions"
$StateDir = Join-Path $env:LOCALAPPDATA "PilotClaw"
$LegacyStateDir = Join-Path $env:LOCALAPPDATA "Clawpilot"
$CompatStateDir = Join-Path $HOME ".pilotclaw"
$LegacyCompatStateDir = Join-Path $HOME ".clawpilot"
$BinDir = Join-Path $StateDir "bin"
$Extensions = @("spawn", "scheduler", "heartbeat", "channels", "daemon", "gateway", "orchestrator", "memory-db", "vault", "fallback")

Write-Host "🦞 PilotClaw CLI — Installing extensions for Windows"
Write-Host ""

if (-not (Get-Command copilot -ErrorAction SilentlyContinue)) {
    throw "Copilot CLI not found on PATH. Install GitHub Copilot CLI first, then re-run install.ps1."
}
Write-Host "✅ Copilot CLI found: $((& copilot --version 2>$null) -join ' ')"

$missingOptional = @()
if (-not (Get-Command sqlite3 -ErrorAction SilentlyContinue)) { $missingOptional += "sqlite3 (for memory-db)" }
if (-not (Get-Command age -ErrorAction SilentlyContinue)) { $missingOptional += "age (for vault)" }
if ($missingOptional.Count -gt 0) {
    Write-Host ""
    Write-Host "ℹ️  Optional dependencies not found:"
    foreach ($dep in $missingOptional) { Write-Host "   • $dep" }
    Write-Host "   Install options: winget install SQLite.SQLite; winget install FiloSottile.age"
}

function Copy-LegacyState {
    New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
    foreach ($item in @("spawned", "heartbeat", "vault", "logs", "scheduler", "channels", "orchestrator", "inbox", "processing", "processed", "history", "scripts", "gateway", "memory.db")) {
        $src = Join-Path $LegacyStateDir $item
        $dest = Join-Path $StateDir $item
        if ((Test-Path -LiteralPath $src) -and (-not (Test-Path -LiteralPath $dest))) {
            Copy-Item -LiteralPath $src -Destination $dest -Recurse -Force
        }
    }
}

if ((Test-Path -LiteralPath $LegacyStateDir -PathType Container) -and (Test-Path -LiteralPath (Join-Path $LegacyStateDir "src\install.ps1"))) {
    Copy-LegacyState
    Write-Host "✅ Copied legacy state from source checkout: $LegacyStateDir → $StateDir"
} elseif ((-not (Test-Path -LiteralPath $StateDir)) -and (Test-Path -LiteralPath $LegacyStateDir -PathType Container)) {
    Move-Item -LiteralPath $LegacyStateDir -Destination $StateDir
    Write-Host "✅ Migrated state: $LegacyStateDir → $StateDir"
} elseif (Test-Path -LiteralPath $LegacyStateDir -PathType Container) {
    Copy-LegacyState
    Write-Host "✅ Preserved existing PilotClaw state; copied missing legacy files from $LegacyStateDir"
}
if ((-not (Test-Path -LiteralPath $CompatStateDir)) -and (Test-Path -LiteralPath $LegacyCompatStateDir -PathType Container)) {
    Move-Item -LiteralPath $LegacyCompatStateDir -Destination $CompatStateDir
    Write-Host "✅ Migrated compatibility state: $LegacyCompatStateDir → $CompatStateDir"
}

$stateSubdirs = @("spawned", "heartbeat", "vault", "logs", "scheduler", "channels", "orchestrator", "inbox", "processing", "processed", "history", "scripts", "gateway")
New-Item -ItemType Directory -Force -Path $StateDir, $CompatStateDir, $BinDir | Out-Null
foreach ($subdir in $stateSubdirs) {
    New-Item -ItemType Directory -Force -Path (Join-Path $StateDir $subdir) | Out-Null
}
Write-Host "✅ State directory: $StateDir"
Write-Host "ℹ️  Compatibility directory preserved/created: $CompatStateDir"

New-Item -ItemType Directory -Force -Path $CopilotExtDir | Out-Null

$legacyTaskNames = @("Clawpilot-daemon", "Clawpilot-gateway")
try {
    $legacyTaskNames += @(Get-ScheduledTask -TaskName "Clawpilot-*" -ErrorAction SilentlyContinue | Select-Object -ExpandProperty TaskName)
} catch {
    # Get-ScheduledTask is unavailable on some older systems; schtasks fallback below still removes known names.
}
foreach ($taskName in ($legacyTaskNames | Sort-Object -Unique)) {
    if (-not $taskName) { continue }
    & schtasks.exe /Delete /F /TN $taskName *> $null
    if ($LASTEXITCODE -eq 0) {
        Write-Host "✅ Removed legacy scheduled task: $taskName"
    }
}

foreach ($ext in $Extensions) {
    $legacyDestDir = Join-Path $CopilotExtDir "clawpilot-$ext"
    if (Test-Path -LiteralPath $legacyDestDir) {
        Remove-Item -LiteralPath $legacyDestDir -Recurse -Force
        Write-Host "✅ Removed legacy extension: clawpilot-$ext"
    }
}

$sharedLibSrc = Join-Path $PilotClawDir "extensions\_lib"
$sharedLibDest = Join-Path $CopilotExtDir "_lib"
if (Test-Path -LiteralPath $sharedLibSrc -PathType Container) {
    Remove-Item -LiteralPath $sharedLibDest -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Force -Path $sharedLibDest | Out-Null
    Copy-Item -Path (Join-Path $sharedLibSrc "*") -Destination $sharedLibDest -Recurse -Force
    Write-Host "✅ shared libs → $sharedLibDest"
}

$installed = 0
$skipped = 0
foreach ($ext in $Extensions) {
    $src = Join-Path $PilotClawDir "extensions\$ext\extension.mjs"
    $destDir = Join-Path $CopilotExtDir "pilotclaw-$ext"
    if (-not (Test-Path -LiteralPath $src)) {
        Write-Host "⏭️  $ext — not yet built, skipping"
        $skipped++
        continue
    }
    New-Item -ItemType Directory -Force -Path $destDir | Out-Null
    Copy-Item -LiteralPath $src -Destination (Join-Path $destDir "extension.mjs") -Force
    if ($ext -eq "gateway") {
        $serverEntry = Join-Path $PilotClawDir "extensions\gateway\server-entry.mjs"
        if (Test-Path -LiteralPath $serverEntry) {
            Copy-Item -LiteralPath $serverEntry -Destination (Join-Path $destDir "server-entry.mjs") -Force
        }
    }
    Write-Host "✅ $ext → $destDir"
    $installed++
}

$agentSyncSrc = Join-Path $PilotClawDir "scripts\import-openclaw-agents.mjs"
if (Test-Path -LiteralPath $agentSyncSrc) {
    $agentSyncDest = Join-Path $StateDir "scripts\import-openclaw-agents.mjs"
    Copy-Item -LiteralPath $agentSyncSrc -Destination $agentSyncDest -Force
    if (Get-Command node -ErrorAction SilentlyContinue) {
        & node $agentSyncDest
    }
}

Copy-Item -LiteralPath (Join-Path $PilotClawDir "pilotclaw.ps1") -Destination (Join-Path $BinDir "pilotclaw.ps1") -Force
Copy-Item -LiteralPath (Join-Path $PilotClawDir "pilotclaw.cmd") -Destination (Join-Path $BinDir "pilotclaw.cmd") -Force
Write-Host "✅ Launcher: $BinDir\pilotclaw.cmd"
Copy-Item -LiteralPath (Join-Path $PilotClawDir "pilotclaw.ps1") -Destination (Join-Path $BinDir "clawpilot.ps1") -Force
Copy-Item -LiteralPath (Join-Path $PilotClawDir "pilotclaw.cmd") -Destination (Join-Path $BinDir "clawpilot.cmd") -Force
Write-Host "✅ Compatibility launcher: $BinDir\clawpilot.cmd → pilotclaw"

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
$pathParts = @($userPath -split ';' | Where-Object { $_ })
if ($pathParts -notcontains $BinDir) {
    $newPath = if ($userPath) { "$userPath;$BinDir" } else { $BinDir }
    [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
    Write-Host "✅ Added launcher directory to user PATH. Restart PowerShell/cmd to refresh PATH."
}

Write-Host ""
Write-Host "🦞 Installed $installed extensions ($skipped skipped)"
Write-Host "Restart Copilot CLI or run /clear to load extensions."
Write-Host "State directory: $StateDir"
Write-Host ""
Write-Host "Usage:"
Write-Host "  copilot          # Normal Copilot CLI (new session each time)"
Write-Host "  pilotclaw        # Always resumes 'main' session (persistent)"
