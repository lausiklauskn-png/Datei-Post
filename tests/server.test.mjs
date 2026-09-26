// The server, driven the way the page drives it: every secret made on
// the "device" side with public/krypto.js, the server only sees the rest.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as K from "../public/krypto.js";
import { starten, einstellungen, hauptcodeSetzen } from "../server.mjs";

const HAUPT = "ein-langer-hauptcode-fuer-die-probe";

async function aufbau(env = {}) {
  const daten = fs.mkdtempSync(path.join(os.tmpdir(), "datei-post-"));
  await hauptcodeSetzen(daten, HAUPT);
  const cfg = einstellungen({ DATEN: daten, ...env });
  const server = starten(cfg);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const basis = `http://127.0.0.1:${server.address().port}`;
  const api = async (pfad, { method = "GET", body, headers = {}, token, roh } = {}) => {
    const h = { ...headers };
    if (token) h.authorization = "Bearer " + token;
    let b = body;
    if (b && !(b instanceof Uint8Array)) { b = JSON.stringify(b); h["content-type"] = "application/json"; }
    const r = await fetch(basis + pfad, { method, headers: h, body: b });
    if (roh) return r;
    return { status: r.status, daten: await r.json().catch(() => ({})) };
  };
  const zu = () => { server.close(); fs.rmSync(daten, { recursive: true, force: true }); };
  return { daten, basis, api, zu };
}

async function anmelden(api) {
  const { schluessel, kennung } = await K.ableiten(HAUPT, "haupt");
  const r = await api("/api/anmelden", { method: "POST", body: { kennung } });
  assert.equal(r.status, 200);
  return { token: r.daten.token, haupt: schluessel };
}

async function hochladen(api, inhalt, name, { token, haupt, upload }) {
  const ds = await K.neuerDateiSchluessel();
  const meta = await K.textEinpacken(JSON.stringify({ name, typ: "text/plain", groesse: inhalt.length }), ds, "meta");
  const body = { meta, groesse: inhalt.length };
  if (upload) { body.uploadKennung = upload.kennung; body.schluesselUpload = await K.schluesselEinpacken(ds, upload.schluessel); }
  else body.schluesselHaupt = await K.schluesselEinpacken(ds, haupt);
  const neu = await api("/api/dateien", { method: "POST", body, token });
  if (neu.status !== 201) return { neu };
  const { id, teile, schreibToken } = neu.daten;
  for (let n = 0; n < teile; n++) {
    const p = await K.teilVerschluesseln(ds, inhalt.subarray(n * K.TEIL_BYTES, (n + 1) * K.TEIL_BYTES), id, n, teile);
    const r = await api(`/api/dateien/${id}/teil/${n}`, { method: "PUT", body: p, headers: { "x-schreib-token": schreibToken } });
    assert.equal(r.status, 200, "Teil " + n);
  }
  const f = await api(`/api/dateien/${id}/fertig`, { method: "POST", headers: { "x-schreib-token": schreibToken } });
  assert.equal(f.status, 200);
  return { id, ds, teile, neu };
}

async function codeErzeugen(api, id, ds, { token, haupt }) {
  const code = K.neuerCode();
  const { schluessel, kennung } = await K.ableiten(K.normalisiereCode(code), "code");
  const r = await api(`/api/dateien/${id}/codes`, { method: "POST", token, body: {
    kennung, schluessel: await K.schluesselEinpacken(ds, schluessel), codeHaupt: await K.textEinpacken(code, haupt, "code") } });
  assert.equal(r.status, 201);
  return code;
}

async function abholen(api, code) {
  const { schluessel, kennung } = await K.ableiten(K.normalisiereCode(code), "code");
  const info = await api("/api/abholen/" + kennung);
  if (info.status !== 200) return { status: info.status, fehler: info.daten.fehler, kennung };
  const ds = await K.schluesselAuspacken(info.daten.schluessel, schluessel);
  const meta = JSON.parse(await K.textAuspacken(info.daten.meta, ds, "meta"));
  const teile = [];
  for (let n = 0; n < info.daten.teile; n++) {
    const r = await api(`/api/abholen/${kennung}/teil/${n}`, { roh: true });
    teile.push(await K.teilEntschluesseln(ds, await r.arrayBuffer(), info.daten.dateiId, n, info.daten.teile));
  }
  return { status: 200, meta, inhalt: Buffer.concat(teile), kennung };
}

test("hochladen → Code → abholen → verbraucht, und der Server sieht keinen Klartext", async (t) => {
  const s = await aufbau(); t.after(s.zu);
  const ich = await anmelden(s.api);
  // three chunks, the last one short
  const inhalt = Buffer.alloc(2 * K.TEIL_BYTES + 12345);
  const marke = Buffer.from("GEHEIMER-KLARTEXT-MARKER");
  for (let i = 0; i < inhalt.length; i += 4096) marke.copy(inhalt, i);
  const { id, ds, teile } = await hochladen(s.api, inhalt, "Rechnung März.pdf", ich);
  assert.equal(teile, 3);

  // nothing on disk carries the content or the name
  const alles = [];
  const lauf = (p) => { for (const f of fs.readdirSync(p, { withFileTypes: true })) f.isDirectory() ? lauf(path.join(p, f.name)) : alles.push(fs.readFileSync(path.join(p, f.name))); };
  lauf(s.daten);
  assert.ok(!alles.some((b) => b.includes(marke)), "Klartext liegt auf dem Server");
  assert.ok(!alles.some((b) => b.includes(Buffer.from("Rechnung"))), "Dateiname liegt auf dem Server");

  const code = await codeErzeugen(s.api, id, ds, ich);
  assert.ok(!alles.some((b) => b.includes(Buffer.from(K.normalisiereCode(code)))));

  // a first attempt that breaks off does NOT use the code up
  const ersterVersuch = await abholen(s.api, code);
  assert.equal(ersterVersuch.status, 200);
  const nochmal = await abholen(s.api, code);
  assert.equal(nochmal.status, 200, "Code war nach abgebrochenem Download weg");
  assert.equal(nochmal.meta.name, "Rechnung März.pdf");
  assert.ok(nochmal.inhalt.equals(inhalt), "Inhalt kam anders an");

  const f = await s.api(`/api/abholen/${nochmal.kennung}/fertig`, { method: "POST" });
  assert.equal(f.status, 200);
  const danach = await abholen(s.api, code);
  assert.equal(danach.status, 410);
  assert.equal(danach.fehler, "abgeholt");

  // the file stays; a new code works
  const neu = await codeErzeugen(s.api, id, ds, ich);
  assert.equal((await abholen(s.api, neu)).status, 200);

  // the list shows both codes, the master can read the code again
  const liste = await s.api("/api/liste", { token: ich.token });
  const d = liste.daten.dateien.find((x) => x.id === id);
  assert.deepEqual(d.codes.map((c) => c.status).sort(), ["abgeholt", "offen"]);
  const offen = d.codes.find((c) => c.status === "offen");
  assert.equal(await K.textAuspacken(offen.codeHaupt, ich.haupt, "code"), neu);
});

test("ohne Hauptcode: nichts anlegen, nichts sehen, nichts löschen", async (t) => {
  const s = await aufbau(); t.after(s.zu);
  assert.equal((await s.api("/api/liste")).status, 401);
  assert.equal((await s.api("/api/dateien", { method: "POST", body: { meta: "YQ==", groesse: 1, schluesselHaupt: "YQ==" } })).status, 403);
  assert.equal((await s.api("/api/upload-codes", { method: "POST", body: {} })).status, 401);
  assert.equal((await s.api("/api/dateien/" + "a".repeat(24), { method: "DELETE" })).status, 401);
  const falsch = await K.ableiten("falscher-hauptcode-xyz", "haupt");
  assert.equal((await s.api("/api/anmelden", { method: "POST", body: { kennung: falsch.kennung } })).status, 401);
  assert.equal((await s.api("/api/liste", { token: "b".repeat(64) })).status, 401, "erfundener Token");
});

test("fremde Schreib-Token und falsche Teile werden abgewiesen", async (t) => {
  const s = await aufbau(); t.after(s.zu);
  const ich = await anmelden(s.api);
  const ds = await K.neuerDateiSchluessel();
  const neu = await s.api("/api/dateien", { method: "POST", token: ich.token, body: {
    meta: await K.textEinpacken("{}", ds, "meta"), groesse: 10, schluesselHaupt: await K.schluesselEinpacken(ds, ich.haupt) } });
  const { id } = neu.daten;
  const p = await K.teilVerschluesseln(ds, new Uint8Array(10), id, 0, 1);
  assert.equal((await s.api(`/api/dateien/${id}/teil/0`, { method: "PUT", body: p, headers: { "x-schreib-token": "c".repeat(64) } })).status, 403);
  assert.equal((await s.api(`/api/dateien/${id}/teil/5`, { method: "PUT", body: p, headers: { "x-schreib-token": neu.daten.schreibToken } })).status, 400);
  assert.equal((await s.api(`/api/dateien/${id}/fertig`, { method: "POST", headers: { "x-schreib-token": neu.daten.schreibToken } })).status, 409, "fertig ohne Teile");
  const zuGross = new Uint8Array(K.TEIL_BYTES + 100);
  assert.equal((await s.api(`/api/dateien/${id}/teil/0`, { method: "PUT", body: zuGross, headers: { "x-schreib-token": neu.daten.schreibToken } })).status, 413);
});

test("Code zum Abgeben: jemand legt eine Datei ab, sie landet beim Hauptcode", async (t) => {
  const s = await aufbau(); t.after(s.zu);
  const ich = await anmelden(s.api);
  const code = K.neuerCode();
  const u = await K.ableiten(K.normalisiereCode(code), "code");
  assert.equal((await s.api("/api/upload-codes", { method: "POST", token: ich.token, body: {
    kennung: u.kennung, codeHaupt: await K.textEinpacken(code, ich.haupt, "code") } })).status, 201);

  // the other person, no token
  assert.equal((await s.api("/api/hochladen/" + u.kennung)).status, 200);
  const inhalt = Buffer.from("Fotos vom Grillfest");
  const { id } = await hochladen(s.api, inhalt, "grill.zip", { upload: u });

  // used up
  assert.equal((await s.api("/api/hochladen/" + u.kennung)).status, 410);
  const zweite = await hochladen(s.api, inhalt, "nochmal.zip", { upload: u });
  assert.equal(zweite.neu.status, 403, "Code zum Abgeben zweimal benutzt");

  // master: recover the file key through the upload code, then re-wrap
  const liste = (await s.api("/api/liste", { token: ich.token })).daten;
  const d = liste.dateien.find((x) => x.id === id);
  assert.equal(d.schluesselHaupt, null);
  const uc = liste.uploadCodes.find((c) => c.id === d.uploadCode);
  assert.equal(uc.status, "benutzt");
  const wieder = await K.textAuspacken(uc.codeHaupt, ich.haupt, "code");
  const { schluessel } = await K.ableiten(K.normalisiereCode(wieder), "code");
  const ds = await K.schluesselAuspacken(d.schluesselUpload, schluessel);
  assert.equal(JSON.parse(await K.textAuspacken(d.meta, ds, "meta")).name, "grill.zip");
  assert.equal((await s.api(`/api/dateien/${id}/haupt`, { method: "POST", token: ich.token, body: { schluesselHaupt: await K.schluesselEinpacken(ds, ich.haupt) } })).status, 200);

  // and hand it on
  const ab = await codeErzeugen(s.api, id, ds, ich);
  const r = await abholen(s.api, ab);
  assert.ok(r.inhalt.equals(inhalt));
});

test("Durchprobieren wird gesperrt — auch für richtige Codes", async (t) => {
  const s = await aufbau({ FEHLER_MAX: "3" }); t.after(s.zu);
  const ich = await anmelden(s.api);
  const { id, ds } = await hochladen(s.api, Buffer.from("x"), "x.txt", ich);
  const code = await codeErzeugen(s.api, id, ds, ich);
  for (let i = 0; i < 3; i++) assert.equal((await s.api("/api/abholen/" + "d".repeat(63) + i)).status, 404);
  assert.equal((await abholen(s.api, code)).status, 429);
  // another address is not affected
  const { kennung } = await K.ableiten(K.normalisiereCode(code), "code");
  assert.equal((await s.api("/api/abholen/" + kennung, { headers: { "x-forwarded-for": "10.9.9.9" } })).status, 200);
});

test("löschen nimmt die Codes mit, zurückziehen den einen", async (t) => {
  const s = await aufbau(); t.after(s.zu);
  const ich = await anmelden(s.api);
  const a = await hochladen(s.api, Buffer.from("a"), "a", ich);
  const c1 = await codeErzeugen(s.api, a.id, a.ds, ich);
  const c2 = await codeErzeugen(s.api, a.id, a.ds, ich);
  const liste = (await s.api("/api/liste", { token: ich.token })).daten;
  const code1Id = liste.dateien[0].codes[0].id;
  assert.equal((await s.api("/api/codes/" + code1Id, { method: "DELETE", token: ich.token })).status, 200);
  const st = [await abholen(s.api, c1), await abholen(s.api, c2)].map((r) => r.status);
  assert.deepEqual([...st].sort(), [200, 404], "genau einer ist zurückgezogen");
  const uebrig = st[0] === 200 ? c1 : c2; // readdir order decides which one was first
  assert.equal(fs.readdirSync(path.join(s.daten, "codes")).length, 1);
  assert.equal((await s.api("/api/dateien/" + a.id, { method: "DELETE", token: ich.token })).status, 200);
  assert.equal((await abholen(s.api, uebrig)).status, 404, "Code lebt nach dem Löschen weiter");
  assert.equal(fs.readdirSync(path.join(s.daten, "codes")).length, 0, "Code-Datei liegt nach dem Löschen noch da");
  assert.ok(!fs.existsSync(path.join(s.daten, "dateien", a.id)));
});

test("voller Speicher nimmt nichts mehr an", async (t) => {
  const s = await aufbau({ PLATZ_GRENZE: "0" }); t.after(s.zu);
  const ich = await anmelden(s.api);
  const r = await hochladen(s.api, Buffer.from("x"), "x", ich);
  assert.equal(r.neu.status, 507);
  assert.equal(r.neu.daten.fehler, "voll");
});

test("zu große Dateien werden vor dem ersten Byte abgelehnt", async (t) => {
  const s = await aufbau({ MAX_DATEI_MB: "1" }); t.after(s.zu);
  const ich = await anmelden(s.api);
  const ds = await K.neuerDateiSchluessel();
  const r = await s.api("/api/dateien", { method: "POST", token: ich.token, body: {
    meta: "YQ==", groesse: 2 * 1024 * 1024, schluesselHaupt: await K.schluesselEinpacken(ds, ich.haupt) } });
  assert.equal(r.status, 413);
});

test("ausgeliefert wird nur die Seite, nicht der Server oder die Daten", async (t) => {
  const s = await aufbau(); t.after(s.zu);
  const ok = await fetch(s.basis + "/");
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get("content-security-policy"), /default-src 'self'/);
  for (const p of ["/server.mjs", "/../server.mjs", "/%2e%2e/server.mjs", "/daten/hauptcode.json", "/hauptcode.json", "/package.json"]) {
    assert.equal((await fetch(s.basis + p)).status, 404, p);
  }
});
