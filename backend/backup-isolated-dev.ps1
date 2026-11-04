[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
    [Parameter(Mandatory)]
    [ValidateSet('Create', 'RestoreTest')]
    [string]$Mode,

    [string]$BackupPath
)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$repositoryRoot = Split-Path $PSScriptRoot -Parent
$profileRoot = Join-Path $repositoryRoot '.matrix-e2e\dev-stage-3h'
$secretDirectory = Join-Path $PSScriptRoot 'dev-isolated\secrets'
$environmentFile = Join-Path $PSScriptRoot '.env.dev.isolated'
$scriptPath = Join-Path $PSScriptRoot 'secure-backup.mjs'
$projectName = 'nymph-stage3h1-dev'
$synapseContainer = "$projectName-synapse-1"
$postgresContainer = "$projectName-postgres-1"

if ($WhatIfPreference) {
    $actions = if ($Mode -eq 'Create') {
        @(
            @{ Target = 'External backup path'; Action = 'Stage isolated dev resources in a temporary directory' },
            @{ Target = $synapseContainer; Action = 'Stop only the isolated Synapse service for a consistent data-volume snapshot, then restart it' },
            @{ Target = $postgresContainer; Action = 'Create logical PostgreSQL dump from isolated database' },
            @{ Target = $synapseContainer; Action = 'Copy isolated Synapse volume and secrets' },
            @{ Target = 'Closed isolated browser profiles'; Action = 'Include development crypto profiles in the encrypted backup' },
            @{ Target = $BackupPath; Action = 'Encrypt backup with scrypt and AES-256-GCM' },
            @{ Target = 'Temporary staging data'; Action = 'Overwrite and remove plaintext staging data where supported' }
        )
    } else {
        @(
            @{ Target = $BackupPath; Action = 'Authenticate and decrypt encrypted backup' },
            @{ Target = 'Fresh temporary directory'; Action = 'Restore and verify file hashes without using original storage' },
            @{ Target = 'Disposable isolated PostgreSQL container and volume'; Action = 'Import the restored PostgreSQL dump and verify the restored schema' },
            @{ Target = 'Disposable no-network Synapse container and volume'; Action = 'Restore Synapse data and verify the config, signing key, and policy database' },
            @{ Target = 'Temporary plaintext restore'; Action = 'Overwrite and remove restored data where supported' }
        )
    }
    foreach ($action in $actions) {
        $null = $PSCmdlet.ShouldProcess($action.Target, $action.Action)
    }
    return
}

function Get-PlaintextPassphrase {
    $secure = Read-Host 'Offline backup passphrase (12+ characters)' -AsSecureString
    $pointer = [IntPtr]::Zero
    try {
        if ($secure.Length -lt 12) {
            throw 'Backup passphrase must contain at least 12 characters.'
        }
        $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
        return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    } finally {
        if ($pointer -ne [IntPtr]::Zero) {
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
        }
        $secure.Dispose()
    }
}

function Invoke-BackupCipher {
    param(
        [Parameter(Mandatory)][ValidateSet('encrypt', 'decrypt')][string]$Operation,
        [Parameter(Mandatory)][string]$InputPath,
        [Parameter(Mandatory)][string]$OutputPath,
        [Parameter(Mandatory)][string]$Passphrase
    )

    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = 'node'
    $startInfo.Arguments = '"{0}" {1} "{2}" "{3}"' -f $scriptPath, $Operation, $InputPath, $OutputPath
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardInput = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $startInfo
    if (-not $process.Start()) {
        throw 'Could not start the authenticated backup encryption utility.'
    }
    $process.StandardInput.WriteLine($Passphrase)
    $process.StandardInput.Close()
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    $process.WaitForExit()
    $stdout = $stdoutTask.GetAwaiter().GetResult()
    $stderr = $stderrTask.GetAwaiter().GetResult()
    if ($process.ExitCode -ne 0) {
        throw "Authenticated backup $Operation failed: $($stderr.Trim())"
    }
    if ($stdout -notmatch "^$Operation complete") {
        throw "Authenticated backup $Operation did not report completion."
    }
}

function Remove-PlaintextTree {
    param([Parameter(Mandatory)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
        return
    }
    foreach ($file in Get-ChildItem -LiteralPath $Path -File -Force -Recurse) {
        $stream = [System.IO.File]::Open(
            $file.FullName,
            [System.IO.FileMode]::Open,
            [System.IO.FileAccess]::Write,
            [System.IO.FileShare]::None
        )
        try {
            $stream.Position = 0
            $buffer = New-Object byte[] 65536
            $remaining = $stream.Length
            while ($remaining -gt 0) {
                $count = [Math]::Min($buffer.Length, $remaining)
                $stream.Write($buffer, 0, $count)
                $remaining -= $count
            }
            $stream.Flush($true)
            [Array]::Clear($buffer, 0, $buffer.Length)
        } finally {
            $stream.Dispose()
        }
    }
    Remove-Item -LiteralPath $Path -Recurse -Force
}

function Remove-PlaintextFile {
    param([Parameter(Mandatory)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return
    }
    $stream = [System.IO.File]::Open(
        $Path,
        [System.IO.FileMode]::Open,
        [System.IO.FileAccess]::ReadWrite,
        [System.IO.FileShare]::None
    )
    try {
        $buffer = New-Object byte[] 65536
        $remaining = $stream.Length
        $stream.Position = 0
        while ($remaining -gt 0) {
            $count = [Math]::Min($buffer.Length, $remaining)
            $stream.Write($buffer, 0, $count)
            $remaining -= $count
        }
        $stream.Flush($true)
        [Array]::Clear($buffer, 0, $buffer.Length)
    } finally {
        $stream.Dispose()
    }
    Remove-Item -LiteralPath $Path -Force
}

function Assert-OutsideRepository {
    param([Parameter(Mandatory)][string]$Path)
    $fullPath = [System.IO.Path]::GetFullPath($Path)
    $rootPath = [System.IO.Path]::GetFullPath($repositoryRoot).TrimEnd('\') + '\'
    if ($fullPath.StartsWith($rootPath, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'Encrypted backup files must be stored outside the repository.'
    }
    return $fullPath
}

function Assert-IsolatedSecretsPath {
    $expected = [System.IO.Path]::GetFullPath($secretDirectory)
    $configured = @($env:DEV_SECRETS_DIR)
    if (Test-Path -LiteralPath $environmentFile -PathType Leaf) {
        foreach ($line in Get-Content -LiteralPath $environmentFile) {
            if ($line -match '^\s*DEV_SECRETS_DIR=(.*)$') {
                $configured += $matches[1].Trim()
            }
        }
    }
    foreach ($path in $configured) {
        if ($path -and [System.IO.Path]::GetFullPath($path) -ne $expected) {
            throw 'DEV_SECRETS_DIR must resolve to the isolated development secrets directory.'
        }
    }
}

function Test-IsolatedComposeContainer {
    param([Parameter(Mandatory)][string]$ContainerName)

    $inspection = & docker inspect --format '{{.State.Running}}|{{json .Config.Labels}}' $ContainerName
    if ($LASTEXITCODE -ne 0) {
        return $false
    }
    $parts = "$inspection" -split '\|', 2
    if ($parts.Count -ne 2) {
        throw "Docker returned an invalid inspection result for '$ContainerName'."
    }
    $labels = $parts[1] | ConvertFrom-Json
    return $parts[0] -eq 'true' -and $labels.'com.docker.compose.project' -eq $projectName
}

function Assert-Manifest {
    param([Parameter(Mandatory)][string]$Root)
    $manifestPath = Join-Path $Root 'manifest.json'
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
        throw 'Restored backup manifest is missing.'
    }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    foreach ($entry in $manifest.files) {
        $path = Join-Path $Root $entry.path
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            throw 'Restored backup is incomplete.'
        }
        $actual = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash
        if ($actual -ne $entry.sha256) {
            throw 'Restored backup integrity verification failed.'
        }
    }
}

function Invoke-DisposablePostgresRestore {
    param([Parameter(Mandatory)][string]$DumpPath)

    $suffix = [Guid]::NewGuid().ToString('N')
    $volumeName = "nymph-stage3h1-restore-$suffix"
    $containerName = "nymph-stage3h1-restore-$suffix"
    $volumeCreated = $false
    $containerCreated = $false
    try {
        if (-not $PSCmdlet.ShouldProcess($volumeName, 'Create a disposable isolated PostgreSQL restore volume')) {
            throw 'Disposable PostgreSQL restore volume creation was not authorized.'
        }
        $null = & docker volume create $volumeName
        if ($LASTEXITCODE -ne 0) { throw 'Could not create the disposable PostgreSQL restore volume.' }
        $volumeCreated = $true

        if (-not $PSCmdlet.ShouldProcess($containerName, 'Start an isolated PostgreSQL restore-test container without published ports')) {
            throw 'Disposable PostgreSQL restore container startup was not authorized.'
        }
        $null = & docker run --detach `
            --name $containerName `
            --network none `
            --mount "source=$volumeName,target=/var/lib/postgresql/data" `
            --env POSTGRES_USER=synapse `
            --env POSTGRES_DB=synapse `
            --env POSTGRES_HOST_AUTH_METHOD=trust `
            'postgres:16.10-alpine'
        if ($LASTEXITCODE -ne 0) { throw 'Could not start the disposable PostgreSQL restore-test container.' }
        $containerCreated = $true

        $ready = $false
        for ($attempt = 0; $attempt -lt 30; $attempt++) {
            & docker exec $containerName pg_isready -U synapse -d synapse *> $null
            if ($LASTEXITCODE -eq 0) {
                $ready = $true
                break
            }
            Start-Sleep -Seconds 2
        }
        if (-not $ready) { throw 'The disposable PostgreSQL restore-test container did not become ready.' }

        if (-not $PSCmdlet.ShouldProcess($containerName, 'Copy the authenticated PostgreSQL dump into the disposable container')) {
            throw 'Copying the PostgreSQL dump into the disposable container was not authorized.'
        }
        & docker cp $DumpPath "${containerName}:/tmp/nymph-dev.dump"
        if ($LASTEXITCODE -ne 0) { throw 'Could not copy the PostgreSQL dump to the disposable container.' }

        if (-not $PSCmdlet.ShouldProcess($containerName, 'Restore the PostgreSQL dump in the disposable database')) {
            throw 'Restoring the PostgreSQL dump in the disposable database was not authorized.'
        }
        & docker exec $containerName pg_restore --exit-on-error -U synapse -d synapse /tmp/nymph-dev.dump
        if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL rejected the restored database dump.' }

        & docker exec $containerName pg_amcheck --database=synapse --username=synapse
        if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL consistency checks failed on the restored database.' }
        $validation = & docker exec $containerName psql -U synapse -d synapse -tAc "SELECT (SELECT count(*) FROM pg_catalog.pg_tables WHERE schemaname = 'public') || '|' || (SELECT count(*) FROM users) || '|' || (SELECT count(*) FROM rooms)"
        if ($LASTEXITCODE -ne 0) { throw 'Could not query restored Synapse account and room state.' }
        $counts = "$validation".Trim().Split('|')
        if ($counts.Count -ne 3 -or [int]$counts[0] -lt 1) {
            throw 'The disposable PostgreSQL restore did not contain the expected schema.'
        }
        if ([int]$counts[1] -ne 0 -or [int]$counts[2] -ne 0) {
            throw 'The restored isolated database contains unexpected accounts or rooms; refusing to report an empty pre-provision state.'
        }
        Write-Output "Restored PostgreSQL verified: $($counts[0]) tables; $($counts[1]) accounts; $($counts[2]) rooms."
    } finally {
        $containerCleanupFailed = $false
        $volumeCleanupFailed = $false
        try {
            if ($containerCreated) {
                if ($PSCmdlet.ShouldProcess($containerName, 'Remove the disposable PostgreSQL restore-test container')) {
                    & docker rm --force $containerName *> $null
                    $containerCleanupFailed = $LASTEXITCODE -ne 0
                } else {
                    $containerCleanupFailed = $true
                }
            }
        } finally {
            if ($volumeCreated) {
                if ($PSCmdlet.ShouldProcess($volumeName, 'Remove the disposable PostgreSQL restore-test volume')) {
                    & docker volume rm $volumeName *> $null
                    $volumeCleanupFailed = $LASTEXITCODE -ne 0
                } else {
                    $volumeCleanupFailed = $true
                }
            }
        }
        if ($containerCleanupFailed -or $volumeCleanupFailed) {
            throw "Disposable PostgreSQL restore cleanup failed. Inspect only container '$containerName' and volume '$volumeName'; do not remove other Docker resources."
        }
    }
}

function Invoke-DisposableSynapseRestore {
    param([Parameter(Mandatory)][string]$SynapseDataPath)

    $suffix = [Guid]::NewGuid().ToString('N')
    $volumeName = "nymph-stage3h1-synapse-restore-$suffix"
    $containerName = "nymph-stage3h1-synapse-restore-$suffix"
    $volumeCreated = $false
    $containerCreated = $false
    try {
        if (-not $PSCmdlet.ShouldProcess($volumeName, 'Create a disposable isolated Synapse restore volume')) {
            throw 'Disposable Synapse restore volume creation was not authorized.'
        }
        $null = & docker volume create $volumeName
        if ($LASTEXITCODE -ne 0) { throw 'Could not create the disposable Synapse restore volume.' }
        $volumeCreated = $true

        if (-not $PSCmdlet.ShouldProcess($containerName, 'Create a no-network Synapse restore-test container')) {
            throw 'Disposable Synapse restore container creation was not authorized.'
        }
        $null = & docker create `
            --name $containerName `
            --network none `
            --mount "source=$volumeName,target=/data" `
            --entrypoint /bin/sh `
            'matrixdotorg/synapse:v1.164.2' `
            -c 'sleep 600'
        if ($LASTEXITCODE -ne 0) { throw 'Could not create the disposable Synapse restore-test container.' }
        $containerCreated = $true

        if (-not $PSCmdlet.ShouldProcess($containerName, 'Copy authenticated Synapse data into the disposable volume')) {
            throw 'Copying Synapse data into the disposable volume was not authorized.'
        }
        & docker cp "$SynapseDataPath\." "${containerName}:/data/"
        if ($LASTEXITCODE -ne 0) { throw 'Could not copy Synapse data into the disposable volume.' }

        if (-not $PSCmdlet.ShouldProcess($containerName, 'Start isolated Synapse data readability validation')) {
            throw 'Starting the disposable Synapse data validator was not authorized.'
        }
        $null = & docker start $containerName
        if ($LASTEXITCODE -ne 0) { throw 'Could not start the disposable Synapse data validator.' }
        $validation = @'
import pathlib, sqlite3, yaml
root = pathlib.Path("/data")
config = yaml.safe_load((root / "homeserver.yaml").read_text(encoding="utf-8"))
if config.get("server_name") != "nymph-dev.localhost":
    raise SystemExit("Restored Synapse server name does not match the isolated environment.")
if not list(root.glob("*.signing.key")):
    raise SystemExit("Restored Synapse signing key is missing.")
policy = sqlite3.connect(f"file:{root / 'nymph-policy.sqlite3'}?mode=ro", uri=True)
tables = {row[0] for row in policy.execute("SELECT name FROM sqlite_master WHERE type='table'")}
if not {"nymph_dev_room_policy", "nymph_active_device", "nymph_pending_device"}.issubset(tables):
    raise SystemExit("Restored Synapse policy database schema is incomplete.")
if policy.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
    raise SystemExit("Restored policy database integrity failed.")
policy.close()
print("Restored Synapse config, signing key, and policy database are readable and internally consistent.")
'@
        & docker exec $containerName python -c $validation
        if ($LASTEXITCODE -ne 0) { throw 'Disposable Synapse data validation failed.' }
    } finally {
        $containerCleanupFailed = $false
        $volumeCleanupFailed = $false
        try {
            if ($containerCreated) {
                if ($PSCmdlet.ShouldProcess($containerName, 'Remove the disposable Synapse restore-test container')) {
                    & docker rm --force $containerName *> $null
                    $containerCleanupFailed = $LASTEXITCODE -ne 0
                } else {
                    $containerCleanupFailed = $true
                }
            }
        } finally {
            if ($volumeCreated) {
                if ($PSCmdlet.ShouldProcess($volumeName, 'Remove the disposable Synapse restore-test volume')) {
                    & docker volume rm $volumeName *> $null
                    $volumeCleanupFailed = $LASTEXITCODE -ne 0
                } else {
                    $volumeCleanupFailed = $true
                }
            }
        }
        if ($containerCleanupFailed -or $volumeCleanupFailed) {
            throw "Disposable Synapse restore cleanup failed. Inspect only container '$containerName' and volume '$volumeName'; do not remove other Docker resources."
        }
    }
}

if ($Mode -eq 'Create') {
    Assert-IsolatedSecretsPath
    if (-not $BackupPath) {
        $defaultDirectory = Join-Path $env:USERPROFILE 'NYMPH-Backups'
        $BackupPath = Join-Path $defaultDirectory (
            'nymph-stage3h1-dev-{0}.enc' -f (Get-Date -Format 'yyyyMMdd-HHmmss')
        )
    }
    $BackupPath = Assert-OutsideRepository $BackupPath
    $backupDirectory = Split-Path -Parent $BackupPath
    if (Test-Path -LiteralPath $BackupPath) {
        throw 'Refusing to overwrite an existing encrypted backup.'
    }
    if (-not (Test-Path -LiteralPath $environmentFile -PathType Leaf) -or
        -not (Test-Path -LiteralPath $secretDirectory -PathType Container)) {
        throw 'The isolated deployment environment and secrets must exist before backup.'
    }

    $activeProfileUsers = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |
        Where-Object { $_.CommandLine -and $_.CommandLine.Contains($profileRoot) }
    if ($activeProfileUsers) {
        throw 'Close isolated Matrix test browsers before backing up their crypto profiles.'
    }
    foreach ($requiredCommand in @('docker', 'node', 'tar.exe')) {
        if (-not (Get-Command $requiredCommand -ErrorAction SilentlyContinue)) {
            throw "Required backup command is unavailable: $requiredCommand"
        }
    }
    $engine = & docker info --format '{{.ServerVersion}}' 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $engine) {
        throw 'Docker Engine is unavailable; no backup or restore operation was attempted.'
    }
    if (-not (Test-IsolatedComposeContainer -ContainerName $synapseContainer)) {
        throw 'The isolated Synapse service is not running under its dedicated Compose project.'
    }
    if (-not (Test-IsolatedComposeContainer -ContainerName $postgresContainer)) {
        throw 'The isolated PostgreSQL service is not running under its dedicated Compose project.'
    }

    $passphrase = Get-PlaintextPassphrase
    $compose = @(
        'compose', '--project-name', $projectName,
        '--env-file', $environmentFile,
        '-f', (Join-Path $PSScriptRoot 'compose.dev.isolated.yaml')
    )
    $timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $stagingRoot = Join-Path ([System.IO.Path]::GetTempPath()) "nymph-stage3h1-backup-$timestamp"
    $stagingArchive = "$stagingRoot.tar"
    $synapseStoppedForSnapshot = $false
    try {
        if (-not (Test-Path -LiteralPath $backupDirectory -PathType Container)) {
            if ($PSCmdlet.ShouldProcess($backupDirectory, 'Create external encrypted-backup directory')) {
                New-Item -ItemType Directory -Path $backupDirectory -Force | Out-Null
            }
        }
        if (-not (Test-Path -LiteralPath $backupDirectory -PathType Container)) {
            throw 'The external backup directory is not available.'
        }
        if (Test-Path -LiteralPath $BackupPath) {
            throw 'Refusing to overwrite an existing encrypted backup.'
        }
        if ($PSCmdlet.ShouldProcess($stagingRoot, 'Create temporary plaintext backup staging area')) {
            New-Item -ItemType Directory -Path $stagingRoot | Out-Null
        }
        if (-not (Test-Path -LiteralPath $stagingRoot -PathType Container)) {
            throw 'Backup staging area was not created.'
        }
        if ($PSCmdlet.ShouldProcess($synapseContainer, 'Stop only the isolated Synapse service for a consistent snapshot')) {
            & docker stop $synapseContainer *> $null
            if ($LASTEXITCODE -ne 0) { throw 'Could not stop the isolated Synapse service for backup.' }
            $synapseStoppedForSnapshot = $true
        } else {
            throw 'Stopping the isolated Synapse service for a consistent backup was not authorized.'
        }
        $stagedSynapseData = Join-Path $stagingRoot 'synapse-data'
        if ($PSCmdlet.ShouldProcess($stagedSynapseData, 'Copy isolated Synapse data volume to temporary staging')) {
            & docker cp "${synapseContainer}:/data" $stagedSynapseData
            if ($LASTEXITCODE -ne 0) { throw 'Could not stage isolated Synapse data.' }
        }
        $stagedDump = Join-Path $stagingRoot 'postgres.dump'
        if ($PSCmdlet.ShouldProcess($stagedDump, 'Create a logical dump from isolated development PostgreSQL')) {
            try {
                $dumpScript = 'PGPASSWORD="$(tr -d "\r\n" < /run/secrets/postgres_password)" pg_dump -U synapse -Fc -f /tmp/nymph-dev.dump synapse'
                $encodedDumpScript = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($dumpScript))
                & docker exec $postgresContainer sh -c "echo $encodedDumpScript | base64 -d | sh -e"
                if ($LASTEXITCODE -ne 0) { throw 'Could not create isolated PostgreSQL dump.' }
                & docker cp "${postgresContainer}:/tmp/nymph-dev.dump" $stagedDump
                if ($LASTEXITCODE -ne 0) { throw 'Could not copy isolated PostgreSQL dump into staging.' }
            } finally {
                & docker exec $postgresContainer rm -f /tmp/nymph-dev.dump
                if ($LASTEXITCODE -ne 0) { throw 'Could not remove temporary PostgreSQL dump from the isolated container.' }
            }
        }
        if (Test-Path -LiteralPath $secretDirectory -PathType Container) {
            if ($PSCmdlet.ShouldProcess((Join-Path $stagingRoot 'secrets'), 'Stage isolated account and service credentials')) {
                Copy-Item -LiteralPath $secretDirectory -Destination (Join-Path $stagingRoot 'secrets') -Recurse
            }
        }
        if ($PSCmdlet.ShouldProcess((Join-Path $stagingRoot 'deployment.env'), 'Stage isolated deployment configuration')) {
            Copy-Item -LiteralPath $environmentFile -Destination (Join-Path $stagingRoot 'deployment.env')
        }
        if (Test-Path -LiteralPath $profileRoot -PathType Container) {
            if ($PSCmdlet.ShouldProcess((Join-Path $stagingRoot 'crypto-profiles'), 'Stage closed isolated Matrix crypto profiles')) {
                Copy-Item -LiteralPath $profileRoot -Destination (Join-Path $stagingRoot 'crypto-profiles') -Recurse
            }
        }

        $entries = @(
            Get-ChildItem -LiteralPath $stagingRoot -File -Force -Recurse |
                ForEach-Object {
                    [PSCustomObject]@{
                        path = $_.FullName.Substring($stagingRoot.Length + 1)
                        sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash
                    }
                }
        )
        if ($PSCmdlet.ShouldProcess((Join-Path $stagingRoot 'manifest.json'), 'Write non-secret backup integrity manifest')) {
            [PSCustomObject]@{
                format = 'nymph-isolated-dev-backup'
                version = 1
                files = $entries
            } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $stagingRoot 'manifest.json') -Encoding UTF8
        }
        if ($PSCmdlet.ShouldProcess($stagingArchive, 'Create a temporary backup archive')) {
            & tar.exe -cf $stagingArchive -C $stagingRoot .
            if ($LASTEXITCODE -ne 0) { throw 'Could not create temporary backup archive.' }
        }
        if ($PSCmdlet.ShouldProcess($BackupPath, 'Encrypt isolated development backup with scrypt and AES-256-GCM')) {
            Invoke-BackupCipher -Operation encrypt -InputPath $stagingArchive -OutputPath $BackupPath -Passphrase $passphrase
        }
        if (-not $WhatIfPreference -and (Test-Path -LiteralPath $BackupPath -PathType Leaf)) {
            Write-Output "Encrypted isolated development backup created: $BackupPath"
        }
    } finally {
        $passphrase = $null
        try {
            try {
                if (Test-Path -LiteralPath $stagingArchive -PathType Leaf) {
                    if ($PSCmdlet.ShouldProcess($stagingArchive, 'Overwrite and remove plaintext archive')) {
                        Remove-PlaintextFile $stagingArchive
                    } else {
                        throw 'Plaintext backup archive cleanup was not authorized.'
                    }
                }
            } finally {
                if (Test-Path -LiteralPath $stagingRoot -PathType Container) {
                    if ($PSCmdlet.ShouldProcess($stagingRoot, 'Overwrite and remove plaintext staging tree')) {
                        Remove-PlaintextTree $stagingRoot
                    } else {
                        throw 'Plaintext backup staging cleanup was not authorized.'
                    }
                }
            }
        } finally {
            if ($synapseStoppedForSnapshot) {
                if ($PSCmdlet.ShouldProcess($synapseContainer, 'Restart the isolated Synapse service after backup')) {
                    & docker start $synapseContainer *> $null
                    if ($LASTEXITCODE -ne 0) {
                        throw 'The isolated Synapse service did not restart after backup; inspect it before continuing.'
                    }
                } else {
                    throw 'The isolated Synapse service remains stopped because its restart was not authorized.'
                }
            }
        }
    }
} else {
    if (-not $BackupPath) {
        throw 'Specify an encrypted backup path for RestoreTest.'
    }
    $BackupPath = Assert-OutsideRepository $BackupPath
    if (-not (Test-Path -LiteralPath $BackupPath -PathType Leaf)) {
        throw 'The encrypted backup file does not exist.'
    }
    foreach ($requiredCommand in @('docker', 'node', 'tar.exe')) {
        if (-not (Get-Command $requiredCommand -ErrorAction SilentlyContinue)) {
            throw "Required restore-test command is unavailable: $requiredCommand"
        }
    }
    $engine = & docker info --format '{{.ServerVersion}}' 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $engine) {
        throw 'Docker Engine is unavailable; no backup restoration was attempted.'
    }
    $restoreRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('nymph-stage3h1-restore-' + [Guid]::NewGuid().ToString('N'))
    $stagingArchive = "$restoreRoot.tar"
    $passphrase = Get-PlaintextPassphrase
    try {
        if ($PSCmdlet.ShouldProcess($restoreRoot, 'Create isolated temporary restore-test directory')) {
            New-Item -ItemType Directory -Path $restoreRoot | Out-Null
        }
        if ($PSCmdlet.ShouldProcess($stagingArchive, 'Authenticate and decrypt backup to temporary staging')) {
            Invoke-BackupCipher -Operation decrypt -InputPath $BackupPath -OutputPath $stagingArchive -Passphrase $passphrase
        }
        if ($PSCmdlet.ShouldProcess($restoreRoot, 'Restore encrypted archive into isolated temporary directory')) {
            & tar.exe -xf $stagingArchive -C $restoreRoot
            if ($LASTEXITCODE -ne 0) { throw 'Could not extract the authenticated backup into the temporary restore area.' }
            Assert-Manifest -Root $restoreRoot
            if (-not (Test-Path -LiteralPath (Join-Path $restoreRoot 'postgres.dump')) -or
                -not (Test-Path -LiteralPath (Join-Path $restoreRoot 'synapse-data\homeserver.yaml'))) {
                throw 'Restored backup is missing required isolated Matrix state.'
            }
            Invoke-DisposablePostgresRestore -DumpPath (Join-Path $restoreRoot 'postgres.dump')
            Invoke-DisposableSynapseRestore -SynapseDataPath (Join-Path $restoreRoot 'synapse-data')
        }
        Write-Output 'Encrypted backup authenticated and restored into an isolated temporary directory; no Docker service or original file was modified.'
    } finally {
        $passphrase = $null
        try {
            if (Test-Path -LiteralPath $stagingArchive -PathType Leaf) {
                if ($PSCmdlet.ShouldProcess($stagingArchive, 'Overwrite and remove temporary decrypted archive')) {
                    Remove-PlaintextFile $stagingArchive
                } else {
                    throw 'Temporary decrypted backup archive cleanup was not authorized.'
                }
            }
        } finally {
            if (Test-Path -LiteralPath $restoreRoot -PathType Container) {
                if ($PSCmdlet.ShouldProcess($restoreRoot, 'Overwrite and remove temporary plaintext restore tree')) {
                    Remove-PlaintextTree $restoreRoot
                } else {
                    throw 'Temporary plaintext restore cleanup was not authorized.'
                }
            }
        }
    }
}
