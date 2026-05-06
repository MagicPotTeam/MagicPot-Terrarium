<#
.SYNOPSIS
    Updates ComfyUI and all custom nodes (submodules) to their latest versions from GitHub.
#>

Write-Host "Starting ComfyUI and Custom Nodes Update..." -ForegroundColor Cyan

# Since all nodes are now direct submodules of the parent project, 
# we can update everything at once.

Write-Host "`nUpdating all submodules (ComfyUI Core + Nodes)..." -ForegroundColor Yellow
git submodule update --remote --merge

if ($LASTEXITCODE -ne 0) {
    Write-Error "Failed to update submodules."
    exit $LASTEXITCODE
}

Write-Host "`nAll updates completed successfully!" -ForegroundColor Green
Write-Host "ComfyUI and Custom Nodes are now at the latest version."
