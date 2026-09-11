# Build handover

`SEIKA-Build-Handover.pdf` — 21 pages: what was built against the testing plan,
how the product works, screenshots of every screen, the bugs the work found,
and what is honestly left before a pilot.

## Regenerating it

The screenshots are of the real product with real data, not mockups, so the
stack has to be running:

```bash
pnpm dev:api:mem                       # :4000
pnpm --filter @seika/dashboard start   # :3000  (after `build`)
pnpm --filter @seika/player start      # :3001  (after `build`)
```

Seed a zone with activity (`POST /api/dev/seed`, then create PCs, players,
sessions and orders), start headless Chrome with the DevTools protocol open:

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-profile
```

then:

```bash
node capture.mjs    # screenshots each screen, clipped to its content
node topdf.mjs out.pdf
```

`capture.mjs` drives Chrome over CDP with node's native WebSocket — no
Puppeteer. It seeds each app's localStorage token before navigating, because
both clients hold auth there, and clips each shot to where the content actually
ends rather than the viewport.

`handover.html` is the document source. Edit it and re-run `topdf.mjs`.
