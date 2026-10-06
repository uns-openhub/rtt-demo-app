# Starts/restarts the backend without reinstalling dependencies.
. "$PSScriptRoot\00-common.ps1"

Write-Log "START BACKEND"
$podman=Ensure-Podman
Ensure-WSL
Ensure-PodmanMachine -Podman $podman
$runtime=Get-Runtime
if(-not $runtime){ Fail-Step "Runtime compose file not found." }
Ensure-RuntimeEnv -Runtime $runtime
Invoke-Compose -Podman $podman -Runtime $runtime -Arguments @("up","-d")
Write-Log "Backend start command completed." "OK"
& "$PSScriptRoot\05-connect-openhub.ps1"
& "$PSScriptRoot\06-connect-uns.ps1"
