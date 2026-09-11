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

  // Where each game keeps its settings on THIS machine. Only games listed here
  // are considered for Smart Sync, and even then the server decides which
  // folders inside them may actually sync.
  gameRoots: {
    // Valorant: "C:/Users/Player/Documents/My Games/Valorant",
    // CS2: "C:/Program Files (x86)/Steam/userdata",
  },
};
