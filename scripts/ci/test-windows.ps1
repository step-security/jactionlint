$ErrorActionPreference = 'Stop'

$testBinary = Join-Path $env:RUNNER_TEMP 'jactionlint-tests.exe'
go test -c -o $testBinary .
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}

$listArgs = @('-test.list=^(Test|Example|Fuzz)')
$testNames = @(& $testBinary @listArgs | Where-Object { $_ -match '^(Test|Example|Fuzz)' })
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}
$testNames = @($testNames | Sort-Object -Unique)
if ($testNames.Count -eq 0) {
  throw 'The compiled test binary did not list any tests.'
}

$shardCount = 4
$shards = for ($shard = 0; $shard -lt $shardCount; $shard++) {
  $names = [System.Collections.Generic.List[string]]::new()
  for ($index = $shard; $index -lt $testNames.Count; $index += $shardCount) {
    $names.Add($testNames[$index])
  }
  [pscustomobject]@{
    Name = "Go test shard $($shard + 1)/$shardCount"
    Pattern = '^(' + ($names -join '|') + ')$'
    TestCount = $names.Count
    Packages = @()
  }
}

$module = 'github.com/jdx/jactionlint/v2'
$packages = @(go list ./... | Where-Object { $_ -ne $module })
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}
if ($packages.Count -gt 0) {
  $shards += [pscustomobject]@{
    Name = 'Other Go packages'
    Pattern = ''
    TestCount = 0
    Packages = $packages
  }
}

$results = $shards | ForEach-Object -Parallel {
  $shard = $_
  $ErrorActionPreference = 'Stop'
  if ($shard.Pattern) {
    Write-Host "Starting $($shard.Name) ($($shard.TestCount) tests)."
    $testArgs = @('-test.v=true', '-test.parallel=1', "-test.run=$($shard.Pattern)")
    & $using:testBinary @testArgs 2>&1 | ForEach-Object {
      Write-Host "[$($shard.Name)] $_"
    }
    $status = $LASTEXITCODE
  } else {
    Write-Host "Starting tests in $($shard.Packages.Count) other Go packages."
    $packages = $shard.Packages
    & go test -v -parallel=1 @packages 2>&1 | ForEach-Object {
      Write-Host "[Other Go packages] $_"
    }
    $status = $LASTEXITCODE
  }
  [pscustomobject]@{ Name = $shard.Name; ExitCode = $status }
} -ThrottleLimit 5

$failed = @($results | Where-Object { $_.ExitCode -ne 0 })
if ($failed.Count -gt 0) {
  foreach ($result in $failed) {
    Write-Error "$($result.Name) failed with exit code $($result.ExitCode)."
  }
  exit 1
}
