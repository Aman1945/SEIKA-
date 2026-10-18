import { describe, it, expect } from "vitest";
import { as, seedPlayer, seedZone } from "./helpers/factories.js";

describe("Malformed ids", () => {
  it("a non-ObjectId in the path is a 400, not a 500", async () => {
    const zone = await seedZone();
    const player = await seedPlayer({ balance: 100, zoneId: zone.zoneId });

    // This is the exact shape that made /api/sessions/history look broken:
    // the real route is /history/list, so "history" was cast to an ObjectId.
    const res = await as(player.token).get("/api/sessions/history");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_ID");

    // And the route that actually exists still works.
    const ok = await as(player.token).get("/api/sessions/history/list?limit=5");
    expect(ok.status).toBe(200);
  });
});
