<#
.SYNOPSIS
  Relaunches the SEIKA kiosk if it is not running.

.DESCRIPTION
  Runs once a minute from a scheduled task. The Windows policies stop the easy
  ways to kill the kiosk; this covers everything else — a crash, a task ended
  by an admin tool, a player who finds something clever. Without it, one
  successful kill means a free PC until a member of staff happens to notice.

  Deliberately dumb: no state, no config beyond the install path, and it never
  decides anything about sessions. If the process is missing, start it.
#>

[CmdletBinding()]
param([string]$InstallPath = "C:\Program Files\SEIKA")

$exe = Join-Path $InstallPath "SEIKA.exe"
$log = Join-Path $env:ProgramData "SEIKA\watchdog.log"

New-Item -ItemType Directory -Force -Path (Split-Path $log) | Out-Null

function Write-Log { param($m)
  "$(Get-Date -Format 'yyyy-MM-ddTHH:mm:ss') $m" | Add-Content -Path $log
  # Keep the log from growing without bound on a PC that runs for months.
  if ((Get-Item $log).Length -gt 1MB) {
    Get-Content $log -Tail 500 | Set-Content $log
  }
}

if (-not (Test-Path $exe)) {
  Write-Log "SEIKA.exe missing at $exe — cannot relaunch"
  exit 1
}

# Staff asked for the machine. The kiosk writes this file when the escape
# code is accepted, and quits; relaunching it a minute later would make the
# PC impossible to service or uninstall. The file carries its own expiry so a
# maintenance window cannot be left open by someone forgetting about it.
$flag = Join-Path $env:ProgramData "SEIKA\maintenance.json"
if (Test-Path $flag) {
  try {
    $until = (Get-Content $flag -Raw | ConvertFrom-Json).until
    if ([DateTime]::Parse($until).ToUniversalTime() -gt (Get-Date).ToUniversalTime()) {
      exit 0
    }
    Write-Log "maintenance window expired — resuming"
    Remove-Item $flag -Force -ErrorAction SilentlyContinue
  } catch {
    # An unreadable flag must not keep a zone's PC offline indefinitely.
    Write-Log "maintenance flag unreadable — ignoring it"
    Remove-Item $flag -Force -ErrorAction SilentlyContinue
  }
}

if (Get-Process -Name "SEIKA" -ErrorAction SilentlyContinue) {
  exit 0   # running, nothing to do
}

Write-Log "kiosk not running — relaunching"
try {
  Start-Process -FilePath $exe
  Write-Log "relaunched"
} catch {
  Write-Log "relaunch failed: $($_.Exception.Message)"
  exit 1
}
