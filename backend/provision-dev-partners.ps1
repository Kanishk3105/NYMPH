[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
    [switch]$ConfirmProvisioning
)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$script:provisioningShouldProcess = $PSCmdlet
$script:activeProvisioningOperation = 'preflight'

$confirmationPhrase = 'PROVISION ISOLATED NYMPH DEV MATRIX'
$repositoryRoot = Split-Path $PSScriptRoot -Parent
$isolatedDirectory = Join-Path $PSScriptRoot 'dev-isolated'
$secretDirectory = Join-Path $isolatedDirectory 'secrets'
$environmentFile = Join-Path $PSScriptRoot '.env.dev.isolated'
$composeFile = Join-Path $PSScriptRoot 'compose.dev.isolated.yaml'
$homeserver = 'http://127.0.0.1:18008'
$synapseContainerHomeserver = 'http://127.0.0.1:8008'
$partnerA = '@partner1-dev:nymph-dev.localhost'
$partnerB = '@partner2-dev:nymph-dev.localhost'
$projectName = 'nymph-stage3h1-dev'
$legacyRoomIdPath = Join-Path $PSScriptRoot 'dev-secrets\room_id'
$legacyDataPath = Join-Path $PSScriptRoot 'dev-data'
$legacySecretPath = Join-Path $PSScriptRoot 'dev-secrets'
$legacySnapshotPath = Join-Path $PSScriptRoot 'dev-backups'
$legacyProfiles = @(
    (Join-Path $repositoryRoot '.matrix-e2e\partner-a-live-2'),
    (Join-Path $repositoryRoot '.matrix-e2e\partner-b-live-2')
)

$proposedActions = @(
    @{ Target = 'External user-selected backup directory'; Action = 'Create authenticated encrypted backup of isolated PostgreSQL, Synapse data, deployment secrets, and closed development crypto profiles; restore-test to a temporary directory' },
    @{ Target = "$projectName isolated deployment"; Action = 'Create Partner A development account if missing; never reset an existing password' },
    @{ Target = "$projectName isolated deployment"; Action = 'Create Partner B development account if missing; never reset an existing password' },
    @{ Target = "$projectName isolated deployment"; Action = 'Create the one private, invite-only, encrypted, non-federatable development room if absent' },
    @{ Target = "$projectName isolated deployment"; Action = 'Write isolated device-ID files and app-local development homeserver configuration if absent' },
    @{ Target = 'External provisioning journal'; Action = 'Record completed operations and resources without secrets' }
)

if ($WhatIfPreference) {
    foreach ($action in $proposedActions) {
        Write-Output ("PLAN: {0}: {1}" -f $action.Target, $action.Action)
        $null = $PSCmdlet.ShouldProcess($action.Target, $action.Action)
    }
    return
}

if (-not $ConfirmProvisioning) {
    throw 'Provisioning is blocked. Review the plan, then pass -ConfirmProvisioning and type the exact phrase when prompted.'
}
$typedConfirmation = Read-Host "Type exactly '$confirmationPhrase' to authorize the isolated development migration"
if ($typedConfirmation -cne $confirmationPhrase) {
    throw 'The confirmation phrase did not match; no provisioning operation was attempted.'
}

foreach ($requiredPath in @($environmentFile, $composeFile, $legacyDataPath, $legacySecretPath, $legacySnapshotPath, $legacyRoomIdPath)) {
    if (-not (Test-Path -LiteralPath $requiredPath)) {
        throw "Required isolated deployment or legacy preservation state is missing: $requiredPath"
    }
}
$envValues = @{}
foreach ($line in Get-Content -LiteralPath $environmentFile) {
    if ($line -match '^\s*([A-Z0-9_]+)=(.*)$') {
        $envValues[$matches[1]] = $matches[2].Trim()
    }
}
if (
    $envValues['MATRIX_SERVER_NAME'] -ne 'nymph-dev.localhost' -or
    $envValues['DEV_HOMESERVER_URL'] -ne $homeserver -or
    $envValues['DEV_PARTNER_A_USER_ID'] -ne $partnerA -or
    $envValues['DEV_PARTNER_B_USER_ID'] -ne $partnerB
) {
    throw 'The isolated server name, client URL, or development account IDs do not match the approved isolated deployment.'
}
$expectedSecretDirectory = [System.IO.Path]::GetFullPath($secretDirectory)
foreach ($configuredSecretDirectory in @($env:DEV_SECRETS_DIR, $envValues['DEV_SECRETS_DIR'])) {
    if ($configuredSecretDirectory) {
        $resolvedSecretDirectory = [System.IO.Path]::GetFullPath($configuredSecretDirectory)
        if ($resolvedSecretDirectory -ne $expectedSecretDirectory) {
            throw 'DEV_SECRETS_DIR must resolve to the isolated development secrets directory.'
        }
    }
}

function Get-LegacyFingerprint {
    $items = [System.Collections.Generic.List[string]]::new()
    $paths = @($legacyDataPath, $legacySecretPath, $legacySnapshotPath) + $legacyProfiles
    foreach ($path in $paths) {
        if (-not (Test-Path -LiteralPath $path)) { continue }
        $item = Get-Item -LiteralPath $path -Force
        $files = if ($item.PSIsContainer) {
            Get-ChildItem -LiteralPath $path -File -Force -Recurse
        } else {
            @($item)
        }
        foreach ($file in $files) {
            $relative = $file.FullName.Substring($repositoryRoot.Length).TrimStart('\')
            $hash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
            $items.Add("$relative|$hash")
        }
    }
    return ($items | Sort-Object) -join "`n"
}

$legacyFingerprintBefore = Get-LegacyFingerprint
$dockerInfo = & docker info --format '{{.ServerVersion}}' 2>$null
if ($LASTEXITCODE -ne 0 -or -not $dockerInfo) {
    throw 'Docker Engine is unavailable; no isolated account or room provisioning was attempted.'
}

$composeArgs = @(
    'compose', '--project-name', $projectName,
    '--env-file', $environmentFile,
    '-f', $composeFile
)
$expectedContainer = "$projectName-synapse-1"
$containerRunning = & docker inspect --format '{{.State.Running}}' $expectedContainer 2>$null
if ($LASTEXITCODE -ne 0 -or $containerRunning -ne 'true') {
    throw 'The isolated Synapse service is not running under its dedicated project identity. Start only start-isolated-dev.ps1 first.'
}
$containerLabelsJson = & docker inspect --format '{{json .Config.Labels}}' $expectedContainer 2>$null
if ($LASTEXITCODE -ne 0 -or -not $containerLabelsJson) {
    throw 'Could not verify the isolated Synapse container project identity.'
}
$containerLabels = $containerLabelsJson | ConvertFrom-Json
if ($containerLabels.'com.docker.compose.project' -ne $projectName -or
    $containerLabels.'com.docker.compose.project.config_files' -ne [System.IO.Path]::GetFullPath($composeFile)) {
    throw 'The isolated Synapse service is not running under its dedicated project identity. Start only start-isolated-dev.ps1 first.'
}
$versionResponse = Invoke-WebRequest -Uri "$homeserver/_matrix/client/versions" -TimeoutSec 5 -UseBasicParsing
if ($versionResponse.StatusCode -ne 200) {
    throw 'The isolated Matrix client API is not ready.'
}
$versionResponse.Content | ConvertFrom-Json | Out-Null

$backupDirectory = Join-Path $env:USERPROFILE 'NYMPH-Backups'
$backupPath = Join-Path $backupDirectory (
    'nymph-stage3h1-dev-{0}.enc' -f (Get-Date -Format 'yyyyMMdd-HHmmss')
)
$journalRunId = '{0}-{1}' -f (Get-Date -Format 'yyyyMMdd-HHmmss'), [Guid]::NewGuid().ToString('N')
$journalPath = Join-Path $backupDirectory "nymph-stage3h1-provisioning-$journalRunId.json"
if (-not (Test-Path -LiteralPath $backupDirectory -PathType Container)) {
    if ($PSCmdlet.ShouldProcess($backupDirectory, 'Create external encrypted-backup and provisioning-journal directory')) {
        New-Item -ItemType Directory -Path $backupDirectory -Force | Out-Null
    } else {
        throw 'External backup directory creation was not authorized.'
    }
}
if (Test-Path -LiteralPath $journalPath) {
    throw 'The unique provisioning journal path already exists; refusing to overwrite it.'
}
$journal = [ordered]@{
    format = 'nymph-stage3h1-provisioning'
    version = 1
    started_at = (Get-Date).ToUniversalTime().ToString('o')
    project = $projectName
    homeserver = $homeserver
    server_name = 'nymph-dev.localhost'
    operations = @()
    resources = @(
        @{ type = 'account'; id = $partnerA; status = 'not_started' },
        @{ type = 'account'; id = $partnerB; status = 'not_started' },
        @{ type = 'room'; id = $null; status = 'not_started' }
    )
}

function Save-ProvisioningJournal {
    param([string]$Status, [string]$Operation)
    if (-not $script:provisioningShouldProcess.ShouldProcess($journalPath, "Record $Operation as $Status in the external provisioning journal")) {
        throw 'Provisioning journal update was not authorized; stopping before the next operation.'
    }
    $journal.operations += [ordered]@{
        operation = $Operation
        status = $Status
        completed_at = (Get-Date).ToUniversalTime().ToString('o')
    }
    $journalJson = $journal | ConvertTo-Json -Depth 8
    if (Test-Path -LiteralPath $journalPath -PathType Leaf) {
        [System.IO.File]::WriteAllText($journalPath, $journalJson, [System.Text.UTF8Encoding]::new($false))
    } else {
        $journalStream = [System.IO.File]::Open(
            $journalPath,
            [System.IO.FileMode]::CreateNew,
            [System.IO.FileAccess]::Write,
            [System.IO.FileShare]::None
        )
        try {
            $journalBytes = [System.Text.UTF8Encoding]::new($false).GetBytes($journalJson)
            $journalStream.Write($journalBytes, 0, $journalBytes.Length)
        } finally {
            $journalStream.Dispose()
        }
    }
}

function Invoke-ProvisioningStep {
    param(
        [Parameter(Mandatory)][string]$Target,
        [Parameter(Mandatory)][string]$Action,
        [Parameter(Mandatory)][string]$OperationName,
        [Parameter(Mandatory)][scriptblock]$Operation
    )
    $script:activeProvisioningOperation = $OperationName
    Save-ProvisioningJournal -Status 'started' -Operation $OperationName
    if (-not $script:provisioningShouldProcess.ShouldProcess($Target, $Action)) {
        throw "Provisioning step was declined: $OperationName. No later steps will run."
    }
    try {
        & $Operation
        Save-ProvisioningJournal -Status 'completed' -Operation $OperationName
    } catch {
        $operationFailureType = $_.Exception.GetType().Name
        try {
            Save-ProvisioningJournal -Status 'failed' -Operation $OperationName
        } catch {
            $journalFailureType = $_.Exception.GetType().Name
            throw "Provisioning step '$OperationName' failed (exception=$operationFailureType; journal_update_exception=$journalFailureType)."
        }
        throw "Provisioning step '$OperationName' failed (exception=$operationFailureType)."
    }
}

try {
    Invoke-ProvisioningStep `
        -Target $backupPath `
        -Action 'Create and restore-test an authenticated encrypted backup of isolated development state' `
        -OperationName 'encrypted-pre-provision-backup' `
        -Operation {
            & (Join-Path $PSScriptRoot 'backup-isolated-dev.ps1') -Mode Create -BackupPath $backupPath -Confirm:$false
            if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) { throw 'Encrypted backup creation failed.' }
            & (Join-Path $PSScriptRoot 'backup-isolated-dev.ps1') -Mode RestoreTest -BackupPath $backupPath -Confirm:$false
            if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) { throw 'Encrypted backup restore test failed.' }
        }

    foreach ($user in @(
        @{ Id = $partnerA; Localpart = 'partner1-dev'; PasswordFile = 'partner1_dev_password' },
        @{ Id = $partnerB; Localpart = 'partner2-dev'; PasswordFile = 'partner2_dev_password' }
    )) {
        $userPasswordPath = Join-Path $secretDirectory $user.PasswordFile
        if (-not (Test-Path -LiteralPath $userPasswordPath -PathType Leaf)) {
            if (-not $PSCmdlet.ShouldProcess($userPasswordPath, "Create an account credential for $($user.Id) after provisioning approval")) {
                throw "Creation of the approved account credential was declined: $($user.Id)"
            }
            $passwordBytes = New-Object byte[] 48
            $passwordGenerator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
            try {
                $passwordGenerator.GetBytes($passwordBytes)
                $newPassword = [Convert]::ToBase64String($passwordBytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
                [System.IO.File]::WriteAllText(
                    $userPasswordPath,
                    $newPassword,
                    [System.Text.UTF8Encoding]::new($false)
                )
            } finally {
                $passwordGenerator.Dispose()
                [Array]::Clear($passwordBytes, 0, $passwordBytes.Length)
            }
        }
        if ([System.IO.File]::ReadAllText($userPasswordPath).Trim().Length -lt 32) {
            throw "The approved account credential is invalid for $($user.Id)."
        }
        Invoke-ProvisioningStep `
            -Target $user.Id `
            -Action 'Create the isolated development account if missing; preserve any existing account password' `
            -OperationName "ensure-account-$($user.Localpart)" `
            -Operation {
                $accountPassword = [System.IO.File]::ReadAllText($userPasswordPath).Trim()
                try {
                    $accountPassword | & docker @composeArgs exec -T synapse register_new_matrix_user `
                        --exists-ok `
                        --user $user.Localpart `
                        --password-file /dev/stdin `
                        --no-admin `
                        --config /data/homeserver.yaml `
                        $synapseContainerHomeserver
                } finally {
                    $accountPassword = $null
                }
                if ($LASTEXITCODE -ne 0) {
                    throw "Could not ensure isolated account $($user.Localpart)."
                }
                $resource = $journal.resources | Where-Object { $_.id -eq $user.Id }
                $resource.status = 'ensured'
            }
    }

    $deviceAPath = Join-Path $secretDirectory 'partner1_dev_device_id'
    $deviceBPath = Join-Path $secretDirectory 'partner2_dev_device_id'
    foreach ($device in @(
        @{ Path = $deviceAPath; Prefix = 'NYMPH_DEV_A_' },
        @{ Path = $deviceBPath; Prefix = 'NYMPH_DEV_B_' }
    )) {
        if (-not (Test-Path -LiteralPath $device.Path)) {
            Invoke-ProvisioningStep `
                -Target $device.Path `
                -Action 'Create an isolated Matrix device-ID file if missing' `
                -OperationName 'create-device-id-file' `
                -Operation {
                    $id = $device.Prefix + [Guid]::NewGuid().ToString('N')
                    [System.IO.File]::WriteAllText($device.Path, $id, [System.Text.UTF8Encoding]::new($false))
                }
        }
    }

    $password = [System.IO.File]::ReadAllText((Join-Path $secretDirectory 'partner1_dev_password')).Trim()
    $deviceId = [System.IO.File]::ReadAllText($deviceAPath).Trim()
    $loginBody = @{
        type = 'm.login.password'
        identifier = @{ type = 'm.id.user'; user = $partnerA }
        password = $password
        device_id = $deviceId
        initial_device_display_name = 'NYMPH isolated development setup'
    } | ConvertTo-Json -Depth 4 -Compress
    $script:session = $null
    try {
        Invoke-ProvisioningStep `
            -Target $partnerA `
            -Action 'Authenticate the isolated Partner A setup device' `
            -OperationName 'authenticate-partner-a-setup-device' `
            -Operation {
                $script:session = Invoke-RestMethod -Uri "$homeserver/_matrix/client/v3/login" -Method Post -ContentType 'application/json' -Body $loginBody
                if ($script:session.user_id -ne $partnerA -or $script:session.device_id -ne $deviceId) {
                    throw 'Isolated setup authentication returned an unexpected account or device.'
                }
            }

        $headers = @{ Authorization = "Bearer $($script:session.access_token)" }
        $session = $script:session
        $roomStatus = Invoke-RestMethod -Uri "$homeserver/_synapse/client/nymph/pairing/status" -Method Post -Headers $headers -ContentType 'application/json' -Body '{}' -TimeoutSec 5
        $roomIdPath = Join-Path $secretDirectory 'dev_room_id'
        $existingRoomId = if (Test-Path -LiteralPath $roomIdPath) {
            [System.IO.File]::ReadAllText($roomIdPath).Trim()
        } else {
            $null
        }
        if ($roomStatus.room_id -and $existingRoomId -and $roomStatus.room_id -ne $existingRoomId) {
            throw 'The isolated policy room and local room record disagree; refusing to create or replace a room.'
        }
        if (-not $roomStatus.room_id -and $existingRoomId) {
            throw 'A local isolated room ID exists but the independent Synapse policy has no room; refusing to recreate it.'
        }

        if ($roomStatus.room_id) {
            $journal.resources[-1].id = $roomStatus.room_id
            $journal.resources[-1].status = 'already_present'
            Save-ProvisioningJournal -Status 'completed' -Operation 'verify-existing-development-room'
        } else {
            Invoke-ProvisioningStep `
                -Target "$projectName $partnerA / $partnerB" `
                -Action 'Create one private invite-only encrypted non-federatable development room' `
                -OperationName 'create-development-room' `
                -Operation {
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
                        name = 'NYMPH Isolated Development'
                        visibility = 'private'
                        preset = 'private_chat'
                        invite = @($partnerB)
                        creation_content = @{ 'm.federate' = $false }
                        initial_state = $initialState
                    } | ConvertTo-Json -Depth 12 -Compress
                    $created = Invoke-RestMethod -Uri "$homeserver/_matrix/client/v3/createRoom" -Method Post -Headers $headers -ContentType 'application/json' -Body $roomBody
                    if (-not $created.room_id) {
                        throw 'Synapse did not return the isolated room ID.'
                    }
                    $verified = Invoke-RestMethod -Uri "$homeserver/_synapse/client/nymph/pairing/status" -Method Post -Headers $headers -ContentType 'application/json' -Body '{}' -TimeoutSec 5
                    if ($verified.room_id -ne $created.room_id) {
                        throw 'The isolated server policy did not record the room that was just created.'
                    }
                    [System.IO.File]::WriteAllText($roomIdPath, $created.room_id, [System.Text.UTF8Encoding]::new($false))
                    $journal.resources[-1].id = $created.room_id
                    $journal.resources[-1].status = 'created'
                }
        }

        $roomStatus = Invoke-RestMethod -Uri "$homeserver/_synapse/client/nymph/pairing/status" -Method Post -Headers $headers -ContentType 'application/json' -Body '{}' -TimeoutSec 5
        $roomId = $roomStatus.room_id
        if (-not $roomId) { throw 'The isolated policy has no configured room after reconciliation.' }
        if (-not $existingRoomId -and -not (Test-Path -LiteralPath $roomIdPath)) {
            if ($PSCmdlet.ShouldProcess($roomIdPath, 'Write the isolated development room ID record')) {
                [System.IO.File]::WriteAllText($roomIdPath, $roomId, [System.Text.UTF8Encoding]::new($false))
            }
        }

        $viteLines = @(
            "VITE_MATRIX_HOMESERVER=$homeserver",
            "VITE_MATRIX_PARTNER_A_USER_ID=$partnerA",
            "VITE_MATRIX_PARTNER_B_USER_ID=$partnerB",
            "VITE_MATRIX_PARTNER_A_DEVICE_ID=$deviceId",
            "VITE_MATRIX_PARTNER_B_DEVICE_ID=$([System.IO.File]::ReadAllText($deviceBPath).Trim())"
        )
        foreach ($mode in @('development', 'android')) {
            $configPath = Join-Path $repositoryRoot ".env.$mode.local"
            $expected = ($viteLines -join "`n") + "`n"
            if (Test-Path -LiteralPath $configPath) {
                $current = [System.IO.File]::ReadAllText($configPath)
                if ($current -ne $expected) {
                    throw "Existing app-local Matrix configuration conflicts with the isolated deployment: $configPath"
                }
            } elseif ($PSCmdlet.ShouldProcess($configPath, 'Write isolated development app configuration')) {
                [System.IO.File]::WriteAllText($configPath, $expected, [System.Text.UTF8Encoding]::new($false))
            }
        }
    } finally {
        $session = $script:session
        if ($script:session -and $script:session.access_token) {
            if ($PSCmdlet.ShouldProcess($partnerA, 'Log out isolated Partner A setup session')) {
                try {
                    $null = Invoke-RestMethod -Uri "$homeserver/_matrix/client/v3/logout" -Method Post -Headers @{ Authorization = "Bearer $($session.access_token)" } -ContentType 'application/json' -Body '{}' -TimeoutSec 5
                } catch {
                    throw 'Could not confirm logout of the isolated setup session.'
                }
            }
        }
        $password = $null
        $loginBody = $null
        $headers = $null
        $script:session = $null
    }

    $legacyFingerprintAfter = Get-LegacyFingerprint
    if ($legacyFingerprintBefore -cne $legacyFingerprintAfter) {
        throw 'Legacy environment fingerprint changed. Stop immediately; do not retry provisioning.'
    }
    Save-ProvisioningJournal -Status 'completed' -Operation 'verify-legacy-state-unchanged'
    Write-Output 'Isolated development accounts and room are ready.'
    Write-Output "Partner IDs: $partnerA and $partnerB"
    Write-Output "Matrix server: $homeserver ($projectName)"
    Write-Output 'No original Matrix account, room, database, config, or crypto profile was intentionally modified.'
} catch {
    $failureType = $_.Exception.GetType().Name
    $failureOperation = $script:activeProvisioningOperation
    $journalFailureType = 'none'
    try {
        Save-ProvisioningJournal -Status 'failed' -Operation 'provisioning-run'
    } catch {
        $journalFailureType = $_.Exception.GetType().Name
    }
    Write-Output "Provisioning stopped at '$failureOperation' (exception=$failureType; journal_update_exception=$journalFailureType)."
    Write-Output 'Do not retry until the isolated room/policy state and external journal are reviewed.'
    Write-Output 'Safe rollback scope is limited to the isolated development project and the explicitly recorded development accounts/room.'
    Write-Output 'Do not delete or alter any legacy account, room, database, config, secret, or crypto profile.'
    throw "Provisioning failed at '$failureOperation' (exception=$failureType; journal_update_exception=$journalFailureType)."
}
