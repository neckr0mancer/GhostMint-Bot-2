$ErrorActionPreference = 'Stop'
$npmArguments = @($args)
$npmVersion = '11.7.0'
$npmArchiveUrl = "https://registry.npmjs.org/npm/-/npm-$npmVersion.tgz"
$npmArchiveSha512 = 'C22099A6FFF8D5B2286C2A09DF5352B4858A7C0C716320F58989D60AD8B29ECF2CE6FDFE97CCB41C23FFB1272E1FA079F868487DD6B81D02A2A9E199C095A117'
$projectRoot = Split-Path -Parent $PSScriptRoot
$toolRoot = Join-Path $projectRoot ".project-tools\npm-$npmVersion"
$npmCli = Join-Path $toolRoot 'package\bin\npm-cli.js'

$runtimeNode = 'C:\Users\General\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
$node = if (Test-Path -LiteralPath $runtimeNode) { $runtimeNode } else {
  (Get-Command node -ErrorAction Stop).Source
}
$env:PATH = "$(Split-Path -Parent $node);$env:PATH"

if (-not (Test-Path -LiteralPath $npmCli)) {
  New-Item -ItemType Directory -Path $toolRoot -Force | Out-Null
  $archive = Join-Path $toolRoot "npm-$npmVersion.tgz"
  Invoke-WebRequest -UseBasicParsing -Uri $npmArchiveUrl -OutFile $archive
  $actualHash = (Get-FileHash -LiteralPath $archive -Algorithm SHA512).Hash
  if ($actualHash -ne $npmArchiveSha512) {
    Remove-Item -LiteralPath $archive -Force
    throw "Downloaded npm $npmVersion archive failed SHA-512 verification."
  }
  tar -xzf $archive -C $toolRoot
  Remove-Item -LiteralPath $archive -Force
}

& $node --use-system-ca $npmCli @npmArguments
exit $LASTEXITCODE
