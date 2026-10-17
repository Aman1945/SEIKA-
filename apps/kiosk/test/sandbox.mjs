/**
 * Stands up everything drive-lock-check.mjs needs, from nothing.
 *
 * The lock check used to depend on a hand-made /tmp/kiosk-seed.json and a
 * hand-edited config.js, which meant it could only be run once, by whoever had
 * just made those files. This rebuilds them, so the check is repeatable.
 *
 * It starts its own in-memory MongoDB REPLICA SET rather than using the local
 * mongod. SEIKA commits every money path in a transaction, and a standalone
 * mongod — which is what Homebrew installs by default — fails all of them. The
 * session authorize in the lock check is one of those paths, so a standalone
 * would fail at step 2 for a reason that has nothing to do with the kiosk.
 *
 *   node apps/kiosk/test/sandbox.mjs
 *
 * Leaves the API on :4000 and the kiosk on CDP :9333, then waits. Ctrl-C tears
 * both down and throws the database away.
 */

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KIOSK = path.resolve(HERE, "..");
const ROOT = path.resolve(KIOSK, "../..");
const API_DIR = path.join(ROOT, "apps/api");

const log = (m) => console.log(`\x1b[36m▸\x1b[0m ${m}`);
const ok = (m) => console.log(`\x1b[32m  ✓\x1b[0m ${m}`);

const children = [];
function cleanup() {
  for (const c of children) {
    try { c.kill("SIGTERM"); } catch {}
  }
}
process.on("SIGINT", () => { cleanup(); process.exit(0); });
process.on("exit", cleanup);

/** Resolves a dependency that pnpm has hoisted somewhere under .pnpm. */
async function resolveFrom(dir, spec) {
  const { createRequire } = await import("node:module");
  const req = createRequire(path.join(dir, "package.json"));
  return req.resolve(spec);
}

// ─── 1. Database ─────────────────────────────────────────────────────────────

log("Starting an in-memory MongoDB replica set");
const mmsPath = await resolveFrom(API_DIR, "mongodb-memory-server");
const { MongoMemoryReplSet } = await import(mmsPath);

const replset = await MongoMemoryReplSet.create({
  replSet: { count: 1, storageEngine: "wiredTiger" },
});
const mongoUri = replset.getUri("seika");
ok(`replica set up — transactions available`);

// ─── 2. Seed a zone, an owner and a PC ───────────────────────────────────────

log("Seeding a zone, an owner and one PC");

// Through the API's own compiled models, not raw collection inserts. The
// schemas carry required fields — a PC needs a branchId and an hourlyRate —
// and hand-written documents drift from them silently: the insert succeeds and
// the first save() on that document fails validation instead.

const mongoosePath = await resolveFrom(API_DIR, "mongoose");
const mongoose = (await import(mongoosePath)).default;
await mongoose.connect(mongoUri);

const { Zone, Branch } = await import(path.join(API_DIR, "dist/models/Zone.js"));
const { PC } = await import(path.join(API_DIR, "dist/models/PC.js"));
const { StaffUser } = await import(path.join(API_DIR, "dist/models/StaffUser.js"));

const clientKey = `sandbox-${crypto.randomBytes(6).toString("hex")}`;
const staffEscapeCode = "4242";
const hourlyRate = 60;

const owner = await StaffUser.create({
  role: "ZONE_OWNER",
  name: "Sandbox Owner",
  email: "owner@sandbox.local",
});
const zone = await Zone.create({
  ownerId: owner._id,
  name: "SEIKA Sandbox Zone",
  country: "India",
  city: "Mumbai",
  verified: true,
});
owner.set("zoneId", zone._id);
await owner.save();

const branch = await Branch.create({ zoneId: zone._id, name: "Main Branch" });
const pc = await PC.create({
  zoneId: zone._id,
  branchId: branch._id,
  pcNumber: "PC-01",
  hourlyRate: mongoose.Types.Decimal128.fromString(hourlyRate.toFixed(2)),
  category: "standard",
  clientKey,
});

const ownerId = owner._id;
const zoneId = zone._id;
const pcId = pc._id;

await mongoose.disconnect();
ok(`zone, owner and PC-01 seeded at ₹${hourlyRate}/hr`);

// ─── 3. The API ──────────────────────────────────────────────────────────────

log("Starting the API on :4000");

const jwtAccess = crypto.randomBytes(32).toString("hex");
const apiEnv = {
  ...process.env,
  NODE_ENV: "development",
  PORT: "4000",
  MONGO_URI: mongoUri,
  JWT_ACCESS_SECRET: jwtAccess,
  JWT_REFRESH_SECRET: crypto.randomBytes(32).toString("hex"),
  JWT_ACCESS_TTL: "6h", // long, so a slow manual run does not expire mid-check
  OTP_PROVIDER: "console",
  RATE_LIMIT_ENABLED: "false",
  CORS_ORIGINS: "http://localhost:3000,http://localhost:3001",
};

const api = spawn("node", ["dist/server.js"], {
  cwd: API_DIR,
  env: apiEnv,
  stdio: ["ignore", "pipe", "pipe"],
});
children.push(api);
api.stdout.on("data", (d) => process.stdout.write(`\x1b[90m  api  ${d}\x1b[0m`));
api.stderr.on("data", (d) => process.stderr.write(`\x1b[31m  api  ${d}\x1b[0m`));

async function waitForApi(timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch("http://localhost:4000/health");
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error("API did not come up — is apps/api built? (pnpm --filter @seika/api build)");
}
await waitForApi();
ok("API ready");

// ─── 4. An owner token ───────────────────────────────────────────────────────
//
// Minted directly rather than via a login flow: the sandbox owner has no OTP
// identity, and the point of this script is to get to the kiosk check.

// Signed by the API's own helper, with the API's own secret, so the token is
// minted exactly the way the server verifies it. Signing it by hand here would
// work until someone changed a claim, and then fail as a 401 that looks like a
// kiosk bug.
Object.assign(process.env, apiEnv);
const { signAccessToken } = await import(path.join(API_DIR, "dist/common/jwt.js"));

const ownerAccessToken = signAccessToken({
  sub: String(ownerId),
  typ: "staff",
  role: "ZONE_OWNER",
  zoneId: String(zoneId),
});

await fs.writeFile(
  "/tmp/kiosk-seed.json",
  JSON.stringify({ ownerAccessToken, pc: { id: String(pcId), clientKey }, zoneId: String(zoneId) }, null, 2)
);
ok("/tmp/kiosk-seed.json written");

// ─── 5. Point the kiosk at it ────────────────────────────────────────────────

await fs.writeFile(
  path.join(KIOSK, "config.js"),
  `// Generated by apps/kiosk/test/sandbox.mjs — not for production.
window.SEIKA_CONFIG = {
  apiUrl: "http://localhost:4000",
  wsUrl: "http://localhost:4000",
  pcId: ${JSON.stringify(String(pcId))},
  clientKey: ${JSON.stringify(clientKey)},
  zoneName: "SEIKA Sandbox Zone",
  staffToken: ${JSON.stringify(ownerAccessToken)},
  staffEscapeCode: ${JSON.stringify(staffEscapeCode)},
  gameRoots: {},
};
`
);
ok("apps/kiosk/config.js pointed at the sandbox");

// ─── 6. The kiosk ────────────────────────────────────────────────────────────

log("Launching the Electron kiosk with CDP on :9333");

// A kiosk left over from a previous run keeps the debug port. The new one
// still starts and still heartbeats, so everything looks healthy — but the
// lock check then attaches to the *old* kiosk, which is pointed at a database
// that no longer exists. Refuse rather than let that happen quietly.
try {
  const stale = await (await fetch("http://127.0.0.1:9333/json")).json();
  if (stale.length) {
    throw new Error(
      "Something is already on CDP :9333 — almost certainly a kiosk from an " +
        "earlier run.\n  Close it first:  pkill -f 'remote-debugging-port=9333'"
    );
  }
} catch (e) {
  if (!/ECONNREFUSED|fetch failed/i.test(String(e))) throw e;
  // Nothing listening, which is what we want.
}

const electronPath = await resolveFrom(KIOSK, "electron");
const electronBin = (await import(electronPath)).default;

const kiosk = spawn(electronBin, [KIOSK, "--remote-debugging-port=9333"], {
  cwd: KIOSK,
  env: { ...process.env, SEIKA_SANDBOX: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});
children.push(kiosk);
kiosk.stdout.on("data", (d) => process.stdout.write(`\x1b[90m kiosk ${d}\x1b[0m`));

async function waitForCdp(timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch("http://127.0.0.1:9333/json")).json();
      if (targets.some((t) => t.type === "page")) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("kiosk did not expose a CDP page target");
}
await waitForCdp();
ok("kiosk up and debuggable");

await fs.mkdir("/tmp/kioskshots", { recursive: true });

console.log(`
\x1b[32m━━━ Sandbox ready ━━━\x1b[0m

  In another terminal:

    node apps/kiosk/test/drive-lock-check.mjs

  Ctrl-C here tears it all down and throws the database away.
`);

// Hold the process open; the database lives in this process.
await new Promise(() => {});
