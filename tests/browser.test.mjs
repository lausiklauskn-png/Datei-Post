// The page in a real browser: the master uploads, a stranger picks up
// with the code from the share panel, and hands a file back in.
// Without playwright-core it is SKIPPED, not green.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { starten, einstellungen, hauptcodeSetzen } from "../server.mjs";

let chromium = null;
try { ({ chromium } = await import("playwright-core")); } catch { /* not installed */ }
const HAUPT = "browser-probe-hauptcode-123";

test("im Browser: hochladen, Code teilen, abholen, verbraucht, abgeben", { skip: !chromium && "playwright-core fehlt — ungeprüft, nicht grün" }, async (t) => {
  const daten = fs.mkdtempSync(path.join(os.tmpdir(), "datei-post-b-"));
  await hauptcodeSetzen(daten, HAUPT);
  const server = starten(einstellungen({ DATEN: daten }));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const basis = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); server.close(); fs.rmSync(daten, { recursive: true, force: true }); });

  const fehler = [];
  const neueSeite = async () => {
    const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 390, height: 800 } });
    const p = await ctx.newPage();
    p.on("console", (m) => { if (m.type() === "error") fehler.push(m.text()); });
    p.on("pageerror", (e) => fehler.push(String(e)));
    return p;
  };

  // ── master uploads
  const ich = await neueSeite();
  await ich.goto(basis);
  await ich.click("summary");
  await ich.fill("#hauptcode", HAUPT);
  await ich.click("#anmelden button");
  await ich.waitForSelector("#haupt:not([hidden])", { timeout: 30000 });
  const inhalt = Buffer.from("Ein Brief mit Umlauten: äöü ß — " + "x".repeat(5000));
  await ich.setInputFiles("#haupt-datei", { name: "Brief für Mutti.txt", mimeType: "text/plain", buffer: inhalt });
  await ich.click("#haupt-hochladen button");
  await ich.waitForSelector("#teilen:not([hidden])", { timeout: 30000 });
  const code = (await ich.textContent("#teilen-code")).trim();
  assert.match(code, /^[2-9A-Z]{4}-[2-9A-Z]{4}-[2-9A-Z]{4}$/);
  const wa = await ich.getAttribute("#teilen-wa", "href");
  assert.ok(decodeURIComponent(wa).includes(code), "WhatsApp-Text trägt den Code nicht");
  assert.ok(decodeURIComponent(wa).includes("#abholen=" + code), "WhatsApp-Link trägt den Code nicht im Fragment");
  await ich.waitForFunction(() => document.querySelector("#liste .name")?.textContent === "Brief für Mutti.txt");

  // ── someone else opens the link
  const du = await neueSeite();
  await du.goto(basis + "#abholen=" + code);
  assert.equal(await du.inputValue("#abholen-code"), code, "Code aus dem Link nicht eingetragen");
  assert.equal(new URL(du.url()).hash, "", "Code bleibt in der Adresszeile stehen");
  await du.click("#abholen-form button");
  await du.waitForSelector("#abholen-datei:not([hidden])", { timeout: 30000 });
  assert.match(await du.textContent("#abholen-name"), /Brief für Mutti\.txt/);
  const [dl] = await Promise.all([du.waitForEvent("download"), du.click("#abholen-los")]);
  // Headless Chromium names EVERY non-ASCII download "download" (measured in
  // Workflow-PDF, 2026-09-26) — so the name is read from the page itself.
  assert.equal(await du.evaluate(() => window.__dateiPost.letzterDownload), "Brief für Mutti.txt");
  assert.ok(fs.readFileSync(await dl.path()).equals(inhalt), "heruntergeladener Inhalt weicht ab");
  await du.waitForFunction(() => /verbraucht/.test(document.querySelector("#meldung").textContent));

  // second try: used up, and the page says so in words
  await du.click("#abholen-form button");
  await du.waitForFunction(() => /schon benutzt/.test(document.querySelector("#meldung").textContent), null, { timeout: 30000 });

  // ── master hands out a code for handing IN
  await ich.click("#teilen-zu");
  await ich.click("#upload-code-neu");
  await ich.waitForSelector("#teilen:not([hidden])");
  const ucode = (await ich.textContent("#teilen-code")).trim();
  const gast = await neueSeite();
  await gast.goto(basis + "#hochladen=" + ucode);
  await gast.setInputFiles("#hochladen-datei", { name: "Fotos <b>fett</b>.zip", mimeType: "application/zip", buffer: Buffer.from("PK-fake") });
  await gast.click("#hochladen-form button[type=submit]");
  await gast.waitForFunction(() => /abgegeben/.test(document.querySelector("#meldung").textContent), null, { timeout: 30000 });

  // master sees it by name after reload of the list — as TEXT: a name from
  // a stranger that contains markup must not become markup
  await ich.click("#abmelden");
  await ich.evaluate(() => { document.querySelector(".haupt-zugang").open = true; });
  await ich.fill("#hauptcode", HAUPT);
  await ich.click("#anmelden button");
  await ich.waitForFunction(() => [...document.querySelectorAll("#liste .name")].some((n) => n.textContent === "Fotos <b>fett</b>.zip"), null, { timeout: 60000 });

  // ── Kim-sync access (2026-10-03): a reusable code, shown with the server,
  //    listed until it is revoked
  await ich.click("#kimsync-code-neu");
  await ich.waitForSelector("#teilen:not([hidden])", { timeout: 60000 });
  const kcode = (await ich.textContent("#teilen-code")).trim();
  assert.match(kcode, /^[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/, "Kim-sync-Zugang ist ein Code");
  const ktext = decodeURIComponent((await ich.getAttribute("#teilen-wa", "href")).split("text=")[1] || "");
  assert.ok(ktext.includes(kcode) && ktext.includes("Server: " + basis.replace(/\/$/, "")), "der Text nennt Server und Zugangscode");
  await ich.click("#teilen-zu");
  await ich.waitForFunction(() => /Zugang vom/.test(document.querySelector("#kimsync-liste").textContent), null, { timeout: 30000 });

  // the refused second pickup (410) is logged by the browser itself — expected
  const echt = fehler.filter((f) => !/status of 410/.test(f));
  assert.deepEqual(echt, [], "Fehler in der Konsole (CSP?)");
  assert.equal(fehler.length - echt.length, 1, "genau eine verweigerte Abholung erwartet");
});

// Klaus 2026-09-26: on an old Windows the mailto: link opened Edge. The user
// picks the way once; the browser remembers it; a stranger's URL scheme
// (javascript:, data:) is never accepted.
test("im Browser: E-Mail-Weg wird einmal gewählt und gemerkt", { skip: !chromium && "playwright-core fehlt — ungeprüft, nicht grün" }, async (t) => {
  const daten = fs.mkdtempSync(path.join(os.tmpdir(), "datei-post-m-"));
  await hauptcodeSetzen(daten, HAUPT);
  const server = starten(einstellungen({ DATEN: daten }));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const basis = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); server.close(); fs.rmSync(daten, { recursive: true, force: true }); });

  const ctx = await browser.newContext({ viewport: { width: 390, height: 800 } });
  await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: basis.replace(/\/$/, "") });
  const draussen = [];
  await ctx.route(/^https:\/\/(mail\.google\.com|outlook\.live\.com|www\.gmx\.net)\//, (r) => { draussen.push(r.request().url()); r.fulfill({ body: "ok" }); });
  const p = await ctx.newPage();
  const fehler = [];
  p.on("pageerror", (e) => fehler.push(String(e)));
  await p.goto(basis);
  await p.click("summary");
  await p.fill("#hauptcode", HAUPT);
  await p.click("#anmelden button");
  await p.waitForSelector("#haupt:not([hidden])", { timeout: 30000 });
  await p.setInputFiles("#haupt-datei", { name: "a.txt", mimeType: "text/plain", buffer: Buffer.from("hallo") });
  await p.click("#haupt-hochladen button");
  await p.waitForSelector("#teilen:not([hidden])", { timeout: 30000 });
  const code = (await p.textContent("#teilen-code")).trim();
  const sichtbar = (s) => p.evaluate((s) => { const e = document.querySelector(s); return !!e && e.checkVisibility(); }, s);

  // first click: nothing remembered, so it ASKS instead of opening anything
  assert.equal(await sichtbar("#mail-gemerkt"), false, "ohne Wahl darf nichts als gemerkt dastehen");
  await p.click("#teilen-mail");
  assert.equal(await sichtbar("#mail-wahl"), true, "erster Klick fragt nicht nach dem Weg");
  assert.deepEqual(draussen, [], "erster Klick öffnet schon etwas");

  // choose Gmail: a compose window with the code opens
  await p.check('input[name="mailweg"][value="gmail"]');
  const [gm] = await Promise.all([ctx.waitForEvent("page"), p.click("#mail-ok")]);
  await gm.waitForLoadState();
  const gurl = decodeURIComponent(gm.url());
  assert.ok(gurl.startsWith("https://mail.google.com/mail/?view=cm"), "Gmail-Adresse falsch: " + gm.url());
  assert.ok(gurl.includes("#abholen=" + code), "Gmail-Text trägt den Link mit Code nicht");
  await gm.close();
  assert.equal(await sichtbar("#mail-wahl"), false, "Auswahl bleibt nach dem Senden offen");
  assert.match(await p.textContent("#mail-gemerkt"), /Gmail/, "gemerkter Weg wird nicht genannt");
  assert.deepEqual(JSON.parse(await p.evaluate(() => localStorage.getItem("dateipost_mailweg_v1"))), { weg: "gmail" });

  // second click: no question, straight to Gmail
  const [gm2] = await Promise.all([ctx.waitForEvent("page"), p.click("#teilen-mail")]);
  assert.ok(gm2.url().startsWith("https://mail.google.com/"), "zweiter Klick geht nicht direkt zum gemerkten Weg");
  assert.equal(await sichtbar("#mail-wahl"), false, "zweiter Klick fragt wieder");
  await gm2.close();

  // change: a javascript: address is refused and the old choice stays
  await p.click("#mail-aendern");
  await p.check('input[name="mailweg"][value="eigen"]');
  assert.equal(await sichtbar("#mail-eigen"), true, "Adressfeld erscheint nicht");
  await p.fill("#mail-eigen", "javascript:alert(1)");
  await p.click("#mail-ok");
  await p.waitForFunction(() => /keine Internet-Adresse/.test(document.querySelector("#meldung").textContent));
  assert.deepEqual(JSON.parse(await p.evaluate(() => localStorage.getItem("dateipost_mailweg_v1"))), { weg: "gmail" }, "javascript:-Adresse wurde gespeichert");

  // own provider without scheme: https:// in front, text on the clipboard, page opens
  await p.fill("#mail-eigen", "www.gmx.net");
  const [gx] = await Promise.all([ctx.waitForEvent("page"), p.click("#mail-ok")]);
  assert.equal(gx.url(), "https://www.gmx.net/");
  await gx.close();
  await p.waitForFunction(() => /Text ist kopiert/.test(document.querySelector("#meldung").textContent));
  assert.ok((await p.evaluate(() => navigator.clipboard.readText())).includes("#abholen=" + code), "Zwischenablage trägt den Text nicht");
  assert.match(await p.textContent("#mail-gemerkt"), /www\.gmx\.net/);

  // a garbage value in storage is not trusted: it asks again
  await p.evaluate(() => localStorage.setItem("dateipost_mailweg_v1", JSON.stringify({ weg: "eigen", adresse: "javascript:alert(1)" })));
  await p.click("#teilen-mail");
  assert.equal(await sichtbar("#mail-wahl"), true, "ein unsauberer gespeicherter Weg wird benutzt statt neu zu fragen");
  assert.deepEqual(fehler, []);
});
