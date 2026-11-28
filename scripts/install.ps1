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

function Get-Sha256([string]$Path) {
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try {
    $stream = [IO.File]::OpenRead($Path)
    try { return ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
    finally { $stream.Dispose() }
  } finally { $algorithm.Dispose() }
}

$ConfigDir = if ($env:ANTIGRAVITY_CONFIG_DIR) { $env:ANTIGRAVITY_CONFIG_DIR } else { Join-Path $HOME ".gemini\config" }
$TargetDir = Join-Path $ConfigDir "plugins\agy-market"
$TempRoot  = Join-Path ([System.IO.Path]::GetTempPath()) ("agy-market-boot-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $TempRoot | Out-Null

$Ticket = $null
$WriteDir = $null
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
            if ($Plug.id -ceq "azwosile__agy-market") {
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

  $ActualHash = Get-Sha256 $TarFile
  if ($ExpectedHash -ne $ActualHash) {
    throw "INTEGRITY_SHA256_MISMATCH: Expected $ExpectedHash, got $ActualHash"
  }

  $UnpackDir = Join-Path $TempRoot "unpacked"
  New-Item -ItemType Directory -Force -Path $UnpackDir | Out-Null
  tar -xzf $TarFile -C $UnpackDir
  if ($LASTEXITCODE -ne 0) { throw "Could not extract verified release archive." }

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

  $DataDir = @($env:AGY_MARKET_DATA_DIR, $env:ANTIGRAVITY_EXECUTABLE_DATA_DIR, $env:PLUGIN_DATA) |
    Where-Object { $_ } | Select-Object -First 1
  if (!$DataDir) {
    $base = Join-Path $HOME ".gemini"
    if (Test-Path -LiteralPath (Join-Path $base "antigravity")) { $base = Join-Path $base "antigravity" }
    $DataDir = Join-Path $base "sidecar_data/agy-market/market_pane/data"
  }
  $LockDir = Join-Path $DataDir "mutation-locks"
  [void][IO.Directory]::CreateDirectory($LockDir)
  $Ticket = Join-Path $LockDir ("$PID-" + [guid]::NewGuid())
  [IO.File]::Open($Ticket, 'CreateNew', 'Write', 'None').Dispose()
  foreach ($other in Get-ChildItem -LiteralPath $LockDir -File) {
    if ($other.Name -eq [IO.Path]::GetFileName($Ticket) -or $other.Name -notmatch '^(\d+)-') { continue }
    if (Get-Process -Id ([int]$Matches[1]) -ErrorAction SilentlyContinue) { throw 'ERR_PLUGIN_OPERATION_BUSY: Another plugin operation is active.' }
  }
  $JournalPath = Join-Path $DataDir "pending-journal.json"
  $Superseded = $null
  if (Test-Path -LiteralPath $JournalPath) {
    $pending = Get-Content -LiteralPath $JournalPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $plugins = if ($pending.pluginsDir) { $pending.pluginsDir } else { Join-Path $ConfigDir "plugins" }
    if (!$pending.parkedByMarket -and $pending.dir -eq "agy-market" -and
        [IO.Path]::GetFullPath((Join-Path $plugins $pending.dir)) -eq [IO.Path]::GetFullPath($TargetDir)) {
      $Superseded = $pending
    }
  }
  New-Item -ItemType Directory -Force -Path $TargetDir | Out-Null
  $ReceiptPath = Join-Path $TargetDir ".agy-market-receipt.json"
  $Previous = if (Test-Path -LiteralPath $ReceiptPath) {
    Get-Content -LiteralPath $ReceiptPath -Raw -Encoding UTF8 | ConvertFrom-Json
  }
  $manifestPath = Join-Path $TargetDir 'plugin.json'
  $existing = if (Test-Path -LiteralPath $manifestPath) {
    Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
  }
  $repo = if ($existing.repository -is [string]) { $existing.repository } else { $existing.repository.url }
  $officialRepo = '^(?:(?:git\+)?(?:https?|git)://github\.com/|ssh://git@github\.com/|git@github\.com:)azwosile/agy-market(?:\.git)?/?$'
  $official = $repo -match $officialRepo
  if (@(Get-ChildItem -LiteralPath $TargetDir -Force).Count -gt 0) {
    $owned = if ($Previous) {
      $Previous.id -ceq 'azwosile__agy-market' -and (!$Previous.repositoryId -or $Previous.repositoryId -eq 1468650761) -and
        (!$Previous.repositoryUrl -or $Previous.repositoryUrl -match $officialRepo) -and
        (!$Previous.pluginRoot -or $Previous.pluginRoot -in @('.', './'))
    } else {
      $official -and !(Test-Path -LiteralPath (Join-Path $TargetDir '.git'))
    }
    if (!$owned -or ($existing -and $existing.name -cne 'agy-market') -or ($repo -and !$official)) {
      throw "ERR_BOOTSTRAP_CONFLICT: $TargetDir contains another installation or a Git worktree."
    }
  }
  $Preserved = @($Previous.preservePaths | Where-Object { $_ -is [string] -and $_ })
  $PreservePatterns = @(
    foreach ($pattern in $Preserved) {
      $glob = ($pattern.Trim().Replace('\', '/') -replace '^\./+', '').TrimEnd('/')
      if (!$glob -or $glob.Contains('..')) { continue }
      $parts = foreach ($part in [regex]::Split($glob, '(\*\*/|\*\*|\*|\?)')) {
        switch -Exact ($part) {
          '**/' { '(?:.+/)?' }
          '**'  { '.*' }
          '*'   { '[^/]*' }
          '?'   { '[^/]' }
          default { [regex]::Escape($part) }
        }
      }
      '^' + ($parts -join '') + '(?:/.*)?$'
    }
  )
  function Test-Preserved([string]$Rel) {
    foreach ($pattern in $PreservePatterns) {
      if ($Rel -match $pattern) { return $true }
    }
    return $false
  }
  function Get-SafeTargetFile([string]$Rel) {
    if ($Rel -match '[\\:\x00-\x1f]|(^|/)(\.{1,2}|)(/|$)') { throw "Invalid release file path: $Rel" }
    $root = [IO.Path]::GetFullPath($TargetDir)
    $current = $root
    foreach ($part in @('') + $Rel.Split('/')) {
      if ($part) { $current = Join-Path $current $part }
      $item = Get-Item -LiteralPath $current -Force -ErrorAction SilentlyContinue
      if ($item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw "Linked path in installation: $current"
      }
    }
    $full = [IO.Path]::GetFullPath($current)
    if (!$full.StartsWith($root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
      throw "Release path outside installation: $Rel"
    }
    return $full
  }

  # Prepare replacements on the same volume. A killed copy cannot leave a
  # partial file in the plugin tree or truncate the last committed receipt.
  $WriteDir = Join-Path $ConfigDir ('.agy-market-write-' + [guid]::NewGuid().ToString('N'))
  [void][IO.Directory]::CreateDirectory($WriteDir)
  $Prepared = Join-Path $WriteDir 'next'
  $Utf8NoBom = [System.Text.UTF8Encoding]::new($false)
  function Publish-Prepared([string]$Dest, [bool]$Replace) {
    if ($Replace) {
      [IO.File]::Replace($Prepared, $Dest, [System.Management.Automation.Language.NullString]::Value)
    } else {
      [IO.File]::Move($Prepared, $Dest)
    }
  }
  $LedgerName = '.agy-market-bootstrap-pending'
  $LedgerPath = Get-SafeTargetFile $LedgerName
  $null = Get-SafeTargetFile '.agy-market-receipt.json'
  $Pending = @{}
  $LedgerLines = [Collections.Generic.List[string]]::new()
  if ([IO.File]::Exists($LedgerPath)) {
    foreach ($line in [IO.File]::ReadAllLines($LedgerPath)) {
      if ($line -cnotmatch '^([a-f0-9]{64})  (.+)$') { throw 'Invalid bootstrap recovery record.' }
      $digest = $Matches[1]
      $path = $Matches[2]
      $null = Get-SafeTargetFile $path
      if ($path -in @($LedgerName, '.agy-market-receipt.json')) { throw 'Invalid bootstrap recovery path.' }
      $Pending[$path] = @($Pending[$path] | Where-Object { $_ }) + $digest
      $LedgerLines.Add($line)
    }
  }
  function Test-PendingFile([string]$Rel, [string]$Dest) {
    if (!$Pending.ContainsKey($Rel) -or ![IO.File]::Exists($Dest)) { return $false }
    return $Pending[$Rel] -contains (Get-Sha256 $Dest)
  }
  $files = @(Get-ChildItem -LiteralPath $BundleDir -File -Recurse -Force)
  $Replaceable = @{}
  $BlockingFiles = @{}
  $BlockingDirs = @{}
  function Add-BlockingFile([string]$Rel) {
    $dest = Get-SafeTargetFile $Rel
    if ((Test-Preserved $Rel) -or
        ($Previous.managedFiles -notcontains $Rel -and !(Test-PendingFile $Rel $dest))) {
      throw "ERR_PLUGIN_LAYOUT_CONFLICT: Cannot replace local path '$Rel'"
    }
    $BlockingFiles[$Rel] = $true
  }
  function Add-BlockingDirectory([string]$Rel) {
    $dest = Get-SafeTargetFile $Rel
    if (Test-Preserved $Rel) { throw "ERR_PLUGIN_LAYOUT_CONFLICT: Preserved directory '$Rel'" }
    foreach ($child in Get-ChildItem -LiteralPath $dest -Force) {
      $childRel = "$Rel/$($child.Name)"
      if ($child.PSIsContainer) { Add-BlockingDirectory $childRel } else { Add-BlockingFile $childRel }
    }
    $BlockingDirs[$Rel] = $true
  }
  $Managed = @(
    foreach ($file in $files) {
      $rel = $file.FullName.Substring($BundleDir.Length + 1).Replace('\', '/')
      if ($rel -eq '.agy-market-receipt.json') { continue }
      if ($rel -eq $LedgerName -or $rel.StartsWith("$LedgerName/", [StringComparison]::OrdinalIgnoreCase)) {
        throw "Reserved bootstrap path in release: $rel"
      }
      $target = Get-SafeTargetFile $rel
      for ($parent = [IO.Path]::GetDirectoryName($rel); $parent; $parent = [IO.Path]::GetDirectoryName($parent)) {
        $parentRel = $parent.Replace('\', '/')
        if ([IO.File]::Exists((Join-Path $TargetDir $parentRel))) { Add-BlockingFile $parentRel }
      }
      if ([IO.Directory]::Exists($target)) {
        $prefix = "$rel/"
        if (!(@($Previous.managedFiles) + @($Pending.Keys) | Where-Object {
          $_ -and $_.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
        })) { throw "ERR_PLUGIN_LAYOUT_CONFLICT: Cannot replace local directory '$rel'" }
        Add-BlockingDirectory $rel
      }
      $exists = [IO.File]::Exists($target)
      $replace = $exists -and (Test-PendingFile $rel $target)
      if (($Previous.managedFiles -is [array] -or $Pending.ContainsKey($rel)) -and $exists -and
          $Previous.managedFiles -notcontains $rel -and !(Test-Preserved $rel) -and !$replace) {
        if ($Superseded) {
          throw "ERR_PLUGIN_LAYOUT_CONFLICT: Cannot replace local path '$rel'. Resume the interrupted Market update in the sidecar, then retry."
        }
        throw "ERR_PLUGIN_LAYOUT_CONFLICT: Cannot replace local path '$rel'"
      }
      $Replaceable[$rel] = $exists
      if ((!$exists -or $replace) -and $Previous.managedFiles -notcontains $rel) {
        $digest = Get-Sha256 $file.FullName
        if ($Pending[$rel] -notcontains $digest) { $LedgerLines.Add("$digest  $rel") }
      }
      $rel
    }
  )
  if (!$Previous -and !$existing) {
    [IO.File]::WriteAllText($Prepared, '{"id":"azwosile__agy-market","managedFiles":[]}', $Utf8NoBom)
    Publish-Prepared $ReceiptPath $false
  }
  if ($LedgerLines.Count) {
    [IO.File]::WriteAllText($Prepared, (($LedgerLines -join "`n") + "`n"), $Utf8NoBom)
    Publish-Prepared $LedgerPath ([IO.File]::Exists($LedgerPath))
  }
  foreach ($rel in $BlockingFiles.Keys) {
    $dest = Get-SafeTargetFile $rel
    if ($Previous.managedFiles -notcontains $rel -and !(Test-PendingFile $rel $dest)) {
      throw "ERR_PLUGIN_LAYOUT_CONFLICT: Local path '$rel' has changed"
    }
    [IO.File]::Delete($dest)
  }
  foreach ($rel in $BlockingDirs.Keys | Sort-Object Length -Descending) {
    [IO.Directory]::Delete((Get-SafeTargetFile $rel), $false)
  }
  function Write-BundleFile([string]$rel) {
    $target = Get-SafeTargetFile $rel
    if ((Test-Path -LiteralPath $target -PathType Leaf) -and (Test-Preserved $rel)) { return }
    [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target))
    [IO.File]::Copy((Join-Path $BundleDir $rel), $Prepared)
    Publish-Prepared $target $Replaceable[$rel]
  }
  foreach ($rel in $Managed) {
    if ($rel -ne 'plugin.json') { Write-BundleFile $rel }
  }
  foreach ($rel in $Previous.managedFiles) {
    if (!$rel -or $rel -in @($LedgerName, '.agy-market-receipt.json') -or $Managed -contains $rel -or (Test-Preserved $rel)) { continue }
    $retired = Get-SafeTargetFile $rel
    if (Test-Path -LiteralPath $retired -PathType Leaf) { [IO.File]::Delete($retired) }
  }
  foreach ($rel in $Pending.Keys) {
    if ($Managed -contains $rel -or (Test-Preserved $rel)) { continue }
    $retired = Get-SafeTargetFile $rel
    if (Test-PendingFile $rel $retired) { [IO.File]::Delete($retired) }
  }

  Write-BundleFile 'plugin.json'
  $Manifest = Get-Content -Path (Join-Path $TargetDir "plugin.json") -Raw -Encoding UTF8 | ConvertFrom-Json
  $Ver = if ($Manifest.version) { [string]$Manifest.version } else { "2.0.0" }
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
    managedFiles = $Managed
    preservePaths = $Preserved
    grantedCapabilities = [ordered]@{
      badges = @("sidecar-ui")
      mcpRemoteDomains = @()
      hookEvents = @()
    }
    installedAt = if ($Previous.installedAt) { $Previous.installedAt } else { $NowIso }
    updatedAt = $NowIso
  } | ConvertTo-Json -Depth 5
  [IO.File]::WriteAllText($Prepared, "$Receipt`n", $Utf8NoBom)
  Publish-Prepared $ReceiptPath ([IO.File]::Exists($ReceiptPath))
  [IO.File]::Delete($LedgerPath)

  if ($Superseded) {
    Remove-Item -LiteralPath $JournalPath -Force
    $stageBase = [IO.Path]::GetFullPath((Join-Path $DataDir "staging"))
    foreach ($dir in @($Superseded.stagingRootDir, $Superseded.backupDir)) {
      if (!$dir) { continue }
      $full = [IO.Path]::GetFullPath($dir)
      if ([IO.Path]::GetDirectoryName($full) -eq $stageBase -and (Test-Path -LiteralPath $full)) {
        $item = Get-Item -LiteralPath $full -Force
        if (!($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
          Remove-Item -LiteralPath $full -Recurse -Force -ErrorAction SilentlyContinue
        }
      }
    }
  }
  Write-Host "✓ Installed AGY Market (v$Ver) -> $TargetDir"
  Write-Host "  Open Market Pane: [AGY Market](sidecar://agy-market/market_pane/)"
  Write-Host "  Manage Plugin:    [AGY Market](customization://agy-market)"
} finally {
  if ($WriteDir) { Remove-Item -LiteralPath $WriteDir -Recurse -Force -ErrorAction SilentlyContinue }
  if ($Ticket) { Remove-Item -LiteralPath $Ticket -Force -ErrorAction SilentlyContinue }
  Remove-Item -Recurse -Force -Path $TempRoot -ErrorAction SilentlyContinue
}
