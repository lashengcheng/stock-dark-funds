# register_task.ps1 - Register daily scheduled task (17:00) for dark-funds snapshot.
# Task name is ASCII ("StockDarkDaily") to avoid encoding issues; re-run this script to update.
# workDir is derived from this script's own location (parent of .\scripts), so the project can be
# moved anywhere without editing this file. This file is pure ASCII on purpose: Windows
# PowerShell 5.1 reads .ps1 as the ANSI codepage, which corrupts any non-ASCII literal.
# Runs only when the user is logged on; StartWhenAvailable catches up missed runs at next boot.
$ErrorActionPreference = 'Stop'

$taskName = 'StockDarkDaily'
$workDir  = Split-Path -Parent $PSScriptRoot

# Locate node.exe (full path so the task does not depend on scheduler PATH)
$node = (Get-Command node -ErrorAction Stop).Source

# Run node.exe directly (no cmd.exe wrapper) so the Chinese install path never goes through a
# shell codepage. daily_job.js writes its own log to out\logs\job_<date>.log.
$action   = New-ScheduledTaskAction -Execute $node -Argument 'scripts\daily_job.js' -WorkingDirectory $workDir
$trigger  = New-ScheduledTaskTrigger -Daily -At '17:00'
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries `
            -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 3) `
            -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings `
  -Description 'Daily 17:00 dark-funds snapshot: fetch_all + backfill, archives to out/history' `
  -Force | Out-Null

Write-Output ('Registered task: ' + $taskName + ' (daily 17:00, node=' + $node + ')')
Get-ScheduledTask -TaskName $taskName | Select-Object TaskName, State
