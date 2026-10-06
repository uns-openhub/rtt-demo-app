# Main orchestrator. The installer only needs to run this script.
# It intentionally calls small scripts in a fixed order.
[CmdletBinding()]
param([switch]$PauseOnExit)

$ErrorActionPreference="Stop"
$root=$PSScriptRoot
$steps=@(
    "01-install-podman.ps1",
    "02-setup-wsl.ps1",
    "03-prepare-runtime.ps1",
    "04-start-services.ps1",
    "05-connect-openhub.ps1",
    "06-connect-uns.ps1",
    "07-health-check.ps1"
)

$logDir=Join-Path $env:LOCALAPPDATA "Furnace Simulation"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log=Join-Path $logDir "modular-install.log"

try{
    Add-Content -LiteralPath $log -Value "===== Furnace Simulation modular install START $(Get-Date) ====="
    foreach($step in $steps){
        Write-Host ""
        Write-Host "=============================================" -ForegroundColor Cyan
        Write-Host " RUNNING $step" -ForegroundColor Cyan
        Write-Host "=============================================" -ForegroundColor Cyan
        & (Join-Path $root $step)
        if($LASTEXITCODE -ne 0){ throw "$step returned exit code $LASTEXITCODE" }
    }
    Write-Host ""
    Write-Host "=============================================" -ForegroundColor Green
    Write-Host " FURNACE SIMULATION BACKEND READY" -ForegroundColor Green
    Write-Host "=============================================" -ForegroundColor Green
    Write-Host "OpenHub endpoint: selected by Podman host/VM connectivity checks"
    Write-Host "Controller endpoint: selected by Podman host/VM connectivity checks"
    Write-Host "Log: $log"
    Add-Content -LiteralPath $log -Value "===== SUCCESS $(Get-Date) ====="
    if($PauseOnExit){ Read-Host "Press Enter to close" | Out-Null }
    exit 0
}catch{
    $msg=$_.Exception.Message
    Add-Content -LiteralPath $log -Value "===== FAILED $(Get-Date) =====`r`n$msg"
    Write-Host ""
    Write-Host "DEPENDENCY SETUP FAILED" -ForegroundColor Red
    Write-Host $msg -ForegroundColor Red
    Write-Host "Log: $log" -ForegroundColor Yellow
    if($PauseOnExit){ Read-Host "Press Enter to close" | Out-Null }
    exit 1
}
