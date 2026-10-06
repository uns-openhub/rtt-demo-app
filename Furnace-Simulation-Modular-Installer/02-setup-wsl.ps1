# Checks/sets up WSL required by Podman on Windows.
. "$PSScriptRoot\00-common.ps1"

Write-Log "STEP 02 - WSL"
Ensure-WSL
