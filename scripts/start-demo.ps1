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
$script:StartedProcesses = New-Object 'System.Collections.Generic.List[object]'
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

function Get-NgrokDomain {
  param([Parameter(Mandatory = $true)][string]$Path)
  foreach ($line in [System.IO.File]::ReadAllLines($Path)) {
    if ($line -match '^\s*NGROK_DOMAIN\s*=\s*(.*?)\s*$') {
      $domain = $matches[1].Trim('"').Trim("'").Trim().TrimEnd('/')
      if ($domain -match '^https?://') { $domain = ([uri]$domain).Host }
      if ($domain -match '^[a-zA-Z0-9.-]+$') { return $domain.ToLowerInvariant() }
      throw 'NGROK_DOMAIN tiene un formato no válido. Usa solo el dominio asignado por ngrok.'
    }
  }
  throw 'Falta NGROK_DOMAIN en .env. Obtén el dominio gratuito en el panel de ngrok, sección Domains, y agrégalo a .env.'
}

function Get-NgrokHttpFlag {
  param([Parameter(Mandatory = $true)][string]$NgrokPath)
  $help = (& $NgrokPath http --help 2>&1 | Out-String)
  # Busca en la lista de opciones, no en ejemplos o texto general de ayuda.
  if ($help -match '(?m)^[ \t]*--url(?:[=\s])') { return 'url' }
  if ($help -match '(?m)^[ \t]*--domain(?:[=\s])') { return 'domain' }
  throw 'Esta versión de ngrok no documenta --url ni --domain en `ngrok http --help`; actualiza ngrok.'
}

function Wait-NgrokTunnel {
  param(
    [Parameter(Mandatory = $true)][System.Diagnostics.Process]$Process,
    [Parameter(Mandatory = $true)][string]$ExpectedUrl,
    [Parameter(Mandatory = $true)][int]$TimeoutSeconds
  )
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  while ([DateTime]::UtcNow -lt $deadline) {
    if ($Process.HasExited) {
      $log = Read-SharedText -Path $Process.DemoStderrPath
      if ($log -match 'ERR_NGROK_121') {
        throw 'La versión instalada del agente ngrok ya no es aceptada por ngrok. Actualízala con `ngrok update` o `winget upgrade --id Ngrok.Ngrok --exact` y vuelve a iniciar.'
      }
      if ($log -match 'unknown flag:\s*--url|unknown flag:\s*--domain') {
        throw 'La versión instalada de ngrok no acepta la opción elegida. Actualiza ngrok con `ngrok update` o `winget upgrade --id Ngrok.Ngrok --exact` y vuelve a iniciar.'
      }
      if ($log -match 'ERR_NGROK_108|already online|limit.*session') {
        throw 'ngrok ya tiene otra sesión activa o se alcanzó el límite del plan gratuito. Cierra únicamente tu otra sesión de ngrok y vuelve a intentar.'
      }
      if ($log -match 'ERR_NGROK_(105|4018)|authtoken|authentication failed|invalid.*token') {
        throw 'ngrok rechazó la autenticación. Configura un authtoken válido con `ngrok config add-authtoken` y vuelve a intentar.'
      }
      if ($log -match 'ERR_NGROK_3200|domain.*(not found|not.*account|not.*reserved)|endpoint.*not found|failed to start tunnel') {
        throw 'ngrok no pudo reservar el dominio. Comprueba que NGROK_DOMAIN esté asignado a esta cuenta y disponible en Domains.'
      }
      throw 'ngrok terminó antes de activar el túnel. Revisa .demo/ngrok.err.log; el script no detuvo procesos ajenos.'
    }
    $result = Invoke-DemoHttp -Uri 'http://127.0.0.1:4040/api/tunnels' -Method GET -TimeoutSeconds 2
    if ($result.StatusCode -eq 200 -and $result.Body) {
      try {
        $tunnels = ($result.Body | ConvertFrom-Json).tunnels
        $match = @($tunnels | Where-Object {
          $_.public_url -ceq $ExpectedUrl -and ([string]$_.config.addr -match '127\.0\.0\.1:5173$')
        }) | Select-Object -First 1
        if ($match) { return $ExpectedUrl }
        if (@($tunnels | Where-Object { $_.public_url -like 'https://*' }).Count -gt 0) {
          throw 'La API local de ngrok muestra un túnel distinto al dominio solicitado. Puede haber otra sesión activa; no se detuvo.'
        }
      } catch {
        if ($_.Exception.Message -like 'La API local*') { throw }
      }
    }
    Start-Sleep -Seconds 1
  }
  $log = Read-SharedText -Path $Process.DemoStderrPath
  if ($log -match 'ERR_NGROK_121') {
    throw 'La versión instalada del agente ngrok ya no es aceptada por ngrok. Actualízala con `ngrok update` o `winget upgrade --id Ngrok.Ngrok --exact` y vuelve a iniciar.'
  }
  if ($log -match 'unknown flag:\s*--url|unknown flag:\s*--domain') {
    throw 'La versión instalada de ngrok no acepta la opción elegida. Actualiza ngrok con `ngrok update` o `winget upgrade --id Ngrok.Ngrok --exact` y vuelve a iniciar.'
  }
  if ($log -match 'ERR_NGROK_(105|4018)|authtoken|authentication failed|invalid.*token') {
    throw 'ngrok rechazó la autenticación. Configura un authtoken válido con `ngrok config add-authtoken` y vuelve a intentar.'
  }
  if ($log -match 'ERR_NGROK_108|already online|limit.*session') {
    throw 'ngrok ya tiene otra sesión activa o se alcanzó el límite del plan gratuito. Cierra únicamente tu otra sesión de ngrok y vuelve a intentar.'
  }
  if ($log -match 'ERR_NGROK_3200|domain.*(not found|not.*account|not.*reserved)|endpoint.*not found') {
    throw 'ngrok no pudo reservar el dominio. Comprueba que NGROK_DOMAIN esté asignado a esta cuenta y disponible en Domains.'
  }
  throw 'ngrok no publicó el dominio esperado en http://127.0.0.1:4040/api/tunnels dentro del tiempo límite. Revisa .demo/ngrok.err.log, el authtoken y el dominio de la cuenta.'
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
  if (($Entry.processName -eq 'cloudflared') -or ($Entry.name -match 'cloudflared')) {
    if ($process.ProcessName -ne 'cloudflared') {
      Write-Warning ('Entrada antigua de cloudflared PID {0}: el proceso ya no se llama cloudflared; no se detuvo.' -f $processId)
      return
    }
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

$n8nReused = $false
$previousPublicUrl = $env:PUBLIC_URL
$previousWakeUrl = $env:N8N_WAKE_URL
$previousWebhookUrl = $env:WEBHOOK_URL
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
  $ngrokCommand = $null
  if (-not $RestartServer) {
    $ngrokCommand = Get-Command 'ngrok' -ErrorAction SilentlyContinue
    if (-not $ngrokCommand -or $ngrokCommand.CommandType -ne 'Application') {
      throw 'No se encontró ngrok. Instálalo con: winget install ngrok.ngrok'
    }
  }
  $environment = Get-DemoEnvironment -Path $envPath
  $ngrokDomain = Get-NgrokDomain -Path $envPath
  $panelUrl = 'https://' + $ngrokDomain
  $configuredPublicUrl = [string]$environment['PUBLIC_URL']
  if ($configuredPublicUrl.TrimEnd('/') -and $configuredPublicUrl.TrimEnd('/') -cne $panelUrl) {
    Write-Warning 'PUBLIC_URL en .env difiere del dominio ngrok; PAYERS usará el dominio fijo solo en este proceso.'
  }
  $wakeUrl = 'http://127.0.0.1:5678/webhook/establo-payers-despertar'
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
  $ngrokFlag = $null
  if (-not $RestartServer) {
    $ngrokFlag = Get-NgrokHttpFlag -NgrokPath $ngrokCommand.Source
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
  if ($RestartServer) {
    Write-Host 'Validación inicial: OK (.env, package.json, node y npm.cmd).'
  } else {
    Write-Host 'Validación inicial: OK (.env, package.json, node, npm.cmd y ngrok).'
  }
  Write-Host ('Orquestación configurada: {0}.' -f $orchestration)

  if ($DryRun) {
    Write-Host ''
    Write-Host 'MODO DRY RUN: no se iniciará ni detendrá ningún proceso y no se modificará .env.'
    if ($RestartServer) {
      Write-Host 'MODO REINICIO: detendría solo el servidor PAYERS identificado en el puerto 5173 y conservaría n8n y ngrok.'
      Write-Host 'Reiniciaría el servidor usando las URL del dominio fijo solo en el proceso; no modificaría .env.'
      return
    }
    if (Test-Path -LiteralPath $script:PidsFile -PathType Leaf) {
      Write-Host '1. Detendría únicamente los procesos registrados en .demo/pids.json.'
    } else {
      Write-Host '1. No hay procesos previos registrados para detener.'
    }
    if ($NoBuild) {
      Write-Host '2. Omitiría la compilación por -NoBuild.'
    } else {
      Write-Host '2. Ejecutaría npm.cmd run build para actualizar la interfaz en cada arranque.'
    }
    if ($orchestration -eq 'n8n') {
      Write-Host ('3. Reutilizaría n8n si ya responde y tiene registrado el webhook en {0}; si no, lo iniciaría.' -f $n8nOrigin)
    } else {
      Write-Host '3. Omitiría n8n porque AGENT_ORCHESTRATION=server.'
    }
    Write-Host '4. Iniciaría un solo ngrok para 127.0.0.1:5173 y esperaría su API local en 127.0.0.1:4040.'
    Write-Host '5. Iniciaría/reutilizaría n8n local cuando AGENT_ORCHESTRATION=n8n y revisaría /healthz.'
    Write-Host '6. Iniciaría PAYERS con PUBLIC_URL fijo y N8N_WAKE_URL local, sin modificar .env.'
    Write-Host '7. Comprobaría PAYERS localmente y el dominio propio con ngrok-skip-browser-warning.'
    Write-Host '8. Mostraría las URL estables para registrar una sola vez en Meta y Mercado Pago.'
    return
  }

  if (-not (Test-Path -LiteralPath $script:DemoDirectory -PathType Container)) {
    [void](New-Item -ItemType Directory -Path $script:DemoDirectory -Force)
  }
  if (-not $NoBuild) {
    Write-Host 'Compilando la aplicación para publicar los cambios recientes...'
    & $npmCommand.Source run build
    if ($LASTEXITCODE -ne 0) { throw ('La compilación terminó con código {0}; no se reinició ningún servicio.' -f $LASTEXITCODE) }
  } elseif (-not (Test-Path -LiteralPath $distIndex -PathType Leaf)) {
    throw 'No existe dist/index.html. Quita -NoBuild o ejecuta npm.cmd run build.'
  }
  if (-not (Test-Path -LiteralPath $distIndex -PathType Leaf)) {
    throw 'La compilación terminó sin generar dist/index.html.'
  }
  if ($RestartServer) {
    if (-not (Test-Path -LiteralPath $script:PidsFile -PathType Leaf)) {
      throw 'No existe .demo/pids.json. Inicia primero la demo completa antes de usar -RestartServer.'
    }
    $trackedData = Read-SharedText -Path $script:PidsFile | ConvertFrom-Json
    $trackedProcesses = @($trackedData.processes)
    $oldServer = @($trackedProcesses | Where-Object { $_.name -eq 'servidor PAYERS' }) | Select-Object -First 1
    $taskkill = Get-Command 'taskkill.exe' -ErrorAction SilentlyContinue
    if (-not $taskkill) { throw 'No se encontró taskkill.exe para reiniciar solo el servidor registrado.' }
    $serverToStop = $null
    $oldServerId = 0
    if ($oldServer -and [int]::TryParse([string]$oldServer.pid, [ref]$oldServerId) -and $oldServerId -gt 0) {
      $candidate = Get-Process -Id $oldServerId -ErrorAction SilentlyContinue
      if ($candidate -and $oldServer.startTimeUtcTicks -and
          [long]$candidate.StartTime.ToUniversalTime().Ticks -eq [long]$oldServer.startTimeUtcTicks) {
        $serverToStop = $candidate
      }
    }
    if (-not $serverToStop) {
      $listenerId = Get-DemoListenerProcessId -Port 5173
      if ($listenerId) {
        $candidate = Get-Process -Id $listenerId -ErrorAction SilentlyContinue
        $cimProcess = Get-CimInstance Win32_Process -Filter ('ProcessId = {0}' -f $listenerId) -ErrorAction SilentlyContinue
        $commandLine = [string]$cimProcess.CommandLine
        $normalizedRoot = $script:ProjectRoot.TrimEnd('\')
        $belongsToProject = ($commandLine -and $commandLine.IndexOf($normalizedRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0) -or
          ($candidate -and $candidate.ProcessName -eq 'node' -and $commandLine -match 'server[\\/]start\.mjs')
        if ($belongsToProject) {
          $serverToStop = $candidate
          $oldServer = Get-ProcessIdentity -Process $candidate -Name 'servidor PAYERS'
          Write-Warning 'El PID guardado cambió; se identificó el servidor PAYERS por el proceso que escucha en 5173.'
        } else {
          throw ('El PID guardado no coincide y el proceso que escucha en 5173 no se pudo asociar a este proyecto (PID {0}); no se detuvo.' -f $listenerId)
        }
      } else {
        throw 'El PID guardado no coincide y no hay un proceso escuchando en 5173; no se detuvo ningún otro proceso.'
      }
    }
    Stop-DemoProcessEntry -Entry $oldServer -TaskkillPath $taskkill.Source
    foreach ($entry in $trackedProcesses) {
      if ($entry.name -ne 'servidor PAYERS') { [void]$script:StartedProcesses.Add($entry) }
    }
    $script:RestartMode = $true
    Save-DemoPids

    $env:PUBLIC_URL = $panelUrl
    $env:N8N_WAKE_URL = $wakeUrl
    $serverProcess = Start-DemoProcess -Name 'servidor PAYERS' -Executable $npmCommand.Source `
      -Arguments @('start') -StdoutPath (Join-Path $script:DemoDirectory 'server.out.log') `
      -StderrPath (Join-Path $script:DemoDirectory 'server.err.log')
    $env:PUBLIC_URL = $previousPublicUrl
    $env:N8N_WAKE_URL = $previousWakeUrl
    Wait-DemoHttp -Uri 'http://127.0.0.1:5173/' -TimeoutSeconds 60 -ServiceName 'Servidor del panel reiniciado'
    Register-DemoListenerProcess -Launcher $serverProcess -Port 5173 -Name 'servidor PAYERS'

    $publicHealth = Invoke-DemoHttp -Uri $panelUrl -Method GET `
      -Headers @{ 'ngrok-skip-browser-warning' = 'true' } -TimeoutSeconds 8
    Write-DemoCheck -Passed ($publicHealth.StatusCode -ge 200 -and $publicHealth.StatusCode -lt 400) `
      -Label 'El dominio propio de ngrok llega a PAYERS (se omite el aviso del navegador).'
    $n8nHealth = Invoke-DemoHttp -Uri 'http://127.0.0.1:5678/healthz' -Method GET -TimeoutSeconds 5
    if ($n8nHealth.StatusCode -eq 200) {
      Write-DemoCheck -Passed $true -Label 'n8n responde en http://127.0.0.1:5678/healthz.'
    } else {
      Write-Warning 'n8n no respondió en http://127.0.0.1:5678/healthz; comprueba que esté activo para las alertas.'
    }
    Write-Host ('Meta WhatsApp: {0}/api/webhooks/whatsapp' -f $panelUrl)
    Write-Host ('Mercado Pago:  {0}/api/webhooks/mercado-pago' -f $panelUrl)
    Write-Host 'Reinicio completado. n8n y ngrok quedaron intactos; .env no se modificó.'
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

  if ($NoBuild) {
    Write-Host 'Se omite la compilación por -NoBuild.'
  }
  if (-not (Test-Path -LiteralPath $distIndex -PathType Leaf)) {
    throw 'No existe dist/index.html. Quita -NoBuild o ejecuta npm.cmd run build.'
  }

  if ($orchestration -eq 'n8n') {
    $existingN8nListener = Get-DemoListenerProcessId -Port $n8nPort
    if ($existingN8nListener) {
      $n8nReused = $true
      Write-Host ('Reutilizando n8n existente en el puerto local {0} (PID {1}).' -f $n8nPort, $existingN8nListener)
    } else {
      $env:N8N_PORT = [string]$n8nPort
      $env:N8N_RUNNERS_BROKER_PORT = [string]$n8nBrokerPort
      $env:WEBHOOK_URL = $n8nOrigin + '/'
      $n8nProcess = Start-DemoProcess -Name 'n8n' -Executable $n8nCommand.Source `
        -Arguments @('start') -StdoutPath (Join-Path $script:DemoDirectory 'n8n.out.log') `
        -StderrPath (Join-Path $script:DemoDirectory 'n8n.err.log')
      $env:WEBHOOK_URL = $previousWebhookUrl
      Wait-DemoHttp -Uri ($n8nOrigin + '/healthz') -TimeoutSeconds 90 -ServiceName 'n8n'
    }
  }

  $activeTunnels = Invoke-DemoHttp -Uri 'http://127.0.0.1:4040/api/tunnels' -Method GET -TimeoutSeconds 2
  if ($activeTunnels.StatusCode -eq 200 -and $activeTunnels.Body) {
    try {
      if (@(($activeTunnels.Body | ConvertFrom-Json).tunnels).Count -gt 0) {
        throw 'Ya existe una sesión de ngrok expuesta en la API local de 127.0.0.1:4040. Cierra esa sesión manualmente o conserva el túnel existente; PAYERS no la terminará.'
      }
    } catch {
      if ($_.Exception.Message -like 'Ya existe una sesión*') { throw }
    }
  }
  $domainFlag = if ($ngrokFlag -eq 'url') { '--url=' + $panelUrl } else { '--domain=' + $ngrokDomain }
  $ngrokProcess = Start-DemoProcess -Name 'ngrok túnel PAYERS' -Executable $ngrokCommand.Source `
    -Arguments @('http', $domainFlag, '127.0.0.1:5173') `
    -StdoutPath (Join-Path $script:DemoDirectory 'ngrok.out.log') `
    -StderrPath (Join-Path $script:DemoDirectory 'ngrok.err.log')
  [void](Wait-NgrokTunnel -Process $ngrokProcess -ExpectedUrl $panelUrl -TimeoutSeconds 60)
  Write-Host ('OK: túnel ngrok fijo activo en {0}.' -f $panelUrl)

  $env:PUBLIC_URL = $panelUrl
  $env:N8N_WAKE_URL = $wakeUrl
  $serverProcess = Start-DemoProcess -Name 'servidor PAYERS' -Executable $npmCommand.Source `
    -Arguments @('start') -StdoutPath (Join-Path $script:DemoDirectory 'server.out.log') `
    -StderrPath (Join-Path $script:DemoDirectory 'server.err.log')
  $env:PUBLIC_URL = $previousPublicUrl
  $env:N8N_WAKE_URL = $previousWakeUrl
  Wait-DemoHttp -Uri 'http://127.0.0.1:5173/' -TimeoutSeconds 60 -ServiceName 'Servidor del panel'
  Register-DemoListenerProcess -Launcher $serverProcess -Port 5173 -Name 'servidor PAYERS'

  [void]$script:StartedProcesses.ToArray()
  Save-DemoPids
  $metaWebhookUrl = $panelUrl + '/api/webhooks/whatsapp'
  $mercadoPagoWebhookUrl = $panelUrl + '/api/webhooks/mercado-pago'
  $publicHealth = Invoke-DemoHttp -Uri $panelUrl -Method GET `
    -Headers @{ 'ngrok-skip-browser-warning' = 'true' } -TimeoutSeconds 10
  Write-DemoCheck -Passed ($publicHealth.StatusCode -ge 200 -and $publicHealth.StatusCode -lt 400) `
    -Label 'El dominio público de ngrok llega al panel.'
  $n8nHealth = Invoke-DemoHttp -Uri 'http://127.0.0.1:5678/healthz' -Method GET -TimeoutSeconds 5
  if ($n8nHealth.StatusCode -eq 200) {
    Write-DemoCheck -Passed $true -Label 'n8n responde en http://127.0.0.1:5678/healthz.'
  } else {
    Write-Warning 'n8n no respondió en http://127.0.0.1:5678/healthz. PAYERS y el túnel pueden funcionar, pero las alertas programadas requieren n8n activo.'
  }

  Write-Host ''
  Write-Host '============================================================'
  Write-Host 'URLS ESTABLES PARA REGISTRAR UNA SOLA VEZ'
  Write-Host '============================================================'
  Write-Host 'Ruta: Casos de uso → Personalizar → Configuración → Webhook.'
  Write-Host ('Meta WhatsApp: {0}' -f $metaWebhookUrl)
  Write-Host ('Mercado Pago:  {0}' -f $mercadoPagoWebhookUrl)
  Write-Host 'Token de verificación: usa el valor de WA_VERIFY_TOKEN de tu .env (no se imprime aquí).'
  Write-Host 'Pulsa “Verificar y guardar” y comprueba que el campo “messages” siga en “Suscritos”.'
  Write-Host 'Si no actualizas la URL en Meta, los mensajes de WhatsApp no llegarán.'
  Write-Host 'Estas direcciones no cambian entre arranques mientras conserves el dominio ngrok.'
  Write-Host 'Los webhooks de Meta y Mercado Pago son llamadas servidor a servidor; el aviso de navegador no los afecta.'
  Write-Host ''
  Write-Host ('Panel: {0}' -f $panelUrl)
  Write-Host ('Logs del servidor: {0} y {1}' -f $serverProcess.DemoStdoutPath, $serverProcess.DemoStderrPath)
  Write-Host ('Logs de ngrok: {0} y {1}' -f $ngrokProcess.DemoStdoutPath, $ngrokProcess.DemoStderrPath)
  if ($orchestration -eq 'n8n') {
    Write-Host ('PAYERS despierta n8n localmente en {0}.' -f $wakeUrl)
    if ($n8nReused) {
      Write-Host 'n8n ya estaba activo y no se añadió a .demo/pids.json; detener la demo no apagará esa instancia.'
    } else {
      Write-Host ('Logs de n8n: {0} y {1}' -f $n8nProcess.DemoStdoutPath, $n8nProcess.DemoStderrPath)
    }
  } else {
    Write-Host 'AGENT_ORCHESTRATION=server: PAYERS procesa mensajes sin n8n; no se creó túnel para n8n.'
  }
  Write-Host 'Activa el workflow en n8n para que exista su ruta de producción y se ejecuten las alertas programadas.'
  Write-Host 'La URL de ngrok muestra una página de aviso al abrirla en un navegador; los clientes pueden verla en el portal, links de pago/retornos y constancias.'
  Write-Host 'Los procesos iniciados quedaron registrados en .demo/pids.json.'
} catch {
  $failureMessage = $_.Exception.Message
  Write-Error ('No se pudo iniciar la demo: {0}' -f $failureMessage) -ErrorAction Continue
  try {
  } catch {
    Write-Warning 'No se pudo limpiar la configuración temporal del proceso.'
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
    $env:PUBLIC_URL = $previousPublicUrl
    $env:N8N_WAKE_URL = $previousWakeUrl
    $env:WEBHOOK_URL = $previousWebhookUrl
    if (-not $RestartServer -and $script:StartedProcesses.Count -gt 0 -and (Test-Path -LiteralPath $script:PidsFile)) {
      Remove-Item -LiteralPath $script:PidsFile -Force -ErrorAction SilentlyContinue
    }
  }
  exit 1
}
