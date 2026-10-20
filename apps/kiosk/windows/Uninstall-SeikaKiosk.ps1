<#
.SYNOPSIS
  Reverses everything Install-SeikaKiosk.ps1 did.

.DESCRIPTION
  A lockdown you cannot undo is a bricked PC. This removes every policy, task
  and key mapping the installer set, and it is deliberately tolerant: each step
  is independent, so a half-applied install still comes all the way back.

  Run this before servicing a PC, reimaging it, or selling it on.

.EXAMPLE
  .\Uninstall-SeikaKiosk.ps1

.NOTES
  Run as Administrator. If the PC is locked and you cannot reach PowerShell,
  boot into Safe Mode — the kiosk's scheduled tasks do not run there — and run
  this from an Administrator prompt.
#>

[CmdletBinding()]
param(
  [switch]$KeepFiles,
  # The account -KioskShell was applied to, so its desktop can be given back.
  [string]$PlayerAccount
)

function Write-Step { param($m) Write-Host "  $m" -ForegroundColor Cyan }
function Write-Ok   { param($m) Write-Host "  $m" -ForegroundColor Green }
function Try-Step {
  param([string]$Label, [scriptblock]$Action)
  Write-Step $Label
  try { & $Action } catch { Write-Host "    (skipped: $($_.Exception.Message))" -ForegroundColor DarkGray }
}

if (-not ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
    ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "Run this from an Administrator PowerShell."
}

Write-Host ""
Write-Host "Removing the SEIKA kiosk lockdown" -ForegroundColor White
Write-Host "─────────────────────────────────" -ForegroundColor DarkGray

$policySystem   = "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System"
$policyExplorer = "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\Explorer"

Try-Step "Re-enabling Task Manager" {
  Remove-ItemProperty -Path $policySystem -Name "DisableTaskMgr" -ErrorAction SilentlyContinue
}

Try-Step "Restoring the Ctrl+Alt+Del screen" {
  foreach ($n in "DisableChangePassword", "DisableLockWorkstation", "HideFastUserSwitching") {
    Remove-ItemProperty -Path $policySystem -Name $n -ErrorAction SilentlyContinue
  }
  foreach ($n in "NoLogoff", "NoRun") {
    Remove-ItemProperty -Path $policyExplorer -Name $n -ErrorAction SilentlyContinue
  }
}

Try-Step "Giving back the Windows shell" {
  # Without this the account starts SEIKA and nothing else, for ever. It is
  # first in the list on purpose: a machine that cannot reach its own desktop
  # is worse than one that still has a kiosk on it.
  $accounts = @()
  if ($PlayerAccount) { $accounts = @($PlayerAccount) }
  else { $accounts = (Get-LocalUser | Where-Object { $_.Enabled }).Name }

  foreach ($a in $accounts) {
    $u = Get-LocalUser -Name $a -ErrorAction SilentlyContinue
    if (-not $u) { continue }
    $sid = $u.SID.Value
    $hive = "Registry::HKEY_USERS\$sid"
    $loaded = Test-Path $hive
    if (-not $loaded) {
      $dat = Join-Path (Join-Path $env:SystemDrive "Users\$a") "NTUSER.DAT"
      if (-not (Test-Path $dat)) { continue }
      reg load "HKU\$sid" "$dat" 2>$null | Out-Null
    }
    $winlogon = "$hive\Software\Microsoft\Windows NT\CurrentVersion\Winlogon"
    $shell = (Get-ItemProperty -Path $winlogon -Name "Shell" -ErrorAction SilentlyContinue).Shell
    if ($shell -and $shell -like "*SEIKA*") {
      # Removed rather than set to explorer.exe: with no value Windows falls
      # back to the machine default, which is what a normal account has.
      Remove-ItemProperty -Path $winlogon -Name "Shell" -ErrorAction SilentlyContinue
      Write-Host "    restored the desktop for $a" -ForegroundColor DarkGray
    }
    if (-not $loaded) { [gc]::Collect(); reg unload "HKU\$sid" 2>$null | Out-Null }
  }
}

Try-Step "Undoing the lockdown" {
  # Everything 4b set. A kiosk that cannot be fully removed is worse than one
  # that was never installed — the machine has to come back as it was.
  foreach ($n in "NoControlPanel", "NoFind", "NoViewContextMenu",
                 "NoTrayContextMenu", "NoSetTaskbar", "DisallowRun",
                 "NoClose", "StartMenuLogOff", "NoFolderOptions", "NoDesktop",
                 "NoDriveTypeAutoRun", "NoDrives", "NoViewOnDrive") {
    Remove-ItemProperty -Path $policyExplorer -Name $n -ErrorAction SilentlyContinue
  }
  foreach ($n in "DisableCMD", "DisableRegistryTools") {
    Remove-ItemProperty -Path $policySystem -Name $n -ErrorAction SilentlyContinue
  }
  Remove-Item -Path "$policyExplorer\DisallowRun" -Recurse -Force -ErrorAction SilentlyContinue
  Remove-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Control\StorageDevicePolicies" `
    -Name "WriteProtect" -ErrorAction SilentlyContinue
  Remove-ItemProperty -Path "HKLM:\SOFTWARE\Policies\Microsoft\Windows\Installer" `
    -Name "DisableMSI" -ErrorAction SilentlyContinue
}

Try-Step "Restoring the Windows keys (takes effect after a reboot)" {
  Remove-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Control\Keyboard Layout" `
    -Name "Scancode Map" -ErrorAction SilentlyContinue
}

Try-Step "Removing the scheduled tasks" {
  foreach ($t in "SEIKA Kiosk", "SEIKA Kiosk Watchdog") {
    Unregister-ScheduledTask -TaskName $t -Confirm:$false -ErrorAction SilentlyContinue
  }
}

Try-Step "Restoring power settings" {
  powercfg /change standby-timeout-ac 30
  powercfg /change monitor-timeout-ac 15
}

Try-Step "Stopping the kiosk if it is running" {
  Get-Process -Name "SEIKA" -ErrorAction SilentlyContinue | Stop-Process -Force
}

Write-Host ""
Write-Ok "Lockdown removed. Reboot to restore the Windows keys."
if (-not $KeepFiles) {
  Write-Host "  The application itself is still installed; uninstall it from Apps & Features." -ForegroundColor Gray
}
Write-Host ""
