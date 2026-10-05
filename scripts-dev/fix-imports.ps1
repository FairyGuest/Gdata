
Get-ChildItem src,scripts,tests -Recurse -Filter *.ts | ForEach-Object {
  $c = [IO.File]::ReadAllText($_.FullName)
  $n = [regex]::Replace($c, "(from '\.{1,2}/[^']*)\.js'", '$1.ts' + [char]39)
  if ($c -ne $n) { [IO.File]::WriteAllText($_.FullName, $n, (New-Object System.Text.UTF8Encoding $false)); Write-Output "patched $($_.Name)" }
}
