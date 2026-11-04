$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$legacyRoomIdPath = Join-Path $PSScriptRoot 'dev-secrets\room_id'
$homeserverConfigPath = Join-Path $PSScriptRoot 'dev-data\homeserver.yaml'
$policyDatabasePath = Join-Path $PSScriptRoot 'dev-data\nymph-policy.sqlite3'
$synapseDatabasePath = Join-Path $PSScriptRoot 'dev-data\homeserver.db'
$secretDirectory = Join-Path $PSScriptRoot 'dev-secrets'
$devAccountA = '@partner1-dev:localhost'
$devAccountB = '@partner2-dev:localhost'
$homeserver = 'http://127.0.0.1:8008'

foreach ($requiredPath in @($legacyRoomIdPath, $homeserverConfigPath, $policyDatabasePath, $synapseDatabasePath)) {
    if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
        throw "The existing local NYMPH environment is incomplete; required state is missing: $requiredPath"
    }
}

$container = 'nymph-local-dev-synapse-1'
$containerRunning = docker inspect --format '{{.State.Running}}' $container 2>$null
if ($LASTEXITCODE -ne 0 -or $containerRunning -ne 'true') {
    throw 'The existing local Synapse container must be running. This script will not initialize or recreate the original environment.'
}

function New-LocalSecret {
    param([string]$Path)

    if (Test-Path -LiteralPath $Path) {
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

New-LocalSecret (Join-Path $secretDirectory 'partner1_dev_password')
New-LocalSecret (Join-Path $secretDirectory 'partner2_dev_password')

$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupDirectory = Join-Path $PSScriptRoot "dev-backups\stage-3h-before-provisioning-$timestamp"
if (Test-Path -LiteralPath $backupDirectory) {
    throw 'A backup directory already exists for this timestamp. Refusing to overwrite it.'
}
New-Item -ItemType Directory -Path $backupDirectory -Force | Out-Null

function Backup-SqliteDatabase {
    param(
        [string]$Source,
        [string]$Destination
    )

    $python = 'import sqlite3,sys; src=sqlite3.connect("file:"+sys.argv[1]+"?mode=ro",uri=True); dst=sqlite3.connect(sys.argv[2]); src.backup(dst); result=dst.execute("PRAGMA integrity_check").fetchone()[0]; dst.close(); src.close(); print(result); sys.exit(0 if result=="ok" else 1)'
    & python -c $python $Source $Destination
    if ($LASTEXITCODE -ne 0) {
        throw "The SQLite backup could not be verified: $Destination"
    }
}

Backup-SqliteDatabase $synapseDatabasePath (Join-Path $backupDirectory 'homeserver.db')
Backup-SqliteDatabase $policyDatabasePath (Join-Path $backupDirectory 'nymph-policy.sqlite3')

$legacyRoomId = [System.IO.File]::ReadAllText($legacyRoomIdPath).Trim()
$verifyLegacyPolicy = 'import sqlite3,sys; db=sqlite3.connect("file:"+sys.argv[1]+"?mode=ro",uri=True); row=db.execute("SELECT room_id FROM nymph_room_policy WHERE id=1").fetchone(); db.close(); sys.exit(0 if row and row[0]==sys.argv[2] else 1)'
& python -c $verifyLegacyPolicy $policyDatabasePath $legacyRoomId
if ($LASTEXITCODE -ne 0) {
    throw 'The archived room ID does not match the existing server-side room policy. No account or room provisioning was attempted.'
}

function Copy-VerifiedFiles {
    param(
        [string]$SourceDirectory,
        [string]$DestinationDirectory,
        [string[]]$ExcludedNames = @()
    )

    $sourceRoot = (Resolve-Path -LiteralPath $SourceDirectory).Path.TrimEnd('\') + '\'
    $files = Get-ChildItem -LiteralPath $SourceDirectory -File -Force -Recurse |
        Where-Object { $ExcludedNames -notcontains $_.Name }
    foreach ($file in $files) {
        $relativePath = $file.FullName.Substring($sourceRoot.Length)
        $destinationPath = Join-Path $DestinationDirectory $relativePath
        $destinationParent = Split-Path -Parent $destinationPath
        New-Item -ItemType Directory -Path $destinationParent -Force | Out-Null
        Copy-Item -LiteralPath $file.FullName -Destination $destinationPath
        $sourceHash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
        $backupHash = (Get-FileHash -LiteralPath $destinationPath -Algorithm SHA256).Hash
        if ($sourceHash -ne $backupHash) {
            throw "A persistent-state backup did not verify: $relativePath"
        }
    }
}

$excludedDatabaseFiles = @(
    'homeserver.db',
    'homeserver.db-wal',
    'homeserver.db-shm',
    'homeserver.db-journal',
    'nymph-policy.sqlite3',
    'nymph-policy.sqlite3-wal',
    'nymph-policy.sqlite3-shm',
    'nymph-policy.sqlite3-journal'
)
Copy-VerifiedFiles `
    (Join-Path $PSScriptRoot 'dev-data') `
    (Join-Path $backupDirectory 'dev-data') `
    $excludedDatabaseFiles
Copy-VerifiedFiles $secretDirectory (Join-Path $backupDirectory 'dev-secrets')

$matrixProfiles = Join-Path (Split-Path $PSScriptRoot -Parent) '.matrix-e2e'
if (Test-Path -LiteralPath $matrixProfiles -PathType Container) {
    $profileRoot = (Resolve-Path -LiteralPath $matrixProfiles).Path.TrimEnd('\')
    $activeProfileUsers = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |
        Where-Object { $_.CommandLine -and $_.CommandLine.Contains($profileRoot) }
    if ($activeProfileUsers) {
        throw 'Close Matrix test browsers before backing up their persistent crypto profiles. No account or room provisioning was attempted.'
    }
    Copy-VerifiedFiles $matrixProfiles (Join-Path $backupDirectory '.matrix-e2e')
}

$compose = @(
    'compose',
    '--project-name', 'nymph-local-dev',
    '--env-file', '.env.dev',
    '-f', 'compose.dev.yaml'
)

& docker @compose up -d synapse
if ($LASTEXITCODE -ne 0) {
    throw 'Could not load the additive development policy into the existing Synapse instance.'
}

$ready = $false
for ($attempt = 0; $attempt -lt 90; $attempt++) {
    try {
        $null = Invoke-RestMethod -Uri "$homeserver/_matrix/client/versions" -TimeoutSec 2
        $ready = $true
        break
    } catch {
        Start-Sleep -Seconds 2
    }
}
if (-not $ready) {
    throw 'Synapse did not become ready after loading the additive policy. No new accounts were provisioned.'
}

$users = @(
    @{ Localpart = 'partner1-dev'; Secret = 'partner1_dev_password' },
    @{ Localpart = 'partner2-dev'; Secret = 'partner2_dev_password' }
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
        throw "Could not provision the development-only account $($user.Localpart)."
    }
}

$deviceIdPath = Join-Path $secretDirectory 'partner1_dev_device_id'
if (Test-Path -LiteralPath $deviceIdPath) {
    $deviceId = [System.IO.File]::ReadAllText($deviceIdPath).Trim()
} else {
    $deviceId = 'NYMPH_DEV_A_' + [Guid]::NewGuid().ToString('N')
    [System.IO.File]::WriteAllText($deviceIdPath, $deviceId, [System.Text.UTF8Encoding]::new($false))
}
$partnerBDeviceIdPath = Join-Path $secretDirectory 'partner2_dev_device_id'
if (Test-Path -LiteralPath $partnerBDeviceIdPath) {
    $partnerBDeviceId = [System.IO.File]::ReadAllText($partnerBDeviceIdPath).Trim()
} else {
    $partnerBDeviceId = 'NYMPH_DEV_B_' + [Guid]::NewGuid().ToString('N')
    [System.IO.File]::WriteAllText($partnerBDeviceIdPath, $partnerBDeviceId, [System.Text.UTF8Encoding]::new($false))
}

$password = [System.IO.File]::ReadAllText((Join-Path $secretDirectory 'partner1_dev_password')).Trim()
$loginBody = @{
    type = 'm.login.password'
    identifier = @{ type = 'm.id.user'; user = $devAccountA }
    password = $password
    device_id = $deviceId
    initial_device_display_name = 'NYMPH development Partner A'
} | ConvertTo-Json -Depth 4 -Compress
$session = Invoke-RestMethod -Uri "$homeserver/_matrix/client/v3/login" -Method Post -ContentType 'application/json' -Body $loginBody
$headers = @{ Authorization = "Bearer $($session.access_token)" }
$roomIdPath = Join-Path $secretDirectory 'dev_room_id'

try {
    $status = Invoke-RestMethod -Uri "$homeserver/_synapse/client/nymph/pairing/status" -Method Post -Headers $headers -ContentType 'application/json' -Body '{}'
    $roomId = $status.room_id
    if (-not $roomId -and (Test-Path -LiteralPath $roomIdPath)) {
        throw 'A development room ID exists locally but is not registered by the server; refusing to create another room.'
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
                    users = @{ $devAccountB = 0 }
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
            name = 'NYMPH Development'
            visibility = 'private'
            preset = 'private_chat'
            invite = @($devAccountB)
            creation_content = @{ 'm.federate' = $false }
            initial_state = $initialState
        } | ConvertTo-Json -Depth 12 -Compress
        $createdRoom = Invoke-RestMethod -Uri "$homeserver/_matrix/client/v3/createRoom" -Method Post -Headers $headers -ContentType 'application/json' -Body $roomBody
        $roomId = $createdRoom.room_id
    }

    if (-not $roomId) {
        throw 'The development room was not accepted by the server-side policy.'
    }
    $verifiedStatus = Invoke-RestMethod -Uri "$homeserver/_synapse/client/nymph/pairing/status" -Method Post -Headers $headers -ContentType 'application/json' -Body '{}'
    if ($verifiedStatus.room_id -ne $roomId) {
        throw 'The server-side development room does not match the created room.'
    }
    [System.IO.File]::WriteAllText($roomIdPath, $roomId, [System.Text.UTF8Encoding]::new($false))

    $viteConfiguration = @(
        "VITE_MATRIX_PARTNER_A_USER_ID=$devAccountA",
        "VITE_MATRIX_PARTNER_B_USER_ID=$devAccountB",
        "VITE_MATRIX_PARTNER_A_DEVICE_ID=$deviceId",
        "VITE_MATRIX_PARTNER_B_DEVICE_ID=$partnerBDeviceId"
    ) -join "`n"
    foreach ($mode in @('development', 'android')) {
        $configurationPath = Join-Path (Split-Path $PSScriptRoot -Parent) ".env.$mode.local"
        [System.IO.File]::WriteAllText($configurationPath, "$viteConfiguration`n", [System.Text.UTF8Encoding]::new($false))
    }
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

Write-Output 'Additive development accounts and room are ready.'
Write-Output "Partner A: $devAccountA"
Write-Output "Partner B: $devAccountB"
Write-Output "Development room: $roomId"
Write-Output "Verified pre-provisioning database/config backup: $backupDirectory"
Write-Output 'Local password and device-ID files were not printed.'
