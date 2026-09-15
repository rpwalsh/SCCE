[CmdletBinding()]
param(
  [ValidateSet("cpu", "vulkan", "npu")]
  [string]$Mode = "cpu",

  [ValidateSet("qwen2.5:3b")]
  [string]$Model = "qwen2.5:3b",

  [ValidateNotNullOrEmpty()]
  [string]$BaseUrl = "http://127.0.0.1:11434",

  [ValidateRange(0, 120)]
  [int]$LoadTimeoutSeconds = 60,

  [ValidateRange(0, 120)]
  [int]$ProbeKeepAliveSeconds = 30,

  [string]$OutFile
)

# This is a local evidence probe, not a benchmark runner. It deliberately records
# no generated answer. It restarts only the local `ollama.exe serve` process, then
# restores a default server in the finally block.
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$knownEnvironment = @(
  "OLLAMA_HOST",
  "OLLAMA_LLM_LIBRARY",
  "OLLAMA_VULKAN",
  "GGML_VK_VISIBLE_DEVICES",
  "OLLAMA_NO_CLOUD",
  "OLLAMA_IGPU_ENABLE"
)

function Get-OllamaPath {
  $command = Get-Command ollama -ErrorAction Stop
  if ($command.CommandType -notin @("Application", "ExternalScript")) {
    throw "The resolved ollama command is not an executable: $($command.Source)"
  }
  return $command.Source
}

function Get-ServerProcesses {
  @(Get-CimInstance Win32_Process -Filter "name='ollama.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match "(?i)(^|[\\/\s])serve([\s]|$)" })
}

function Save-ProcessEnvironment {
  $saved = @{}
  foreach ($name in $knownEnvironment) {
    $saved[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
  }
  return $saved
}

function Restore-ProcessEnvironment([hashtable]$Saved) {
  foreach ($name in $knownEnvironment) {
    [Environment]::SetEnvironmentVariable($name, $Saved[$name], "Process")
  }
}

function Set-ServerEnvironment([hashtable]$Settings) {
  foreach ($name in $knownEnvironment) {
    [Environment]::SetEnvironmentVariable($name, $null, "Process")
  }
  foreach ($entry in $Settings.GetEnumerator()) {
    [Environment]::SetEnvironmentVariable([string]$entry.Key, [string]$entry.Value, "Process")
  }
}

function Stop-ServerProcesses([object[]]$Processes) {
  foreach ($process in $Processes) {
    $live = Get-Process -Id ([int]$process.ProcessId) -ErrorAction SilentlyContinue
    if ($null -ne $live) {
      Stop-Process -Id ([int]$process.ProcessId) -Force -ErrorAction SilentlyContinue
    }
  }
  $deadline = [DateTime]::UtcNow.AddSeconds(10)
  while ((Get-ServerProcesses).Count -gt 0 -and [DateTime]::UtcNow -lt $deadline) {
    Start-Sleep -Milliseconds 200
  }
}

function Start-Server([string]$OllamaPath, [hashtable]$Settings, [string]$LogDirectory) {
  New-Item -ItemType Directory -Path $LogDirectory -Force | Out-Null
  $stdoutPath = Join-Path $LogDirectory "server.stdout.log"
  $stderrPath = Join-Path $LogDirectory "server.stderr.log"
  $old = Save-ProcessEnvironment
  try {
    Set-ServerEnvironment $Settings
    $started = Start-Process -FilePath $OllamaPath -ArgumentList @("serve") -WorkingDirectory (Split-Path -Parent $OllamaPath) -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
  }
  finally {
    Restore-ProcessEnvironment $old
  }
  return @{
    Process = $started
    Pid = $started.Id
    Command = "`"$OllamaPath`" serve"
    Environment = @{} + $Settings
    Stdout = $stdoutPath
    Stderr = $stderrPath
  }
}

function Wait-Api([string]$Url, [int]$TimeoutSeconds) {
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  do {
    try {
      return Invoke-RestMethod -Uri "$Url/api/version" -Method Get -TimeoutSec 3
    }
    catch {
      Start-Sleep -Milliseconds 250
    }
  } while ([DateTime]::UtcNow -lt $deadline)
  throw "Ollama API did not become ready within $TimeoutSeconds seconds: $Url"
}

function Invoke-JsonApi([string]$Method, [string]$Uri, [object]$Body) {
  $json = $Body | ConvertTo-Json -Depth 10 -Compress
  return Invoke-RestMethod -Uri $Uri -Method $Method -ContentType "application/json" -Body $json -TimeoutSec ([Math]::Max(10, $LoadTimeoutSeconds))
}

function Get-VulkanEvidence {
  $command = Get-Command vulkaninfo -ErrorAction SilentlyContinue
  if ($null -eq $command) {
    return @{ available = $false; reason = "vulkaninfo-not-found"; devices = @(); raw = "" }
  }
  $nativeErrorAction = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    $raw = (& $command.Source --summary 2>&1 | ForEach-Object { [string]$_ } | Out-String).Trim()
  }
  finally {
    $ErrorActionPreference = $nativeErrorAction
  }
  $devices = @([regex]::Matches($raw, "(?m)^\s*deviceName\s*=\s*(.+?)\s*$") | ForEach-Object { $_.Groups[1].Value.Trim() })
  return @{
    available = ($devices.Count -gt 0)
    command = $command.Source
    devices = $devices
    intelArc = [bool]($devices | Where-Object { $_ -match "(?i)Intel.*Arc" })
    raw = $raw
  }
}

function Get-ResidencyEvidence([string]$OllamaPath, [string]$Url, [string]$TargetModel, [string]$ServerStdout, [string]$ServerStderr) {
  $api = Invoke-RestMethod -Uri "$Url/api/ps" -Method Get -TimeoutSec 10
  $running = @($api.models | Where-Object { $_.name -eq $TargetModel -or $_.model -eq $TargetModel }) | Select-Object -First 1
  $cliText = (& $OllamaPath ps 2>&1 | Out-String).Trim()
  $cliLine = @($cliText -split "`r?`n" | Where-Object { $_ -match [regex]::Escape($TargetModel) }) | Select-Object -First 1
  $processor = $null
  if ($cliLine) {
    $match = [regex]::Match($cliLine, "(?i)(100%\s+GPU|100%\s+CPU|\d+%/\d+%\s+CPU/GPU)")
    if ($match.Success) { $processor = $match.Value }
  }
  $vram = $null
  $size = $null
  if ($null -ne $running) {
    $vram = [Int64]$running.size_vram
    $size = [Int64]$running.size
  }
  $logs = ""
  foreach ($path in @($ServerStdout, $ServerStderr)) {
    if (Test-Path -LiteralPath $path) { $logs += "`n" + (Get-Content -LiteralPath $path -Raw -ErrorAction SilentlyContinue) }
  }
  $backendLines = @($logs -split "`r?`n" | Where-Object { $_ -match "(?i)ggml_vulkan|Vulkan|Intel.*Arc|library" })
  return @{
    api = $running
    ollamaPs = $cliText
    ollamaPsLine = $cliLine
    processor = $processor
    sizeBytes = $size
    sizeVramBytes = $vram
    backendLogEvidence = $backendLines
  }
}

function Write-Result([hashtable]$Result) {
  $text = $Result | ConvertTo-Json -Depth 20
  if ($OutFile) {
    $parent = Split-Path -Parent $OutFile
    if ($parent) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
    Set-Content -LiteralPath $OutFile -Value $text -Encoding UTF8
  }
  [Console]::Out.WriteLine($text)
}

$ollamaPath = Get-OllamaPath
$startedAt = [DateTimeOffset]::UtcNow
$runId = "ollama-device-$($startedAt.ToUnixTimeMilliseconds())"
$evidenceRoot = Join-Path ([IO.Path]::GetTempPath()) $runId
$modeSettings = @{
  cpu = @{
    OLLAMA_HOST = "127.0.0.1:11434"
    OLLAMA_LLM_LIBRARY = "cpu_avx2"
    OLLAMA_VULKAN = "0"
    GGML_VK_VISIBLE_DEVICES = "-1"
    OLLAMA_NO_CLOUD = "1"
  }
  vulkan = @{
    OLLAMA_HOST = "127.0.0.1:11434"
    OLLAMA_VULKAN = "1"
    GGML_VK_VISIBLE_DEVICES = "0"
    OLLAMA_IGPU_ENABLE = "1"
    OLLAMA_NO_CLOUD = "1"
  }
}
$originalServers = @(Get-ServerProcesses)
$temporaryServer = $null
$result = @{
  schemaVersion = "ollama-device-mode-1"
  startedAt = $startedAt.ToString("o")
  requestedMode = $Mode
  model = $Model
  ollamaExecutable = $ollamaPath
  ollamaCliVersion = ((& $ollamaPath --version 2>&1 | Out-String).Trim())
  localHardware = @{
    computer = (Get-CimInstance Win32_ComputerSystem | Select-Object Manufacturer, Model, TotalPhysicalMemory)
    processor = (Get-CimInstance Win32_Processor | Select-Object -First 1 Name, NumberOfCores, NumberOfLogicalProcessors)
    graphics = @(Get-CimInstance Win32_VideoController | Select-Object Name, DriverVersion, AdapterRAM)
    npu = @(Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue | Where-Object { $_.Class -eq "ComputeAccelerator" } | Select-Object Class, FriendlyName, Status, InstanceId)
  }
  vulkan = Get-VulkanEvidence
  server = @{}
  modelEvidence = @{}
  verification = @{}
  restore = @{}
}

try {
  if ($Mode -eq "npu") {
    $result.server = @{ action = "none"; command = $null; environment = @{} }
    $result.verification = @{
      status = "rejected"
      verified = $false
      reason = "Ollama 0.32.5 has no documented Intel NPU backend or NPU device selector; Intel AI Boost presence alone is not inference residency evidence."
    }
    exit 2
  }

  Stop-ServerProcesses $originalServers
  $temporaryServer = Start-Server $ollamaPath $modeSettings[$Mode] (Join-Path $evidenceRoot "requested-$Mode")
  $result.server = @{
    action = "restarted-for-requested-mode"
    pid = $temporaryServer.Pid
    command = $temporaryServer.Command
    environment = $temporaryServer.Environment
    stdout = $temporaryServer.Stdout
    stderr = $temporaryServer.Stderr
  }
  $version = Wait-Api $BaseUrl $LoadTimeoutSeconds
  $show = Invoke-JsonApi "POST" "$BaseUrl/api/show" @{ model = $Model; verbose = $true }
  $result.ollamaApiVersion = $version.version
  $result.modelEvidence = @{
    digest = $null
    modelDetails = $show.details
    quantization = $show.details.quantization_level
    parameterSize = $show.details.parameter_size
  }

  # A content-neutral one-token health request causes the runner to load the model.
  # The response body is intentionally discarded so this probe cannot alter eval answers.
  $null = Invoke-JsonApi "POST" "$BaseUrl/api/generate" @{
    model = $Model
    prompt = "0"
    stream = $false
    keep_alive = "${ProbeKeepAliveSeconds}s"
    options = @{ temperature = 0; seed = 0; num_ctx = 512 }
  }
  Start-Sleep -Milliseconds 500
  $residency = Get-ResidencyEvidence $ollamaPath $BaseUrl $Model $temporaryServer.Stdout $temporaryServer.Stderr
  $result.modelEvidence.residency = $residency
  if ($null -ne $residency.api) {
    $result.modelEvidence.digest = $residency.api.digest
  }
  $digestVerified = $result.modelEvidence.digest -match "^sha256:[0-9a-f]{64}$" -or $result.modelEvidence.digest -match "^[0-9a-f]{64}$"
  $processorVerified = $false
  if ($Mode -eq "cpu") {
    $cpuLogVerified = [bool]($residency.backendLogEvidence | Where-Object { $_ -match "(?i)inference compute.*library=cpu" })
    $processorVerified = $digestVerified -and $residency.processor -match "(?i)^100%\s+CPU$" -and $residency.sizeVramBytes -eq 0 -and $cpuLogVerified
  }
  elseif ($Mode -eq "vulkan") {
    $vulkanLogVerified = [bool]($residency.backendLogEvidence | Where-Object { $_ -match "(?i)inference compute.*library=Vulkan.*Intel.*Arc" })
    $processorVerified = $digestVerified -and $residency.processor -match "(?i)GPU" -and $residency.sizeVramBytes -gt 0 -and $result.vulkan.intelArc -and $vulkanLogVerified
  }
  $result.verification = @{
    status = $(if ($processorVerified) { "verified" } else { "rejected" })
    verified = $processorVerified
    requestedMode = $Mode
    processorEvidence = $residency.processor
    vramBytes = $residency.sizeVramBytes
    reason = $(if ($processorVerified) { "Requested mode and observed model residency satisfy the mode checks." } else { "Observed residency did not prove the requested mode; no device claim is accepted." })
  }
}
catch {
  $result.verification = @{
    status = "error"
    verified = $false
    reason = $_.Exception.Message
  }
}
finally {
  if ($Mode -eq "npu") {
    try {
      $preserved = Wait-Api $BaseUrl 5
      $result.restore = @{ status = "existing-server-preserved"; apiVersion = $preserved.version }
    }
    catch {
      $result.restore = @{ status = "no-server-to-restore"; error = $_.Exception.Message }
    }
    $result.finishedAt = [DateTimeOffset]::UtcNow.ToString("o")
    Write-Result $result
    exit 2
  }
  if ($null -ne $temporaryServer) {
    Stop-ServerProcesses @(@{ ProcessId = $temporaryServer.Pid })
  }
  # Restore a plain local Ollama server even if the requested mode failed.
  $restoreServer = Start-Server $ollamaPath @{
    OLLAMA_HOST = "127.0.0.1:11434"
  } (Join-Path $evidenceRoot "restored-default")
  try {
    $restoreVersion = Wait-Api $BaseUrl $LoadTimeoutSeconds
    $result.restore = @{
      status = "running-default"
      pid = $restoreServer.Pid
      command = $restoreServer.Command
      environment = $restoreServer.Environment
      apiVersion = $restoreVersion.version
      stdout = $restoreServer.Stdout
      stderr = $restoreServer.Stderr
    }
  }
  catch {
    $result.restore = @{
      status = "failed"
      pid = $restoreServer.Pid
      command = $restoreServer.Command
      environment = $restoreServer.Environment
      error = $_.Exception.Message
    }
  }
  $result.finishedAt = [DateTimeOffset]::UtcNow.ToString("o")
  if ($result.verification.status -eq "error") {
    Write-Result $result
    exit 1
  }
  if ($result.verification.verified -ne $true) {
    Write-Result $result
    exit 2
  }
  Write-Result $result
}
