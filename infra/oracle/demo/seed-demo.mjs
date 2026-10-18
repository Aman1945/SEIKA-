/**
 * Fills the demo deployment with something worth looking at.
 *
 * An empty SEIKA shows empty screens: no PCs on the map, no products in the
 * shop, no one on the leaderboard. Someone opening the demo would conclude the
 * product does nothing. This seeds a zone that looks like a Friday evening.
 *
 * Run ON the server — mongo is bound to loopback and is not reachable from
 * anywhere else, which is correct and not worth changing for a demo:
 *
 *   cd /opt/seika && sudo -u seika node infra/oracle/demo/seed-demo.mjs
 *
 * Idempotent: it keys everything off a fixed demo zone name and clears that
 * zone's own data before reseeding. It never touches anything outside it.
 */

import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";

const API_DIR = path.resolve(process.cwd(), "apps/api");
const req = createRequire(path.join(API_DIR, "package.json"));

const mongoose = (await import(req.resolve("mongoose"))).default;

const MONGO_URI =
  process.env.MONGO_URI ??
  "mongodb://127.0.0.1:27017/seika?replicaSet=rs0&directConnection=true";

await mongoose.connect(MONGO_URI);
console.log("connected");

const { Zone, Branch } = await import(path.join(API_DIR, "dist/models/Zone.js"));
const { PC } = await import(path.join(API_DIR, "dist/models/PC.js"));
const { StaffUser } = await import(path.join(API_DIR, "dist/models/StaffUser.js"));
const { Product } = await import(path.join(API_DIR, "dist/models/Product.js"));
const { Player } = await import(path.join(API_DIR, "dist/models/Player.js"));
const { WalletLedger } = await import(path.join(API_DIR, "dist/models/WalletLedger.js"));

const D = (n) => mongoose.Types.Decimal128.fromString(Number(n).toFixed(2));
const ZONE_NAME = "SEIKA Demo Zone";

// ─── Clear only this zone ────────────────────────────────────────────────────

const existing = await Zone.findOne({ name: ZONE_NAME });
if (existing) {
  const zoneId = existing._id;
  for (const M of [PC, Product, Branch, StaffUser]) {
    await M.deleteMany({ zoneId });
  }
  const demoPlayers = await Player.find({ zoneId }).select("_id").lean();
  await WalletLedger.deleteMany({ playerId: { $in: demoPlayers.map((p) => p._id) } });
  await Player.deleteMany({ zoneId });
  await Zone.deleteOne({ _id: zoneId });
  console.log("cleared the previous demo zone");
}

// ─── The zone ────────────────────────────────────────────────────────────────

const owner = await StaffUser.create({
  role: "ZONE_OWNER",
  name: "Demo Owner",
  email: `demo-owner-${crypto.randomBytes(4).toString("hex")}@seika.demo`,
});

const zone = await Zone.create({
  ownerId: owner._id,
  name: ZONE_NAME,
  country: "India",
  city: "Mumbai",
  verified: true,
});
owner.set("zoneId", zone._id);
await owner.save();

const branch = await Branch.create({ zoneId: zone._id, name: "Andheri Branch" });

// ─── PCs ─────────────────────────────────────────────────────────────────────
//
// A believable floor: a few tiers at different rates, and a mix of statuses so
// the PC map is not a wall of identical green tiles.

const RIGS = [
  { n: "PC-01", cat: "standard", rate: 60, gpu: "GTX 1660 Super" },
  { n: "PC-02", cat: "standard", rate: 60, gpu: "GTX 1660 Super" },
  { n: "PC-03", cat: "standard", rate: 60, gpu: "GTX 1660 Super" },
  { n: "PC-04", cat: "premium", rate: 90, gpu: "RTX 3060" },
  { n: "PC-05", cat: "premium", rate: 90, gpu: "RTX 3060" },
  { n: "PC-06", cat: "premium", rate: 90, gpu: "RTX 3060" },
  { n: "VIP-01", cat: "vip", rate: 150, gpu: "RTX 4070" },
  { n: "VIP-02", cat: "vip", rate: 150, gpu: "RTX 4070" },
];
const STATUSES = ["AVAILABLE", "AVAILABLE", "AVAILABLE", "OCCUPIED", "OCCUPIED", "AVAILABLE", "OCCUPIED", "MAINTENANCE"];

const pcs = await PC.create(
  RIGS.map((r, i) => ({
    zoneId: zone._id,
    branchId: branch._id,
    pcNumber: r.n,
    category: r.cat,
    hourlyRate: D(r.rate),
    status: STATUSES[i],
    specs: { cpu: "Intel i5-12400F", gpu: r.gpu, ram: "16GB DDR4" },
    games: ["Valorant", "CS2", "GTA V", "Fortnite"],
    clientKey: `demo-${r.n.toLowerCase()}-${crypto.randomBytes(4).toString("hex")}`,
  }))
);

// ─── Shop ────────────────────────────────────────────────────────────────────

await Product.create([
  { zoneId: zone._id, branchId: branch._id, name: "Lays Classic", category: "snack", price: D(20), stockQty: 48 },
  { zoneId: zone._id, branchId: branch._id, name: "Doritos Nacho", category: "snack", price: D(40), stockQty: 24 },
  { zoneId: zone._id, branchId: branch._id, name: "Coca-Cola 500ml", category: "drink", price: D(40), stockQty: 60 },
  { zoneId: zone._id, branchId: branch._id, name: "Red Bull", category: "drink", price: D(125), stockQty: 18 },
  { zoneId: zone._id, branchId: branch._id, name: "Cold Coffee", category: "drink", price: D(60), stockQty: 30 },
  { zoneId: zone._id, branchId: branch._id, name: "Maggi", category: "snack", price: D(50), stockQty: 40 },
  // Low stock, so the dashboard's low-stock warning has something to show.
  { zoneId: zone._id, branchId: branch._id, name: "Gaming Mousepad", category: "accessory", price: D(350), stockQty: 2, lowStockThreshold: 5 },
  { zoneId: zone._id, branchId: branch._id, name: "3 Hour Pack", category: "package", price: D(150), isPackage: true, packageMinutes: 180, stockQty: 999 },
  { zoneId: zone._id, branchId: branch._id, name: "Weekend 5 Hour Pack", category: "package", price: D(240), isPackage: true, packageMinutes: 300, stockQty: 999 },
]);

// ─── Players ─────────────────────────────────────────────────────────────────
//
// With balances and XP, so the leaderboard and wallet screens are populated.
// Phone numbers are in the 999xxxxxxx demo range.

const NAMES = [
  ["Arjun Mehta", "arjun_ace", 9990000001, 1250, 8400],
  ["Riya Sharma", "riya_rush", 9990000002, 820, 7250],
  ["Kabir Singh", "kabir_clutch", 9990000003, 2100, 6900],
  ["Ananya Rao", "ananya_aim", 9990000004, 450, 5600],
  ["Dev Patel", "dev_dash", 9990000005, 180, 4100],
  ["Zara Khan", "zara_zap", 9990000006, 960, 3300],
  ["Rohan Gupta", "rohan_recoil", 9990000007, 75, 2050],
  ["Meera Nair", "meera_mvp", 9990000008, 1600, 1200],
];

for (const [name, username, phone, balance, xp] of NAMES) {
  const player = await Player.create({
    name,
    username,
    phone: String(phone),
    zoneId: zone._id,
    xpTotal: xp,
    otpVerified: true,
  });
  if (balance > 0) {
    // An opening balance is a real ledger row, not a number on the player.
    // Balance is SUM(ledger) everywhere in SEIKA, so a seeded figure that
    // skipped the ledger would show up and then vanish on the first spend.
    await WalletLedger.create({
      playerId: player._id,
      zoneId: zone._id,
      type: "TOPUP",
      method: "CASH",
      amount: D(balance),
      createdBy: String(owner._id),
      note: "Demo opening balance",
    });
  }
}

console.log(`
  zone      ${zone.name} (${zone.city})
  branch    ${branch.name}
  PCs       ${pcs.length}
  products  9
  players   ${NAMES.length}

  Demo is seeded. Anyone can sign in with any phone number — the staging
  server returns the OTP in the response, which is what makes the demo
  usable and exactly what must be turned off before real money.
`);

await mongoose.disconnect();
