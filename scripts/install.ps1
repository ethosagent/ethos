#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$Branch    = 'main',
    [string]$Commit    = '',
    [string]$Tag       = '',
    [switch]$SkipSetup,
    [string]$EthosHome  = (Join-Path $env:USERPROFILE '.ethos'),
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'ethos\ethos-agent'),
    [string]$NodeDir    = (Join-Path $env:LOCALAPPDATA 'ethos\node'),
    [string]$BinDir     = (Join-Path $env:LOCALAPPDATA 'ethos\bin')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Force TLS 1.2+ for all web requests
[Net.ServicePointManager]::SecurityProtocol = `
    [Net.SecurityProtocolType]::Tls12 -bor [Net.SecurityProtocolType]::Tls13

# ---------------------------------------------------------------------------
# Helper functions
# ---------------------------------------------------------------------------

function Write-Step([string]$msg) {
    Write-Host ""
    Write-Host "  $msg" -ForegroundColor Cyan
}

function Write-Ok([string]$msg) {
    Write-Host "  $msg" -ForegroundColor Green
}

function Write-Warn([string]$msg) {
    Write-Host "  WARNING: $msg" -ForegroundColor Yellow
}

function Write-Fail([string]$msg) {
    Write-Host ""
    Write-Host "  ERROR: $msg" -ForegroundColor Red
    exit 1
}

function Retry {
    param(
        [scriptblock]$Action,
        [int]$Attempts = 3,
        [int]$DelayMs  = 2000
    )
    $lastError = $null
    for ($i = 1; $i -le $Attempts; $i++) {
        try {
            $result = & $Action
            return $result
        } catch {
            $lastError = $_
            if ($i -lt $Attempts) {
                Start-Sleep -Milliseconds $DelayMs
            }
        }
    }
    throw $lastError
}

# ---------------------------------------------------------------------------
# Banner
# ---------------------------------------------------------------------------

Write-Host ""
try {
    # Try Unicode box-drawing first
    $banner = @"
  +-----------------------------------+
  |  Ethos Installer for Windows      |
  |  ethosagent.ai                    |
  +-----------------------------------+
"@
    # Use Unicode if the console can handle it
    $enc = [Console]::OutputEncoding
    if ($enc.GetBytes([char]0x250C).Length -gt 0) {
        $banner = @"
  +-----------------------------------+
  |  Ethos Installer for Windows      |
  |  ethosagent.ai                    |
  +-----------------------------------+
"@
    }
    Write-Host $banner
} catch {
    Write-Host "  Ethos Installer for Windows"
    Write-Host "  ethosagent.ai"
}

# ---------------------------------------------------------------------------
# Step 1: Resolve portable Node 24
# ---------------------------------------------------------------------------

Write-Step "Step 1/9 — Resolving portable Node 24"

$nodeExePath = Join-Path $NodeDir 'node.exe'
if (Test-Path $nodeExePath) {
    $existingVersion = & $nodeExePath --version 2>&1
    Write-Ok "Node already installed: $existingVersion"
} else {
    Write-Ok "Fetching Node.js release index from nodejs.org..."

    $nodeIndex = Retry {
        Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json'
    } -Attempts 3 -DelayMs 2000

    $nodeRelease = $nodeIndex |
        Where-Object { $_.version -like 'v24.*' -and $_.files -contains 'win-x64-zip' } |
        Select-Object -First 1

    if (-not $nodeRelease) {
        Write-Fail "Could not find a Node 24 win-x64-zip release on nodejs.org."
    }

    $nodeVersion = $nodeRelease.version
    $nodeZipUrl  = "https://nodejs.org/dist/$nodeVersion/node-$nodeVersion-win-x64.zip"
    $nodeTmpZip  = Join-Path $env:TEMP "node-$nodeVersion-win-x64.zip"

    Write-Ok "Downloading Node $nodeVersion..."
    Retry {
        Invoke-WebRequest -Uri $nodeZipUrl -OutFile $nodeTmpZip -UseBasicParsing
    } -Attempts 3 -DelayMs 2000

    $nodeParentDir = Split-Path $NodeDir -Parent
    if (-not (Test-Path $nodeParentDir)) {
        New-Item -ItemType Directory -Path $nodeParentDir -Force | Out-Null
    }

    if (Test-Path $NodeDir) {
        Remove-Item -Recurse -Force $NodeDir -ErrorAction SilentlyContinue
    }

    Write-Ok "Extracting Node $nodeVersion..."
    Expand-Archive -Path $nodeTmpZip -DestinationPath $nodeParentDir -Force

    $extractedName = "node-$nodeVersion-win-x64"
    $extractedPath = Join-Path $nodeParentDir $extractedName
    Rename-Item -Path $extractedPath -NewName (Split-Path $NodeDir -Leaf)

    Remove-Item $nodeTmpZip -ErrorAction SilentlyContinue

    if (-not (Test-Path $nodeExePath)) {
        Write-Fail "Node installation failed — $nodeExePath not found after extraction."
    }

    $installedVersion = & $nodeExePath --version 2>&1
    Write-Ok "Node $installedVersion installed."
}

# Add NodeDir and its .bin subfolder to PATH for this session
$nodeModulesBin = Join-Path $NodeDir 'node_modules\.bin'
$env:PATH = "$NodeDir;$nodeModulesBin;$env:PATH"

$script:NodeExe = Join-Path $NodeDir 'node.exe'
$script:NpmCmd  = Join-Path $NodeDir 'npm.cmd'

# ---------------------------------------------------------------------------
# Step 2: Install pnpm via portable npm
# ---------------------------------------------------------------------------

Write-Step "Step 2/9 — Installing pnpm"

$pnpmCmdPath = Join-Path $NodeDir 'pnpm.cmd'
if (Test-Path $pnpmCmdPath) {
    $pnpmVersion = & $pnpmCmdPath --version 2>&1
    Write-Ok "pnpm already installed: $pnpmVersion"
} else {
    Write-Ok "Installing pnpm via npm..."
    Retry {
        $result = & $script:NpmCmd install -g pnpm --prefix "$NodeDir" 2>&1
        if ($LASTEXITCODE -ne 0) {
            throw "npm install pnpm failed:`n$result"
        }
    } -Attempts 3 -DelayMs 2000

    if (-not (Test-Path $pnpmCmdPath)) {
        Write-Fail "pnpm installation failed — $pnpmCmdPath not found."
    }

    $pnpmVersion = & $pnpmCmdPath --version 2>&1
    Write-Ok "pnpm $pnpmVersion installed."
}

$script:PnpmCmd = Join-Path $NodeDir 'pnpm.cmd'

# ---------------------------------------------------------------------------
# Step 3: Download Ethos source
# ---------------------------------------------------------------------------

Write-Step "Step 3/9 — Downloading Ethos source"

$archiveRef = if ($Commit) { $Commit }
              elseif ($Tag) { "refs/tags/$Tag" }
              else { "refs/heads/$Branch" }

$archiveUrl   = "https://github.com/ethosagent/ethos/archive/$archiveRef.zip"
$srcTmpZip    = Join-Path $env:TEMP 'ethos-src.zip'
$srcExtractTmp = Join-Path $env:TEMP 'ethos-extract-tmp'

Write-Ok "Downloading archive from $archiveUrl..."
Retry {
    Invoke-WebRequest -Uri $archiveUrl -OutFile $srcTmpZip -UseBasicParsing
} -Attempts 3 -DelayMs 2000

if (Test-Path $srcExtractTmp) {
    Remove-Item -Recurse -Force $srcExtractTmp -ErrorAction SilentlyContinue
}

Write-Ok "Extracting source..."
Expand-Archive -Path $srcTmpZip -DestinationPath $srcExtractTmp -Force

# GitHub archives always contain one top-level directory (ethos-<ref>)
$topLevelDirs = Get-ChildItem -Path $srcExtractTmp -Directory
if ($topLevelDirs.Count -ne 1) {
    Write-Fail "Unexpected archive structure — expected exactly one top-level directory, found $($topLevelDirs.Count)."
}
$extractedSourceDir = $topLevelDirs[0].FullName

if (Test-Path $InstallDir) {
    # Selectively remove source dirs to preserve node_modules for faster re-installs
    foreach ($subdir in @('apps', 'packages', 'extensions', 'skills', 'docs')) {
        $subdirPath = Join-Path $InstallDir $subdir
        if (Test-Path $subdirPath) {
            Remove-Item -Recurse -Force $subdirPath -ErrorAction SilentlyContinue
        }
    }
} else {
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
}

Copy-Item -Path (Join-Path $extractedSourceDir '*') -Destination $InstallDir -Recurse -Force

Remove-Item $srcTmpZip -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force $srcExtractTmp -ErrorAction SilentlyContinue

Write-Ok "Source extracted to $InstallDir"

# ---------------------------------------------------------------------------
# Step 4: pnpm install
# ---------------------------------------------------------------------------

Write-Step "Step 4/9 — Installing dependencies (pnpm install)"

Push-Location $InstallDir
try {
    Retry {
        $result = & $script:PnpmCmd install --frozen-lockfile 2>&1
        if ($LASTEXITCODE -ne 0) {
            throw "pnpm install failed:`n$result"
        }
    } -Attempts 3 -DelayMs 3000
} finally {
    Pop-Location
}

Write-Ok "Dependencies installed."

# ---------------------------------------------------------------------------
# Step 5: Build
# ---------------------------------------------------------------------------

Write-Step "Step 5/9 — Building Ethos (this may take a few minutes on first install)"

Push-Location $InstallDir
try {
    Write-Ok "Running pnpm build..."
    $result = & $script:PnpmCmd run build 2>&1
    if ($LASTEXITCODE -ne 0) {
        $tail = $result | Select-Object -Last 30 | Out-String
        Write-Fail "Build failed:`n$tail"
    }
} finally {
    Pop-Location
}

$cliEntry = Join-Path $InstallDir 'apps\ethos\dist\index.js'
if (-not (Test-Path $cliEntry)) {
    Write-Fail "Build completed but $cliEntry was not produced. Check build output above."
}

Write-Ok "Build complete."

# ---------------------------------------------------------------------------
# Step 6: Create shim
# ---------------------------------------------------------------------------

Write-Step "Step 6/9 — Creating command shim"

if (-not (Test-Path $BinDir)) {
    New-Item -ItemType Directory -Path $BinDir -Force | Out-Null
}

$ethosCmd = Join-Path $BinDir 'ethos.cmd'
$ethosCmdContent = "@echo off`r`nsetlocal`r`nset ETHOS_HOME=$EthosHome`r`n`"$script:NodeExe`" `"$cliEntry`" %*`r`n"
[IO.File]::WriteAllText($ethosCmd, $ethosCmdContent, [Text.Encoding]::ASCII)
Write-Ok "Created $ethosCmd"

# ethos-update.cmd
$updateRefArg = if ($Commit) { "-Commit '$Commit'" }
                elseif ($Tag) { "-Tag '$Tag'" }
                else { "-Branch '$Branch'" }

$ethosUpdateCmd = Join-Path $BinDir 'ethos-update.cmd'
$ethosUpdateCmdContent = "@echo off`r`npowershell -ExecutionPolicy Bypass -Command `"& ([scriptblock]::Create((irm 'https://raw.githubusercontent.com/ethosagent/ethos/main/scripts/install.ps1'))) -SkipSetup $updateRefArg`"`r`n"
[IO.File]::WriteAllText($ethosUpdateCmd, $ethosUpdateCmdContent, [Text.Encoding]::ASCII)
Write-Ok "Created $ethosUpdateCmd"

# ---------------------------------------------------------------------------
# Step 7: Add BinDir to User PATH
# ---------------------------------------------------------------------------

Write-Step "Step 7/9 — Updating User PATH"

$userPath = [Environment]::GetEnvironmentVariable('PATH', 'User')
if ($null -eq $userPath) { $userPath = '' }

$pathParts = $userPath -split ';' | Where-Object { $_ -ne '' }
if ($pathParts | Where-Object { $_ -eq $BinDir } | Select-Object -First 1) {
    Write-Ok "$BinDir already in User PATH"
} else {
    [Environment]::SetEnvironmentVariable('PATH', "$BinDir;$userPath", 'User')
    Write-Ok "Added $BinDir to User PATH"
    Write-Warn "Open a new terminal window for PATH changes to take effect."
}

# Also add to current session PATH
$env:PATH = "$BinDir;$env:PATH"

# ---------------------------------------------------------------------------
# Step 8: Verify install
# ---------------------------------------------------------------------------

Write-Step "Step 8/9 — Verifying installation"

try {
    $cliVersion = & $script:NodeExe "$cliEntry" --version 2>&1
    Write-Ok "ethos $cliVersion"
} catch {
    Write-Warn "Could not verify ethos version — the install may still be functional."
}

# ---------------------------------------------------------------------------
# Step 9: Success message and optional setup
# ---------------------------------------------------------------------------

Write-Step "Step 9/9 — Done"

Write-Host ""
Write-Host "  Ethos installed successfully!" -ForegroundColor Green
Write-Host ""
Write-Host "  Quick start (open a new terminal first):"
Write-Host "    ethos            -- start chatting"
Write-Host "    ethos --help     -- show all commands"
Write-Host "    ethos-update     -- update to latest"
Write-Host ""
Write-Host "  Data directory:  $EthosHome"
Write-Host "  Install dir:     $InstallDir"
Write-Host ""

if (-not $SkipSetup) {
    Write-Host "  Starting first-run setup..." -ForegroundColor Cyan
    & $script:NodeExe "$cliEntry" setup
}
