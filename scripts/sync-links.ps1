#Requires -Version 5.1
<#
.SYNOPSIS
  Link every skill under ./skills into ~/.agents/skills via Windows directory junctions.

.DESCRIPTION
  Dev-machine helper for Yogioo/agent-skills.
  - Scans <repo>/skills/*/SKILL.md
  - Ensures %USERPROFILE%\.agents\skills\<name> -> <repo>\skills\<name>
  - Replaces a wrong junction; refuses to delete a real non-link directory unless -Force

.EXAMPLE
  pwsh -File .\scripts\sync-links.ps1
  pwsh -File .\scripts\sync-links.ps1 -Force
#>
[CmdletBinding()]
param(
  [switch]$Force,
  [switch]$WhatIf
)

$ErrorActionPreference = 'Stop'

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$skillsRoot = Join-Path $repoRoot 'skills'
$agentsSkills = Join-Path $env:USERPROFILE '.agents\skills'

if (-not (Test-Path $skillsRoot)) {
  throw "Skills directory not found: $skillsRoot"
}

New-Item -ItemType Directory -Path $agentsSkills -Force | Out-Null

function Get-ReparseTarget([string]$path) {
  $item = Get-Item -LiteralPath $path -Force
  if (-not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    return $null
  }
  if ($item.Target -is [string]) { return $item.Target }
  if ($item.Target -is [array] -and $item.Target.Count -gt 0) { return [string]$item.Target[0] }
  # Fallback: cmd dir parse is brittle; use .NET if available
  return $null
}

function Remove-PathForRelink([string]$path) {
  $item = Get-Item -LiteralPath $path -Force
  $isReparse = [bool]($item.Attributes -band [IO.FileAttributes]::ReparsePoint)
  if ($WhatIf) {
    Write-Host "[WhatIf] remove $path (reparse=$isReparse)"
    return
  }
  if ($isReparse) {
    cmd /c "rmdir `"$path`"" | Out-Null
  } else {
    Remove-Item -LiteralPath $path -Recurse -Force
  }
}

$skillDirs = Get-ChildItem -LiteralPath $skillsRoot -Directory |
  Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'SKILL.md') }

if (-not $skillDirs) {
  Write-Host "No skills with SKILL.md under $skillsRoot"
  exit 0
}

$created = 0
$ok = 0
$replaced = 0
$skipped = 0

foreach ($dir in $skillDirs) {
  $name = $dir.Name
  $source = $dir.FullName
  $dest = Join-Path $agentsSkills $name

  if (-not (Test-Path -LiteralPath $dest)) {
    if ($WhatIf) {
      Write-Host "[WhatIf] mklink /J `"$dest`" `"$source`""
    } else {
      $out = cmd /c "mklink /J `"$dest`" `"$source`"" 2>&1
      if ($LASTEXITCODE -ne 0) { throw "Failed to link $name : $out" }
      Write-Host "CREATED  $name -> $source"
    }
    $created++
    continue
  }

  $item = Get-Item -LiteralPath $dest -Force
  $isReparse = [bool]($item.Attributes -band [IO.FileAttributes]::ReparsePoint)
  if ($isReparse) {
    $current = Get-ReparseTarget $dest
    $currentFull = if ($current) { [IO.Path]::GetFullPath($current) } else { '' }
    $sourceFull = [IO.Path]::GetFullPath($source)
    if ($currentFull -and ($currentFull.TrimEnd('\') -ieq $sourceFull.TrimEnd('\'))) {
      Write-Host "OK       $name"
      $ok++
      continue
    }
    Write-Host "REPLACE  $name (was -> $current)"
    Remove-PathForRelink $dest
    if (-not $WhatIf) {
      $out = cmd /c "mklink /J `"$dest`" `"$source`"" 2>&1
      if ($LASTEXITCODE -ne 0) { throw "Failed to relink $name : $out" }
    }
    $replaced++
    continue
  }

  # Real directory / file exists
  if (-not $Force) {
    Write-Warning "SKIP     $name — $dest exists and is not a junction. Re-run with -Force to replace."
    $skipped++
    continue
  }

  Write-Host "FORCE    $name (removing real path)"
  Remove-PathForRelink $dest
  if (-not $WhatIf) {
    $out = cmd /c "mklink /J `"$dest`" `"$source`"" 2>&1
    if ($LASTEXITCODE -ne 0) { throw "Failed to force-link $name : $out" }
  }
  $replaced++
}

Write-Host ""
Write-Host "Done. created=$created ok=$ok replaced=$replaced skipped=$skipped"
Write-Host "Agents dir: $agentsSkills"
Write-Host "Repo skills: $skillsRoot"
