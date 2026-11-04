$provisionerPath = Join-Path (Split-Path $PSScriptRoot -Parent) 'provision-dev-partners.ps1'
$backendPath = Split-Path $PSScriptRoot -Parent
$legacyFiles = @(
    (Join-Path $PSScriptRoot '..\dev-data\homeserver.db'),
    (Join-Path $PSScriptRoot '..\dev-data\nymph-policy.sqlite3'),
    (Join-Path $PSScriptRoot '..\dev-data\homeserver.yaml'),
    (Join-Path $PSScriptRoot '..\dev-secrets\room_id'),
    (Join-Path $PSScriptRoot '..\dev-secrets\partner1_password'),
    (Join-Path $PSScriptRoot '..\dev-secrets\partner2_password'),
    (Join-Path $PSScriptRoot '..\dev-secrets\registration_shared_secret')
)

function Get-LegacyFileHashes {
    foreach ($path in $legacyFiles) {
        if (Test-Path -LiteralPath $path -PathType Leaf) {
            '{0}|{1}' -f [System.IO.Path]::GetFullPath($path), (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash
        }
    }
}

Describe 'Isolated Stage 3H provisioner safety gates' {
    It 'supports a non-mutating WhatIf plan covering account, room, backup and journal operations' {
        $before = @(Get-LegacyFileHashes)
        $output = & $provisionerPath -WhatIf 3>&1 4>&1 5>&1 | Out-String
        $after = @(Get-LegacyFileHashes)

        $output | Should Match 'Create Partner A development account'
        $output | Should Match 'Create Partner B development account'
        $output | Should Match 'Create the one private'
        $output | Should Match 'authenticated encrypted backup'
        $output | Should Match 'Record completed operations'
        $after | Should Be $before
    }

    It 'blocks provisioning without the explicit approval switch' {
        $before = @(Get-LegacyFileHashes) -join "`n"
        { & $provisionerPath } | Should Throw
        $after = @(Get-LegacyFileHashes) -join "`n"
        $after | Should Be $before
    }

    It 'blocks an incorrect typed confirmation phrase before any operation' {
        Mock Read-Host { return 'NOT THE APPROVED PHRASE' }
        { & $provisionerPath -ConfirmProvisioning } | Should Throw
        Assert-MockCalled Read-Host -Times 1
    }

    It 'keeps deployment and backup WhatIf runs free of filesystem side effects' {
        $environmentPath = Join-Path $backendPath '.env.dev.isolated'
        $secretPath = Join-Path $backendPath 'dev-isolated\secrets'
        $environmentExisted = Test-Path -LiteralPath $environmentPath
        $secretsExisted = Test-Path -LiteralPath $secretPath
        $backupPath = Join-Path $env:TEMP ('nymph-whatif-' + [Guid]::NewGuid().ToString('N') + '\backup.enc')

        $null = & (Join-Path $backendPath 'start-isolated-dev.ps1') -WhatIf 2>&1
        $null = & (Join-Path $backendPath 'backup-isolated-dev.ps1') -Mode Create -BackupPath $backupPath -WhatIf 2>&1

        (Test-Path -LiteralPath $environmentPath) | Should Be $environmentExisted
        (Test-Path -LiteralPath $secretPath) | Should Be $secretsExisted
        (Test-Path -LiteralPath (Split-Path $backupPath -Parent)) | Should Be $false
    }

    It 'rejects a secrets-directory override that could point at legacy credentials' {
        $previousSecretDirectory = $env:DEV_SECRETS_DIR
        $env:DEV_SECRETS_DIR = Join-Path $backendPath 'dev-secrets'
        try {
            { & (Join-Path $backendPath 'start-isolated-dev.ps1') } | Should Throw
        } finally {
            if ($null -eq $previousSecretDirectory) {
                Remove-Item Env:DEV_SECRETS_DIR -ErrorAction SilentlyContinue
            } else {
                $env:DEV_SECRETS_DIR = $previousSecretDirectory
            }
        }
    }

    It 'defines separate deployment database volumes and homeserver endpoint' {
        $compose = Get-Content -LiteralPath (Join-Path $backendPath 'compose.dev.isolated.yaml') -Raw
        $environment = Get-Content -LiteralPath (Join-Path $backendPath '.env.dev.isolated.example') -Raw
        $compose | Should Match 'nymph-stage3h1-dev-postgres-data'
        $compose | Should Match 'nymph-stage3h1-dev-synapse-data'
        $compose | Should Match '127\.0\.0\.1:\$\{DEV_MATRIX_PORT:-18008\}:8008'
        $environment | Should Match 'MATRIX_SERVER_NAME=nymph-dev\.localhost'
        $environment | Should Match 'DEV_HOMESERVER_URL=http://127\.0\.0\.1:18008'
    }

    It 'does not configure archived accounts in the isolated Synapse policy' {
        $config = Get-Content -LiteralPath (Join-Path $backendPath 'configure_isolated_dev_synapse.py') -Raw
        $config | Should Match '"legacy_pair_enabled": False'
        $config | Should Match 'nymph-dev\.localhost'
        $config | Should Not Match '@partner1:localhost'
        $config | Should Not Match '@partner2:localhost'
    }

    It 'reconciles existing development resources instead of resetting or recreating them' {
        $provisioner = Get-Content -LiteralPath $provisionerPath -Raw
        $provisioner | Should Match '--exists-ok'
        $provisioner | Should Match 'roomStatus\.room_id'
        $provisioner | Should Match 'refusing to create or replace a room'
        $provisioner | Should Match 'Save-ProvisioningJournal'
        $provisioner | Should Match 'Get-LegacyFingerprint'
    }

    It 'uses the parent ShouldProcess context inside provisioning helper functions' {
        $provisioner = Get-Content -LiteralPath $provisionerPath -Raw
        $provisioner | Should Match '\$script:provisioningShouldProcess = \$PSCmdlet'
        $provisioner | Should Match '\$script:provisioningShouldProcess\.ShouldProcess\(\$journalPath'
        $provisioner | Should Match '\$script:provisioningShouldProcess\.ShouldProcess\(\$Target'
    }

    It 'creates the first journal file without relying on unsupported Set-Content parameters' {
        $provisioner = Get-Content -LiteralPath $provisionerPath -Raw
        $provisioner | Should Match '\[System\.IO\.FileMode\]::CreateNew'
        $provisioner | Should Match '\[System\.IO\.File\]::WriteAllText\(\$journalPath'
        $provisioner | Should Not Match 'Set-Content[^\r\n]*-NoClobber'
        $provisioner | Should Match "Provisioning stopped at"
    }

    It 'uses the container-local Synapse API for account creation' {
        $provisioner = Get-Content -LiteralPath $provisionerPath -Raw
        $provisioner | Should Match "\$synapseContainerHomeserver = 'http://127\.0\.0\.1:8008'"
        $provisioner | Should Match '--config /data/homeserver\.yaml `\s+\$synapseContainerHomeserver'
        $provisioner | Should Not Match '--config /data/homeserver\.yaml `\s+\$homeserver'
    }

    It 'prompts before backup mutations and blocks the complete production Synapse Admin API prefix' {
        $backup = Get-Content -LiteralPath (Join-Path $backendPath 'backup-isolated-dev.ps1') -Raw
        $caddy = Get-Content -LiteralPath (Join-Path $backendPath 'Caddyfile') -Raw
        $promptPosition = $backup.IndexOf('$passphrase = Get-SecurePassphrase')
        $stopPosition = $backup.IndexOf('& docker stop $synapseContainer')
        $promptPosition | Should BeGreaterThan -1
        $stopPosition | Should BeGreaterThan $promptPosition
        $backup | Should Match 'UseSystemPasswordChar = \$true'
        $backup | Should Match 'ShortcutsEnabled = \$true'
        $backup | Should Not Match 'Read-Host'
        $backup | Should Not Match 'Set-Alias'
        ([regex]::Matches($backup, '\$PSCmdlet\.ShouldProcess\(').Count) | Should Be 3
        $backup | Should Match "'encrypt', 'decrypt', 'verify'"
        $backup | Should Match 'Invoke-BackupCipher -Operation verify'
        $backup | Should Match 'Protect-EncryptedBackupFile -Path \$BackupPath'
        $backup | Should Match 'Microsoft\.PowerShell\.Management\\Get-WmiObject Win32_Process'
        $backup | Should Match 'CREATE EXTENSION IF NOT EXISTS amcheck'
        $backup | Should Match 'pg_amcheck --database=synapse'
        $backup | Should Match '\$validation \| & docker exec -i \$containerName python -'
        $backup | Should Match 'unexpected accounts or rooms'
        $caddy | Should Match '@admin_api path /_synapse/admin /_synapse/admin/\*'
        $caddy | Should Match 'respond @admin_api 404'
    }
}
