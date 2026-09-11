import { describe, it, expect } from "vitest";

import { anon, as, seedPlayer, seedStaff, seedZone } from "./helpers/factories.js";

/**
 * Module A — Auth & accounts (SEIKA Complete Software Testing Plan §7.A).
 * Every case here is P0 except A6.
 */
describe("A. Auth & accounts", () => {
  it("A1 — player OTP signup/login creates a player with no staff permissions", async () => {
    const reqOtp = await anon().post("/api/auth/otp/request").send({ identifier: "9876500011" });
    expect(reqOtp.status).toBe(200);
    expect(reqOtp.body.devCode).toMatch(/^\d{6}$/);

    const verify = await anon()
      .post("/api/auth/otp/verify")
      .send({ identifier: "9876500011", code: reqOtp.body.devCode });
    expect(verify.status).toBe(200);
    expect(verify.body.subjectType).toBe("player");
    expect(verify.body.accessToken).toBeTruthy();

    const me = await as(verify.body.accessToken).get("/api/auth/me");
    expect(me.status).toBe(200);
    expect(me.body.auth.typ).toBe("player");
    // A player token must never carry a staff role.
    expect(me.body.auth.role ?? null).toBeNull();
  });

  it("A2 — staff OTP login opens with the correct assigned role", async () => {
    const zone = await seedZone();
    const cashier = await seedStaff(zone, "CASHIER", { phone: "9700000001" });

    const reqOtp = await anon()
      .post("/api/auth/otp/request")
      .send({ identifier: cashier.phone, audience: "staff" });
    expect(reqOtp.status).toBe(200);

    const verify = await anon()
      .post("/api/auth/otp/verify")
      .send({ identifier: cashier.phone, code: reqOtp.body.devCode, audience: "staff" });
    expect(verify.status).toBe(200);
    expect(verify.body.subjectType).toBe("staff");

    const me = await as(verify.body.accessToken).get("/api/auth/me");
    expect(me.body.auth.role).toBe("CASHIER");
  });

  it("A3 — wrong OTP is rejected and issues no token", async () => {
    await anon().post("/api/auth/otp/request").send({ identifier: "9876500013" });
    const verify = await anon()
      .post("/api/auth/otp/verify")
      .send({ identifier: "9876500013", code: "000000" });
    expect(verify.status).toBe(401);
    expect(verify.body.accessToken).toBeUndefined();
  });

  it("A4 — a player identifier cannot log in through the staff audience", async () => {
    // No StaffUser exists for this phone, so the staff flow must refuse it.
    const reqOtp = await anon()
      .post("/api/auth/otp/request")
      .send({ identifier: "9876500014", audience: "staff" });
    const verify = await anon()
      .post("/api/auth/otp/verify")
      .send({ identifier: "9876500014", code: reqOtp.body.devCode, audience: "staff" });
    expect(verify.status).toBe(401);
  });

  it("A5 — a rotated refresh token is revoked and rejected on reuse", async () => {
    const reqOtp = await anon().post("/api/auth/otp/request").send({ identifier: "9876500015" });
    const verify = await anon()
      .post("/api/auth/otp/verify")
      .send({ identifier: "9876500015", code: reqOtp.body.devCode });
    const original = verify.body.refreshToken as string;

    const first = await anon().post("/api/auth/refresh").send({ refreshToken: original });
    expect(first.status).toBe(200);
    expect(first.body.refreshToken).not.toBe(original);

    // Reusing the old token must fail — this is the token-theft guard.
    const replay = await anon().post("/api/auth/refresh").send({ refreshToken: original });
    expect(replay.status).toBe(401);
  });

  it("A6 — /me without a token is unauthorized", async () => {
    const res = await anon().get("/api/auth/me");
    expect(res.status).toBe(401);
  });

  it("A6 — profile customization saves and is reflected in the passport", async () => {
    const zone = await seedZone();
    const player = await seedPlayer({ zoneId: zone.zoneId });

    const res = await as(player.token).patch("/api/players/me").send({
      gamerTag: "NightOwl",
      city: "Pune",
      country: "India",
      favoriteGames: ["Valorant", "CS2"],
    });
    expect(res.status).toBe(200);

    const passport = await as(player.token).get("/api/players/me/passport");
    expect(passport.body.passport.gamerTag).toBe("NightOwl");
    expect(passport.body.passport.city).toBe("Pune");
    expect(passport.body.passport.favoriteGames).toContain("Valorant");
  });
});
