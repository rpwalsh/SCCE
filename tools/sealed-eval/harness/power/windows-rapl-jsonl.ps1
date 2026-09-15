[CmdletBinding()]
param(
  [ValidateRange(1000, 60000)]
  [int]$IntervalMilliseconds = 1000,

  [ValidateRange(0, 86400)]
  [int]$DurationSeconds = 0,

  [ValidateNotNullOrEmpty()]
  [string]$InstanceName = "RAPL_Package0_PKG"
)

$ErrorActionPreference = "Stop"
$counterClass = "Win32_PerfRawData_PowerMeterCounter_EnergyMeter"
$source = "windows-perflib-rapl"
$scope = "processor-package"
$sensorId = "${source}:${InstanceName}"
$picowattHourToJoule = 3.6e-9
$startedAt = [DateTimeOffset]::UtcNow
$lastEnergy = $null
$lastProviderTime = $null

function Write-Sample([hashtable]$Sample) {
  [Console]::Out.WriteLine(($Sample | ConvertTo-Json -Compress -Depth 4))
  [Console]::Out.Flush()
}

while ($true) {
  try {
    $reading = Get-CimInstance -Namespace "root/cimv2" -ClassName $counterClass |
      Where-Object { $_.Name -eq $InstanceName } |
      Select-Object -First 1
    # Timestamp the completed observation. The first CIM query can be much
    # slower than later samples, so timestamping before it would move the
    # cumulative reading backwards by the query latency.
    $timestamp = [DateTimeOffset]::UtcNow

    if ($null -eq $reading) {
      Write-Sample @{
        timestampMs = $timestamp.ToUnixTimeMilliseconds()
        source = $source
        scope = $scope
        sensorId = $sensorId
        valid = $false
        reason = "counter-instance-missing"
      }
    }
    else {
      $energy = [UInt64]$reading.Energy
      $providerTime = [UInt64]$reading.Time
      $advanced = $null -eq $lastEnergy -or ($energy -gt $lastEnergy -and $providerTime -gt $lastProviderTime)

      Write-Sample @{
        timestampMs = $timestamp.ToUnixTimeMilliseconds()
        joules = [double]$energy * $picowattHourToJoule
        source = $source
        scope = $scope
        sensorId = $sensorId
        valid = [bool]$advanced
        reason = $(if ($advanced) { $null } else { "counter-stale" })
        raw = @{
          energyPicowattHours = $energy.ToString([Globalization.CultureInfo]::InvariantCulture)
          providerTimeMs = $providerTime.ToString([Globalization.CultureInfo]::InvariantCulture)
          instance = [string]$reading.Name
        }
      }

      $lastEnergy = $energy
      $lastProviderTime = $providerTime
    }
  }
  catch {
    $timestamp = [DateTimeOffset]::UtcNow
    Write-Sample @{
      timestampMs = $timestamp.ToUnixTimeMilliseconds()
      source = $source
      scope = $scope
      sensorId = $sensorId
      valid = $false
      reason = "counter-read-failed"
      errorType = $_.Exception.GetType().FullName
    }
  }

  if ($DurationSeconds -gt 0 -and ([DateTimeOffset]::UtcNow - $startedAt).TotalSeconds -ge $DurationSeconds) {
    break
  }
  Start-Sleep -Milliseconds $IntervalMilliseconds
}
