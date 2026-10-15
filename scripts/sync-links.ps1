#Requires -Version 5.1
<#
.SYNOPSIS
  Link every active skill under ./skills into an agents skills directory via junctions.

.DESCRIPTION
  Dev-machine helper for Yogioo/agent-skills.

  - Active skills are directories that still contain SKILL.md.
  - Ensures <destination>\<name> -> <skills-root>\<name> for every active skill.
  - With -Prune, removes retired junctions that point exactly at this repo's
    skills\<name> and no longer contain SKILL.md. Foreign links, real
    directories and live skills are never pruned.
  - -Force replaces a real non-junction directory only after verifying the
    resolved path stays under the destination root.
  - -WhatIf performs no filesystem mutation (not even creating the destination).

.PARAMETER Destination
  Agents skills directory. Defaults to %USERPROFILE%\.agents\skills. Use a temp
  path in tests to isolate the target.

.PARAMETER SkillsRoot
  Skills source directory. Defaults to <repo>\skills. Use a temp repo in tests.

.PARAMETER Prune
  Explicitly remove retired junctions as described above.

.PARAMETER Force
  Replace a real (non-junction) directory that occupies an active skill name.

.EXAMPLE
  pwsh -File .\scripts\sync-links.ps1
  pwsh -File .\scripts\sync-links.ps1 -Prune
  pwsh -File .\scripts\sync-links.ps1 -Destination $env:TEMP\agents-skills -SkillsRoot $env:TEMP\repo\skills -Prune
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [switch]$Force,
  [switch]$Prune,
  [string]$Destination,
  [string]$SkillsRoot
)

$ErrorActionPreference = 'Stop'

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')

if ($SkillsRoot) {
  $skillsRoot = [IO.Path]::GetFullPath($SkillsRoot)
} else {
  $skillsRoot = Join-Path $repoRoot 'skills'
}

if ($Destination) {
  $destRoot = [IO.Path]::GetFullPath($Destination)
} else {
  $destRoot = Join-Path $env:USERPROFILE '.agents\skills'
}

if (-not (Test-Path -LiteralPath $skillsRoot -PathType Container)) {
  throw "Skills directory not found: $skillsRoot"
}

$whatIf = [bool]$WhatIfPreference

# DirectoryInfo.Target is the recorded junction target even when the target is
# missing (broken junction). Fall back to LinkTarget on newer PowerShell.
function Get-LinkTarget($item) {
  try {
    $target = $item.Target
    if ($target -is [array]) { if ($target.Count -gt 0) { return [string]$target[0] } }
    elseif ($target) { return [string]$target }
  } catch { }
  try {
    if ($item.LinkTarget) { return [string]$item.LinkTarget }
  } catch { }
  return $null
}

function Test-ReparsePoint($item) {
  return [bool]($item.Attributes -band [IO.FileAttributes]::ReparsePoint)
}

function Normalize-PathString([string]$path) {
  if (-not $path) { return '' }
  return ([IO.Path]::GetFullPath($path)).TrimEnd('\', '/')
}

function Test-SamePath([string]$a, [string]$b) {
  if (-not $a -or -not $b) { return $false }
  return (Normalize-PathString $a) -ieq (Normalize-PathString $b)
}

function Test-UnderRoot([string]$path, [string]$root) {
  $full = [IO.Path]::GetFullPath($path)
  $fullRoot = [IO.Path]::GetFullPath($root).TrimEnd('\', '/')
  return $full.StartsWith($fullRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
}

function Get-ExistingItem([string]$path) {
  return Get-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
}

function New-Junction([string]$linkPath, [string]$targetPath) {
  if ($whatIf) {
    Write-Host "[WhatIf] junction $linkPath -> $targetPath"
    return
  }
  New-Item -ItemType Junction -Path $linkPath -Target $targetPath | Out-Null
}

# Remove only the junction/reparse point. Never recurses, so the target is safe.
function Remove-Link([string]$path) {
  if ($whatIf) {
    Write-Host "[WhatIf] remove link $path"
    return
  }
  try {
    [System.IO.Directory]::Delete($path, $false)
  } catch {
    Remove-Item -LiteralPath $path -Force
  }
}

function Remove-RealDirectory([string]$path) {
  if (-not (Test-UnderRoot $path $destRoot)) {
    throw "Refusing to remove real directory outside destination: $path"
  }
  if ($whatIf) {
    Write-Host "[WhatIf] remove real directory $path"
    return
  }
  Remove-Item -LiteralPath $path -Recurse -Force
}

# Active skills: directories that still contain SKILL.md.
$activeSkills = @()
if (Test-Path -LiteralPath $skillsRoot -PathType Container) {
  $activeSkills = @(Get-ChildItem -LiteralPath $skillsRoot -Directory -Force |
    Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'SKILL.md') })
}

if (-not (Test-Path -LiteralPath $destRoot) -and -not $whatIf) {
  New-Item -ItemType Directory -Path $destRoot -Force | Out-Null
}

$created = 0
$ok = 0
$replaced = 0
$skipped = 0
$pruned = 0

foreach ($dir in $activeSkills) {
  $name = $dir.Name
  $source = $dir.FullName
  $dest = Join-Path $destRoot $name
  $existing = Get-ExistingItem $dest

  if (-not $existing) {
    New-Junction $dest $source
    if (-not $whatIf) { Write-Host "CREATED  $name -> $source" }
    $created++
    continue
  }

  if (Test-ReparsePoint $existing) {
    $current = Get-LinkTarget $existing
    if (Test-SamePath $current $source) {
      Write-Host "OK       $name"
      $ok++
      continue
    }
    Write-Host "REPLACE  $name (was -> $current)"
    Remove-Link $dest
    New-Junction $dest $source
    $replaced++
    continue
  }

  if (-not $Force) {
    Write-Warning "SKIP     $name - $dest exists and is not a junction. Re-run with -Force to replace."
    $skipped++
    continue
  }

  Write-Host "FORCE    $name (removing real path)"
  Remove-RealDirectory $dest
  New-Junction $dest $source
  $replaced++
}

if ($Prune -and (Test-Path -LiteralPath $destRoot -PathType Container)) {
  $links = @(Get-ChildItem -LiteralPath $destRoot -Force | ForEach-Object {
    $candidate = Get-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue
    if ($candidate -and (Test-ReparsePoint $candidate)) { $candidate }
  })
  foreach ($link in $links) {
    $name = $link.Name
    $expectedSource = [IO.Path]::GetFullPath((Join-Path $skillsRoot $name))
    $current = Get-LinkTarget $link
    if (-not (Test-SamePath $current $expectedSource)) {
      # Points to another repo or an unrelated path: never prune it.
      continue
    }
    $sourceStillActive = Test-Path -LiteralPath (Join-Path $expectedSource 'SKILL.md')
    if ($sourceStillActive) {
      continue
    }
    Write-Host "PRUNE    $name (retired, -> $current)"
    Remove-Link $link.FullName
    $pruned++
  }
}

Write-Host ""
Write-Host "Done. created=$created ok=$ok replaced=$replaced skipped=$skipped pruned=$pruned"
Write-Host "Agents dir: $destRoot"
Write-Host "Skills root: $skillsRoot"
