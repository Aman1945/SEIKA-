"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn, execSync } = require("node:child_process");

/**
 * Signs the player out of Steam and Epic when their session ends.
 *
 * A player signs into their own account to play. If that is still signed in
 * when the next customer sits down, the next customer has their library,
 * their friends list, their saved payment method and their chat. That is the
 * zone's problem the moment it happens once.
 *
 * Both launchers remember a login on disk, so closing them is not enough —
 * they come back signed in. The remembered credential has to go too.
 *
 * None of this is allowed to stop a PC locking: every step is wrapped, and a
 * launcher that is not installed is simply nothing to do.
 */

function quiet(cmd, args) {
  try {
    spawn(cmd, args, { stdio: "ignore", windowsHide: true, detached: true }).unref();
  } catch {
    // Not installed, or already gone.
  }
}

function regDelete(key, value) {
  try {
    execSync(`reg delete "${key}" /v ${value} /f`, {
      stdio: "ignore",
      windowsHide: true,
      timeout: 4000,
    });
    return true;
  } catch {
    // Absent already, which is the state we wanted.
    return false;
  }
}

/**
 * Steam.
 *
 * `-shutdown` asks it to close properly rather than killing it, so it is not
 * mid-write when the login file is cleared. AutoLoginUser is what signs the
 * next person straight back in as the last one; loginusers.vdf is the list
 * the account picker shows.
 */
function signOutSteam(root, log) {
  if (!root) return;
  const exe = path.join(root, "steam.exe");

  if (fs.existsSync(exe)) quiet(exe, ["-shutdown"]);
  // Steam takes a moment to write its config out before it exits. Clearing
  // underneath it would simply be overwritten.
  setTimeout(() => {
    try {
      regDelete("HKCU\\Software\\Valve\\Steam", "AutoLoginUser");
      regDelete("HKCU\\Software\\Valve\\Steam", "RememberPassword");

      const logins = path.join(root, "config", "loginusers.vdf");
      if (fs.existsSync(logins)) {
        fs.rmSync(logins, { force: true });
        log("cleared Steam's remembered logins");
      } else {
        log("signed out of Steam");
      }
    } catch (err) {
      log(`Steam sign-out incomplete: ${err.message}`);
    }
  }, 3000);
}

/**
 * Epic.
 *
 * The launcher keeps a refresh token in GameUserSettings.ini under
 * [RememberMe]. Removing that section is what actually signs the account out;
 * the process is closed first so it does not write it straight back.
 */
function signOutEpic(log) {
  quiet("taskkill", ["/IM", "EpicGamesLauncher.exe", "/T", "/F"]);

  setTimeout(() => {
    const ini = path.join(
      process.env.LOCALAPPDATA || "",
      "EpicGamesLauncher",
      "Saved",
      "Config",
      "Windows",
      "GameUserSettings.ini"
    );
    try {
      if (!fs.existsSync(ini)) return;
      const text = fs.readFileSync(ini, "utf8");
      // Drop the [RememberMe] block, keeping every other setting the zone
      // may have configured — resolution, install paths, bandwidth limits.
      const stripped = text.replace(/\[RememberMe\][\s\S]*?(?=\n\[|\s*$)/g, "");
      if (stripped !== text) {
        fs.writeFileSync(ini, stripped);
        log("cleared Epic's remembered login");
      }
    } catch (err) {
      log(`Epic sign-out incomplete: ${err.message}`);
    }
  }, 2500);
}

/**
 * Signs out of every launcher this PC knows about.
 *
 * `steamRoot` is passed in rather than looked up again, since detect.js has
 * already done that work and the two must agree about where Steam is.
 */
function signOutLaunchers({ steamRoot, log }) {
  if (process.platform !== "win32") return;
  try {
    signOutSteam(steamRoot, log);
    signOutEpic(log);
  } catch (err) {
    log(`launcher sign-out failed: ${err.message}`);
  }
}

module.exports = { signOutLaunchers };
