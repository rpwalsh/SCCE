# SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
# Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
#
# Emits one JSONL sample per interval: cumulative RAPL energy in joules, plus the ACPI thermal zone in Celsius.
# The energy contract is the one tools/sealed-eval/harness/lib/power-measurement.mjs already integrates
# (cumulative `joules`, strictly increasing `timestampMs`, constant source/scope/sensorId).
#
# Units are not assumed. The Windows Energy Meter provider reports Energy in picowatt-hours and Time in
# milliseconds; that was confirmed against the provider's own independent Power counter (milliwatts) to within
# 0.05% over five consecutive intervals, and Time against OS uptime to 153 ms.
#
# Scope is the processor package plus DRAM. It is NOT whole-system: display, storage and NIC draw are outside it.
# pp0/pp1 are sub-domains already inside pkg and are reported raw but never added.
[CmdletBinding()]
param(
  [ValidateRange(50, 60000)]
  [int]$IntervalMilliseconds = 250,

  [ValidateRange(0, 86400)]
  [int]$DurationSeconds = 0
)

$ErrorActionPreference = "Stop"
$source = "windows-perflib-rapl-thermal"
$scope = "processor-package-plus-dram"
$picowattHourToJoule = 3.6e-9
$startedAt = [DateTimeOffset]::UtcNow
$lastEnergy = $null
$lastTimestampMs = $null

function Write-Sample([hashtable]$Sample) {
  [Console]::Out.WriteLine(($Sample | ConvertTo-Json -Compress -Depth 5))
  [Console]::Out.Flush()
}

# Instances are discovered, never hardcoded: the domain set differs per CPU and a missing domain must surface
# as an absent reading rather than as a silently smaller total.
$energyCategory = New-Object System.Diagnostics.PerformanceCounterCategory "Energy Meter"
$allInstances = @($energyCategory.GetInstanceNames())
$pkgInstances = @($allInstances | Where-Object { $_ -match '_pkg$' } | Sort-Object)
$dramInstances = @($allInstances | Where-Object { $_ -match '_dram$' } | Sort-Object)
$subInstances = @($allInstances | Where-Object { $_ -match '_pp[01]$' } | Sort-Object)

$pkgCounters = @($pkgInstances | ForEach-Object { New-Object System.Diagnostics.PerformanceCounter "Energy Meter", "Energy", $_, $true })
$dramCounters = @($dramInstances | ForEach-Object { New-Object System.Diagnostics.PerformanceCounter "Energy Meter", "Energy", $_, $true })
$subCounters = @($subInstances | ForEach-Object { New-Object System.Diagnostics.PerformanceCounter "Energy Meter", "Energy", $_, $true })
$timeCounter = if ($pkgInstances.Count) { New-Object System.Diagnostics.PerformanceCounter "Energy Meter", "Time", $pkgInstances[0], $true } else { $null }

$sensorId = "${source}:" + (($pkgInstances + $dramInstances) -join "+")

# The thermal zone is a separate provider and is allowed to be absent. Losing it must not discard real energy.
$zoneName = $null
$zoneCounter = $null
$zoneReason = $null
try {
  $zoneCategory = New-Object System.Diagnostics.PerformanceCounterCategory "Thermal Zone Information"
  $zones = @($zoneCategory.GetInstanceNames() | Sort-Object)
  if ($zones.Count) {
    $zoneName = $zones[0]
    $zoneCounter = New-Object System.Diagnostics.PerformanceCounter "Thermal Zone Information", "High Precision Temperature", $zoneName, $true
  } else { $zoneReason = "no-thermal-zone-instance" }
} catch { $zoneReason = "thermal-category-unavailable" }

if (-not $pkgInstances.Count) {
  Write-Sample @{
    timestampMs = ([DateTimeOffset]::UtcNow).ToUnixTimeMilliseconds()
    source = $source; scope = $scope; sensorId = $sensorId
    valid = $false; reason = "no-rapl-package-instance"
  }
  exit 1
}

while ($true) {
  try {
    [UInt64]$pkg = 0; foreach ($c in $pkgCounters) { $pkg += [UInt64]$c.RawValue }
    [UInt64]$dram = 0; foreach ($c in $dramCounters) { $dram += [UInt64]$c.RawValue }
    $sub = @{}; foreach ($c in $subCounters) { $sub[$c.InstanceName] = ([UInt64]$c.RawValue).ToString([Globalization.CultureInfo]::InvariantCulture) }
    [UInt64]$providerTime = if ($timeCounter) { [UInt64]$timeCounter.RawValue } else { 0 }

    $deciKelvin = $null
    $celsius = $null
    if ($zoneCounter) {
      try { $deciKelvin = [Int64]$zoneCounter.RawValue; $celsius = [math]::Round(($deciKelvin / 10.0) - 273.15, 2) }
      catch { $zoneReason = "thermal-read-failed" }
    }

    # Timestamp the completed observation: the counter reads take milliseconds, and stamping before them would
    # place a cumulative reading earlier than the energy it already contains.
    $timestamp = ([DateTimeOffset]::UtcNow).ToUnixTimeMilliseconds()
    $total = $pkg + $dram
    $advanced = ($null -eq $lastEnergy) -or ($total -gt $lastEnergy)

    # The integrator requires a strictly increasing clock. A stalled millisecond is dropped, never renumbered.
    if (($null -eq $lastTimestampMs) -or ($timestamp -gt $lastTimestampMs)) {
      Write-Sample @{
        timestampMs = $timestamp
        joules = [double]$total * $picowattHourToJoule
        source = $source; scope = $scope; sensorId = $sensorId
        valid = [bool]$advanced
        reason = $(if ($advanced) { $null } else { "counter-stale" })
        celsius = $celsius
        celsiusReason = $(if ($null -ne $celsius) { $null } else { $zoneReason })
        raw = @{
          packagePicowattHours = $pkg.ToString([Globalization.CultureInfo]::InvariantCulture)
          dramPicowattHours = $dram.ToString([Globalization.CultureInfo]::InvariantCulture)
          subdomainPicowattHours = $sub
          providerTimeMs = $providerTime.ToString([Globalization.CultureInfo]::InvariantCulture)
          zoneDeciKelvin = $deciKelvin
          zone = $zoneName
          packageInstances = $pkgInstances
          dramInstances = $dramInstances
        }
      }
      $lastTimestampMs = $timestamp
    }
    $lastEnergy = $total
  }
  catch {
    Write-Sample @{
      timestampMs = ([DateTimeOffset]::UtcNow).ToUnixTimeMilliseconds()
      source = $source; scope = $scope; sensorId = $sensorId
      valid = $false; reason = "counter-read-failed"; errorType = $_.Exception.GetType().FullName
    }
  }

  if ($DurationSeconds -gt 0 -and ([DateTimeOffset]::UtcNow - $startedAt).TotalSeconds -ge $DurationSeconds) { break }
  Start-Sleep -Milliseconds $IntervalMilliseconds
}
