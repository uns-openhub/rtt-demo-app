# Verifies the UNS-facing controller endpoint used by the application.
. "$PSScriptRoot\00-common.ps1"

Write-Log "STEP 06 - UNS connection"
$podman=Ensure-Podman
$selected=$null
foreach($endpoint in (Get-OpenHubEndpoints -Podman $podman)){
    if(Wait-Tcp -ComputerName $endpoint.Host -Port 3200 -TimeoutSeconds 30){ $selected=$endpoint; break }
}
if(-not $selected){ Fail-Step "UNS controller connection failed on localhost and the Podman VM address." }

$graphql=Test-Http ($selected.Address + ":3200/graphql")
if($graphql -eq 200 -or $graphql -eq 405){
    Write-Log "UNS/OpenHub GraphQL endpoint is reachable (HTTP $graphql)." "OK"
}else{
    Write-Log "GraphQL endpoint returned HTTP $graphql. Authentication/API readiness still needs to be checked by the GUI." "WARN"
}

$web=Test-Http ($selected.Address + ":8180/")
if($web -eq 200){ Write-Log "UNS web path through Caddy is reachable." "OK" }
else{ Write-Log "Caddy web endpoint returned HTTP $web." "WARN" }

Write-Log "UNS transport connection is ready. User authentication remains in Furnace Simulation/OpenHub login." "OK"
