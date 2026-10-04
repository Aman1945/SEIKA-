// Copy to config.js on each gaming PC.
//
// pcId and clientKey come from the zone console when the PC is created. The
// clientKey is this machine's identity: it is what lets the PC heartbeat and
// join its own realtime room, so treat it like a password for the machine.
window.SEIKA_CONFIG = {
  // The zone's API. On a LAN this is the zone laptop's address.
  apiUrl: "http://ZONE-HOST:4000",
  wsUrl: "http://ZONE-HOST:4000", // usually the same host

  pcId: "PUT_PC_ID_HERE",
  clientKey: "PUT_PC_CLIENT_KEY_HERE",

  // Shown on the lock screen.
  zoneName: "SEIKA",

  // Optional: a staff token, if this zone requires authentication to mint QR
  // tokens. Leave unset unless the console tells you to set it.
  staffToken: undefined,

  // ─── Staff escape ────────────────────────────────────────────────────────
  // Ctrl+Alt+Shift+U on the lock screen asks for this code and unlocks the PC
  // for maintenance.
  //
  // This exists because the alternative is worse: without it, a zone whose
  // network drops has every PC locked and no way in — the kiosk cannot ask the
  // server for permission exactly when it most needs to.
  //
  // It is still a backdoor, so: give it to staff only, rotate it when someone
  // leaves, and know that every use is written to the zone's audit log (sent
  // immediately when online, on the next heartbeat when it was used during an
  // outage). It unlocks for maintenance only — it starts no session, bills
  // nobody, and awards no XP.
  //
  // Prefer the hash so the plain code is not sitting on the gaming PC:
  //   node -e "console.log(require('crypto').createHash('sha256').update('YOUR-CODE').digest('hex'))"
  staffEscapeCodeHash: undefined,
  // Or, for a quick setup, the code itself:
  // staffEscapeCode: "1234",

  // Where each game keeps its settings on THIS machine. Only games listed here
  // are considered for Smart Sync, and even then the server decides which
  // folders inside them may actually sync.
  gameRoots: {
    // Valorant: "C:/Users/Player/Documents/My Games/Valorant",
    // CS2: "C:/Program Files (x86)/Steam/userdata",
  },
};
