# SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
# Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
#
# Reports what this machine is doing thermally and electrically, and what is consuming it.
# Read-only: queries WMI/CIM and process tables. Writes nothing, kills nothing, changes no setting.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools/machine-thermal-report.ps1
#
# Elevation is optional. Without it, the ACPI thermal-zone class is access-denied and the script falls
# back to the performance-counter zone, which is unprivileged and reports the same sensor in decikelvin.

$ErrorActionPreference = "SilentlyContinue"

$elevated = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
            ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

function K10-ToC([double] $deciKelvin) { [math]::Round(($deciKelvin / 10) - 273.15, 1) }

Write-Output "== elevation"
Write-Output ("  administrator: {0}" -f $elevated)

Write-Output "== thermal zones (ACPI, needs elevation)"
$acpi = Get-CimInstance -Namespace root/WMI -ClassName MSAcpi_ThermalZoneTemperature
if ($acpi) {
  foreach ($zone in $acpi) {
    Write-Output ("  {0,-34} {1,6:N1} C   critical {2,6:N1} C   passive {3,6:N1} C" -f `
      $zone.InstanceName, (K10-ToC $zone.CurrentTemperature), (K10-ToC $zone.CriticalTripPoint), (K10-ToC $zone.PassiveTripPoint))
  }
} else {
  Write-Output "  unavailable (access denied without elevation)"
}

Write-Output "== thermal zones (performance counter, unprivileged)"
$perf = Get-CimInstance -ClassName Win32_PerfFormattedData_Counters_ThermalZoneInformation
if ($perf) {
  foreach ($zone in $perf) {
    Write-Output ("  {0,-34} {1,6:N1} C   passive-limit {2}%   throttle-reasons {3}" -f `
      $zone.Name, (K10-ToC $zone.HighPrecisionTemperature), $zone.PercentPassiveLimit, $zone.ThrottleReasons)
  }
} else {
  Write-Output "  unavailable"
}

Write-Output "== processor"
foreach ($cpu in Get-CimInstance Win32_Processor) {
  Write-Output ("  {0}" -f $cpu.Name.Trim())
  Write-Output ("  load {0}%   clock {1}/{2} MHz   cores {3}   threads {4}" -f `
    $cpu.LoadPercentage, $cpu.CurrentClockSpeed, $cpu.MaxClockSpeed, $cpu.NumberOfCores, $cpu.NumberOfLogicalProcessors)
}

Write-Output "== power"
$battery = Get-CimInstance Win32_Battery
if ($battery) {
  foreach ($b in $battery) {
    $draw = if ($b.BatteryStatus -eq 1) { "discharging" } else { "on AC / charging" }
    Write-Output ("  battery {0}%   {1}   runtime-estimate {2} min" -f $b.EstimatedChargeRemaining, $draw, $b.EstimatedRunTime)
  }
}
# Discharge rate is the closest unprivileged proxy for whole-machine draw on a laptop.
$rate = Get-CimInstance -Namespace root/WMI -ClassName BatteryStatus
if ($rate) {
  foreach ($r in $rate) {
    if ($r.DischargeRate -gt 0) { Write-Output ("  discharge {0:N2} W" -f ($r.DischargeRate / 1000)) }
    if ($r.ChargeRate -gt 0)    { Write-Output ("  charge    {0:N2} W" -f ($r.ChargeRate / 1000)) }
  }
}
$plan = powercfg /getactivescheme
if ($plan) { Write-Output ("  {0}" -f $plan.Trim()) }

Write-Output "== memory"
$os = Get-CimInstance Win32_OperatingSystem
Write-Output ("  free {0:N1} GB of {1:N1} GB" -f ($os.FreePhysicalMemory / 1MB), ($os.TotalVisibleMemorySize / 1MB))

Write-Output "== top consumers (cpu-seconds since start)"
Get-CimInstance Win32_Process |
  Where-Object { $_.Name -notin @("System", "Idle") } |
  Select-Object @{n = "pid"; e = { $_.ProcessId } },
                @{n = "cpu_s"; e = { [math]::Round((($_.KernelModeTime + $_.UserModeTime) / 10000000), 1) } },
                @{n = "rss_mb"; e = { [math]::Round($_.WorkingSetSize / 1MB, 0) } },
                @{n = "what"; e = { if ($_.CommandLine) { $_.CommandLine.Substring(0, [math]::Min(88, $_.CommandLine.Length)) } else { $_.Name } } } |
  Sort-Object cpu_s -Descending |
  Select-Object -First 15 |
  Format-Table -AutoSize |
  Out-String -Width 200 |
  Write-Output

Write-Output "== SCCE processes"
Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='postgres.exe'" |
  Where-Object { $_.CommandLine -match "scce|fuggit|vitest|postgres" } |
  Select-Object @{n = "pid"; e = { $_.ProcessId } },
                @{n = "cpu_s"; e = { [math]::Round((($_.KernelModeTime + $_.UserModeTime) / 10000000), 1) } },
                @{n = "rss_mb"; e = { [math]::Round($_.WorkingSetSize / 1MB, 0) } },
                @{n = "what"; e = { $_.CommandLine.Substring(0, [math]::Min(88, $_.CommandLine.Length)) } } |
  Sort-Object cpu_s -Descending |
  Format-Table -AutoSize |
  Out-String -Width 200 |
  Write-Output
