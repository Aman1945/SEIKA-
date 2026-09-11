# SEIKA PC Client (Kiosk)

Electron app installed on every gaming PC. Shows a fullscreen lock screen with a
QR code; unlocks **only** when the Zone OS backend sends `command:unlock` (after
payment/booking authorization). Re-locks on `command:lock` / session end.

## Run (on a Windows gaming PC)
```bash
cd apps/kiosk
cp config.example.js config.js   # fill pcId + clientKey (from Zone OS) + zone IP
npm install
npm start
```

## How the Windows lock works
1. **Electron kiosk window** — `kiosk:true`, `alwaysOnTop`, frameless, not closable → covers everything.
2. **Escape keys blocked** — Alt+Tab, Win, Alt+F4, Ctrl+Shift+Esc via `globalShortcut`.
3. On `command:unlock` the app releases kiosk + shortcuts and minimizes → player can use the PC/games.
   On session end the backend sends `command:lock` → fullscreen lock returns.

### Hard lock (production) — pick one
- **Windows Assigned Access (Kiosk mode)** — Pro/Enterprise built-in; set SEIKA as the kiosk app. Simplest + robust.
- **Shell replacement** — set the app as the Windows shell so `explorer.exe` never loads
  (registry `HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon\Shell`). No desktop/taskbar at all.
- **Ctrl+Alt+Del** cannot be blocked from user space — use Assigned Access or a keyboard-filter driver.
- Auto-start on boot + a watchdog service that relaunches the app if it exits.

## Notes
- Socket.IO client is loaded from the API host (`/socket.io/socket.io.js`) — no extra dependency.
- QR image currently uses a public renderer; **bundle a local QR lib** (e.g. `qrcode`) for offline LAN before production.
- The unlock decision is 100% server-side (Session Authorization Engine). The kiosk only obeys commands.
