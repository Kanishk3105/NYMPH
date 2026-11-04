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
            @{ Target = 'External backup path'; Action = 'Create a new encrypted file without overwriting an existing backup' },
            @{ Target = $synapseContainer; Action = 'Stop only isolated Synapse for a consistent snapshot; restart it in finally' },
            @{ Target = $postgresContainer; Action = 'Create and remove a logical PostgreSQL dump; keep PostgreSQL running' },
            @{ Target = $synapseContainer; Action = 'Copy isolated Synapse data, service secrets, and deployment configuration' },
            @{ Target = 'Closed isolated browser profiles'; Action = 'Include profiles if present and record their inventory' },
            @{ Target = $BackupPath; Action = 'Encrypt backup with scrypt and AES-256-GCM' },
            @{ Target = $BackupPath; Action = 'Authenticate ciphertext without writing a decrypted verification copy' },
            @{ Target = 'Temporary staging data'; Action = 'Restrict ACLs, overwrite plaintext files, remove the tree, and verify absence' }
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

function Read-SecurePassphraseOnce {
    param([Parameter(Mandatory)][string]$Message)

    Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
    Add-Type -AssemblyName System.Drawing -ErrorAction Stop
    $form = New-Object System.Windows.Forms.Form
    $form.Text = 'NYMPH local backup passphrase'
    $form.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
    $form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedDialog
    $form.MaximizeBox = $false
    $form.MinimizeBox = $false
    $form.ShowInTaskbar = $true
    $form.TopMost = $true
    $form.ClientSize = [System.Drawing.Size]::new(440, 150)

    $label = New-Object System.Windows.Forms.Label
    $label.Text = $Message
    $label.Location = [System.Drawing.Point]::new(16, 16)
    $label.Size = [System.Drawing.Size]::new(408, 42)
    $form.Controls.Add($label)

    $entry = New-Object System.Windows.Forms.TextBox
    $entry.Location = [System.Drawing.Point]::new(16, 64)
    $entry.Size = [System.Drawing.Size]::new(408, 24)
    $entry.UseSystemPasswordChar = $true
    $entry.MaxLength = 2048
    $entry.ShortcutsEnabled = $true
    $form.Controls.Add($entry)

    $validation = New-Object System.Windows.Forms.Label
    $validation.Location = [System.Drawing.Point]::new(16, 94)
    $validation.Size = [System.Drawing.Size]::new(270, 24)
    $validation.ForeColor = [System.Drawing.Color]::Firebrick
    $form.Controls.Add($validation)

    $continue = New-Object System.Windows.Forms.Button
    $continue.Text = 'Continue'
    $continue.Location = [System.Drawing.Point]::new(292, 100)
    $continue.Size = [System.Drawing.Size]::new(80, 30)
    $continue.Add_Click({
        if ($entry.Text.Length -lt 12) {
            $validation.Text = 'Use at least 12 characters.'
            return
        }
        $form.DialogResult = [System.Windows.Forms.DialogResult]::OK
        $form.Close()
    }.GetNewClosure())
    $form.Controls.Add($continue)

    $cancel = New-Object System.Windows.Forms.Button
    $cancel.Text = 'Cancel'
    $cancel.Location = [System.Drawing.Point]::new(376, 100)
    $cancel.Size = [System.Drawing.Size]::new(48, 30)
    $cancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
    $form.Controls.Add($cancel)
    $form.AcceptButton = $continue
    $form.CancelButton = $cancel
    $form.Add_Shown({ $entry.Focus() }.GetNewClosure())

    $secure = $null
    try {
        if ($form.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) {
            throw 'Passphrase entry was cancelled.'
        }
        $secure = New-Object System.Security.SecureString
        foreach ($character in $entry.Text.ToCharArray()) {
            $secure.AppendChar($character)
        }
        $secure.MakeReadOnly()
        return $secure
    } catch {
        if ($secure) {
            $secure.Dispose()
        }
        throw
    } finally {
        $entry.Clear()
        $form.Dispose()
    }
}

function Get-SecurePassphrase {
    $first = Read-SecurePassphraseOnce -Message 'Enter 12+ characters in the masked field. Paste is supported; nothing is saved.'
    try {
        $confirmation = Read-SecurePassphraseOnce -Message 'Re-enter the same passphrase in the masked field. Nothing is saved.'
        try {
            if (-not (Test-SecurePassphraseMatch $first $confirmation)) {
                throw 'The passphrases did not match. No backup changes were made.'
            }
        } finally {
            $confirmation.Dispose()
        }
        return $first
    } catch {
        $first.Dispose()
        throw
    }
}

function Test-SecurePassphraseMatch {
    param(
        [Parameter(Mandatory)][System.Security.SecureString]$First,
        [Parameter(Mandatory)][System.Security.SecureString]$Second
    )

    if ($First.Length -ne $Second.Length) {
        return $false
    }
    $firstPointer = [IntPtr]::Zero
    $secondPointer = [IntPtr]::Zero
    try {
        $firstPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($First)
        $secondPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Second)
        for ($index = 0; $index -lt $First.Length; $index++) {
            if ([Runtime.InteropServices.Marshal]::ReadInt16($firstPointer, $index * 2) -ne
                [Runtime.InteropServices.Marshal]::ReadInt16($secondPointer, $index * 2)) {
                return $false
            }
        }
        return $true
    } finally {
        if ($firstPointer -ne [IntPtr]::Zero) {
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($firstPointer)
        }
        if ($secondPointer -ne [IntPtr]::Zero) {
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($secondPointer)
        }
    }
}

function Invoke-BackupCipher {
    param(
        [Parameter(Mandatory)][ValidateSet('encrypt', 'decrypt', 'verify')][string]$Operation,
        [Parameter(Mandatory)][string]$InputPath,
        [string]$OutputPath,
        [Parameter(Mandatory)][System.Security.SecureString]$Passphrase
    )

    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = 'node'
    if ($Operation -eq 'verify') {
        $startInfo.Arguments = '"{0}" verify "{1}"' -f $scriptPath, $InputPath
    } else {
        $startInfo.Arguments = '"{0}" {1} "{2}" "{3}"' -f $scriptPath, $Operation, $InputPath, $OutputPath
    }
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardInput = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $startInfo
    $pointer = [IntPtr]::Zero
    $characters = New-Object char[] $Passphrase.Length
    $utf8Bytes = $null
    try {
        if (-not $process.Start()) {
            throw 'Could not start the authenticated backup encryption utility.'
        }
        $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Passphrase)
        [Runtime.InteropServices.Marshal]::Copy($pointer, $characters, 0, $characters.Length)
        $utf8Bytes = [System.Text.UTF8Encoding]::new($false).GetBytes($characters)
        $stdin = $process.StandardInput.BaseStream
        $stdin.Write($utf8Bytes, 0, $utf8Bytes.Length)
        $stdin.WriteByte(10)
        $stdin.Flush()
        $process.StandardInput.Close()
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        $process.WaitForExit()
        $stdout = $stdoutTask.GetAwaiter().GetResult()
        $stderr = $stderrTask.GetAwaiter().GetResult()
        if ($process.ExitCode -ne 0) {
            if ($Operation -eq 'decrypt' -and $stderr -match '^Backup decrypt failed \[stage=([a-z0-9 -]+); exception=([A-Za-z0-9_]+)(; code=([A-Z0-9_]+))?\]\.') {
                $diagnosticCode = if ($matches[4]) { "; code=$($matches[4])" } else { '' }
                throw "Authenticated backup decrypt failed: stage=$($matches[1]); exception=$($matches[2])$diagnosticCode."
            }
            if ($Operation -eq 'decrypt') {
                throw "Authenticated backup decrypt helper failed with exit code $($process.ExitCode); sensitive exception details were suppressed."
            }
            throw "Authenticated backup $Operation failed: $($stderr.Trim())"
        }
        if ($stdout -notmatch "^$Operation complete") {
            throw "Authenticated backup $Operation did not report completion."
        }
    } finally {
        [Array]::Clear($characters, 0, $characters.Length)
        if ($utf8Bytes) {
            [Array]::Clear($utf8Bytes, 0, $utf8Bytes.Length)
        }
        if ($pointer -ne [IntPtr]::Zero) {
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
        }
        $process.Dispose()
    }
}

function Remove-PlaintextTree {
    param([Parameter(Mandatory)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
        return
    }
    foreach ($file in Get-ChildItem -LiteralPath $Path -File -Force -Recurse) {
        if (($file.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            continue
        }
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
    if (Test-Path -LiteralPath $Path) {
        throw 'Plaintext staging directory remains after cleanup.'
    }
}

function Protect-PlaintextDirectory {
    param([Parameter(Mandatory)][string]$Path)

    $currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $systemAccount = New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
    $acl = Get-Acl -LiteralPath $Path
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($rule in @($acl.Access)) {
        $null = $acl.RemoveAccessRuleSpecific($rule)
    }
    $inheritance = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
    $allow = [Security.AccessControl.AccessControlType]::Allow
    foreach ($identity in @($currentUser, $systemAccount)) {
        $rule = New-Object Security.AccessControl.FileSystemAccessRule(
            $identity,
            [Security.AccessControl.FileSystemRights]::FullControl,
            $inheritance,
            [Security.AccessControl.PropagationFlags]::None,
            $allow
        )
        $acl.AddAccessRule($rule)
    }
    $acl.SetOwner($currentUser)
    Set-Acl -LiteralPath $Path -AclObject $acl
}

function Protect-EncryptedBackupFile {
    param([Parameter(Mandatory)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw 'Encrypted backup file is missing before ACL protection.'
    }
    $currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $systemAccount = New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
    $acl = Get-Acl -LiteralPath $Path
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($rule in @($acl.Access)) {
        $null = $acl.RemoveAccessRuleSpecific($rule)
    }
    foreach ($identity in @($currentUser, $systemAccount)) {
        $rule = New-Object Security.AccessControl.FileSystemAccessRule(
            $identity,
            [Security.AccessControl.FileSystemRights]::FullControl,
            [Security.AccessControl.AccessControlType]::Allow
        )
        $acl.AddAccessRule($rule)
    }
    $acl.SetOwner($currentUser)
    Set-Acl -LiteralPath $Path -AclObject $acl
    $verifiedAcl = Get-Acl -LiteralPath $Path
    $identities = @($verifiedAcl.Access | ForEach-Object {
        $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
    })
    if (-not $verifiedAcl.AreAccessRulesProtected -or $identities.Count -ne 2 -or
        $identities -notcontains $currentUser.Value -or $identities -notcontains $systemAccount.Value) {
        throw 'Encrypted backup file ACL is not restricted to the current user and SYSTEM.'
    }
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
        $null = & docker volume create $volumeName
        if ($LASTEXITCODE -ne 0) { throw 'Could not create the disposable PostgreSQL restore volume.' }
        $volumeCreated = $true

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

        & docker cp $DumpPath "${containerName}:/tmp/nymph-dev.dump"
        if ($LASTEXITCODE -ne 0) { throw 'Could not copy the PostgreSQL dump to the disposable container.' }

        & docker exec $containerName pg_restore --exit-on-error -U synapse -d synapse /tmp/nymph-dev.dump
        if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL rejected the restored database dump.' }

        & docker exec $containerName psql -v ON_ERROR_STOP=1 -U synapse -d synapse -c 'CREATE EXTENSION IF NOT EXISTS amcheck' *> $null
        if ($LASTEXITCODE -ne 0) { throw 'Could not enable amcheck in the disposable restored database.' }
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
                & docker rm --force $containerName *> $null
                $containerCleanupFailed = $LASTEXITCODE -ne 0
            }
        } finally {
            if ($volumeCreated) {
                & docker volume rm $volumeName *> $null
                $volumeCleanupFailed = $LASTEXITCODE -ne 0
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
        $null = & docker volume create $volumeName
        if ($LASTEXITCODE -ne 0) { throw 'Could not create the disposable Synapse restore volume.' }
        $volumeCreated = $true

        $null = & docker create `
            --name $containerName `
            --network none `
            --mount "source=$volumeName,target=/data" `
            --entrypoint /bin/sh `
            'matrixdotorg/synapse:v1.164.2' `
            -c 'sleep 600'
        if ($LASTEXITCODE -ne 0) { throw 'Could not create the disposable Synapse restore-test container.' }
        $containerCreated = $true

        & docker cp "$SynapseDataPath\." "${containerName}:/data/"
        if ($LASTEXITCODE -ne 0) { throw 'Could not copy Synapse data into the disposable volume.' }

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
        $validation | & docker exec -i $containerName python -
        if ($LASTEXITCODE -ne 0) { throw 'Disposable Synapse data validation failed.' }
    } finally {
        $containerCleanupFailed = $false
        $volumeCleanupFailed = $false
        try {
            if ($containerCreated) {
                & docker rm --force $containerName *> $null
                $containerCleanupFailed = $LASTEXITCODE -ne 0
            }
        } finally {
            if ($volumeCreated) {
                & docker volume rm $volumeName *> $null
                $volumeCleanupFailed = $LASTEXITCODE -ne 0
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

    $activeProfileUsers = Microsoft.PowerShell.Management\Get-WmiObject Win32_Process -Filter "Name='chrome.exe'" |
        Where-Object {
            $_.CommandLine -and
            $_.CommandLine.IndexOf($profileRoot, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
        }
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

    if (-not $PSCmdlet.ShouldProcess(
        $BackupPath,
        'Create an authenticated encrypted backup of only the isolated NYMPH development environment'
    )) {
        Write-Warning 'Backup creation cancelled before any resource or file changes.'
        return
    }
    $passphrase = $null
    $backupVerified = $false
    $encryptedBackupCreated = $false
    $stagingContainer = Join-Path ([System.IO.Path]::GetTempPath()) ('nymph-stage3h1-backup-' + [Guid]::NewGuid().ToString('N'))
    $stagingRoot = Join-Path $stagingContainer 'payload'
    $stagingArchive = Join-Path $stagingContainer 'backup.tar'
    $synapseStoppedForSnapshot = $false
    try {
        $passphrase = Get-SecurePassphrase
        if (-not (Test-Path -LiteralPath $backupDirectory -PathType Container)) {
            New-Item -ItemType Directory -Path $backupDirectory -Force | Out-Null
        }
        if (-not (Test-Path -LiteralPath $backupDirectory -PathType Container)) {
            throw 'The external backup directory is not available.'
        }
        if (Test-Path -LiteralPath $BackupPath) {
            throw 'Refusing to overwrite an existing encrypted backup.'
        }
        New-Item -ItemType Directory -Path $stagingRoot | Out-Null
        if (-not (Test-Path -LiteralPath $stagingRoot -PathType Container)) {
            throw 'Backup staging area was not created.'
        }
        Protect-PlaintextDirectory -Path $stagingContainer
        & docker stop $synapseContainer *> $null
        if ($LASTEXITCODE -ne 0) { throw 'Could not stop the isolated Synapse service for backup.' }
        $synapseStoppedForSnapshot = $true
        $stagedSynapseData = Join-Path $stagingRoot 'synapse-data'
        & docker cp "${synapseContainer}:/data" $stagedSynapseData
        if ($LASTEXITCODE -ne 0) { throw 'Could not stage isolated Synapse data.' }
        $stagedDump = Join-Path $stagingRoot 'postgres.dump'
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
        if (Test-Path -LiteralPath $secretDirectory -PathType Container) {
            Copy-Item -LiteralPath $secretDirectory -Destination (Join-Path $stagingRoot 'secrets') -Recurse
        }
        Copy-Item -LiteralPath $environmentFile -Destination (Join-Path $stagingRoot 'deployment.env')
        $stagedDeployment = Join-Path $stagingRoot 'deployment'
        New-Item -ItemType Directory -Path $stagedDeployment | Out-Null
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'compose.dev.isolated.yaml') -Destination (Join-Path $stagedDeployment 'compose.dev.isolated.yaml')
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'configure_isolated_dev_synapse.py') -Destination (Join-Path $stagedDeployment 'configure_isolated_dev_synapse.py')
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'dev-modules') -Destination (Join-Path $stagedDeployment 'dev-modules') -Recurse
        if (Test-Path -LiteralPath $profileRoot -PathType Container) {
            Copy-Item -LiteralPath $profileRoot -Destination (Join-Path $stagingRoot 'crypto-profiles') -Recurse
        }
        $profileFiles = if (Test-Path -LiteralPath (Join-Path $stagingRoot 'crypto-profiles')) {
            @(Get-ChildItem -LiteralPath (Join-Path $stagingRoot 'crypto-profiles') -File -Force -Recurse).Count
        } else {
            0
        }
        [PSCustomObject]@{
            isolatedCryptoProfileDirectoryPresent = Test-Path -LiteralPath $profileRoot -PathType Container
            isolatedCryptoProfileFileCount = $profileFiles
        } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $stagingRoot 'backup-inventory.json') -Encoding UTF8

        $entries = @(
            Get-ChildItem -LiteralPath $stagingRoot -File -Force -Recurse |
                ForEach-Object {
                    [PSCustomObject]@{
                        path = $_.FullName.Substring($stagingRoot.Length + 1)
                        sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash
                    }
                }
        )
        [PSCustomObject]@{
            format = 'nymph-isolated-dev-backup'
            version = 1
            files = $entries
        } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $stagingRoot 'manifest.json') -Encoding UTF8
        Assert-Manifest -Root $stagingRoot
        & tar.exe -cf $stagingArchive -C $stagingRoot .
        if ($LASTEXITCODE -ne 0) { throw 'Could not create temporary backup archive.' }
        Invoke-BackupCipher -Operation encrypt -InputPath $stagingArchive -OutputPath $BackupPath -Passphrase $passphrase
        $encryptedBackupCreated = Test-Path -LiteralPath $BackupPath -PathType Leaf
        if (-not $encryptedBackupCreated -or (Get-Item -LiteralPath $BackupPath).Length -le 0) {
            throw 'The encrypted backup file is missing or empty.'
        }
        Invoke-BackupCipher -Operation verify -InputPath $BackupPath -Passphrase $passphrase
        Protect-EncryptedBackupFile -Path $BackupPath
        $backupVerified = $true
        if (-not $WhatIfPreference -and (Test-Path -LiteralPath $BackupPath -PathType Leaf)) {
            Write-Output "Encrypted isolated development backup created: $BackupPath"
        }
    } finally {
        if ($passphrase) {
            $passphrase.Dispose()
            $passphrase = $null
        }
        try {
            if (Test-Path -LiteralPath $stagingContainer -PathType Container) {
                Remove-PlaintextTree $stagingContainer
            }
        } finally {
            try {
                if ($synapseStoppedForSnapshot) {
                    & docker start $synapseContainer *> $null
                    if ($LASTEXITCODE -ne 0) {
                        throw 'The isolated Synapse service did not restart after backup; inspect it before continuing.'
                    }
                }
            } finally {
                if (-not $backupVerified -and $encryptedBackupCreated -and (Test-Path -LiteralPath $BackupPath -PathType Leaf)) {
                    Remove-Item -LiteralPath $BackupPath -Force
                    if (Test-Path -LiteralPath $BackupPath) {
                        throw 'An unverified encrypted backup remains at the destination.'
                    }
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
    if ((Get-Item -LiteralPath $BackupPath).Length -le 0) {
        throw 'The encrypted backup file is empty.'
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
    if (-not $PSCmdlet.ShouldProcess(
        $BackupPath,
        'Authenticate and restore-test only into newly created disposable NYMPH resources'
    )) {
        Write-Warning 'RestoreTest cancelled before creating any disposable resources.'
        return
    }
    $restoreContainer = Join-Path ([System.IO.Path]::GetTempPath()) ('nymph-stage3h1-restore-' + [Guid]::NewGuid().ToString('N'))
    $restoreRoot = Join-Path $restoreContainer 'payload'
    $stagingArchive = Join-Path $restoreContainer 'restored.tar'
    $passphrase = $null
    $restoreStage = 'passphrase entry'
    try {
        $passphrase = Get-SecurePassphrase
        New-Item -ItemType Directory -Path $restoreRoot | Out-Null
        Protect-PlaintextDirectory -Path $restoreContainer
        $restoreStage = 'encrypted backup authentication/decryption'
        Invoke-BackupCipher -Operation decrypt -InputPath $BackupPath -OutputPath $stagingArchive -Passphrase $passphrase
        $restoreStage = 'archive extraction'
        & tar.exe -xf $stagingArchive -C $restoreRoot
        if ($LASTEXITCODE -ne 0) { throw 'Could not extract the authenticated backup into the temporary restore area.' }
        $restoreStage = 'integrity manifest verification'
        Assert-Manifest -Root $restoreRoot
        if (-not (Test-Path -LiteralPath (Join-Path $restoreRoot 'postgres.dump')) -or
            -not (Test-Path -LiteralPath (Join-Path $restoreRoot 'synapse-data\homeserver.yaml')) -or
            -not (Test-Path -LiteralPath (Join-Path $restoreRoot 'deployment.env')) -or
            -not (Test-Path -LiteralPath (Join-Path $restoreRoot 'deployment\compose.dev.isolated.yaml')) -or
            -not (Test-Path -LiteralPath (Join-Path $restoreRoot 'deployment\configure_isolated_dev_synapse.py')) -or
            -not (Test-Path -LiteralPath (Join-Path $restoreRoot 'secrets\postgres_password')) -or
            -not (Test-Path -LiteralPath (Join-Path $restoreRoot 'secrets\registration_shared_secret'))) {
            throw 'Restored backup is missing required isolated Matrix state.'
        }
        $inventory = Get-Content -LiteralPath (Join-Path $restoreRoot 'backup-inventory.json') -Raw | ConvertFrom-Json
        if ($inventory.isolatedCryptoProfileDirectoryPresent -and
            [int]$inventory.isolatedCryptoProfileFileCount -gt 0 -and
            -not (Test-Path -LiteralPath (Join-Path $restoreRoot 'crypto-profiles'))) {
            throw 'The backup inventory reports crypto profiles but the profile data is missing.'
        }
        $restoreStage = 'disposable PostgreSQL restoration and validation'
        Invoke-DisposablePostgresRestore -DumpPath (Join-Path $restoreRoot 'postgres.dump')
        $restoreStage = 'disposable Synapse data validation'
        Invoke-DisposableSynapseRestore -SynapseDataPath (Join-Path $restoreRoot 'synapse-data')
        $restoreStage = 'restore completion'
        Write-Output 'Encrypted backup authenticated and restored into an isolated temporary directory; no Docker service or original file was modified.'
    } catch {
        $exceptionType = $_.Exception.GetType().Name
        $detail = if ($_.Exception.Message -match '^Authenticated backup decrypt (?:failed: stage=[a-z0-9 -]+; exception=[A-Za-z0-9_]+(?:; code=[A-Z0-9_]+)?|helper failed with exit code [0-9]+)\.') {
            $_.Exception.Message
        } else {
            'Sensitive exception details were suppressed.'
        }
        throw "RestoreTest failed at stage '$restoreStage' (exception=$exceptionType). $detail"
    } finally {
        try {
            if (Test-Path -LiteralPath $restoreContainer -PathType Container) {
                try {
                    Remove-PlaintextTree $restoreContainer
                } catch {
                    throw "RestoreTest cleanup failed for temporary plaintext directory '$restoreContainer' (exception=$($_.Exception.GetType().Name))."
                }
            }
        } finally {
            if ($passphrase) {
                $passphrase.Dispose()
                $passphrase = $null
            }
        }
    }
}
