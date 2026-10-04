<#
.SYNOPSIS
  Locks a Windows gaming PC down around the SEIKA kiosk.

.DESCRIPTION
  Electron alone cannot hold a lock on Windows. `globalShortcut` does not stop
  the Windows key, Task Manager, or Ctrl+Alt+Del, so a player gets behind the
  lock screen in about a minute. This script adds the Windows-level pieces that
  actually hold:

    1. Task Manager disabled, so the kiosk process cannot be killed.
    2. The Ctrl+Alt+Del screen emptied — no Task Manager, no sign out, no switch
       user, no lock. The key combination itself cannot be blocked from user
       space by anyone, so instead it is made to lead nowhere.
    3. Windows keys disabled at the keyboard driver, which is the only reliable
       way; an app-level hook loses the race against the shell.
    4. A watchdog that relaunches the kiosk within a minute if it ever exits.
    5. Auto-start at logon, running before the player can reach the desktop.

  Explorer keeps running on purpose. Assigned Access and shell replacement are
  the usual kiosk answers and both are wrong here: a gaming PC has to let the
  player launch games once they have paid, and neither of those allows it. So
  the kiosk is an always-on-top overlay that Windows will not let them dismiss,
  rather than a replacement for the desktop.

.PARAMETER InstallPath
  Where SEIKA.exe is installed.

.PARAMETER SkipKeyboard
  Leave the Windows keys alone. Nothing else needs a reboot, so this makes the
  install take effect immediately — at the cost of the weakest escape staying
  open. Use it to try the setup, not to run a zone.

.EXAMPLE
  .\Install-SeikaKiosk.ps1 -InstallPath "C:\Program Files\SEIKA"

.NOTES
  Run as Administrator. Uninstall-SeikaKiosk.ps1 reverses every change here,
  and the README documents recovery from Safe Mode if a PC is ever locked with
  no working way in.
#>

[CmdletBinding()]
param(
  [string]$InstallPath = "C:\Program Files\SEIKA",
  [switch]$SkipKeyboard
)

$ErrorActionPreference = "Stop"

function Write-Step { param($m) Write-Host "  $m" -ForegroundColor Cyan }
function Write-Ok   { param($m) Write-Host "  $m" -ForegroundColor Green }
function Write-Warn { param($m) Write-Host "  $m" -ForegroundColor Yellow }

if (-not ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
    ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "Run this from an Administrator PowerShell. Right-click PowerShell and choose 'Run as administrator'."
}

$exe = Join-Path $InstallPath "SEIKA.exe"
if (-not (Test-Path $exe)) {
  throw "SEIKA.exe not found at $exe. Install the kiosk first, or pass -InstallPath."
}

Write-Host ""
Write-Host "SEIKA kiosk lockdown" -ForegroundColor White
Write-Host "────────────────────" -ForegroundColor DarkGray

# ─── 1. Task Manager ─────────────────────────────────────────────────────────
# The single most important one. With Task Manager available a player ends the
# kiosk process and has a free PC.

Write-Step "Disabling Task Manager"
$policySystem = "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System"
New-Item -Path $policySystem -Force | Out-Null
Set-ItemProperty -Path $policySystem -Name "DisableTaskMgr" -Value 1 -Type DWord

# ─── 2. The Ctrl+Alt+Del screen ──────────────────────────────────────────────
# Ctrl+Alt+Del is a secure-attention sequence: no user-space program can
# intercept it, and anything claiming otherwise is lying. What *can* be done is
# remove every option from the screen it opens, so it becomes a dead end.

Write-Step "Emptying the Ctrl+Alt+Del screen"
Set-ItemProperty -Path $policySystem -Name "DisableChangePassword"  -Value 1 -Type DWord
Set-ItemProperty -Path $policySystem -Name "DisableLockWorkstation" -Value 1 -Type DWord
Set-ItemProperty -Path $policySystem -Name "HideFastUserSwitching"  -Value 1 -Type DWord

$policyExplorer = "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\Explorer"
New-Item -Path $policyExplorer -Force | Out-Null
Set-ItemProperty -Path $policyExplorer -Name "NoLogoff" -Value 1 -Type DWord
# No Run dialog, and no right-click taskbar route to Task Manager.
Set-ItemProperty -Path $policyExplorer -Name "NoRun" -Value 1 -Type DWord

# ─── 3. Windows keys ─────────────────────────────────────────────────────────
# Mapped out at the keyboard driver via Scancode Map. An app-level hook is the
# obvious alternative and it is not reliable: the shell handles Win before a
# user-space hook sees it. This needs a reboot, and it is fully reversible.

if ($SkipKeyboard) {
  Write-Warn "Skipping the Windows keys (-SkipKeyboard). The Win key still opens the Start menu."
} else {
  Write-Step "Disabling the Windows keys (takes effect after a reboot)"
  # Layout: version(4) + flags(4) + count(4) + mappings(4 each) + terminator(4).
  # Each mapping is a DWORD whose high word is the scancode being remapped and
  # whose low word is its replacement; 0x0000 means "nothing".
  #   Left Win  = 0xE05B      Right Win = 0xE05C
  $scancodeMap = [byte[]]@(
    0x00,0x00,0x00,0x00,   # version
    0x00,0x00,0x00,0x00,   # flags
    0x03,0x00,0x00,0x00,   # 2 mappings + terminator
    0x00,0x00,0x5B,0xE0,   # Left Win  -> disabled
    0x00,0x00,0x5C,0xE0,   # Right Win -> disabled
    0x00,0x00,0x00,0x00    # terminator
  )
  $keyboardLayout = "HKLM:\SYSTEM\CurrentControlSet\Control\Keyboard Layout"
  Set-ItemProperty -Path $keyboardLayout -Name "Scancode Map" -Value $scancodeMap -Type Binary
}

# ─── 4. Auto-start at logon ──────────────────────────────────────────────────
# A scheduled task rather than a Run key: it runs with highest privileges, it
# starts before the player reaches a usable desktop, and a player cannot remove
# it from their own profile.

Write-Step "Registering auto-start at logon"
$startAction  = New-ScheduledTaskAction -Execute $exe
$startTrigger = New-ScheduledTaskTrigger -AtLogOn
$startSettings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId "BUILTIN\Users" -RunLevel Highest

Register-ScheduledTask -TaskName "SEIKA Kiosk" `
  -Action $startAction -Trigger $startTrigger -Settings $startSettings -Principal $principal `
  -Description "Starts the SEIKA kiosk lock screen at logon." -Force | Out-Null

# ─── 5. Watchdog ─────────────────────────────────────────────────────────────
# Policies stop the easy kills; the watchdog covers the rest — a crash, a task
# ended by an admin tool, a player who finds something clever. Without it, one
# successful kill is a free PC until someone notices.

Write-Step "Registering the watchdog (checks every minute)"
$watchdog = Join-Path $InstallPath "SeikaWatchdog.ps1"
if (-not (Test-Path $watchdog)) {
  Copy-Item (Join-Path $PSScriptRoot "SeikaWatchdog.ps1") $watchdog -Force
}

$wdAction = New-ScheduledTaskAction -Execute "powershell.exe" `
  -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$watchdog`" -InstallPath `"$InstallPath`""
$wdTrigger = New-ScheduledTaskTrigger -AtLogOn
$wdTrigger.Repetition = (New-ScheduledTaskTrigger -Once -At (Get-Date) `
  -RepetitionInterval (New-TimeSpan -Minutes 1) `
  -RepetitionDuration ([TimeSpan]::MaxValue)).Repetition

Register-ScheduledTask -TaskName "SEIKA Kiosk Watchdog" `
  -Action $wdAction -Trigger $wdTrigger -Principal $principal `
  -Settings (New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries) `
  -Description "Relaunches the SEIKA kiosk if it stops running." -Force | Out-Null

# ─── 6. Nuisances that let a player sit outside the lock ────────────────────

Write-Step "Turning off sleep, hibernate and the lock screen"
# A sleeping PC mid-session locks out a player who has paid for the time.
powercfg /change standby-timeout-ac 0
powercfg /change monitor-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
powercfg /hibernate off 2>$null

# ─── Done ────────────────────────────────────────────────────────────────────

Write-Host ""
Write-Ok "Lockdown applied."
Write-Host ""
Write-Host "  Still to do by hand:" -ForegroundColor White
Write-Host "   * Reboot, for the Windows keys to take effect." -ForegroundColor Gray
Write-Host "   * Set the player account to auto-login, and give it NO admin rights." -ForegroundColor Gray
Write-Host "   * Keep a separate Administrator account for staff. Do not lock that one down." -ForegroundColor Gray
Write-Host "   * In BIOS: set a supervisor password and disable USB/network boot." -ForegroundColor Gray
Write-Host "     Without that, a player with a USB stick walks around all of this." -ForegroundColor DarkGray
Write-Host ""
Write-Host "  To reverse everything: .\Uninstall-SeikaKiosk.ps1" -ForegroundColor White
Write-Host ""
