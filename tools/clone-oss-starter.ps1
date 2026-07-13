param(
  [string]$OutDir = "corpus/oss"
)

$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$repos = @(
  @{ Name = "react"; Url = "https://github.com/facebook/react.git" },
  @{ Name = "vite"; Url = "https://github.com/vitejs/vite.git" },
  @{ Name = "three.js"; Url = "https://github.com/mrdoob/three.js.git" },
  @{ Name = "node"; Url = "https://github.com/nodejs/node.git" }
)

foreach ($repo in $repos) {
  $target = Join-Path $OutDir $repo.Name
  if (Test-Path $target) {
    Write-Host "Skipping existing repo $target"
    continue
  }
  Write-Host "Cloning $($repo.Url) -> $target"
  & git clone --depth=1 $repo.Url $target
}

Write-Host "OSS starter repos written to $OutDir"
