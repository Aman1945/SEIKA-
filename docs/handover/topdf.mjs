/**
 * Renders doc.html to PDF with headless Chrome over CDP.
 *
 * Chrome's print pipeline is what makes the screenshots and the type come out
 * right — the page CSS already declares @page margins, so nothing is overridden
 * here except the footer, which has to be supplied as a template.
 */

import fs from "node:fs/promises";

const CDP = "http://127.0.0.1:9222";
const OUT = process.argv[2] ?? "/tmp/shots/SEIKA-Build-Handover.pdf";

class Session {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.events = new Map();
    ws.addEventListener("message", (e) => {
      const msg = JSON.parse(e.data);
      if (msg.id && this.pending.has(msg.id)) {
        const w = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? w.reject(new Error(msg.error.message)) : w.resolve(msg.result);
      } else if (msg.method) {
        this.events.get(msg.method)?.forEach((fn) => fn(msg.params));
      }
    });
  }
  on(method, fn) {
    this.events.set(method, [...(this.events.get(method) ?? []), fn]);
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
}

const res = await fetch(`${CDP}/json/new?about:blank`, { method: "PUT" });
const target = await res.json();

const cdp = await new Promise((resolve, reject) => {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  ws.addEventListener("open", () => resolve(new Session(ws)));
  ws.addEventListener("error", reject);
});

await cdp.send("Page.enable");

// Wait for the load event rather than a fixed delay: this page pulls in
// eighteen screenshots, and a short sleep would print some of them blank.
const loaded = new Promise((resolve) => cdp.on("Page.loadEventFired", resolve));
await cdp.send("Page.navigate", { url: "file:///tmp/shots/doc.html" });
await loaded;

// Belt and braces: confirm every image actually decoded before printing.
await cdp.send("Runtime.enable");
for (let i = 0; i < 40; i++) {
  const { result } = await cdp.send("Runtime.evaluate", {
    expression: `Array.from(document.images).every(img => img.complete && img.naturalWidth > 0)`,
    returnByValue: true,
  });
  if (result.value) break;
  await new Promise((r) => setTimeout(r, 250));
}

const { data } = await cdp.send("Page.printToPDF", {
  printBackground: true,
  preferCSSPageSize: true,
  displayHeaderFooter: true,
  headerTemplate: "<span></span>",
  footerTemplate: `
    <div style="width:100%;font-size:7pt;color:#8a93a6;padding:0 15mm;
                font-family:-apple-system,'Segoe UI',sans-serif;
                display:flex;justify-content:space-between;">
      <span>SEIKA Gaming Zone OS — Build Handover</span>
      <span class="pageNumber"></span>
    </div>`,
  marginTop: 0,
  marginBottom: 0,
});

await fs.writeFile(OUT, Buffer.from(data, "base64"));
cdp.ws.close();
await fetch(`${CDP}/json/close/${target.id}`);
console.log("wrote", OUT);
