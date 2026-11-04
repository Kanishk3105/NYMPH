[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param()

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$envFile = Join-Path $PSScriptRoot '.env.dev.isolated'
$exampleFile = Join-Path $PSScriptRoot '.env.dev.isolated.example'
$secretDirectory = Join-Path $PSScriptRoot 'dev-isolated\secrets'
$composeFile = Join-Path $PSScriptRoot 'compose.dev.isolated.yaml'
$projectName = 'nymph-stage3h1-dev'

$plannedActions = @(
    @{ Target = $envFile; Action = 'Create isolated development environment configuration if missing' },
    @{ Target = $secretDirectory; Action = 'Create isolated PostgreSQL and Synapse service secrets only' },
    @{ Target = 'nymph-stage3h1-dev-synapse-data'; Action = 'Generate Synapse configuration in the isolated named volume if absent' },
    @{ Target = "$projectName isolated deployment"; Action = 'Start only the isolated PostgreSQL and Synapse services' }
)
if ($WhatIfPreference) {
    foreach ($action in $plannedActions) {
        $null = $PSCmdlet.ShouldProcess($action.Target, $action.Action)
    }
    return
}

$configurationToCheck = if (Test-Path -LiteralPath $envFile -PathType Leaf) { $envFile } else { $exampleFile }
$environmentValues = @{}
foreach ($line in Get-Content -LiteralPath $configurationToCheck) {
    if ($line -match '^\s*([A-Z0-9_]+)=(.*)$') {
        $environmentValues[$matches[1]] = $matches[2].Trim()
    }
}
if (
    $environmentValues['MATRIX_SERVER_NAME'] -ne 'nymph-dev.localhost' -or
    $environmentValues['DEV_HOMESERVER_URL'] -ne 'http://127.0.0.1:18008' -or
    $environmentValues['DEV_PARTNER_A_USER_ID'] -ne '@partner1-dev:nymph-dev.localhost' -or
    $environmentValues['DEV_PARTNER_B_USER_ID'] -ne '@partner2-dev:nymph-dev.localhost'
) {
    throw 'The isolated server name, URL, or partner IDs do not match the dedicated Stage 3H.1 deployment.'
}
$expectedSecretDirectory = [System.IO.Path]::GetFullPath($secretDirectory)
foreach ($configuredSecretDirectory in @($env:DEV_SECRETS_DIR, $environmentValues['DEV_SECRETS_DIR'])) {
    if ($configuredSecretDirectory) {
        $resolvedSecretDirectory = [System.IO.Path]::GetFullPath($configuredSecretDirectory)
        if ($resolvedSecretDirectory -ne $expectedSecretDirectory) {
            throw 'DEV_SECRETS_DIR must resolve to the isolated development secrets directory.'
        }
    }
}

$engine = & docker info --format '{{.ServerVersion}}' 2>$null
if ($LASTEXITCODE -ne 0 -or -not $engine) {
    throw 'Docker Engine is unavailable; no isolated configuration, secret, or service was changed.'
}

function New-IsolatedSecret {
    param([Parameter(Mandatory)][string]$Path)

    if (Test-Path -LiteralPath $Path) {
        if ([System.IO.File]::ReadAllText($Path).Trim().Length -lt 32) {
            throw "An existing isolated secret is invalid: $(Split-Path $Path -Leaf)"
        }
        return
    }
    if (-not $PSCmdlet.ShouldProcess($Path, 'Create a random isolated development secret')) {
        throw 'Creation of a required isolated secret was not authorized.'
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

if (-not (Test-Path -LiteralPath $envFile)) {
    if ($PSCmdlet.ShouldProcess($envFile, 'Create isolated development environment configuration')) {
        Copy-Item -LiteralPath $exampleFile -Destination $envFile
    }
}
if (-not (Test-Path -LiteralPath $envFile)) {
    throw 'The isolated environment file was not created; no Docker operation was attempted.'
}

if (-not (Test-Path -LiteralPath $secretDirectory -PathType Container)) {
    if ($PSCmdlet.ShouldProcess($secretDirectory, 'Create isolated secret directory')) {
        New-Item -ItemType Directory -Path $secretDirectory -Force | Out-Null
    }
}
if (-not (Test-Path -LiteralPath $secretDirectory -PathType Container)) {
    throw 'The isolated secret directory is missing; no Docker operation was attempted.'
}

foreach ($name in @(
    'postgres_password',
    'registration_shared_secret'
)) {
    New-IsolatedSecret (Join-Path $secretDirectory $name)
}

$composeArgs = @(
    'compose',
    '--project-name', $projectName,
    '--env-file', $envFile,
    '-f', $composeFile
)
$volumeName = 'nymph-stage3h1-dev-synapse-data'
$matchingVolumes = @(& docker volume ls --quiet --filter "name=$volumeName")
if ($LASTEXITCODE -ne 0) {
    throw 'Could not inspect Docker volumes; no isolated Synapse configuration was generated.'
}
$volumeExists = $matchingVolumes -contains $volumeName
if (-not $volumeExists) {
    if ($PSCmdlet.ShouldProcess("$projectName named Synapse volume", 'Generate isolated Synapse configuration')) {
        & docker @composeArgs --profile init run --rm synapse-generate
        if ($LASTEXITCODE -ne 0) {
            throw 'Isolated Synapse configuration generation failed.'
        }
    } else {
        throw 'Isolated Synapse configuration generation was not authorized.'
    }
} else {
    $hasConfig = $false
    if ($PSCmdlet.ShouldProcess("$projectName named Synapse volume", 'Check existing isolated Synapse configuration without rewriting it')) {
        & docker @composeArgs run --rm --no-deps --entrypoint /bin/sh synapse-generate -c 'test -f /data/homeserver.yaml'
        $hasConfig = $LASTEXITCODE -eq 0
    }
    if (-not $hasConfig) {
        throw 'The existing isolated Synapse volume is missing its configuration; refusing to overwrite or regenerate it.'
    }
}

if ($PSCmdlet.ShouldProcess("$projectName isolated Synapse and PostgreSQL services", 'Start isolated development deployment')) {
    & docker @composeArgs up -d postgres synapse
    if ($LASTEXITCODE -ne 0) {
        throw 'Could not start the isolated development deployment.'
    }
} else {
    throw 'Starting the isolated development deployment was not authorized.'
}

if (-not $WhatIfPreference) {
    Write-Output 'The isolated development Synapse/PostgreSQL deployment is configured.'
    Write-Output 'No accounts, rooms, Matrix keys, or recovery keys were created.'
}
