# Installs/checks Podman only.
. "$PSScriptRoot\00-common.ps1"

Write-Log "STEP 01 - Podman"
$podman=Ensure-Podman
Write-Log "Podman dependency is ready." "OK"
