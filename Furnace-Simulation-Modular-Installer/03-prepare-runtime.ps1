# Finds the packaged runtime and prepares runtime.env/secrets.
. "$PSScriptRoot\00-common.ps1"

Write-Log "STEP 03 - Runtime files"
$runtime=Get-Runtime
if(-not $runtime){ Fail-Step "docker-compose.yml was not found. Put the runtime/compose files in the Furnace Simulation package before running the installer." }
Write-Log "Compose: $($runtime.ComposeFile)" "OK"
Ensure-RuntimeEnv -Runtime $runtime
