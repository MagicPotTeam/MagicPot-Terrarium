<#
.SYNOPSIS
    Sets up junctions for custom nodes and data directories, ensuring ComfyUI git repo remains clean.
#>

$ScriptDir = $PSScriptRoot
$RepoRoot = Resolve-Path (Join-Path $ScriptDir "..\..")
$ComfyRuntimeDir = Join-Path $RepoRoot "vendor\comfyui"
$ComfyUIDir = Join-Path $ComfyRuntimeDir "ComfyUI"

Write-Host "Setting up ComfyUI directories..." -ForegroundColor Cyan

# Get the git exclude file path for the ComfyUI submodule
Push-Location $ComfyUIDir
$ExcludeFile = (git rev-parse --git-path info/exclude)
Pop-Location

Write-Host "Git Exclude File: $ExcludeFile" -ForegroundColor Gray

# ==================== Custom Nodes ====================
$CustomNodesSource = Join-Path $ComfyRuntimeDir "comfyui_data\custom_nodes"
$CustomNodesTarget = Join-Path $ComfyUIDir "custom_nodes"

if (-not (Test-Path $CustomNodesTarget)) {
    New-Item -ItemType Directory -Path $CustomNodesTarget -Force | Out-Null
}

Write-Host "`nLinking custom nodes..." -ForegroundColor Yellow
Get-ChildItem -Path $CustomNodesSource -Directory | ForEach-Object {
    $NodeName = $_.Name
    $SourcePath = $_.FullName
    $TargetPath = Join-Path $CustomNodesTarget $NodeName

    if (-not (Test-Path $TargetPath)) {
        cmd /c mklink /J "$TargetPath" "$SourcePath" | Out-Null
        Write-Host "  Linked: $NodeName" -ForegroundColor Green
    }

    # Add to git exclude
    $ExcludeLine = "custom_nodes/$NodeName"
    if (Test-Path $ExcludeFile) {
        $Content = Get-Content $ExcludeFile
        if ($Content -notcontains $ExcludeLine) {
            Add-Content -Path $ExcludeFile -Value $ExcludeLine
        }
    }
}

# ==================== Data Directories ====================
$DataDirs = @(
    @{ Name = "models"; ComfyUIPath = "models" },
    @{ Name = "input"; ComfyUIPath = "input" },
    @{ Name = "output"; ComfyUIPath = "output" },
    @{ Name = "workflows"; ComfyUIPath = "user\default\workflows" }
)

Write-Host "`nLinking data directories..." -ForegroundColor Yellow
foreach ($Dir in $DataDirs) {
    $SourcePath = Join-Path $ComfyRuntimeDir "comfyui_data\$($Dir.Name)"
    $TargetPath = Join-Path $ComfyUIDir $Dir.ComfyUIPath

    # Ensure source exists
    if (-not (Test-Path $SourcePath)) {
        New-Item -ItemType Directory -Path $SourcePath -Force | Out-Null
    }

    # Check if target is already a junction or directory
    if (Test-Path $TargetPath) {
        $item = Get-Item $TargetPath -Force
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            Write-Host "  Already linked: $($Dir.Name)" -ForegroundColor Gray
            continue
        } else {
            # Move contents and remove
            Move-Item -Path "$TargetPath\*" -Destination $SourcePath -Force -ErrorAction SilentlyContinue
            Remove-Item -Path $TargetPath -Recurse -Force
        }
    }

    # Ensure parent directory exists
    $ParentPath = Split-Path $TargetPath -Parent
    if (-not (Test-Path $ParentPath)) {
        New-Item -ItemType Directory -Path $ParentPath -Force | Out-Null
    }

    # Create junction
    cmd /c mklink /J "$TargetPath" "$SourcePath" | Out-Null
    Write-Host "  Linked: $($Dir.Name)" -ForegroundColor Green

    # Add to git exclude
    $ExcludeLine = $Dir.ComfyUIPath -replace '\\', '/'
    if (Test-Path $ExcludeFile) {
        $Content = Get-Content $ExcludeFile
        if ($Content -notcontains $ExcludeLine) {
            Add-Content -Path $ExcludeFile -Value $ExcludeLine
        }
    }
}

Write-Host "`nSetup completed." -ForegroundColor Green
Write-Host "All directories are linked and ignored in ComfyUI repository."
