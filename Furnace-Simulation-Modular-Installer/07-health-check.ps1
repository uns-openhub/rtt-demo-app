# Final readiness check. This only inspects the existing Compose project;
# it never creates, replaces, or removes containers.
. "$PSScriptRoot\00-common.ps1"

Write-Log "STEP 07 - Final health check"
$podman=Ensure-Podman
$runtime=Get-Runtime
if(-not $runtime){ Fail-Step "Runtime compose file not found." }

function Get-ExistingContainers {
    $r=Invoke-Native $podman @("ps","-a","--format","{{.Names}}|{{.State}}|{{.Labels}}") -AllowFailure
    if($r.ExitCode -ne 0){ Fail-Step "Could not inspect existing Podman containers.`n$($r.Output)" }
    return @($r.Output -split "`r?`n" | Where-Object { $_ -match '\|' } | ForEach-Object {
        $p=$_ -split '\|',3
        $labels=if($p.Count -ge 3){$p[2].Trim()}else{''}
        $project=''
        if($labels -match '(?:com|io\.podman)\.docker\.compose\.project[=:]([^,}]+)'){ $project=$matches[1] }
        [pscustomobject]@{ Name=$p[0].Trim(); State=$p[1].Trim(); Project=$project }
    })
}

$requiredServices=@{
    'postgres'='PostgreSQL'; 'mosquitto'='Mosquitto'; 'caddy'='Caddy';
    'questdb'='QuestDB'; 'uns-openhub-controller'='OpenHub Controller'
}
$containers=Get-ExistingContainers
$missing=@()
foreach($service in $requiredServices.Keys){
    $match=@($containers | Where-Object {
        ($_.Project -eq 'uns-openhub-runtime' -or $_.Name -match '^uns-openhub-runtime[-_]') -and
        $_.Name -match "(^|[-_])$([regex]::Escape($service))([-_]|$)" -and $_.State -match '^running'
    })
    if($match.Count -eq 0){
        $missing += $service
        Write-Log "$($requiredServices[$service]) Compose service is not running." "ERROR"
    }else{
        Write-Log "$($requiredServices[$service]) Compose service is running." "OK"
    }
}
if($missing.Count -gt 0){ Fail-Step "Required Compose services are not running: $($missing -join ', ')." }

$selected=$null
foreach($endpoint in (Get-OpenHubEndpoints -Podman $podman)){
    if(Wait-Tcp -ComputerName $endpoint.Host -Port 3200 -TimeoutSeconds 30){ $selected=$endpoint; break }
}
if(-not $selected){ Fail-Step "No reachable OpenHub endpoint was found on localhost or the Podman VM." }
$vmHost=$selected.Host
$controllerHealth=Test-Http ($selected.Address + ":3200/api/healthcheck")
if($controllerHealth -ne 200){ Fail-Step "OpenHub Controller readiness check returned HTTP $controllerHealth." }
Write-Log "OpenHub Controller readiness endpoint returned HTTP 200." "OK"

$rtt=@($containers | Where-Object { $_.Name -match '^rtt-demo-app($|[-_])' -and $_.State -match '^running' })
if($rtt.Count -gt 0){
    Write-Log "Existing controller-managed rtt-demo-app container is running; no RTT container was created." "OK"
}else{
    Write-Log "No running rtt-demo-app container was found. RTT is controller-managed and must be discovered by OpenHub/GUI; no container was created." "WARN"
}

$ports=@(
    @{P=5432;N="PostgreSQL"},
    @{P=1883;N="Mosquitto"},
    @{P=9001;N="Mosquitto WebSocket"},
    @{P=8180;N="Caddy/OpenHub Web"},
    @{P=2019;N="Caddy Admin"},
    @{P=9000;N="QuestDB HTTP"},
    @{P=8812;N="QuestDB PGWire"},
    @{P=9009;N="QuestDB ILP"},
    @{P=3200;N="OpenHub Controller"}
)
$failed=$false
foreach($x in $ports){
    if(Wait-Tcp -ComputerName $vmHost -Port $x.P -TimeoutSeconds 10){
        Write-Log "$($x.N) : port $($x.P) READY" "OK"
    }else{
        Write-Log "$($x.N) : port $($x.P) NOT READY" "ERROR"
        $failed=$true
    }
}
if($failed){ Fail-Step "One or more backend services are not reachable. Check $script:LogFile and Podman logs." }
Write-Log "ALL REQUIRED BACKEND CONNECTIONS ARE READY." "OK"
