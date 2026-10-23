# run-trigger.ps1 - Decrypt the stored token and trigger the GitHub workflow.
# Used by the Windows scheduled task "StockDarkPublish".
# Pure ASCII on purpose (Windows PowerShell 5.1 reads .ps1 as ANSI).
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\ci\run-trigger.ps1 [-NodePath node]
param(
    [string]$NodePath = 'node'
)

$ErrorActionPreference = 'Stop'

# node 输出的是 UTF-8，PowerShell 5.1 默认按 ANSI 解码会把中文变成乱码
try {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    $OutputEncoding = [System.Text.Encoding]::UTF8
}
catch { }

$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$tokenFile = Join-Path $root '.gh-token.xml'
$logDir = Join-Path $root 'out\logs'
$logFile = Join-Path $logDir 'trigger.log'

if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }

function Write-Log([string]$msg) {
    $line = '[' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '] ' + $msg
    Add-Content -Path $logFile -Value $line -Encoding utf8
    Write-Output $line
}

try {
    if (-not (Test-Path $tokenFile)) {
        Write-Log 'ERROR: .gh-token.xml not found. Run scripts\ci\save-token.ps1 first.'
        exit 2
    }

    $enc = (Get-Content -Path $tokenFile -Raw).Trim()
    $secure = ConvertTo-SecureString $enc
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
        $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    }
    finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    }

    $env:GH_TOKEN = $plain
    $script = Join-Path $root 'scripts\ci\trigger_github.js'

    Write-Log 'Triggering GitHub workflow ...'
    $out = & $NodePath $script 2>&1
    $code = $LASTEXITCODE
    foreach ($line in $out) { Write-Log ([string]$line) }
    Write-Log ('Exit code: ' + $code)
    exit $code
}
catch {
    Write-Log ('ERROR: ' + $_.Exception.Message)
    exit 1
}
