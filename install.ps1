$ErrorActionPreference = "Stop"

$ClawpilotDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$CopilotExtDir = Join-Path $HOME ".copilot\extensions"
$StateDir = Join-Path $env:LOCALAPPDATA "Clawpilot"
$CompatStateDir = Join-Path $HOME ".clawpilot"
$BinDir = Join-Path $StateDir "bin"
$Extensions = @("spawn", "scheduler", "heartbeat", "channels", "daemon", "orchestrator", "memory-db", "vault", "fallback")

Write-Host "🦞 Clawpilot CLI — Installing extensions for Windows"
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

$stateSubdirs = @("spawned", "heartbeat", "vault", "logs", "scheduler", "channels", "orchestrator", "inbox", "processing", "processed", "history", "scripts")
New-Item -ItemType Directory -Force -Path $StateDir, $CompatStateDir, $BinDir | Out-Null
foreach ($subdir in $stateSubdirs) {
    New-Item -ItemType Directory -Force -Path (Join-Path $StateDir $subdir) | Out-Null
}
Write-Host "✅ State directory: $StateDir"
Write-Host "ℹ️  Compatibility directory preserved/created: $CompatStateDir"

New-Item -ItemType Directory -Force -Path $CopilotExtDir | Out-Null

$sharedLibSrc = Join-Path $ClawpilotDir "extensions\_lib"
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
    $src = Join-Path $ClawpilotDir "extensions\$ext\extension.mjs"
    $destDir = Join-Path $CopilotExtDir "clawpilot-$ext"
    if (-not (Test-Path -LiteralPath $src)) {
        Write-Host "⏭️  $ext — not yet built, skipping"
        $skipped++
        continue
    }
    New-Item -ItemType Directory -Force -Path $destDir | Out-Null
    Copy-Item -LiteralPath $src -Destination (Join-Path $destDir "extension.mjs") -Force
    Write-Host "✅ $ext → $destDir"
    $installed++
}

$agentSyncSrc = Join-Path $ClawpilotDir "scripts\import-openclaw-agents.mjs"
if (Test-Path -LiteralPath $agentSyncSrc) {
    $agentSyncDest = Join-Path $StateDir "scripts\import-openclaw-agents.mjs"
    Copy-Item -LiteralPath $agentSyncSrc -Destination $agentSyncDest -Force
    if (Get-Command node -ErrorAction SilentlyContinue) {
        & node $agentSyncDest
    }
}

Copy-Item -LiteralPath (Join-Path $ClawpilotDir "clawpilot.ps1") -Destination (Join-Path $BinDir "clawpilot.ps1") -Force
Copy-Item -LiteralPath (Join-Path $ClawpilotDir "clawpilot.cmd") -Destination (Join-Path $BinDir "clawpilot.cmd") -Force
Write-Host "✅ Launcher: $BinDir\clawpilot.cmd"

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
Write-Host "  clawpilot        # Always resumes 'main' session (persistent)"
