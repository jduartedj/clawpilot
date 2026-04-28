$ErrorActionPreference = "Stop"

$CopilotExtDir = Join-Path $HOME ".copilot\extensions"
$StateDir = Join-Path $env:LOCALAPPDATA "Clawpilot"
$BinDir = Join-Path $StateDir "bin"
$Extensions = @("spawn", "scheduler", "heartbeat", "channels", "daemon", "gateway", "orchestrator", "memory-db", "vault", "fallback")

Write-Host "🦞 Clawpilot CLI — Uninstalling Windows extensions"
Write-Host ""

$taskNames = @("Clawpilot-daemon", "Clawpilot-gateway")
try {
    $taskNames += @(Get-ScheduledTask -TaskName "Clawpilot-*" -ErrorAction SilentlyContinue | Select-Object -ExpandProperty TaskName)
} catch {
    # Get-ScheduledTask is unavailable on some older systems; schtasks fallback below still removes known names.
}
$removedTasks = 0
foreach ($taskName in ($taskNames | Sort-Object -Unique)) {
    if (-not $taskName) { continue }
    & schtasks.exe /Delete /F /TN $taskName *> $null
    if ($LASTEXITCODE -eq 0) {
        Write-Host "🗑️  Removed scheduled task $taskName"
        $removedTasks++
    }
}

$removed = 0
foreach ($ext in $Extensions) {
    $destDir = Join-Path $CopilotExtDir "clawpilot-$ext"
    if (Test-Path -LiteralPath $destDir) {
        Remove-Item -LiteralPath $destDir -Recurse -Force
        Write-Host "🗑️  Removed clawpilot-$ext"
        $removed++
    }
}

$sharedLibDir = Join-Path $CopilotExtDir "_lib"
if (Test-Path -LiteralPath $sharedLibDir) {
    Remove-Item -LiteralPath $sharedLibDir -Recurse -Force
    Write-Host "🗑️  Removed shared Clawpilot extension libraries"
}

$launcherCmd = Join-Path $BinDir "clawpilot.cmd"
$launcherPs1 = Join-Path $BinDir "clawpilot.ps1"
Remove-Item -LiteralPath $launcherCmd, $launcherPs1 -Force -ErrorAction SilentlyContinue
Write-Host "🗑️  Removed launcher files from $BinDir"

Write-Host ""
Write-Host "Removed $removed extensions."
Write-Host "Removed $removedTasks scheduled tasks."
Write-Host "State directory preserved at: $StateDir"
Write-Host "To remove state, delete that directory manually after confirming you no longer need logs/secrets/history."
Write-Host "Restart Copilot CLI or run /clear to unload extensions."
