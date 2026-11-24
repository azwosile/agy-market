# Zero-npm PowerShell Bootstrap Installer for AGY Market (`scripts/install.ps1`)
# Verifies SHA-256 digest before extracting real files into ~/.gemini/config/plugins/agy-market
# Automatically falls back to the authoritative AGY Market catalog index when binary release assets are absent.

param(
  [string]$ReleaseBaseUrl = "https://github.com/azwosile/agy-market/releases/latest/download",
  [string]$MirrorPrefix = "",
  [string[]]$CatalogUrls = @(
    "https://azwosile.github.io/agy-market-catalog/index.json",
    "https://raw.githubusercontent.com/azwosile/agy-market-catalog/gh-pages/index.json"
  )
)

$ErrorActionPreference = "Stop"

function Save-UriToFile {
  param([string]$Uri, [string]$OutFile)
  if ($Uri -match '^file://') {
    $LocalPath = ([uri]$Uri).LocalPath
    if (-not (Test-Path -LiteralPath $LocalPath)) {
      throw "Local file not found: $LocalPath"
    }
    Copy-Item -LiteralPath $LocalPath -Destination $OutFile -Force
  } else {
    Invoke-WebRequest -Uri $Uri -OutFile $OutFile -UseBasicParsing
  }
}

$ConfigDir = if ($env:ANTIGRAVITY_CONFIG_DIR) { $env:ANTIGRAVITY_CONFIG_DIR } else { Join-Path $HOME ".gemini\config" }
$TargetDir = Join-Path $ConfigDir "plugins\agy-market"
$TempRoot  = Join-Path ([System.IO.Path]::GetTempPath()) ("agy-market-boot-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $TempRoot | Out-Null

try {
  $TarUrl = "$ReleaseBaseUrl/agy-market.tar.gz"
  $ShaUrl = "$ReleaseBaseUrl/agy-market.tar.gz.sha256"
  if ($MirrorPrefix -and $TarUrl -match '^https?://') {
    $Prefix = $MirrorPrefix.TrimEnd("/")
    $TarUrl = "$Prefix/$TarUrl"
    $ShaUrl = "$Prefix/$ShaUrl"
  }

  $TarFile = Join-Path $TempRoot "agy-market.tar.gz"
  $ShaFile = Join-Path $TempRoot "agy-market.tar.gz.sha256"
  $ExpectedHash = ""
  $ResolvedRepoId = 0

  Write-Host "[AGY Market] Downloading release archive & SHA-256 checksum..."
  try {
    Save-UriToFile -Uri $TarUrl -OutFile $TarFile
    Save-UriToFile -Uri $ShaUrl -OutFile $ShaFile
    $ExpectedHash = ((Get-Content -Path $ShaFile -Raw).Trim() -split "\s+")[0].ToLowerInvariant()
  } catch {
    Write-Host "[AGY Market] Direct release asset unavailable; resolving verified bundle from AGY Market catalog..."
    $CatalogEntry = $null
    foreach ($CatUrl in $CatalogUrls) {
      if (-not $CatUrl) { continue }
      try {
        $CatFile = Join-Path $TempRoot "catalog-index.json"
        Save-UriToFile -Uri $CatUrl -OutFile $CatFile
        $CatJson = Get-Content -Path $CatFile -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($CatJson -and $CatJson.plugins) {
          foreach ($Plug in $CatJson.plugins) {
            if ($Plug.id -eq "azwosile__agy-market" -or $Plug.canonicalName -eq "agy-market") {
              $CatalogEntry = $Plug
              break
            }
          }
        }
        if ($CatalogEntry) { break }
      } catch {
        continue
      }
    }

    if (-not $CatalogEntry -or -not $CatalogEntry.distribution -or -not $CatalogEntry.distribution.tarballUrl -or -not $CatalogEntry.distribution.sha256) {
      throw "ERR_BOOTSTRAP_CATALOG_FALLBACK: Could not resolve azwosile__agy-market from catalog feeds."
    }

    $FallbackTarUrl = [string]$CatalogEntry.distribution.tarballUrl
    if ($MirrorPrefix -and $FallbackTarUrl -match '^https://github\.com/') {
      $FallbackTarUrl = "$($MirrorPrefix.TrimEnd('/'))/$FallbackTarUrl"
    }
    $ExpectedHash = ([string]$CatalogEntry.distribution.sha256).Trim().ToLowerInvariant()
    if ($CatalogEntry.repository -and $CatalogEntry.repository.repositoryId) {
      $ResolvedRepoId = [int64]$CatalogEntry.repository.repositoryId
    }
    Save-UriToFile -Uri $FallbackTarUrl -OutFile $TarFile
  }

  $Sha256 = [System.Security.Cryptography.SHA256]::Create()
  $TarStream = [System.IO.File]::OpenRead($TarFile)
  try {
    $ActualHash = ([System.BitConverter]::ToString($Sha256.ComputeHash($TarStream))).Replace("-", "").ToLowerInvariant()
  } finally {
    $TarStream.Dispose()
    $Sha256.Dispose()
  }
  if ($ExpectedHash -ne $ActualHash) {
    throw "INTEGRITY_SHA256_MISMATCH: Expected $ExpectedHash, got $ActualHash"
  }

  $UnpackDir = Join-Path $TempRoot "unpacked"
  New-Item -ItemType Directory -Force -Path $UnpackDir | Out-Null
  tar -xzf $TarFile -C $UnpackDir

  $BundleDir = $UnpackDir
  if (-not (Test-Path -LiteralPath (Join-Path $BundleDir "plugin.json"))) {
    $TopEntries = @(Get-ChildItem -LiteralPath $UnpackDir -Force)
    if ($TopEntries.Count -eq 1 -and $TopEntries[0].PSIsContainer -and (Test-Path -LiteralPath (Join-Path $TopEntries[0].FullName "plugin.json"))) {
      $BundleDir = $TopEntries[0].FullName
    }
  }
  if (-not (Test-Path -LiteralPath (Join-Path $BundleDir "plugin.json"))) {
    throw "ERR_BOOTSTRAP_MISSING_MANIFEST: Unpacked archive does not contain plugin.json"
  }

  New-Item -ItemType Directory -Force -Path $TargetDir | Out-Null
  Get-ChildItem -LiteralPath $BundleDir -Force | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination $TargetDir -Recurse -Force
  }

  $Manifest = Get-Content -Path (Join-Path $TargetDir "plugin.json") -Raw -Encoding UTF8 | ConvertFrom-Json
  $Ver = if ($Manifest.version) { [string]$Manifest.version } else { "1.5.1" }
  $NowIso = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
  $Receipt = [ordered]@{
    schemaVersion = 1
    id = "azwosile__agy-market"
    track = "verified"
    repositoryId = $ResolvedRepoId
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
  $Utf8NoBom = [System.Text.UTF8Encoding]::new($false)
  [System.IO.File]::WriteAllText((Join-Path $TargetDir ".agy-market-receipt.json"), "$Receipt`n", $Utf8NoBom)

  Write-Host "✓ Installed AGY Market (v$Ver) -> $TargetDir"
  Write-Host "  Open Market Pane: [AGY Market](sidecar://agy-market/market_pane/)"
  Write-Host "  Manage Plugin:    [AGY Market](customization://agy-market)"
} finally {
  Remove-Item -Recurse -Force -Path $TempRoot -ErrorAction SilentlyContinue
}
