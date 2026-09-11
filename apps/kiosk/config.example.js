// Copy to config.js on each gaming PC. These come from the Zone OS when the PC
// is created/paired (dev seed returns pc.id + pc.clientKey).
window.SEIKA_CONFIG = {
  apiUrl: "http://ZONE-LAPTOP-IP:4000", // Zone OS REST API
  wsUrl: "http://ZONE-LAPTOP-IP:4000", // Socket.IO (same host)
  pcId: "PUT_PC_ID_HERE",
  clientKey: "PUT_PC_CLIENT_KEY_HERE",
};
