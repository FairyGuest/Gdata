# Offline dependency materialization (this sandbox has no network access).
# Copies typescript / @types/node / undici-types from the local pnpm content-
# addressable store (F:\.pnpm-store\v10) into node_modules. In a normal
# environment just run: npm install
$ErrorActionPreference = "Stop"
$store = "F:\.pnpm-store\v10"

function Materialize($indexJson, $dest) {
  $idx = Get-Content $indexJson -Raw | ConvertFrom-Json
  foreach ($prop in $idx.files.PSObject.Properties) {
    $b64 = $prop.Value.integrity -replace '^sha512-',''
    $hex = ([Convert]::FromBase64String($b64) | ForEach-Object { $_.ToString('x2') }) -join ''
    $src = Join-Path $store ("files\" + $hex.Substring(0,2) + "\" + $hex.Substring(2))
    if (-not (Test-Path $src)) { $src = $src + '-exec' }
    $out = Join-Path $dest $prop.Name
    New-Item -ItemType Directory -Force (Split-Path $out) | Out-Null
    Copy-Item $src $out -Force
  }
}

Materialize "$store\index\a7\57625ba4ea2fd2f4ee7371bd130cee130cc387395cea3fd626cbe1a0081a64-typescript@5.8.3.json" "node_modules\typescript"
Materialize "$store\index\a1\a79349b09e7fb53fcfbac3789035dfcc691b736e29ceb8feb676aa65059052-@types+node@24.0.15.json" "node_modules\@types\node"
Materialize "$store\index\f5\4276c460ef438ded63254ca6e1e5b20029c9d07c64a7d5613b0b0e15e414bf-undici-types@7.8.0.json" "node_modules\undici-types"

New-Item -ItemType Directory -Force node_modules\.bin | Out-Null
Set-Content -Encoding ascii node_modules\.bin\tsc.cmd '@echo off' 
Add-Content -Encoding ascii node_modules\.bin\tsc.cmd 'node "%~dp0\..\typescript\lib\tsc.js" %*'
Write-Host "offline deps materialized"

