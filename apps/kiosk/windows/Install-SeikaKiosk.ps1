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
  [switch]$SkipKeyboard,

  # Per-PC settings. Pass these and the script writes the config for you;
  # leave them out and it expects C:\ProgramData\SEIKA\config.js to exist.
  # pcId and clientKey come from the zone console, and differ on every machine.
  [string]$ApiUrl,
  [string]$PcId,
  [string]$ClientKey,
  # Where the player app is served. The QR on the lock screen encodes a link
  # to it, so a phone's own camera can scan it.
  [string]$PlayerUrl,
  [string]$ZoneName = "SEIKA",
  [string]$StaffEscapeCode,

  # Ctrl+Alt+Del keeps its menu unless you ask for it to be stripped. It is
  # the last way back into a machine that is misbehaving, and it should be
  # the last thing taken away — once the rest is proven on real hardware.
  [switch]$LockCtrlAltDel,

  # Skip the lockdown policies entirely (leaves only the kiosk app itself).
  [switch]$NoHarden,

  # Replace the Windows shell with SEIKA for the player account: no desktop,
  # no taskbar, no Explorer at all. This is what "the desktop is cut off"
  # actually requires — policies only hide things that are still running.
  #
  # Read §SHELL at the end before using it. If SEIKA will not start, that
  # account has no shell, and the way back is another account or Safe Mode.
  [switch]$KioskShell,

  # The account the player signs in as. Needed for -KioskShell, because the
  # shell is per-user and setting it machine-wide would lock staff out too.
  [string]$PlayerAccount
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

# ─── 0. Per-PC config ────────────────────────────────────────────────────────
# Not in the installed program directory: that is inside app.asar and read
# only. ProgramData is writable by this admin install, readable by the player
# account, and survives an app update.

$configDir  = Join-Path $env:ProgramData "SEIKA"
$configFile = Join-Path $configDir "config.js"

if ($ApiUrl -and $PcId -and $ClientKey) {
  Write-Step "Writing $configFile"
  New-Item -Path $configDir -ItemType Directory -Force | Out-Null

  $escapeLine = ""
  if ($StaffEscapeCode) {
    # Stored as a SHA-256 hash so the plain code is not sitting on a machine
    # players use. The kiosk accepts either, and prefers the hash.
    $sha  = [System.Security.Cryptography.SHA256]::Create()
    $hash = ($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($StaffEscapeCode)) |
             ForEach-Object { $_.ToString("x2") }) -join ""
    $escapeLine = "  staffEscapeCodeHash: `"$hash`","
  }

  @"
// Generated by Install-SeikaKiosk.ps1 — this machine only.
window.SEIKA_CONFIG = {
  apiUrl: "$ApiUrl",
  wsUrl: "$ApiUrl",
  pcId: "$PcId",
  clientKey: "$ClientKey",
  playerUrl: "$(if ($PlayerUrl) { $PlayerUrl } else { $ApiUrl })",
  zoneName: "$ZoneName",
$escapeLine
  gameRoots: {},
};
"@ | Set-Content -Path $configFile -Encoding UTF8

  # The player account must read it; it must not be able to rewrite it.
  icacls $configFile /inheritance:r /grant:r "BUILTIN\Administrators:(F)" "BUILTIN\Users:(R)" "SYSTEM:(F)" | Out-Null
  Write-Ok "config written and locked to read-only for players"
}
elseif (-not (Test-Path $configFile)) {
  throw @"
No config found at $configFile, and no -ApiUrl/-PcId/-ClientKey given.

Each PC needs its own pcId and clientKey from the zone console. Example:

  .\Install-SeikaKiosk.ps1 ``
    -ApiUrl "http://your-server" ``
    -PcId "<from the console>" ``
    -ClientKey "<from the console>" ``
    -ZoneName "Your Zone" ``
    -StaffEscapeCode "1234"
"@
}
else {
  Write-Ok "using the existing $configFile"
}

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
if ($LockCtrlAltDel) {
  Set-ItemProperty -Path $policySystem -Name "DisableChangePassword"  -Value 1 -Type DWord
  Set-ItemProperty -Path $policySystem -Name "DisableLockWorkstation" -Value 1 -Type DWord
  Set-ItemProperty -Path $policySystem -Name "HideFastUserSwitching"  -Value 1 -Type DWord
  Write-Ok "Ctrl+Alt+Del stripped"
} else {
  # Deliberately left working. Pass -LockCtrlAltDel once the rest is proven.
  Remove-ItemProperty -Path $policySystem -Name "DisableChangePassword"  -ErrorAction SilentlyContinue
  Remove-ItemProperty -Path $policySystem -Name "DisableLockWorkstation" -ErrorAction SilentlyContinue
  Remove-ItemProperty -Path $policySystem -Name "HideFastUserSwitching"  -ErrorAction SilentlyContinue
  Write-Warn "Ctrl+Alt+Del left working — pass -LockCtrlAltDel to remove it"
}

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

# ─── 4b. Lockdown ────────────────────────────────────────────────────────────
#
# Everything below is a policy on the machine, and every one of them can be
# undone by an administrator in two minutes. They are worth setting because
# the player account is NOT an administrator — and if it is, none of this is
# protecting anything. That is checked, loudly, at the end.

if (-not $NoHarden) {
  Write-Step "Closing the usual ways out"

  # Run, cmd, PowerShell, the registry editor, Control Panel, Settings. These
  # are the routes someone reaches for first, and none of them is needed to
  # play a game.
  Set-ItemProperty -Path $policyExplorer -Name "NoRun"               -Value 1 -Type DWord
  Set-ItemProperty -Path $policyExplorer -Name "NoControlPanel"      -Value 1 -Type DWord
  Set-ItemProperty -Path $policyExplorer -Name "NoFind"              -Value 1 -Type DWord
  Set-ItemProperty -Path $policyExplorer -Name "NoViewContextMenu"   -Value 1 -Type DWord
  Set-ItemProperty -Path $policyExplorer -Name "NoTrayContextMenu"   -Value 1 -Type DWord
  Set-ItemProperty -Path $policyExplorer -Name "NoSetTaskbar"        -Value 1 -Type DWord
  Set-ItemProperty -Path $policySystem   -Name "DisableCMD"          -Value 2 -Type DWord
  Set-ItemProperty -Path $policySystem   -Name "DisableRegistryTools" -Value 1 -Type DWord
  Write-Ok "Run, cmd, registry editor and Control Panel closed"

  # Named programs refused outright. A blocklist, not a whitelist: a whitelist
  # would also have to name every game and every launcher a zone installs, and
  # the first one missed is a PC nobody can play on.
  $disallow = "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\Explorer\DisallowRun"
  New-Item -Path $disallow -Force | Out-Null
  Set-ItemProperty -Path $policyExplorer -Name "DisallowRun" -Value 1 -Type DWord
  $blocked = @(
    "powershell.exe", "powershell_ise.exe", "pwsh.exe", "cmd.exe",
    "regedit.exe", "regedt32.exe", "mmc.exe", "gpedit.msc",
    "taskmgr.exe", "msconfig.exe", "control.exe", "cmstp.exe",
    "wscript.exe", "cscript.exe", "mshta.exe",
    "msiexec.exe",                       # no installers
    "bitsadmin.exe", "certutil.exe",     # common download-anything tools
    "ftp.exe", "curl.exe", "wget.exe"
  )
  for ($i = 0; $i -lt $blocked.Count; $i++) {
    Set-ItemProperty -Path $disallow -Name ($i + 1) -Value $blocked[$i] -Type String
  }
  Write-Ok "$($blocked.Count) programs blocked by name"

  # Nothing leaves on a USB stick, and nothing arrives on one either.
  $storage = "HKLM:\SYSTEM\CurrentControlSet\Control\StorageDevicePolicies"
  New-Item -Path $storage -Force | Out-Null
  Set-ItemProperty -Path $storage -Name "WriteProtect" -Value 1 -Type DWord
  Write-Ok "USB storage is read-only"

  # Nothing that ends the session from the inside: no sign out, no shutdown
  # menu, no lock. A player who can log off is a player who can reach another
  # account, and a PC that can be restarted mid-session is a session nobody
  # can account for.
  Set-ItemProperty -Path $policyExplorer -Name "NoClose"              -Value 1 -Type DWord
  Set-ItemProperty -Path $policyExplorer -Name "NoLogoff"             -Value 1 -Type DWord
  Set-ItemProperty -Path $policyExplorer -Name "StartMenuLogOff"      -Value 1 -Type DWord
  Set-ItemProperty -Path $policyExplorer -Name "NoFolderOptions"      -Value 1 -Type DWord
  Set-ItemProperty -Path $policyExplorer -Name "NoDesktop"            -Value 1 -Type DWord
  Set-ItemProperty -Path $policyExplorer -Name "NoDriveTypeAutoRun"   -Value 255 -Type DWord
  # Every drive hidden in Explorer: 0x3FFFFFF is A through Z.
  Set-ItemProperty -Path $policyExplorer -Name "NoDrives"             -Value 67108863 -Type DWord
  Set-ItemProperty -Path $policyExplorer -Name "NoViewOnDrive"        -Value 67108863 -Type DWord
  Write-Ok "sign out, shutdown, desktop and drives closed off"

  # No installing anything, for anyone who is not an administrator.
  $installer = "HKLM:\SOFTWARE\Policies\Microsoft\Windows\Installer"
  New-Item -Path $installer -Force | Out-Null
  Set-ItemProperty -Path $installer -Name "DisableMSI" -Value 2 -Type DWord
  Write-Ok "installers blocked for non-administrators"
}

# ─── 4c. Shell replacement ───────────────────────────────────────────────────
#
# Policies hide the desktop. This removes it: Windows starts SEIKA instead of
# explorer.exe for that account, so there is no taskbar, no Start menu, no
# file manager and nothing behind the kiosk to alt-tab to.
#
# Per-user, not machine-wide: staff and administrators keep a normal desktop
# on their own accounts, which is also the way back if this goes wrong.

if ($KioskShell) {
  if (-not $PlayerAccount) {
    throw "-KioskShell needs -PlayerAccount <name>: the shell is set per user, and setting it for everyone would lock staff out too."
  }

  $acct = Get-LocalUser -Name $PlayerAccount -ErrorAction SilentlyContinue
  if (-not $acct) { throw "No local account called '$PlayerAccount'." }

  Write-Step "Making SEIKA the shell for $PlayerAccount"

  # Written under that user's own hive, which has to be loaded if they are
  # not signed in — HKU\<SID> only exists while a session is open.
  $sid = $acct.SID.Value
  $hive = "Registry::HKEY_USERS\$sid"
  $loaded = Test-Path $hive
  if (-not $loaded) {
    $dat = Join-Path (Join-Path $env:SystemDrive "Users\$PlayerAccount") "NTUSER.DAT"
    if (-not (Test-Path $dat)) {
      throw "Cannot reach $PlayerAccount's registry. Sign in as that account once, sign out, then run this again."
    }
    reg load "HKU\$sid" "$dat" | Out-Null
  }

  $winlogon = "$hive\Software\Microsoft\Windows NT\CurrentVersion\Winlogon"
  New-Item -Path $winlogon -Force | Out-Null
  Set-ItemProperty -Path $winlogon -Name "Shell" -Value $exe -Type String

  if (-not $loaded) { [gc]::Collect(); reg unload "HKU\$sid" | Out-Null }
  Write-Ok "SEIKA is the shell — that account has no desktop to return to"
}

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
# ─── The thing that decides whether any of this matters ──────────────────────
#
# Every policy above lives in the registry, and an administrator can undo all
# of them from the machine in about two minutes. They are only a lock if the
# account the player uses is a standard user. If it is not, this script has
# given you the appearance of a locked PC and nothing else, and it is worth
# saying so plainly rather than letting a zone find out the expensive way.

Write-Host ""
$admins = @()
try {
  $admins = Get-LocalGroupMember -Group "Administrators" -ErrorAction Stop |
            Where-Object { $_.ObjectClass -eq "User" } |
            ForEach-Object { $_.Name }
} catch {
  Write-Warn "Could not read the Administrators group — check it by hand."
}

$me = "$env:COMPUTERNAME\$env:USERNAME"
$playerLooksAdmin = $admins | Where-Object { $_ -notmatch "Administrator$" -and $_ -ne $me }

if ($playerLooksAdmin) {
  Write-Host "  ! These accounts are administrators:" -ForegroundColor Yellow
  $playerLooksAdmin | ForEach-Object { Write-Host "      $_" -ForegroundColor Yellow }
  Write-Host ""
  Write-Host "  If a player signs in with one of those, everything this script" -ForegroundColor Yellow
  Write-Host "  just set can be undone from the machine. Make the player account" -ForegroundColor Yellow
  Write-Host "  a Standard user:" -ForegroundColor Yellow
  Write-Host "      Remove-LocalGroupMember -Group Administrators -Member '<name>'" -ForegroundColor DarkGray
} else {
  Write-Ok "no extra administrator accounts found"
}

if ($KioskShell) {
  Write-Host ""
  Write-Host "  SHELL — read this before you walk away" -ForegroundColor Yellow
  Write-Host "    $PlayerAccount has no desktop now. If SEIKA does not start," -ForegroundColor Yellow
  Write-Host "    that account has nothing at all: no taskbar, no Explorer, no" -ForegroundColor Yellow
  Write-Host "    way to launch anything." -ForegroundColor Yellow
  Write-Host ""
  Write-Host "    Test it before the PC goes on the floor: sign in as" -ForegroundColor Yellow
  Write-Host "    $PlayerAccount and confirm SEIKA comes up." -ForegroundColor Yellow
  Write-Host ""
  Write-Host "    The way back is an administrator account, which still has a" -ForegroundColor DarkGray
  Write-Host "    normal desktop, or Safe Mode. Then:" -ForegroundColor DarkGray
  Write-Host "      Uninstall-SeikaKiosk.ps1 -PlayerAccount $PlayerAccount" -ForegroundColor DarkGray
  Write-Host ""
}

Write-Host ""
Write-Host "  Not covered by any of this:" -ForegroundColor DarkGray
Write-Host "    - booting from USB or into Safe Mode. Set a BIOS password and" -ForegroundColor DarkGray
Write-Host "      disable USB boot; nothing in Windows can stop it." -ForegroundColor DarkGray
Write-Host "    - a player deleting their own documents. Games need to write," -ForegroundColor DarkGray
Write-Host "      so the profile cannot be made read-only." -ForegroundColor DarkGray
if (-not $LockCtrlAltDel) {
  Write-Host "    - Ctrl+Alt+Del, left working on purpose. Add -LockCtrlAltDel" -ForegroundColor DarkGray
  Write-Host "      once you have tested the rest." -ForegroundColor DarkGray
}

Write-Host ""
