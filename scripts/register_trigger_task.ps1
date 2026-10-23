# register_trigger_task.ps1 - Register the external trigger for the daily snapshot.
# Task name "StockDarkPublish" runs at 16:05 and 17:05 (Asia/Shanghai) and calls
# GitHub's workflow_dispatch API, because GitHub's own schedule proved unreliable
# for this repository (zero scheduled runs in a full day of testing).
# Pure ASCII on purpose (Windows PowerShell 5.1 reads .ps1 as ANSI).
#
# Re-run this script after moving the project or changing the times.
$ErrorActionPreference = 'Stop'

$taskName = 'StockDarkPublish'
$workDir = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node -ErrorAction Stop).Source
$ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

$script = Join-Path $workDir 'scripts\ci\run-trigger.ps1'
$arg = '-NoProfile -ExecutionPolicy Bypass -File "' + $script + '" -NodePath "' + $node + '"'

$action = New-ScheduledTaskAction -Execute $ps -Argument $arg -WorkingDirectory $workDir
$triggers = @(
    (New-ScheduledTaskTrigger -Daily -At '16:05'),
    (New-ScheduledTaskTrigger -Daily -At '17:05')
)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 1) `
    -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $triggers -Settings $settings `
    -Description 'Trigger GitHub Actions daily snapshot at 16:05 / 17:05' -Force | Out-Null

Write-Output ('Registered task: ' + $taskName + ' (16:05, 17:05)')
Write-Output ('  node: ' + $node)
Get-ScheduledTask -TaskName $taskName | Select-Object TaskName, State
