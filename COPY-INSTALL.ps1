[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$Target,
  [string]$RuntimeRoot,
  [string[]]$TrustedSlot = @(),
  [ValidateSet('links', 'projection')]
  [string]$ResourceMode = 'links',
  [switch]$Update,
  [switch]$DryRun,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$source = (Resolve-Path -LiteralPath (Split-Path -Parent $MyInvocation.MyCommand.Path)).Path
$targetPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Target)
if ($source.Equals($targetPath, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Target is the template directory itself: $targetPath"
}
if ($Force) {
  Write-Warning '-Force does not override project ownership; conflicts remain protected.'
}

$markerPath = Join-Path $targetPath '.pi\control-plane-consumer.json'
$slots = if ($TrustedSlot.Count -gt 0) { $TrustedSlot } else { @((Join-Path $HOME '.subagent-control\releases\consumer')) }

function Resolve-RuntimeRoot {
  if (-not [string]::IsNullOrWhiteSpace($RuntimeRoot)) {
    return (Resolve-Path -LiteralPath $RuntimeRoot).Path
  }
  if ((Test-Path -LiteralPath $markerPath) -and -not $Update) {
    $marker = Get-Content -LiteralPath $markerPath -Raw | ConvertFrom-Json
    if (-not $marker.runtime_root -or -not (Test-Path -LiteralPath $marker.runtime_root)) {
      throw 'The installed runtime is missing. Use -Update to repair from the current release.'
    }
    return (Resolve-Path -LiteralPath $marker.runtime_root).Path
  }
  foreach ($slot in $slots) {
    $pointerPath = Join-Path $slot 'current.json'
    if (Test-Path -LiteralPath $pointerPath) {
      $pointer = Get-Content -LiteralPath $pointerPath -Raw | ConvertFrom-Json
      if ($pointer.schema_version -ne 1 -or -not $pointer.runtime_root) {
        throw "Invalid current release registration: $pointerPath"
      }
      return (Resolve-Path -LiteralPath $pointer.runtime_root).Path
    }
  }
  throw 'No shared runtime is installed. Install a verified consumer release, or pass -RuntimeRoot <release>.'
}

$runtime = Resolve-RuntimeRoot
$installer = Join-Path $runtime 'ops\consumer-tools\consumer_install.py'
if (-not (Test-Path -LiteralPath $installer)) {
  throw "The verified runtime is incomplete: $installer"
}
$pythonCommand = Get-Command python -ErrorAction SilentlyContinue
if (-not $pythonCommand) {
  throw 'Python 3.12+ is required on PATH.'
}
$installArgs = @('-B', $installer, '--target', $targetPath, '--runtime-root', $runtime,
  '--resource-mode', $ResourceMode, '--format', 'json')
foreach ($slot in $slots) { $installArgs += @('--trusted-slot', $slot) }
if ($Update) { $installArgs += '--update' }
if ($DryRun) { $installArgs += '--dry-run' }

# 项目状态和台账由同一安装事务从 factory-project/factory-state-delta/factory-ledger 初始化。
# 运行入口使用 -B，避免在共享 Python 工具目录写入字节码缓存。
& $pythonCommand.Source @installArgs
$installExit = $LASTEXITCODE
if ($installExit -ne 0) { exit $installExit }
if ($DryRun) {
  Write-Output 'DryRun complete: no project path was written.'
  exit 0
}
Write-Output "Consumer install complete: $targetPath (runtime=$runtime)"
Write-Output 'Open Pi from the project root; trust only this exact project when prompted.'
