$tools = @(
  "Git.Git","BurntSushi.ripgrep.MSVC","sharkdp.fd","jqlang.jq","dandavison.delta",
  "OpenJS.NodeJS.LTS","pnpm.pnpm","Kitware.CMake","LLVM.LLVM","PostgreSQL.PostgreSQL"
)
foreach ($t in $tools) {
  Write-Host "=== $t ==="
  winget install $t --accept-package-agreements --accept-source-agreements
  Write-Host ""
}
Get-Command rg,fd,jq,delta,node,pnpm,cmake,psql,git -ErrorAction SilentlyContinue | Select-Object Name,Source