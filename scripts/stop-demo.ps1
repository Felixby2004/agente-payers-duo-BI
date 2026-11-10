$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2

$projectRoot = Split-Path -Parent $PSScriptRoot
$demoDirectory = Join-Path $projectRoot '.demo'
$pidsFile = Join-Path $demoDirectory 'pids.json'

try {
  if (-not (Test-Path -LiteralPath $pidsFile -PathType Leaf)) {
    Write-Host 'No hay procesos de la demo registrados en .demo/pids.json.'
    Write-Host 'El archivo .env se dejó sin cambios. La próxima ejecución de start-demo.ps1 pondrá direcciones nuevas.'
    exit 0
  }

  $data = Get-Content -LiteralPath $pidsFile -Raw | ConvertFrom-Json
  $taskkill = Get-Command 'taskkill.exe' -ErrorAction SilentlyContinue
  if (-not $taskkill) { throw 'No se encontró taskkill.exe para detener los procesos registrados.' }

  foreach ($entry in @($data.processes | Sort-Object -Property pid -Descending)) {
    $processId = 0
    if (-not [int]::TryParse([string]$entry.pid, [ref]$processId) -or $processId -le 0) {
      Write-Warning 'Se omitió una entrada de PID inválida en .demo/pids.json.'
      continue
    }

    $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
    if (-not $process) {
      Write-Host ('El proceso registrado PID {0} ya no existe.' -f $processId)
      continue
    }
    if (-not $entry.startTimeUtcTicks) {
      Write-Warning ('Se omitió el PID {0}: no tiene identidad verificable.' -f $processId)
      continue
    }
    if ([long]$process.StartTime.ToUniversalTime().Ticks -ne [long]$entry.startTimeUtcTicks) {
      Write-Warning ('Se omitió el PID {0}: ahora pertenece a otra ejecución.' -f $processId)
      continue
    }

    Write-Host ('Deteniendo solo el proceso registrado PID {0} y sus hijos...' -f $processId)
    $null = & $taskkill.Source /PID $processId /T /F 2>&1
    if ($LASTEXITCODE -ne 0 -and (Get-Process -Id $processId -ErrorAction SilentlyContinue)) {
      Write-Warning ('No se pudo detener PID {0}.' -f $processId)
    }
  }

  Remove-Item -LiteralPath $pidsFile -Force
  Write-Host 'Se eliminó .demo/pids.json.'
  Write-Host 'El archivo .env se dejó sin cambios. La próxima ejecución de start-demo.ps1 pondrá direcciones nuevas.'
} catch {
  Write-Error ('No se pudieron detener los procesos de la demo: {0}' -f $_.Exception.Message)
  exit 1
}
