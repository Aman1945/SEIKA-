"use strict";

/**
 * Smart Sync, disk side.
 *
 * These run under plain `node --test` — no Electron, no display — because the
 * part worth testing is the part that touches a player's files, and that must
 * be provable on any machine including CI.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");

const smartsync = require("../src/smartsync");

async function tempRoot(files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "seika-sync-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content);
  }
  return root;
}

test("enumerate finds files relative to the game root", async () => {
  const root = await tempRoot({
    "Config/GameUserSettings.ini": "sens=0.42",
    "Config/Telemetry/hwid.json": "{}",
    "Saved/Config/WindowsClient/Input.ini": "bind=x",
  });

  const found = await smartsync.enumerate(root);
  assert.deepEqual(
    found.sort(),
    ["Config/GameUserSettings.ini", "Config/Telemetry/hwid.json", "Saved/Config/WindowsClient/Input.ini"]
  );
});

test("enumerate skips caches and version-control noise", async () => {
  const root = await tempRoot({
    "Config/settings.ini": "a=1",
    "Config/cache/blob.bin": "junk",
    "node_modules/pkg/index.js": "x",
    ".git/HEAD": "ref",
  });

  const found = await smartsync.enumerate(root);
  assert.deepEqual(found, ["Config/settings.ini"]);
});

test("collect reads only the paths the server allowed", async () => {
  const root = await tempRoot({
    "Config/settings.ini": "keep me",
    "Config/Telemetry/hwid.json": "do not take this",
  });

  // The server allowed one of the two; the other must not be read at all.
  const { files } = await smartsync.collect(root, ["Config/settings.ini"]);

  assert.deepEqual(Object.keys(files), ["Config/settings.ini"]);
  assert.equal(Buffer.from(files["Config/settings.ini"], "base64").toString(), "keep me");
});

test("collect refuses a path that escapes the game directory", async () => {
  const root = await tempRoot({ "Config/settings.ini": "ok" });
  const secretDir = await fs.mkdtemp(path.join(os.tmpdir(), "seika-secret-"));
  await fs.writeFile(path.join(secretDir, "passwords.txt"), "hunter2");

  // Even if the server were somehow tricked into allowing it, the client will
  // not read outside the root it was given.
  const { files } = await smartsync.collect(root, [
    "../" + path.basename(secretDir) + "/passwords.txt",
  ]);

  assert.deepEqual(Object.keys(files), []);
});

test("collect skips a file larger than the per-file cap", async () => {
  const root = await tempRoot({
    "Config/settings.ini": "small",
    "Config/huge.bin": "x".repeat(smartsync.MAX_FILE_BYTES + 1),
  });

  const { files } = await smartsync.collect(root, ["Config/settings.ini", "Config/huge.bin"]);
  assert.deepEqual(Object.keys(files), ["Config/settings.ini"]);
});

test("apply writes only allowed paths and leaves the rest alone", async () => {
  const root = await tempRoot({ "Config/settings.ini": "old" });

  const bundle = {
    files: {
      "Config/settings.ini": Buffer.from("new").toString("base64"),
      "Config/Telemetry/hwid.json": Buffer.from("nope").toString("base64"),
    },
  };

  // The bundle was stored under an older policy; only what is allowed *now*
  // may be written.
  const written = await smartsync.apply(root, bundle, ["Config/settings.ini"]);

  assert.deepEqual(written, ["Config/settings.ini"]);
  assert.equal(await fs.readFile(path.join(root, "Config/settings.ini"), "utf8"), "new");
  await assert.rejects(() => fs.stat(path.join(root, "Config/Telemetry/hwid.json")));
});

test("apply refuses a traversal path inside a bundle", async () => {
  const root = await tempRoot({ "Config/settings.ini": "x" });
  const outside = path.join(root, "..", "escaped.txt");

  const written = await smartsync.apply(
    root,
    { files: { "../escaped.txt": Buffer.from("pwned").toString("base64") } },
    ["../escaped.txt"]
  );

  assert.deepEqual(written, []);
  await assert.rejects(() => fs.stat(outside));
});

test("apply leaves no temp file behind", async () => {
  const root = await tempRoot({});
  await smartsync.apply(
    root,
    { files: { "Config/new.ini": Buffer.from("v").toString("base64") } },
    ["Config/new.ini"]
  );

  const entries = await fs.readdir(path.join(root, "Config"));
  assert.deepEqual(entries, ["new.ini"]);
});

test("gameRoot honours a configured path over the default", () => {
  const configured = smartsync.gameRoot({ gameRoots: { Valorant: "D:/Games/Valorant" } }, "Valorant");
  assert.equal(configured, "D:/Games/Valorant");

  const fallback = smartsync.gameRoot({}, "Valorant");
  assert.ok(fallback.includes("Valorant"));
});

test("hasGame is false for a game this machine does not have", () => {
  assert.equal(smartsync.hasGame({ gameRoots: { Nope: "/definitely/not/here" } }, "Nope"), false);
});
