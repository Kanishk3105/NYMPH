$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

if (-not (Test-Path '.env.dev')) {
    Copy-Item '.env.dev.example' '.env.dev'
}

$secretDirectory = Join-Path $PSScriptRoot 'dev-secrets'
New-Item -ItemType Directory -Path $secretDirectory -Force | Out-Null

function New-LocalSecret {
    param([string]$Path)

    if (Test-Path $Path) {
        return
    }

    $bytes = New-Object byte[] 48
    $generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $generator.GetBytes($bytes)
        $value = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
        [System.IO.File]::WriteAllText($Path, $value, [System.Text.UTF8Encoding]::new($false))
    } finally {
        $generator.Dispose()
        [Array]::Clear($bytes, 0, $bytes.Length)
    }
}

New-LocalSecret (Join-Path $secretDirectory 'registration_shared_secret')
New-LocalSecret (Join-Path $secretDirectory 'partner1_password')
New-LocalSecret (Join-Path $secretDirectory 'partner2_password')
New-LocalSecret (Join-Path $secretDirectory 'partner1_dev_password')
New-LocalSecret (Join-Path $secretDirectory 'partner2_dev_password')

$compose = @(
    'compose',
    '--project-name', 'nymph-local-dev',
    '--env-file', '.env.dev',
    '-f', 'compose.dev.yaml'
)

if (-not (Test-Path 'dev-data\homeserver.yaml')) {
    & docker @compose --profile init run --rm synapse-generate
    if ($LASTEXITCODE -ne 0) {
        throw 'Synapse development configuration generation failed.'
    }
}

& docker @compose up -d synapse
if ($LASTEXITCODE -ne 0) {
    throw 'Could not start the local Synapse development service.'
}

$homeserver = 'http://127.0.0.1:8008'
$ready = $false
Write-Output 'Waiting for the local Synapse first-run migrations to finish.'
for ($attempt = 0; $attempt -lt 180; $attempt++) {
    try {
        $null = Invoke-RestMethod -Uri "$homeserver/_matrix/client/versions" -TimeoutSec 2
        $ready = $true
        break
    } catch {
        Start-Sleep -Seconds 2
    }
}
if (-not $ready) {
    & docker @compose logs --tail=80 synapse
    throw 'Synapse did not become ready. See the local container log above.'
}

$users = @(
    @{ Localpart = 'partner1'; Secret = 'partner1_password' },
    @{ Localpart = 'partner2'; Secret = 'partner2_password' }
)
foreach ($user in $users) {
    & docker @compose exec -T synapse register_new_matrix_user `
        --exists-ok `
        --user $user.Localpart `
        --password-file "/run/secrets/$($user.Secret)" `
        --no-admin `
        --config /data/homeserver.yaml `
        $homeserver
    if ($LASTEXITCODE -ne 0) {
        throw "Could not provision the local account $($user.Localpart)."
    }
}

$partnerA = '@partner1:localhost'
$partnerB = '@partner2:localhost'
$password = [System.IO.File]::ReadAllText((Join-Path $secretDirectory 'partner1_password')).Trim()
$loginBody = @{
    type = 'm.login.password'
    identifier = @{ type = 'm.id.user'; user = $partnerA }
    password = $password
    initial_device_display_name = 'NYMPH local development setup'
} | ConvertTo-Json -Depth 4 -Compress
$session = Invoke-RestMethod -Uri "$homeserver/_matrix/client/v3/login" -Method Post -ContentType 'application/json' -Body $loginBody
$headers = @{ Authorization = "Bearer $($session.access_token)" }
try {
$status = Invoke-RestMethod -Uri "$homeserver/_synapse/client/nymph/pairing/status" -Method Post -Headers $headers -ContentType 'application/json' -Body '{}'
$roomId = $status.room_id
$roomIdPath = Join-Path $secretDirectory 'room_id'
if (-not $roomId -and (Test-Path $roomIdPath)) {
    throw 'A local room ID exists, but Synapse policy has not recorded that room. Refusing to create another room.'
}

if (-not $roomId) {
    $initialState = @(
        @{ type = 'm.room.encryption'; state_key = ''; content = @{ algorithm = 'm.megolm.v1.aes-sha2' } },
        @{ type = 'm.room.join_rules'; state_key = ''; content = @{ join_rule = 'invite' } },
        @{ type = 'm.room.history_visibility'; state_key = ''; content = @{ history_visibility = 'joined' } },
        @{
            type = 'm.room.power_levels'
            state_key = ''
            content = @{
                users = @{ $partnerB = 0 }
                users_default = 0
                events_default = 0
                state_default = 100
                invite = 100
                kick = 100
                ban = 100
                redact = 100
            }
        }
    )
    $roomBody = @{
        name = 'NYMPH Local Development'
        visibility = 'private'
        preset = 'private_chat'
        invite = @($partnerB)
        creation_content = @{ 'm.federate' = $false }
        initial_state = $initialState
    } | ConvertTo-Json -Depth 12 -Compress
    $createdRoom = Invoke-RestMethod -Uri "$homeserver/_matrix/client/v3/createRoom" -Method Post -Headers $headers -ContentType 'application/json' -Body $roomBody
    $roomId = $createdRoom.room_id
}

if (-not $roomId) {
    throw 'The server policy did not record the private room. The local room was not accepted.'
}

$verifiedStatus = Invoke-RestMethod -Uri "$homeserver/_synapse/client/nymph/pairing/status" -Method Post -Headers $headers -ContentType 'application/json' -Body '{}'
if ($verifiedStatus.room_id -ne $roomId) {
    throw 'Synapse did not persist the expected private room in its server-side policy.'
}

[System.IO.File]::WriteAllText(
    $roomIdPath,
    $roomId,
    [System.Text.UTF8Encoding]::new($false)
)
} finally {
    try {
        if ($headers) {
            $null = Invoke-RestMethod -Uri "$homeserver/_matrix/client/v3/logout" -Method Post -Headers $headers -ContentType 'application/json' -Body '{}'
        }
    } finally {
        $password = $null
        $loginBody = $null
        $headers = $null
        $session = $null
    }
}

Write-Output 'Local-only Synapse is ready.'
Write-Output 'Partner A: @partner1:localhost'
Write-Output 'Partner B: @partner2:localhost'
Write-Output "Encrypted room: $roomId"
Write-Output 'Local passwords are stored under backend\dev-secrets and were not printed.'
