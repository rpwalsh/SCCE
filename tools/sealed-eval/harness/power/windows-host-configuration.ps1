[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$errors = @()
$cpu = @()
$gpu = @()
$npu = @()
$operatingSystem = $null
$battery = @()
$batteryStatus = @()
$powerScheme = $null

try { $cpu = @(Get-CimInstance Win32_Processor | Select-Object Name, NumberOfCores, NumberOfLogicalProcessors, MaxClockSpeed) }
catch { $errors += "cpu-inventory-unavailable" }
try { $gpu = @(Get-CimInstance Win32_VideoController | Select-Object Name, DriverVersion, DriverDate, AdapterRAM) }
catch { $errors += "gpu-inventory-unavailable" }
try {
  $npu = @(Get-CimInstance Win32_PnPSignedDriver |
    Where-Object { $_.DeviceClass -eq "ComputeAccelerator" -or $_.DeviceName -match "Intel.*AI Boost" } |
    Select-Object DeviceName, DriverVersion, DriverDate, Manufacturer)
}
catch { $errors += "npu-inventory-unavailable" }
try { $operatingSystem = Get-CimInstance Win32_OperatingSystem | Select-Object Caption, Version, BuildNumber, OSArchitecture }
catch { $errors += "os-inventory-unavailable" }
try { $powerScheme = (& powercfg.exe /getactivescheme | Out-String).Trim() }
catch { $errors += "active-power-scheme-unavailable" }
try { $battery = @(Get-CimInstance Win32_Battery | Select-Object BatteryStatus, EstimatedChargeRemaining) }
catch { $errors += "battery-state-unavailable" }
try {
  $batteryStatus = @(Get-CimInstance -Namespace root/wmi -ClassName BatteryStatus |
    Select-Object PowerOnline, Discharging, Charging, DischargeRate, ChargeRate, RemainingCapacity, Voltage)
}
catch { $errors += "ac-battery-telemetry-unavailable" }

[ordered]@{
  capturedAt = [DateTimeOffset]::UtcNow.ToString("o")
  cpu = $cpu
  gpu = $gpu
  npu = $npu
  operatingSystem = $operatingSystem
  activePowerScheme = $powerScheme
  battery = $battery
  batteryStatus = $batteryStatus
  inventoryErrors = $errors
} | ConvertTo-Json -Depth 6 -Compress
