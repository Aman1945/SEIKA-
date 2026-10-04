# SEIKA PC Client (kiosk)

The Electron app on every gaming PC. It shows a lock screen with a QR code and
unlocks **only** when the server sends `command:unlock` — which the server only
sends after the Session Authorization Engine has accepted a payment source.

The kiosk never decides anything. It displays, it reports, and it obeys.

## Install on a gaming PC

```bash
cd apps/kiosk
cp config.example.js config.js    # fill pcId + clientKey from the zone console
pnpm install
pnpm start
```

`pcId` and `clientKey` come from the zone console when the PC is created. The
clientKey is that machine's identity — it is what lets the PC heartbeat and join
its own realtime room, so treat it as a password for the machine.

## What it does

| | |
|---|---|
| **Lock screen** | Fullscreen kiosk window, always on top, not closable. Locked is the resting state. |
| **QR** | Rendered locally with `qrcode` and refreshed every 40s against a 60s server TTL, with the countdown visible. A stale code is shown as stale rather than silently failing when someone scans it. |
| **Heartbeat** | Every 20s, authenticated by clientKey. Its absence is what tells the dashboard a PC is offline, so it runs independently of the socket — the two fail separately. |
| **Commands** | `unlock`, `lock`, `restart`, `shutdown`, `maintenance`. Anything unrecognised changes nothing. |
| **Smart Sync** | Restores a player's game settings before play and saves them after, within the folders the *server* allows. |

## Failing safe

Locked is what happens when anything is unclear: no config, a bad clientKey, no
network, an unknown command. A kiosk that fails open is a kiosk that gives away
free play, so every uncertain path ends in a locked screen with the reason on
it rather than an unlocked PC nobody can account for.

A wrong clientKey is shown on screen instead of retried silently — otherwise a
misconfigured install looks exactly like a quiet one.

## Smart Sync, and why the policy is not here

The kiosk enumerates candidate files and asks the API to screen them. Only paths
the API allowed are read, and only those are written back. It keeps no allow-list
of its own: a second copy of that policy is a second place for it to be wrong,
and wrong here means uploading a player's browser cookies or writing into an
anti-cheat folder and getting them banned.

Downloaded bundles are re-screened before being written, so a config stored under
an older, wider policy cannot write somewhere the current policy forbids. Writes
go to a temp file and are renamed — a half-written config is worse than an old
one, and a game may be reading it.

Set `gameRoots` in `config.js` to where each game keeps its settings on that
machine. A game not listed is never considered.

## Running it on Windows

### 1. Install the app

Build the installer (from any OS — electron-builder cross-builds):

```bash
pnpm --filter @seika/kiosk dist     # → dist/SEIKA Setup 0.1.0.exe
```

Copy it to the gaming PC and run it. It installs per-machine to
`C:\Program Files\SEIKA`. Windows SmartScreen will warn, because the build is
unsigned — "More info" then "Run anyway". Buy a code-signing certificate before
you roll this out to a zone, or staff will be clicking past that warning on
every PC and will stop reading it.

### 2. Point it at the zone

```powershell
cd "C:\Program Files\SEIKA\resources\app"
copy config.example.js config.js
notepad config.js
```

Fill in `apiUrl`, `pcId` and `clientKey` from the zone console, and set
`staffEscapeCodeHash` (see below).

### 3. Lock the machine down

```powershell
cd "C:\Program Files\SEIKA\resources\windows"
.\Install-SeikaKiosk.ps1
```

from an **Administrator** PowerShell. Then reboot.

## Why the lock is shaped this way

Electron on its own does not hold a Windows PC. `globalShortcut` cannot stop
the Windows key, cannot stop Task Manager, and **nothing in user space can stop
Ctrl+Alt+Del** — it is a secure attention sequence, and any product claiming
otherwise is lying to you. A player gets behind an Electron-only lock screen in
about a minute.

So the real lock is Windows policy, applied by `Install-SeikaKiosk.ps1`:

| Escape | What stops it |
|---|---|
| End the process in Task Manager | Task Manager disabled by policy |
| Ctrl+Alt+Del → Task Manager / sign out / switch user | Every option on that screen removed, so the combination leads nowhere |
| Windows key → Start menu | Both Win keys mapped out at the keyboard driver (needs a reboot; an app-level hook loses the race against the shell) |
| Alt+Tab, Alt+F4, Win+D and friends | Blocked by the app while it has focus |
| Kill it some other way | Watchdog relaunches it within a minute |
| A game or updater steals focus | The lock screen re-asserts itself every second |
| Boot a USB stick | **BIOS supervisor password — set this yourself.** Nothing in software can stop it. |

### Why not Assigned Access or shell replacement

Those are the usual answers for a kiosk and both are wrong here. Assigned
Access allows exactly one application, and shell replacement removes the
desktop entirely — a gaming PC has to let the player launch games once they
have paid. So explorer keeps running and SEIKA is an always-on-top overlay
Windows will not let them dismiss.

## The staff escape

`Ctrl+Alt+Shift+U` on the lock screen asks for a code and unlocks the PC for
maintenance.

This is a backdoor and it is there on purpose. Without it, a zone whose network
drops has every PC locked with no way in — the kiosk cannot ask the server for
permission at precisely the moment it most needs to. That failure mode is worse
than the risk, provided the risk stays bounded:

- The code is set per zone in `config.js` and never ships in the build.
- Prefer the hash, so the plain code is not sitting on a gaming PC:
  ```bash
  node -e "console.log(require('crypto').createHash('sha256').update('YOUR-CODE').digest('hex'))"
  ```
- Every use is written to the zone's audit log — immediately when online, and
  on the next heartbeat when it was used during an outage. Staff cannot use it
  quietly.
- It unlocks for maintenance only. It starts no session, bills nobody and
  awards no XP, so it cannot hand out free play that looks paid.

**Rotate it when a staff member leaves.**

## Undoing it

```powershell
.\Uninstall-SeikaKiosk.ps1
```

Reverses every policy, task and key mapping. A lockdown you cannot undo is a
bricked PC, so this is deliberately tolerant — each step is independent and a
half-applied install still comes all the way back.

If a PC is locked and you cannot reach PowerShell at all, boot into **Safe
Mode**: the scheduled tasks do not run there, so you get a normal desktop and
an Administrator prompt.

## Also do these by hand

- Player account: auto-login, **no administrator rights**.
- A separate Administrator account for staff, which you do not lock down.
- BIOS: supervisor password, and disable USB and network boot.

## Tests

```bash
pnpm --filter @seika/kiosk test
```

Plain `node --test`, no Electron and no display, because the part worth testing
is the part that touches a player's files: that it reads only what the server
allowed, refuses paths that escape the game directory, and leaves nothing
half-written. Those run in CI.

## Still to do before a pilot

- Run it on real Windows hardware. Nothing here has been exercised on Windows,
  and the plan (§11) is explicit that kiosk behaviour must be tested there and
  not simulated through the API.
- Camera QR scanning is on the player's phone, not here; the lock screen only
  displays the code.
- Signed installer: `pnpm dist` produces an NSIS installer but it is unsigned,
  so Windows will warn on first run.
