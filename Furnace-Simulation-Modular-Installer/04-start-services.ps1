# Starts the existing Compose stack.
# PostgreSQL, Mosquitto, Caddy and QuestDB are CONTAINERS in this project;
# do not install separate native copies that can steal ports 5432/1883/8180/9000.
. "$PSScriptRoot\00-common.ps1"

Write-Log "STEP 04 - Start backend services"
$podman=Ensure-Podman
Ensure-WSL
Ensure-PodmanMachine -Podman $podman

$runtime=Get-Runtime
if(-not $runtime){ Fail-Step "Runtime compose file not found." }
Ensure-RuntimeEnv -Runtime $runtime

Write-Log "Pulling required images..."
Invoke-Compose -Podman $podman -Runtime $runtime -Arguments @("pull")

Write-Log "Starting PostgreSQL and infrastructure services..."
Invoke-Compose -Podman $podman -Runtime $runtime -Arguments @("up","-d","postgres","mosquitto","caddy","questdb")

$runtimePassword = $null
foreach($line in [IO.File]::ReadAllLines($script:RuntimeEnvFile)) {
    if($line -match '^POSTGRES_PASSWORD=(.*)$') { $runtimePassword = $matches[1] }
}
if(-not $runtimePassword) { Fail-Step "POSTGRES_PASSWORD was not found in the generated runtime environment." }

$postgresContainer = "$($script:ProjectName)-postgres-1"
$deadline = (Get-Date).AddSeconds(120)
$authenticated = $false
Write-Log "Waiting for PostgreSQL authenticated readiness before starting OpenHub Controller..."
while((Get-Date) -lt $deadline) {
    $check = Invoke-Native $podman @("exec",$postgresContainer,"sh","-c","PGPASSWORD='$runtimePassword' psql -U uns -d uns -h 127.0.0.1 -c 'SELECT 1' -At") -AllowFailure
    if($check.ExitCode -eq 0 -and $check.Output -match '1') {
        $authenticated = $true
        break
    }
    Start-Sleep -Seconds 3
}
if(-not $authenticated) { Fail-Step "PostgreSQL did not accept an authenticated connection for user uns/database uns within 120 seconds." }
Write-Log "PostgreSQL accepted the authenticated controller connection." "OK"

Write-Log "Starting OpenHub Controller..."
Invoke-Compose -Podman $podman -Runtime $runtime -Arguments @("up","-d","uns-openhub-controller")
Write-Log "Compose stack started." "OK"
