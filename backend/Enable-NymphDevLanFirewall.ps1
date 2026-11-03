param(
    [Parameter(Mandatory = $true)]
    [string]$LanAddress
)

$ErrorActionPreference = 'Stop'
$ipConfig = Get-NetIPAddress -AddressFamily IPv4 -IPAddress $LanAddress -ErrorAction Stop |
    Where-Object { $_.AddressState -eq 'Preferred' } |
    Select-Object -First 1
if (-not $ipConfig) {
    throw 'The supplied LAN address is not assigned to an active interface.'
}
$profile = Get-NetConnectionProfile -InterfaceAlias $ipConfig.InterfaceAlias -ErrorAction Stop
if ($profile.NetworkCategory -ne 'Private') {
    throw "Refusing to open the firewall on a $($profile.NetworkCategory) network. Use only a trusted Wi-Fi network classified Private."
}

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this script from an elevated PowerShell window.'
}

$ruleName = 'NYMPH local Matrix HTTPS (development)'
if (Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue) {
    Write-Output 'The scoped NYMPH development firewall rule already exists.'
    exit 0
}

New-NetFirewallRule `
    -DisplayName $ruleName `
    -Direction Inbound `
    -Action Allow `
    -Protocol TCP `
    -LocalPort 8443 `
    -LocalAddress $LanAddress `
    -RemoteAddress LocalSubnet `
    -InterfaceAlias $ipConfig.InterfaceAlias `
    -Profile Private `
    -EdgeTraversalPolicy Block | Out-Null

Write-Output "Allowed TCP 8443 on $LanAddress through interface $($ipConfig.InterfaceAlias) from LocalSubnet only."
