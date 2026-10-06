# Verifies the OpenHub controller and web proxy are reachable.
. "$PSScriptRoot\00-common.ps1"

Write-Log "STEP 05 - OpenHub connection"
$podman=Ensure-Podman
$selected=$null
$endpoints=@(Get-OpenHubEndpoints -Podman $podman | Sort-Object @{Expression={if($_.Source -eq 'Podman VM address'){0}else{1}}})
$deadline=(Get-Date).AddSeconds(180)
while((Get-Date) -lt $deadline -and -not $selected){
    foreach($endpoint in $endpoints){
        $health=Test-Http ($endpoint.Address + ":3200/api/healthcheck")
        if($health -eq 200){
            $selected=$endpoint
            break
        }
    }
    if(-not $selected){ Start-Sleep -Seconds 3 }
}
if(-not $selected){ Fail-Step "OpenHub Controller /api/healthcheck did not return HTTP 200 within 180 seconds on the Podman VM or localhost." }
Write-Log "OpenHub Controller endpoint: $($selected.Address):3200 ($($selected.Source))." "OK"

Write-Log "OpenHub Controller health endpoint returned HTTP 200." "OK"

$web=Test-Http ($selected.Address + ":8180/")
if($web -eq 200){ Write-Log "OpenHub web/Caddy returned HTTP 200 at $($selected.Address):8180." "OK" }
else{ Write-Log "OpenHub web/Caddy returned HTTP $web at $($selected.Address):8180." "WARN" }
