param(
  [switch]$NoBuild,
  [switch]$DryRun,
  [switch]$RestartServer
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2

$script:ProjectRoot = Split-Path -Parent $PSScriptRoot
$script:DemoDirectory = Join-Path $script:ProjectRoot '.demo'
$script:PidsFile = Join-Path $script:DemoDirectory 'pids.json'
$script:EnvironmentBackup = Join-Path $script:DemoDirectory 'env.backup'
$script:StartedProcesses = New-Object 'System.Collections.Generic.List[object]'
$script:EnvironmentWasUpdated = $false
$script:RestartMode = $false
$script:RestartServerProcess = $null

function Read-SharedText {
  param([Parameter(Mandatory = $true)][string]$Path)

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return '' }

  $stream = $null
  $reader = $null
  try {
    $share = [System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete
    $stream = New-Object System.IO.FileStream(
      $Path,
      [System.IO.FileMode]::Open,
      [System.IO.FileAccess]::Read,
      $share
    )
    $reader = New-Object System.IO.StreamReader($stream)
    return $reader.ReadToEnd()
  } finally {
    if ($reader) { $reader.Dispose() }
    elseif ($stream) { $stream.Dispose() }
  }
}

function Get-DemoEnvironment {
  param([Parameter(Mandatory = $true)][string]$Path)

  $values = @{}
  foreach ($line in [System.IO.File]::ReadAllLines($Path)) {
    if ($line -match '^\s*([^#=\s]+)\s*=\s*(.*?)\s*$') {
      $name = $matches[1]
      $value = $matches[2]
      if ($value.Length -ge 2 -and
          (($value.StartsWith('"') -and $value.EndsWith('"')) -or
           ($value.StartsWith("'") -and $value.EndsWith("'")))) {
        $value = $value.Substring(1, $value.Length - 2)
      }
      $values[$name] = $value
    }
  }
  return $values
}

function Update-DemoEnvironment {
  param(
    [Parameter(Mandatory = $true)][string]$EnvPath,
    [Parameter(Mandatory = $true)][string]$BackupPath,
    [Parameter(Mandatory = $true)][string]$PublicUrl,
    [Parameter(Mandatory = $true)][AllowEmptyString()][string]$WakeUrl
  )

  $directory = Split-Path -Parent $BackupPath
  if (-not (Test-Path -LiteralPath $directory -PathType Container)) {
    [void](New-Item -ItemType Directory -Path $directory -Force)
  }
  Copy-Item -LiteralPath $EnvPath -Destination $BackupPath -Force

  $temporaryPath = Join-Path $directory ('.env-' + [guid]::NewGuid().ToString('N') + '.tmp')
  try {
    $text = [System.IO.File]::ReadAllText($EnvPath, [System.Text.Encoding]::UTF8)
    $newline = [System.Environment]::NewLine
    $firstLf = $text.IndexOf("`n", [System.StringComparison]::Ordinal)
    if ($firstLf -ge 0 -and $firstLf -gt 0 -and $text[$firstLf - 1] -eq "`r") {
      $newline = "`r`n"
    } elseif ($firstLf -ge 0) {
      $newline = "`n"
    }

    $hasTrailingNewline = $text.EndsWith($newline, [System.StringComparison]::Ordinal)
    $lines = New-Object 'System.Collections.Generic.List[string]'
    foreach ($line in $text.Split([string[]]@($newline), [System.StringSplitOptions]::None)) {
      [void]$lines.Add($line)
    }
    if ($hasTrailingNewline -and $lines.Count -gt 0 -and $lines[$lines.Count - 1] -eq '') {
      $lines.RemoveAt($lines.Count - 1)
    } elseif ($text.Length -eq 0 -and $lines.Count -eq 1) {
      $lines.Clear()
    }

    $foundPublicUrl = $false
    $foundWakeUrl = $false
    for ($index = 0; $index -lt $lines.Count; $index++) {
      if ($lines[$index] -match '^PUBLIC_URL=') {
        $lines[$index] = 'PUBLIC_URL=' + $PublicUrl
        $foundPublicUrl = $true
      } elseif ($lines[$index] -match '^N8N_WAKE_URL=') {
        $lines[$index] = 'N8N_WAKE_URL=' + $WakeUrl
        $foundWakeUrl = $true
      }
    }
    if (-not $foundPublicUrl) { [void]$lines.Add('PUBLIC_URL=' + $PublicUrl) }
    if (-not $foundWakeUrl) { [void]$lines.Add('N8N_WAKE_URL=' + $WakeUrl) }
    if ($hasTrailingNewline) { [void]$lines.Add('') }

    $updatedText = [string]::Join($newline, $lines.ToArray())
    $encoding = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($temporaryPath, $updatedText, $encoding)
    Move-Item -LiteralPath $temporaryPath -Destination $EnvPath -Force
    return $newline
  } catch {
    if (Test-Path -LiteralPath $temporaryPath) {
      Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue
    }
    if (Test-Path -LiteralPath $BackupPath) {
      Copy-Item -LiteralPath $BackupPath -Destination $EnvPath -Force -ErrorAction SilentlyContinue
    }
    throw
  }
}

function Get-CloudflaredPath {
  $command = Get-Command 'cloudflared' -ErrorAction SilentlyContinue
  if ($command -and $command.CommandType -eq 'Application') {
    return $command.Source
  }
  $programFilesX86 = [System.Environment]::GetFolderPath('ProgramFilesX86')
  if ($programFilesX86) {
    $fallback = Join-Path (Join-Path $programFilesX86 'cloudflared') 'cloudflared.exe'
    if (Test-Path -LiteralPath $fallback -PathType Leaf) { return $fallback }
  }
  return $null
}

function Get-WebhookPath {
  $workflowPath = Join-Path $script:ProjectRoot 'n8n\Establo-PAYERS.json'
  if (-not (Test-Path -LiteralPath $workflowPath -PathType Leaf)) {
    throw 'No se encontró n8n\Establo-PAYERS.json para comprobar la ruta del webhook.'
  }
  $workflow = Get-Content -LiteralPath $workflowPath -Raw | ConvertFrom-Json
  $node = @($workflow.nodes | Where-Object { $_.name -eq 'Despertar por WhatsApp' }) | Select-Object -First 1
  if (-not $node -or -not $node.parameters.path) {
    throw 'No se encontró el nodo Despertar por WhatsApp o su path en el workflow.'
  }
  return ([string]$node.parameters.path).Trim('/')
}

function Get-ProcessIdentity {
  param(
    [Parameter(Mandatory = $true)][System.Diagnostics.Process]$Process,
    [string]$Name
  )

  $current = Get-Process -Id $Process.Id -ErrorAction Stop
  if (-not $Name) { $Name = $Process.ProcessName }
  return [pscustomobject]@{
    name = $Name
    processName = $Process.ProcessName
    pid = [int]$Process.Id
    startTimeUtcTicks = [long]$current.StartTime.ToUniversalTime().Ticks
  }
}

function Save-DemoPids {
  if (-not (Test-Path -LiteralPath $script:DemoDirectory -PathType Container)) {
    [void](New-Item -ItemType Directory -Path $script:DemoDirectory -Force)
  }
  $data = [pscustomobject]@{
    version = 1
    processes = @($script:StartedProcesses.ToArray())
  }
  $json = ConvertTo-Json -InputObject $data -Depth 5
  [System.IO.File]::WriteAllText(
    $script:PidsFile,
    $json,
    (New-Object System.Text.UTF8Encoding($false))
  )
}

function Stop-DemoTrackedProcesses {
  param([Parameter(Mandatory = $true)][string]$Path)

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return }
  $data = Read-SharedText -Path $Path | ConvertFrom-Json
  if (-not $data.processes) {
    Remove-Item -LiteralPath $Path -Force
    return
  }
  $taskkill = Get-Command 'taskkill.exe' -ErrorAction SilentlyContinue
  if (-not $taskkill) { throw 'No se encontró taskkill.exe para detener los procesos registrados.' }

  foreach ($entry in @($data.processes | Sort-Object -Property pid -Descending)) {
    Stop-DemoProcessEntry -Entry $entry -TaskkillPath $taskkill.Source
  }
}

function Stop-DemoProcessEntry {
  param(
    [Parameter(Mandatory = $true)][object]$Entry,
    [Parameter(Mandatory = $true)][string]$TaskkillPath
  )

  $processId = 0
  if (-not [int]::TryParse([string]$Entry.pid, [ref]$processId) -or $processId -le 0) {
    Write-Warning 'Se omitió una entrada de PID inválida en .demo/pids.json.'
    return
  }
  $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
  if (-not $process) {
    Write-Host ('El proceso registrado {0} ya no existe.' -f $processId)
    return
  }
  if ($Entry.startTimeUtcTicks) {
    $actualTicks = [long]$process.StartTime.ToUniversalTime().Ticks
    if ($actualTicks -ne [long]$Entry.startTimeUtcTicks) {
      Write-Warning ('Se omitió el PID {0}: ahora pertenece a otra ejecución.' -f $processId)
      return
    }
  } else {
    Write-Warning ('Se omitió el PID {0}: no tiene identidad de proceso verificable.' -f $processId)
    return
  }
  Write-Host ('Deteniendo proceso registrado PID {0} y sus hijos...' -f $processId)
  $null = & $TaskkillPath /PID $processId /T /F 2>&1
  if ($LASTEXITCODE -ne 0 -and (Get-Process -Id $processId -ErrorAction SilentlyContinue)) {
    throw ('No se pudo detener el proceso registrado PID {0}.' -f $processId)
  }
}

function Start-DemoProcess {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$Executable,
    [string[]]$Arguments = @(),
    [Parameter(Mandatory = $true)][string]$StdoutPath,
    [Parameter(Mandatory = $true)][string]$StderrPath
  )

  $actualStdoutPath = $StdoutPath
  $actualStderrPath = $StderrPath
  $logPaths = @(
    [pscustomobject]@{ Requested = $StdoutPath; Stream = 'stdout' },
    [pscustomobject]@{ Requested = $StderrPath; Stream = 'stderr' }
  )
  foreach ($log in $logPaths) {
    $logPath = $log.Requested
    if (Test-Path -LiteralPath $logPath) {
      try {
        Remove-Item -LiteralPath $logPath -Force
      } catch {
        $directory = Split-Path -Parent $logPath
        $baseName = [System.IO.Path]::GetFileNameWithoutExtension($logPath)
        $extension = [System.IO.Path]::GetExtension($logPath)
        $uniqueName = '{0}.{1}.{2}{3}' -f $baseName, $log.Stream,
          ([guid]::NewGuid().ToString('N')), $extension
        $logPath = Join-Path $directory $uniqueName
        Write-Warning ('El log anterior está en uso; se escribirá en {0}.' -f $logPath)
      }
    }
    if ($log.Stream -eq 'stdout') {
      $actualStdoutPath = $logPath
    } else {
      $actualStderrPath = $logPath
    }
  }
  $process = Start-Process -FilePath $Executable -ArgumentList $Arguments `
    -WorkingDirectory $script:ProjectRoot -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput $actualStdoutPath -RedirectStandardError $actualStderrPath
  Add-Member -InputObject $process -NotePropertyName DemoStdoutPath -NotePropertyValue $actualStdoutPath
  Add-Member -InputObject $process -NotePropertyName DemoStderrPath -NotePropertyValue $actualStderrPath
  [void]$script:StartedProcesses.Add((Get-ProcessIdentity -Process $process -Name $Name))
  Save-DemoPids
  Write-Host ('Iniciado {0} (PID {1}).' -f $Name, $process.Id)
  Write-Host ('Logs de {0}: {1} y {2}' -f $Name, $actualStdoutPath, $actualStderrPath)
  return $process
}

function Get-DemoListenerProcessId {
  param([Parameter(Mandatory = $true)][int]$Port)

  $tcpCommand = Get-Command 'Get-NetTCPConnection' -ErrorAction SilentlyContinue
  if ($tcpCommand) {
    try {
      $connection = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction Stop |
        Select-Object -First 1
      if ($connection) { return [int]$connection.OwningProcess }
    } catch {
      Write-Warning ('No se pudo consultar Get-NetTCPConnection; se intentará netstat para el puerto {0}.' -f $Port)
    }
  }

  $netstat = Get-Command 'netstat.exe' -ErrorAction SilentlyContinue
  if ($netstat) {
    foreach ($line in (& $netstat.Source -ano -p tcp 2>$null)) {
      if ($line -match ('^\s*TCP\s+\S+:{0}\s+\S+\s+LISTENING\s+(\d+)\s*$' -f $Port)) {
        return [int]$matches[1]
      }
    }
  }
  return 0
}

function Register-DemoListenerProcess {
  param(
    [Parameter(Mandatory = $true)][System.Diagnostics.Process]$Launcher,
    [Parameter(Mandatory = $true)][int]$Port,
    [Parameter(Mandatory = $true)][string]$Name
  )

  $listenerId = Get-DemoListenerProcessId -Port $Port
  if (-not $listenerId) {
    throw ('No se pudo identificar el proceso que escucha en el puerto {0}.' -f $Port)
  }
  $listener = Get-Process -Id $listenerId -ErrorAction Stop
  $launcherEntry = @($script:StartedProcesses | Where-Object { $_.pid -eq $Launcher.Id }) |
    Select-Object -First 1
  if (-not $launcherEntry) {
    throw ('No se encontró el proceso de lanzamiento registrado para {0}.' -f $Name)
  }
  $listenerIdentity = Get-ProcessIdentity -Process $listener -Name $Name
  if ($listenerIdentity.startTimeUtcTicks -lt [long]$launcherEntry.startTimeUtcTicks) {
    throw ('El puerto {0} ya estaba ocupado por otro proceso; no se registró ni detuvo ese proceso.' -f $Port)
  }

  [void]$script:StartedProcesses.Remove($launcherEntry)
  [void]$script:StartedProcesses.Add($listenerIdentity)
  Save-DemoPids
}

function Invoke-DemoHttp {
  param(
    [Parameter(Mandatory = $true)][string]$Uri,
    [Parameter(Mandatory = $true)][ValidateSet('GET', 'POST')][string]$Method,
    [hashtable]$Headers = @{},
    [int]$TimeoutSeconds = 8
  )

  $request = [System.Net.HttpWebRequest]::Create($Uri)
  $request.Method = $Method
  $request.Timeout = $TimeoutSeconds * 1000
  $request.ReadWriteTimeout = $TimeoutSeconds * 1000
  $request.AllowAutoRedirect = $false
  foreach ($name in $Headers.Keys) {
    if ($name -eq 'Authorization') {
      $request.Headers[[System.Net.HttpRequestHeader]::Authorization] = [string]$Headers[$name]
    } else {
      $request.Headers[$name] = [string]$Headers[$name]
    }
  }
  if ($Method -eq 'POST') {
    $request.ContentType = 'application/json'
    $request.ContentLength = 0
  }

  $response = $null
  try {
    $response = [System.Net.HttpWebResponse]$request.GetResponse()
    $reader = New-Object System.IO.StreamReader($response.GetResponseStream())
    try { $body = $reader.ReadToEnd() } finally { $reader.Dispose() }
    return [pscustomobject]@{ StatusCode = [int]$response.StatusCode; Body = $body }
  } catch [System.Net.WebException] {
    if ($_.Exception.Response) {
      $response = [System.Net.HttpWebResponse]$_.Exception.Response
      $reader = New-Object System.IO.StreamReader($response.GetResponseStream())
      try { $body = $reader.ReadToEnd() } finally { $reader.Dispose() }
      return [pscustomobject]@{ StatusCode = [int]$response.StatusCode; Body = $body }
    }
    return [pscustomobject]@{ StatusCode = 0; Body = '' }
  } finally {
    if ($response) { $response.Dispose() }
  }
}

function Wait-DemoHttp {
  param(
    [Parameter(Mandatory = $true)][string]$Uri,
    [Parameter(Mandatory = $true)][int]$TimeoutSeconds,
    [Parameter(Mandatory = $true)][string]$ServiceName
  )

  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  while ([DateTime]::UtcNow -lt $deadline) {
    $response = Invoke-DemoHttp -Uri $Uri -Method GET -TimeoutSeconds 3
    if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 400) {
      Write-Host ('OK: {0} responde (HTTP {1}).' -f $ServiceName, $response.StatusCode)
      return
    }
    Start-Sleep -Seconds 1
  }
  throw ('{0} no respondió en {1} segundos: {2}' -f $ServiceName, $TimeoutSeconds, $Uri)
}

function Wait-DemoTunnel {
  param(
    [Parameter(Mandatory = $true)][System.Diagnostics.Process]$Process,
    [Parameter(Mandatory = $true)][string]$StderrPath,
    [Parameter(Mandatory = $true)][int]$TimeoutSeconds,
    [Parameter(Mandatory = $true)][string]$TunnelName
  )

  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  $pattern = 'https://([a-z0-9-]+)\.trycloudflare\.com'
  while ([DateTime]::UtcNow -lt $deadline) {
    if ($Process.HasExited) {
      throw ('cloudflared terminó antes de publicar la dirección del {0}.' -f $TunnelName)
    }
    try {
      $logText = Read-SharedText -Path $StderrPath
      foreach ($match in [System.Text.RegularExpressions.Regex]::Matches($logText, $pattern)) {
        if ($match.Groups[1].Value -ne 'api') {
          $url = $match.Value
          Write-Host ('OK: {0} disponible en {1}.' -f $TunnelName, $url)
          return $url
        }
      }
    } catch [System.IO.IOException] {
      Start-Sleep -Seconds 1
      continue
    }
    Start-Sleep -Seconds 1
  }
  throw ('No apareció una dirección quick tunnel válida para {0} en {1} segundos.' -f $TunnelName, $TimeoutSeconds)
}

function Write-DemoCheck {
  param(
    [Parameter(Mandatory = $true)][bool]$Passed,
    [Parameter(Mandatory = $true)][string]$Label
  )
  if ($Passed) {
    Write-Host ('OK: {0}' -f $Label)
  } else {
    Write-Host ('FALLÓ: {0}' -f $Label)
  }
}

function Test-DemoTunnel {
  param(
    [Parameter(Mandatory = $true)][string]$Uri,
    [Parameter(Mandatory = $true)][ValidateSet('GET', 'POST')][string]$Method,
    [Parameter(Mandatory = $true)][string]$Label,
    [int[]]$ExpectedStatusCodes,
    [string]$ExpectedBodyPattern,
    [int]$TimeoutSeconds = 90,
    [switch]$ExplainNotPublished
  )

  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  $lastResponse = [pscustomobject]@{ StatusCode = 0; Body = '' }
  while ([DateTime]::UtcNow -lt $deadline) {
    $remainingSeconds = ($deadline - [DateTime]::UtcNow).TotalSeconds
    $requestTimeout = [Math]::Max(1, [Math]::Min(5, [Math]::Ceiling($remainingSeconds)))
    $lastResponse = Invoke-DemoHttp -Uri $Uri -Method $Method -TimeoutSeconds $requestTimeout
    $statusAccepted = $ExpectedStatusCodes -contains $lastResponse.StatusCode
    $bodyAccepted = (-not $ExpectedBodyPattern) -or ($lastResponse.Body -match $ExpectedBodyPattern)
    if ($statusAccepted -and $bodyAccepted) {
      Write-DemoCheck -Passed $true -Label ('{0} (HTTP {1}).' -f $Label, $lastResponse.StatusCode)
      return
    }
    $remainingSeconds = ($deadline - [DateTime]::UtcNow).TotalSeconds
    if ($remainingSeconds -gt 0) {
      Start-Sleep -Seconds ([Math]::Min(2, [Math]::Ceiling($remainingSeconds)))
    }
  }

  if ($ExplainNotPublished -and $lastResponse.StatusCode -eq 404) {
    Write-Host 'FALLÓ: el túnel de n8n responde 404. Publica/activa el workflow y confirma su URL Production.'
  } else {
    Write-DemoCheck -Passed $false `
      -Label ('{0} tras {1} s (último HTTP {2}).' -f $Label, $TimeoutSeconds, $lastResponse.StatusCode)
  }
}

$environmentUpdated = $false
$n8nReused = $false
try {
  Set-Location -LiteralPath $script:ProjectRoot
  $envPath = Join-Path $script:ProjectRoot '.env'
  $packagePath = Join-Path $script:ProjectRoot 'package.json'
  $distIndex = Join-Path $script:ProjectRoot 'dist\index.html'
  foreach ($requiredPath in @(
      @{ Path = $envPath; Name = '.env' },
      @{ Path = $packagePath; Name = 'package.json' }
    )) {
    if (-not (Test-Path -LiteralPath $requiredPath.Path -PathType Leaf)) {
      throw ('Falta {0} en la raíz del proyecto.' -f $requiredPath.Name)
    }
  }

  $nodeCommand = Get-Command 'node' -ErrorAction SilentlyContinue
  if (-not $nodeCommand -or $nodeCommand.CommandType -ne 'Application') {
    throw 'No se encontró node en PATH. Instala Node.js y vuelve a intentarlo.'
  }
  $npmCommand = Get-Command 'npm.cmd' -ErrorAction SilentlyContinue
  if (-not $npmCommand -or $npmCommand.CommandType -ne 'Application') {
    throw 'No se encontró npm.cmd en PATH. Repara la instalación de Node.js y vuelve a intentarlo.'
  }
  $environment = Get-DemoEnvironment -Path $envPath
  $orchestration = 'server'
  if ($environment.ContainsKey('AGENT_ORCHESTRATION') -and $environment['AGENT_ORCHESTRATION']) {
    $orchestration = [string]$environment['AGENT_ORCHESTRATION']
  }
  $orchestration = $orchestration.Trim()
  if ($orchestration -ne 'server' -and $orchestration -ne 'n8n') {
    throw 'AGENT_ORCHESTRATION debe ser server o n8n.'
  }
  $n8nPort = 5678
  if ($environment.ContainsKey('N8N_PORT') -and $environment['N8N_PORT']) {
    $configuredN8nPort = 0
    $n8nPortParsed = [int]::TryParse([string]$environment['N8N_PORT'], [ref]$configuredN8nPort)
    if (-not $n8nPortParsed -or $configuredN8nPort -lt 1024 -or $configuredN8nPort -gt 65535) {
      throw 'N8N_PORT debe ser un puerto numérico entre 1024 y 65535.'
    }
    $n8nPort = $configuredN8nPort
  }
  $n8nOrigin = 'http://127.0.0.1:{0}' -f $n8nPort
  $n8nBrokerPort = 5679
  if ($environment.ContainsKey('N8N_RUNNERS_BROKER_PORT') -and $environment['N8N_RUNNERS_BROKER_PORT']) {
    $configuredBrokerPort = 0
    $brokerPortParsed = [int]::TryParse([string]$environment['N8N_RUNNERS_BROKER_PORT'], [ref]$configuredBrokerPort)
    if (-not $brokerPortParsed -or $configuredBrokerPort -lt 1024 -or $configuredBrokerPort -gt 65535) {
      throw 'N8N_RUNNERS_BROKER_PORT debe ser un puerto numérico entre 1024 y 65535.'
    }
    $n8nBrokerPort = $configuredBrokerPort
  }
  if ($n8nPort -eq $n8nBrokerPort) { throw 'N8N_PORT y N8N_RUNNERS_BROKER_PORT deben ser distintos.' }
  $n8nCommand = $null
  $cloudflaredPath = $null
  if (-not $RestartServer) {
    $cloudflaredPath = Get-CloudflaredPath
    if (-not $cloudflaredPath) {
      throw 'No se encontró cloudflared en PATH ni en Program Files (x86)\cloudflared.'
    }
  }
  if ($orchestration -eq 'n8n' -and -not $RestartServer) {
    $n8nCommand = Get-Command 'n8n.cmd' -ErrorAction SilentlyContinue
    if (-not $n8nCommand) {
      $n8nCommand = Get-Command 'n8n' -ErrorAction SilentlyContinue
    }
    if (-not $n8nCommand -or $n8nCommand.CommandType -ne 'Application') {
      throw 'AGENT_ORCHESTRATION=n8n, pero no se encontró el comando n8n en PATH.'
    }
  }
  $webhookPath = $null
  if (-not $RestartServer) { $webhookPath = Get-WebhookPath }

  if ($RestartServer) {
    Write-Host 'Validación inicial: OK (.env, package.json, node y npm.cmd).'
  } else {
    Write-Host 'Validación inicial: OK (.env, package.json, node, npm.cmd y cloudflared).'
  }
  Write-Host ('Orquestación configurada: {0}.' -f $orchestration)
  if ($orchestration -eq 'n8n' -and -not $RestartServer) {
    Write-Host ('Ruta del webhook leída del workflow: /webhook/{0}' -f $webhookPath)
  }

  if ($DryRun) {
    Write-Host ''
    Write-Host 'MODO DRY RUN: no se iniciará ni detendrá ningún proceso y no se modificará .env.'
    if ($RestartServer) {
      Write-Host 'MODO REINICIO: detendría únicamente el PID servidor PAYERS en .demo/pids.json; conservaría n8n y ambos túneles.'
      Write-Host 'Reiniciaría npm.cmd start, actualizaría solo el registro de su PID y repetiría comprobaciones con hasta 90 s por túnel.'
      Write-Host 'No modificaría PUBLIC_URL ni N8N_WAKE_URL.'
      return
    }
    if (Test-Path -LiteralPath $script:PidsFile -PathType Leaf) {
      Write-Host '1. Detendría únicamente los procesos registrados en .demo/pids.json.'
    } else {
      Write-Host '1. No hay procesos previos registrados para detener.'
    }
    if (-not $NoBuild -and -not (Test-Path -LiteralPath $distIndex -PathType Leaf)) {
      Write-Host '2. Ejecutaría npm.cmd run build.'
    } elseif ($NoBuild) {
      Write-Host '2. Omitiría la compilación por -NoBuild.'
    } else {
      Write-Host '2. Omitiría la compilación porque dist/index.html ya existe.'
    }
    if ($orchestration -eq 'n8n') {
      Write-Host ('3. Reutilizaría n8n si ya responde y tiene registrado el webhook en {0}; si no, lo iniciaría.' -f $n8nOrigin)
    } else {
      Write-Host '3. Omitiría n8n porque AGENT_ORCHESTRATION=server.'
    }
    Write-Host '4. Iniciaría cloudflared hacia http://127.0.0.1:5173 y leería su stderr (60 s).'
    if ($orchestration -eq 'n8n') {
      Write-Host ('5. Iniciaría el segundo túnel hacia {0}.' -f $n8nOrigin)
    } else {
      Write-Host '5. Omitiría el segundo túnel y dejaría N8N_WAKE_URL vacía.'
    }
    Write-Host '6. Guardaría una copia en .demo/env.backup y actualizaría solo PUBLIC_URL y N8N_WAKE_URL.'
    Write-Host '7. Iniciaría npm.cmd start y esperaría http://127.0.0.1:5173 (60 s).'
    Write-Host '8. Probaría el webhook Meta con token inválido, el webhook n8n sin autorización y el token WA sin imprimirlo.'
    Write-Host '9. Mostraría la URL del panel y las instrucciones para actualizar Meta.'
    return
  }

  if (-not (Test-Path -LiteralPath $script:DemoDirectory -PathType Container)) {
    [void](New-Item -ItemType Directory -Path $script:DemoDirectory -Force)
  }
  if ($RestartServer) {
    if (-not (Test-Path -LiteralPath $script:PidsFile -PathType Leaf)) {
      throw 'No existe .demo/pids.json. Inicia primero la demo completa antes de usar -RestartServer.'
    }
    $trackedData = Read-SharedText -Path $script:PidsFile | ConvertFrom-Json
    $trackedProcesses = @($trackedData.processes)
    $oldServer = @($trackedProcesses | Where-Object { $_.name -eq 'servidor PAYERS' }) | Select-Object -First 1
    if (-not $oldServer) {
      throw 'No se encontró el PID del servidor PAYERS en .demo/pids.json; no se modificó ningún proceso.'
    }
    $taskkill = Get-Command 'taskkill.exe' -ErrorAction SilentlyContinue
    if (-not $taskkill) { throw 'No se encontró taskkill.exe para reiniciar solo el servidor registrado.' }
    $oldServerId = 0
    if (-not [int]::TryParse([string]$oldServer.pid, [ref]$oldServerId) -or $oldServerId -le 0) {
      throw 'El PID registrado para el servidor no es válido; no se modificó ningún proceso.'
    }
    $oldServerProcess = Get-Process -Id $oldServerId -ErrorAction SilentlyContinue
    if (-not $oldServerProcess -or -not $oldServer.startTimeUtcTicks -or
        [long]$oldServerProcess.StartTime.ToUniversalTime().Ticks -ne [long]$oldServer.startTimeUtcTicks) {
      throw 'El PID registrado del servidor ya no identifica su proceso original; no se reinició ningún otro proceso.'
    }
    Stop-DemoProcessEntry -Entry $oldServer -TaskkillPath $taskkill.Source
    foreach ($entry in $trackedProcesses) {
      if ($entry.name -ne 'servidor PAYERS') { [void]$script:StartedProcesses.Add($entry) }
    }
    $script:RestartMode = $true
    Save-DemoPids

    $serverProcess = Start-DemoProcess -Name 'servidor PAYERS' -Executable $npmCommand.Source `
      -Arguments @('start') -StdoutPath (Join-Path $script:DemoDirectory 'server.out.log') `
      -StderrPath (Join-Path $script:DemoDirectory 'server.err.log')
    Wait-DemoHttp -Uri 'http://127.0.0.1:5173/' -TimeoutSeconds 60 -ServiceName 'Servidor del panel reiniciado'
    Register-DemoListenerProcess -Launcher $serverProcess -Port 5173 -Name 'servidor PAYERS'

    $panelUrl = [string]$environment['PUBLIC_URL']
    if (-not $panelUrl) { throw 'PUBLIC_URL no está configurada en .env; no se puede repetir la verificación del túnel Meta.' }
    $panelUrl = $panelUrl.TrimEnd('/')
    $metaWebhookUrl = $panelUrl + '/api/webhooks/whatsapp'
    $metaVerificationUrl = $metaWebhookUrl + '?hub.mode=subscribe&hub.verify_token=invalido&hub.challenge=1'
    Test-DemoTunnel -Uri $metaVerificationUrl -Method GET -Label 'El túnel del panel llega al webhook Meta (token de prueba inválido)' `
      -ExpectedStatusCodes @(403) -ExpectedBodyPattern 'Verificaci.n inv.lida' -TimeoutSeconds 90

    if ($orchestration -eq 'n8n') {
      $wakeUrl = [string]$environment['N8N_WAKE_URL']
      if (-not $wakeUrl) { throw 'AGENT_ORCHESTRATION=n8n, pero N8N_WAKE_URL está vacía; no se puede verificar el túnel existente.' }
      Test-DemoTunnel -Uri $wakeUrl -Method POST -Label 'El túnel de n8n exige autorización sin cabecera' `
        -ExpectedStatusCodes @(401, 403) -TimeoutSeconds 90 -ExplainNotPublished
    }

    $graphVersion = [string]$environment['WA_GRAPH_VERSION']
    $phoneNumberId = [string]$environment['WA_PHONE_NUMBER_ID']
    $accessToken = [string]$environment['WA_ACCESS_TOKEN']
    if ($graphVersion -and $phoneNumberId -and $accessToken) {
      $graphUrl = 'https://graph.facebook.com/{0}/{1}' -f $graphVersion, [uri]::EscapeDataString($phoneNumberId)
      $graphCheck = Invoke-DemoHttp -Uri $graphUrl -Method GET -Headers @{ Authorization = 'Bearer ' + $accessToken }
      $graphErrorCode = $null
      if ($graphCheck.Body) {
        try {
          $graphBody = $graphCheck.Body | ConvertFrom-Json
          if ($graphBody.error -and $graphBody.error.code) { $graphErrorCode = [int]$graphBody.error.code }
        } catch { $graphErrorCode = $null }
      }
      if ($graphErrorCode -eq 190) {
        Write-Host 'FALLÓ: El WA_ACCESS_TOKEN venció: genera uno nuevo en Meta (Paso 1: Pruébalo → Generar nuevo token), pégalo en el .env y reinicia el servidor'
      } else {
        Write-DemoCheck -Passed ($graphCheck.StatusCode -ge 200 -and $graphCheck.StatusCode -lt 300) `
          -Label 'Validación del token de WhatsApp (no se muestra el token).'
      }
    } else {
      Write-DemoCheck -Passed $false -Label 'No se pudo validar el token: faltan variables WA requeridas en .env.'
    }
    Write-Host 'Reinicio completado. n8n, los túneles y las URLs de .env quedaron intactos.'
    Write-Host ('Logs del servidor: {0} y {1}' -f $serverProcess.DemoStdoutPath, $serverProcess.DemoStderrPath)
    return
  }

  if (Test-Path -LiteralPath $script:PidsFile -PathType Leaf) {
    Write-Host 'Se encontró una ejecución previa; deteniendo sus procesos registrados...'
    Stop-DemoTrackedProcesses -Path $script:PidsFile
    Remove-Item -LiteralPath $script:PidsFile -Force -ErrorAction SilentlyContinue
  }

  $existingPanelListener = Get-DemoListenerProcessId -Port 5173
  if ($existingPanelListener) {
    throw ('El puerto 5173 ya está ocupado por PID {0}; no se iniciaron n8n ni los túneles. Detén el servidor anterior o libera ese puerto.' -f $existingPanelListener)
  }

  if (-not $NoBuild -and -not (Test-Path -LiteralPath $distIndex -PathType Leaf)) {
    Write-Host 'Compilando la aplicación con npm.cmd run build...'
    & $npmCommand.Source run build
    if ($LASTEXITCODE -ne 0) { throw ('La compilación terminó con código {0}.' -f $LASTEXITCODE) }
  } elseif ($NoBuild) {
    Write-Host 'Se omite la compilación por -NoBuild.'
  } else {
    Write-Host 'dist/index.html ya existe; se omite la compilación.'
  }
  if (-not (Test-Path -LiteralPath $distIndex -PathType Leaf)) {
    throw 'No existe dist/index.html. Quita -NoBuild o ejecuta npm.cmd run build.'
  }

  if ($orchestration -eq 'n8n') {
    $existingN8nListener = Get-DemoListenerProcessId -Port $n8nPort
    if ($existingN8nListener) {
      $n8nHealth = Invoke-DemoHttp -Uri ($n8nOrigin + '/healthz') -Method GET -TimeoutSeconds 5
      if ($n8nHealth.StatusCode -ne 200) {
        throw ('El puerto {0} ya está ocupado por PID {1}, pero n8n no responde en /healthz (HTTP {2}).' -f $n8nPort, $existingN8nListener, $n8nHealth.StatusCode)
      }
      $n8nWebhookCheck = Invoke-DemoHttp -Uri ($n8nOrigin + '/webhook/' + $webhookPath) `
        -Method POST -TimeoutSeconds 5
      if (@(401, 403) -notcontains $n8nWebhookCheck.StatusCode) {
        throw ('n8n responde en el puerto {0}, pero el webhook /webhook/{1} no está registrado (HTTP {2}). Activa el workflow en esa instancia.' -f $n8nPort, $webhookPath, $n8nWebhookCheck.StatusCode)
      }
      $n8nReused = $true
      Write-Host ('Reutilizando n8n existente (PID {0}); webhook registrado y protegido.' -f $existingN8nListener)
    } else {
      $env:N8N_PORT = [string]$n8nPort
      $env:N8N_RUNNERS_BROKER_PORT = [string]$n8nBrokerPort
      $n8nProcess = Start-DemoProcess -Name 'n8n' -Executable $n8nCommand.Source `
        -Arguments @('start') -StdoutPath (Join-Path $script:DemoDirectory 'n8n.out.log') `
        -StderrPath (Join-Path $script:DemoDirectory 'n8n.err.log')
      Wait-DemoHttp -Uri ($n8nOrigin + '/healthz') -TimeoutSeconds 90 -ServiceName 'n8n'
    }
  }

  $panelTunnel = Start-DemoProcess -Name 'cloudflared túnel del panel' -Executable $cloudflaredPath `
    -Arguments @('tunnel', '--url', 'http://127.0.0.1:5173') `
    -StdoutPath (Join-Path $script:DemoDirectory 'panel-tunnel.out.log') `
    -StderrPath (Join-Path $script:DemoDirectory 'panel-tunnel.err.log')
  $panelUrl = Wait-DemoTunnel -Process $panelTunnel `
    -StderrPath $panelTunnel.DemoStderrPath `
    -TimeoutSeconds 60 -TunnelName 'Túnel del panel'

  $wakeUrl = ''
  $n8nTunnelUrl = ''
  if ($orchestration -eq 'n8n') {
    $n8nTunnel = Start-DemoProcess -Name 'cloudflared túnel de n8n' -Executable $cloudflaredPath `
      -Arguments @('tunnel', '--url', $n8nOrigin) `
      -StdoutPath (Join-Path $script:DemoDirectory 'n8n-tunnel.out.log') `
      -StderrPath (Join-Path $script:DemoDirectory 'n8n-tunnel.err.log')
    $n8nTunnelUrl = Wait-DemoTunnel -Process $n8nTunnel `
      -StderrPath $n8nTunnel.DemoStderrPath `
      -TimeoutSeconds 60 -TunnelName 'Túnel de n8n'
    $wakeUrl = $n8nTunnelUrl + '/webhook/' + $webhookPath
  }

  [void](Update-DemoEnvironment -EnvPath $envPath -BackupPath $script:EnvironmentBackup `
    -PublicUrl $panelUrl -WakeUrl $wakeUrl)
  $environmentUpdated = $true
  $script:EnvironmentWasUpdated = $true
  Write-Host 'Se actualizó .env (solo PUBLIC_URL y N8N_WAKE_URL); los valores no se mostrarán.'

  $serverProcess = Start-DemoProcess -Name 'servidor PAYERS' -Executable $npmCommand.Source `
    -Arguments @('start') -StdoutPath (Join-Path $script:DemoDirectory 'server.out.log') `
    -StderrPath (Join-Path $script:DemoDirectory 'server.err.log')
  Wait-DemoHttp -Uri 'http://127.0.0.1:5173/' -TimeoutSeconds 60 -ServiceName 'Servidor del panel'
  Register-DemoListenerProcess -Launcher $serverProcess -Port 5173 -Name 'servidor PAYERS'

  $metaWebhookUrl = $panelUrl + '/api/webhooks/whatsapp'
  $metaVerificationUrl = $metaWebhookUrl + '?hub.mode=subscribe&hub.verify_token=invalido&hub.challenge=1'
  Test-DemoTunnel -Uri $metaVerificationUrl -Method GET `
    -Label 'El túnel del panel llega al webhook Meta (token de prueba inválido)' `
    -ExpectedStatusCodes @(403) -ExpectedBodyPattern 'Verificaci.n inv.lida' -TimeoutSeconds 90

  if ($orchestration -eq 'n8n') {
    $n8nWebhookUrl = $n8nTunnelUrl + '/webhook/' + $webhookPath
    Test-DemoTunnel -Uri $n8nWebhookUrl -Method POST `
      -Label 'El túnel de n8n exige autorización sin cabecera' `
      -ExpectedStatusCodes @(401, 403) -TimeoutSeconds 90 -ExplainNotPublished
  }

  $environment = Get-DemoEnvironment -Path $envPath
  $graphVersion = [string]$environment['WA_GRAPH_VERSION']
  $phoneNumberId = [string]$environment['WA_PHONE_NUMBER_ID']
  $accessToken = [string]$environment['WA_ACCESS_TOKEN']
  if ($graphVersion -and $phoneNumberId -and $accessToken) {
    $graphUrl = 'https://graph.facebook.com/{0}/{1}' -f $graphVersion, [uri]::EscapeDataString($phoneNumberId)
    $graphCheck = Invoke-DemoHttp -Uri $graphUrl -Method GET `
      -Headers @{ Authorization = 'Bearer ' + $accessToken }
    $graphErrorCode = $null
    if ($graphCheck.Body) {
      try {
        $graphBody = $graphCheck.Body | ConvertFrom-Json
        if ($graphBody.error -and $graphBody.error.code) { $graphErrorCode = [int]$graphBody.error.code }
      } catch {
        $graphErrorCode = $null
      }
    }
    if ($graphErrorCode -eq 190) {
      Write-Host 'FALLÓ: El WA_ACCESS_TOKEN venció: genera uno nuevo en Meta (Paso 1: Pruébalo → Generar nuevo token), pégalo en el .env y reinicia el servidor'
    } else {
      $graphPassed = ($graphCheck.StatusCode -ge 200 -and $graphCheck.StatusCode -lt 300)
      if ($graphPassed) {
        Write-DemoCheck -Passed $true -Label 'Meta aceptó el token de WhatsApp (no se muestra el token).'
      } else {
        Write-DemoCheck -Passed $false -Label ('Meta no validó el token de WhatsApp (HTTP {0}; no se muestra la respuesta ni el token).' -f $graphCheck.StatusCode)
      }
    }
  } else {
    Write-DemoCheck -Passed $false -Label 'No se pudo validar el token: faltan WA_GRAPH_VERSION, WA_PHONE_NUMBER_ID o WA_ACCESS_TOKEN en .env.'
  }

  [void]$script:StartedProcesses.ToArray()
  Save-DemoPids
  $clipboardMessage = 'URL de devolución de llamada: ' + $metaWebhookUrl
  try {
    Set-Clipboard -Value $clipboardMessage
    $clipboardStatus = 'La URL de devolución de llamada se copió al portapapeles.'
  } catch {
    $clipboardStatus = 'No se pudo usar el portapapeles; copia la URL que aparece abajo.'
  }

  Write-Host ''
  Write-Host '============================================================'
  Write-Host 'SIGUIENTE PASO MANUAL EN META'
  Write-Host '============================================================'
  Write-Host 'Ruta: Casos de uso → Personalizar → Configuración → Webhook.'
  Write-Host ('URL de devolución de llamada: {0}' -f $metaWebhookUrl)
  Write-Host $clipboardStatus
  Write-Host 'Token de verificación: usa el valor de WA_VERIFY_TOKEN de tu .env (no se imprime aquí).'
  Write-Host 'Pulsa “Verificar y guardar” y comprueba que el campo “messages” siga en “Suscritos”.'
  Write-Host 'Si no actualizas la URL en Meta, los mensajes de WhatsApp no llegarán.'
  if ($environment['PAYMENT_MODE'] -eq 'mercado_pago') {
    Write-Host ''
    Write-Host 'WEBHOOK DE PAGOS DE MERCADO PAGO (MODO DE PRUEBA)'
    Write-Host ('URL: {0}/api/webhooks/mercado-pago' -f $panelUrl)
    Write-Host 'En Tus integraciones → tu aplicación → Webhooks, actualiza la URL de prueba y deja activo el evento Pagos.'
    Write-Host 'La URL temporal cambia en cada inicio; actualízala antes de probar pagos.'
  }
  Write-Host ''
  Write-Host ('Panel: {0}' -f $panelUrl)
  Write-Host ('Logs del servidor: {0} y {1}' -f $serverProcess.DemoStdoutPath, $serverProcess.DemoStderrPath)
  Write-Host ('Logs del túnel del panel: {0} y {1}' -f $panelTunnel.DemoStdoutPath, $panelTunnel.DemoStderrPath)
  if ($orchestration -eq 'n8n') {
    Write-Host ('Webhook de activación de n8n: {0}' -f $wakeUrl)
    if ($n8nReused) {
      Write-Host 'n8n ya estaba activo y no se añadió a .demo/pids.json; detener la demo no apagará esa instancia.'
    } else {
      Write-Host ('Logs de n8n: {0} y {1}' -f $n8nProcess.DemoStdoutPath, $n8nProcess.DemoStderrPath)
    }
    Write-Host ('Logs del túnel de n8n: {0} y {1}' -f $n8nTunnel.DemoStdoutPath, $n8nTunnel.DemoStderrPath)
  } else {
    Write-Host 'Orquestación server: n8n y el túnel 2 no se iniciaron; N8N_WAKE_URL quedó vacía.'
  }
  Write-Host 'Los procesos iniciados quedaron registrados en .demo/pids.json.'
} catch {
  $failureMessage = $_.Exception.Message
  Write-Error ('No se pudo iniciar la demo: {0}' -f $failureMessage) -ErrorAction Continue
  try {
    if (-not $script:RestartMode -and $environmentUpdated -and (Test-Path -LiteralPath $script:EnvironmentBackup -PathType Leaf)) {
      Copy-Item -LiteralPath $script:EnvironmentBackup `
        -Destination (Join-Path $script:ProjectRoot '.env') -Force
      Write-Host 'Se restauró .env desde la copia de seguridad.'
    }
  } catch {
    Write-Warning 'No se pudo restaurar .env automáticamente; revisa .demo/env.backup antes de volver a iniciar.'
  }
  try {
    if ($script:RestartMode) {
      $taskkill = Get-Command 'taskkill.exe' -ErrorAction SilentlyContinue
      if ($taskkill) {
        foreach ($entry in @($script:StartedProcesses.ToArray() | Where-Object { $_.name -eq 'servidor PAYERS' })) {
          Stop-DemoProcessEntry -Entry $entry -TaskkillPath $taskkill.Source
        }
      }
      $preservedProcesses = @($script:StartedProcesses.ToArray() | Where-Object { $_.name -ne 'servidor PAYERS' })
      $script:StartedProcesses.Clear()
      foreach ($entry in $preservedProcesses) { [void]$script:StartedProcesses.Add($entry) }
      Save-DemoPids
    } elseif ($script:StartedProcesses.Count -gt 0) {
      Save-DemoPids
      Stop-DemoTrackedProcesses -Path $script:PidsFile
    }
  } catch {
    Write-Warning ('No se pudieron detener todos los procesos iniciados: {0}' -f $_.Exception.Message)
  } finally {
    if (-not $RestartServer -and (Test-Path -LiteralPath $script:PidsFile)) {
      Remove-Item -LiteralPath $script:PidsFile -Force -ErrorAction SilentlyContinue
    }
  }
  exit 1
}
