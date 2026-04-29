param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Args
)

$ErrorActionPreference = "Stop"

$SessionName = "main"
$Autopilot = $true
$Yolo = $true
$CopilotExtraArgs = New-Object System.Collections.Generic.List[string]

function Get-PilotClawWorkspace {
    $openclawConfig = Join-Path $HOME ".openclaw\openclaw.json"
    if (Test-Path -LiteralPath $openclawConfig) {
        try {
            $config = Get-Content -LiteralPath $openclawConfig -Raw | ConvertFrom-Json
            $agents = @($config.agents.list)
            $defaultAgent = $agents | Where-Object { $_.default } | Select-Object -First 1
            if (-not $defaultAgent -and $agents.Count -gt 0) { $defaultAgent = $agents[0] }
            if ($defaultAgent.workspace -and (Test-Path -LiteralPath $defaultAgent.workspace -PathType Container)) {
                return $defaultAgent.workspace
            }
        } catch {
            # Fall through to conventional workspace locations.
        }
    }

    foreach ($candidate in @((Join-Path $HOME "clawd"), (Join-Path $HOME "openclaw"))) {
        if (Test-Path -LiteralPath $candidate -PathType Container) { return $candidate }
    }
    return $HOME
}

function Sync-OpenClawAgents {
    $syncScript = Join-Path $env:LOCALAPPDATA "PilotClaw\scripts\import-openclaw-agents.mjs"
    if ((Test-Path -LiteralPath $syncScript) -and (Get-Command node -ErrorAction SilentlyContinue)) {
        & node $syncScript | Out-Null
    }
}

$i = 0
while ($i -lt $Args.Count) {
    $arg = $Args[$i]
    if ($arg -eq "--no-yolo") {
        $Yolo = $false
        $i++
    } elseif ($arg -eq "--no-autopilot") {
        $Autopilot = $false
        $i++
    } elseif ($arg -eq "--session") {
        if ($i + 1 -ge $Args.Count) { throw "--session requires a value" }
        $SessionName = $Args[$i + 1]
        $i += 2
    } elseif ($arg -like "--session=*") {
        $SessionName = $arg.Substring("--session=".Length)
        $i++
    } elseif ($arg -eq "--") {
        for ($j = $i + 1; $j -lt $Args.Count; $j++) { $CopilotExtraArgs.Add($Args[$j]) }
        break
    } else {
        $CopilotExtraArgs.Add($arg)
        $i++
    }
}

$Workspace = Get-PilotClawWorkspace
Sync-OpenClawAgents

$copilotArgs = New-Object System.Collections.Generic.List[string]
if ($Autopilot) { $copilotArgs.Add("--autopilot") }
if ($Yolo) { $copilotArgs.Add("--allow-all") }
foreach ($arg in $CopilotExtraArgs) { $copilotArgs.Add($arg) }

Set-Location -LiteralPath $Workspace

& copilot "--resume=$SessionName" @copilotArgs
$exitCode = if ($null -eq $LASTEXITCODE) { 0 } else { $LASTEXITCODE }
if ($exitCode -ne 0) {
    & copilot "--name=$SessionName" @copilotArgs
    exit $LASTEXITCODE
}
exit $exitCode
