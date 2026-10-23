# save-token.ps1 - Store a GitHub token for the daily publish trigger.
# The token is encrypted with Windows DPAPI (user scope): only the same Windows
# account on this machine can decrypt it. It never touches the repository.
# This file is intentionally pure ASCII: Windows PowerShell 5.1 reads .ps1 using
# the ANSI codepage, which corrupts non-ASCII literals.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\ci\save-token.ps1 -Token ghp_xxx
param(
    [Parameter(Mandatory = $true)][string]$Token
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$target = Join-Path $root '.gh-token.xml'

if ([string]::IsNullOrWhiteSpace($Token)) { throw 'Token is empty.' }

$secure = ConvertTo-SecureString $Token -AsPlainText -Force
$secure | ConvertFrom-SecureString | Set-Content -Path $target -Encoding ascii

Write-Output ('Saved encrypted token to ' + $target)
Write-Output ('Token length: ' + $Token.Length)
