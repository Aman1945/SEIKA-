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

## Hard lock on Windows

The Electron window covers the screen and blocks the usual escapes (Alt+Tab,
Win, Alt+F4, Ctrl+Shift+Esc, F11). That is not enough on its own —
**Ctrl+Alt+Del cannot be blocked from user space.** Production needs one of:

- **Assigned Access (Kiosk mode)** — Windows Pro/Enterprise, built in. Set SEIKA
  as the kiosk app. Simplest and the most robust.
- **Shell replacement** — set the app as the Windows shell so `explorer.exe`
  never loads: `HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon\Shell`.
  No desktop, no taskbar.

Either way, add:
- auto-start at boot,
- a watchdog service that relaunches the app if it exits,
- a local Administrator account for staff that is *not* the kiosk account.

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
