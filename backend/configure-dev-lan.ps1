param(
    [Parameter(Mandatory = $true)]
    [string]$LanAddress
)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$address = [System.Net.IPAddress]::Parse($LanAddress)
$octets = $address.GetAddressBytes()
$isPrivateIPv4 = $address.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork -and (
    $octets[0] -eq 10 -or
    ($octets[0] -eq 172 -and $octets[1] -ge 16 -and $octets[1] -le 31) -or
    ($octets[0] -eq 192 -and $octets[1] -eq 168)
)
if (-not $isPrivateIPv4) {
    throw 'The development listener accepts only an RFC1918 IPv4 address.'
}

$ipConfig = Get-NetIPAddress -AddressFamily IPv4 -IPAddress $LanAddress -ErrorAction Stop |
    Where-Object { $_.AddressState -eq 'Preferred' } |
    Select-Object -First 1
if (-not $ipConfig) {
    throw 'The supplied address is not assigned to an active network interface.'
}
$profile = Get-NetConnectionProfile -InterfaceAlias $ipConfig.InterfaceAlias -ErrorAction Stop
if ($profile.NetworkCategory -ne 'Private') {
    throw "Network '$($profile.Name)' is classified as $($profile.NetworkCategory). Only run this on a trusted Wi-Fi network explicitly classified Private."
}
if (-not (Test-Path '..\dist\index.html')) {
    throw 'Build the React application first by running npm run build from the repository root.'
}

$envPath = Join-Path $PSScriptRoot '.env.dev'
if (-not (Test-Path $envPath)) {
    Copy-Item '.env.dev.example' $envPath
}
$lines = [System.Collections.Generic.List[string]]::new()
$lines.AddRange([string[]][System.IO.File]::ReadAllLines($envPath))
function Set-EnvValue {
    param([string]$Name, [string]$Value)
    $pattern = '^' + [regex]::Escape($Name) + '='
    $matches = @($lines | Where-Object { $_ -match $pattern })
    if ($matches.Count -gt 0) {
        for ($index = 0; $index -lt $lines.Count; $index++) {
            if ($lines[$index] -match $pattern) {
                $lines[$index] = "$Name=$Value"
                return
            }
        }
    }
    $lines.Add("$Name=$Value")
}

Set-EnvValue 'DEV_HOMESERVER_URL' "https://$LanAddress`:8443"
Set-EnvValue 'DEV_APP_ORIGINS' "http://localhost:5173,https://localhost,https://$LanAddress`:8443"
Set-EnvValue 'DEV_LAN_ADDRESS' $LanAddress
[System.IO.File]::WriteAllLines($envPath, $lines, [System.Text.UTF8Encoding]::new($false))

& docker compose --project-name nymph-local-dev --env-file .env.dev `
    -f compose.dev.yaml -f compose.dev-lan.yaml --profile lan `
    up -d --force-recreate synapse lan-proxy
if ($LASTEXITCODE -ne 0) {
    throw 'Could not start the local HTTPS LAN proxy and Synapse.'
}

$baseUrl = "https://$LanAddress`:8443"
$ready = $false
for ($attempt = 0; $attempt -lt 60; $attempt++) {
    $httpCode = & curl.exe --max-time 3 -k -sS -o NUL -w "%{http_code}" "$baseUrl/_matrix/client/versions" 2>$null
    if ($LASTEXITCODE -eq 0 -and $httpCode -eq '200') {
        $ready = $true
        break
    }
    Start-Sleep -Seconds 2
}
if (-not $ready) {
    & docker compose --project-name nymph-local-dev --env-file .env.dev `
        -f compose.dev.yaml -f compose.dev-lan.yaml --profile lan logs --tail=80 lan-proxy synapse
    throw 'The local HTTPS endpoint did not become reachable.'
}

$certSource = Join-Path $PSScriptRoot 'dev-caddy-data\caddy\pki\authorities\local\root.crt'
$certDestination = Join-Path $PSScriptRoot 'dev-caddy-root.crt'
if (-not (Test-Path $certSource)) {
    throw 'Caddy started, but its local CA certificate was not found. Inspect the lan-proxy logs.'
}
Copy-Item $certSource $certDestination -Force

Write-Output "Local HTTPS endpoint: $baseUrl"
Write-Output "Caddy public root certificate: $certDestination"
Write-Output 'Install only this public root certificate on both Android devices; never copy the Caddy private key.'
Write-Output 'Run Enable-NymphDevLanFirewall.ps1 in an elevated PowerShell window to allow TCP 8443 from this Wi-Fi subnet only.'
