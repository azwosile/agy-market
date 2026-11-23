# Zero-npm PowerShell Bootstrap Installer for AGY Market (`scripts/install.ps1`)
# Verifies SHA-256 digest before extracting real files into ~/.gemini/config/plugins/agy-market

param(
  [string]$ReleaseBaseUrl = "https://github.com/azwosile/agy-market/releases/latest/download",
  [string]$MirrorPrefix = ""
)

$ErrorActionPreference = "Stop"

$ConfigDir = if ($env:ANTIGRAVITY_CONFIG_DIR) { $env:ANTIGRAVITY_CONFIG_DIR } else { Join-Path $HOME ".gemini\config" }
$TargetDir = Join-Path $ConfigDir "plugins\agy-market"
$TempRoot  = Join-Path ([System.IO.Path]::GetTempPath()) ("agy-market-boot-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $TempRoot | Out-Null

try {
  $TarUrl = "$ReleaseBaseUrl/agy-market.tar.gz"
  $ShaUrl = "$ReleaseBaseUrl/agy-market.tar.gz.sha256"
  if ($MirrorPrefix) {
    $Prefix = $MirrorPrefix.TrimEnd("/")
    $TarUrl = "$Prefix/$TarUrl"
    $ShaUrl = "$Prefix/$ShaUrl"
  }

  $TarFile = Join-Path $TempRoot "agy-market.tar.gz"
  $ShaFile = Join-Path $TempRoot "agy-market.tar.gz.sha256"

  Write-Host "[AGY Market] Downloading release archive & SHA-256 checksum..."
  Invoke-WebRequest -Uri $TarUrl -OutFile $TarFile -UseBasicParsing
  Invoke-WebRequest -Uri $ShaUrl -OutFile $ShaFile -UseBasicParsing

  $ExpectedHash = ((Get-Content -Path $ShaFile -Raw).Trim() -split "\s+")[0].ToLowerInvariant()
  $ActualHash   = (Get-FileHash -Path $TarFile -Algorithm SHA256).Hash.ToLowerInvariant()

  if ($ExpectedHash -ne $ActualHash) {
    throw "INTEGRITY_SHA256_MISMATCH: Expected $ExpectedHash, got $ActualHash"
  }

  New-Item -ItemType Directory -Force -Path $TargetDir | Out-Null
  tar -xzf $TarFile -C $TargetDir

  $Manifest = Get-Content -Path (Join-Path $TargetDir "plugin.json") -Raw | ConvertFrom-Json
  $Ver = if ($Manifest.version) { [string]$Manifest.version } else { "1.0.0" }
  $NowIso = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
  $Receipt = [ordered]@{
    schemaVersion = 1
    id = "azwosile__agy-market"
    track = "verified"
    repositoryId = 0
    installedDir = "agy-market"
    effectivePluginName = "agy-market"
    scopedRewriteApplied = $false
    installedVersion = $Ver
    gitTag = "v$Ver"
    sha256 = $ActualHash
    preservePaths = @()
    grantedCapabilities = [ordered]@{
      badges = @("sidecar-ui")
      mcpRemoteDomains = @()
      hookEvents = @()
    }
    installedAt = $NowIso
    updatedAt = $NowIso
  } | ConvertTo-Json -Depth 5
  Set-Content -Path (Join-Path $TargetDir ".agy-market-receipt.json") -Value $Receipt -Encoding UTF8

  Write-Host "✓ Installed AGY Market -> $TargetDir"
  Write-Host "  Open Market Pane: [AGY Market](sidecar://agy-market/market_pane/)"
  Write-Host "  Manage Plugin:    [AGY Market](customization://agy-market)"
} finally {
  Remove-Item -Recurse -Force -Path $TempRoot -ErrorAction SilentlyContinue
}
