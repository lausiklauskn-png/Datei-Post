// Kim-sync parks big videos here (Klaus 2026-10-03). Driven the way the
// messenger drives it: the access code and the file key are made on the
// "device" side with public/krypto.js; the server only ever sees the
// derived kennung, sizes and encrypted parts.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as K from "../public/krypto.js";
import { starten, einstellungen, hauptcodeSetzen } from "../server.mjs";

const HAUPT = "ein-langer-hauptcode-fuer-die-probe";
const HERKUNFT = "https://lausiklauskn-png.github.io";
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

async function aufbau(env = {}) {
  const daten = fs.mkdtempSync(path.join(os.tmpdir(), "datei-post-ks-"));
  await hauptcodeSetzen(daten, HAUPT);
  const server = starten(einstellungen({ DATEN: daten, ...env }));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const basis = `http://127.0.0.1:${server.address().port}`;
  const api = async (pfad, { method = "GET", body, headers = {}, token, roh } = {}) => {
    const h = { ...headers };
    if (token) h.authorization = "Bearer " + token;
    let b = body;
    if (b && !(b instanceof Uint8Array)) { b = JSON.stringify(b); h["content-type"] = "application/json"; }
    const r = await fetch(basis + pfad, { method, headers: h, body: b });
    if (roh) return r;
    return { status: r.status, kopf: r.headers, daten: await r.json().catch(() => ({})) };
  };
  const zu = () => { server.close(); fs.rmSync(daten, { recursive: true, force: true }); };
  return { daten, api, zu, server };
}

async function anmelden(api) {
  const { schluessel, kennung } = await K.ableiten(HAUPT, "haupt");
  const r = await api("/api/anmelden", { method: "POST", body: { kennung } });
  return { token: r.daten.token, haupt: schluessel };
}

// what the main area does: a fresh code, its kennung, the code kept for the master
async function zugangAnlegen(api, s) {
  const code = K.neuerCode();
  const { kennung } = await K.ableiten(K.normalisiereCode(code), "kimsync");
  const r = await api("/api/kimsync-codes", { method: "POST", token: s.token,
    body: { kennung, codeHaupt: await K.textEinpacken(code, s.haupt, "code") } });
  return { code, kennung, r };
}

// what Kim-sync does with a big video
async function videoAblegen(api, kennung, inhalt, herkunft = HERKUNFT) {
  const o = { origin: herkunft };
  const neu = await api("/api/kimsync/dateien", { method: "POST", headers: o, body: { kennung, groesse: inhalt.length } });
  if (neu.status !== 201) return { neu };
  const ds = await K.neuerDateiSchluessel();
  const { id, teile, schreibToken } = neu.daten;
  for (let n = 0; n < teile; n++) {
    const p = await K.teilVerschluesseln(ds, inhalt.subarray(n * K.TEIL_BYTES, (n + 1) * K.TEIL_BYTES), id, n, teile);
    const r = await api(`/api/kimsync/dateien/${id}/teil/${n}`, { method: "PUT", body: p, headers: { ...o, "x-schreib-token": schreibToken } });
    assert.equal(r.status, 200, "Teil " + n);
    assert.equal(r.kopf.get("access-control-allow-origin"), herkunft, "CORS am Teil");
  }
  const f = await api(`/api/kimsync/dateien/${id}/fertig`, { method: "POST", headers: { ...o, "x-schreib-token": schreibToken } });
  assert.equal(f.status, 200);
  return { neu, id, teile, ds };
}

async function videoHolen(api, id, teile, ds) {
  const stuecke = [];
  for (let n = 0; n < teile; n++) {
    const r = await api(`/api/kimsync/dateien/${id}/teil/${n}`, { roh: true, headers: { origin: HERKUNFT } });
    assert.equal(r.status, 200);
    stuecke.push(await K.teilEntschluesseln(ds, new Uint8Array(await r.arrayBuffer()), id, n, teile));
  }
  return Buffer.concat(stuecke.map((b) => Buffer.from(b)));
}

const inhalt = (bytes) => { const b = crypto.randomBytes(bytes); return new Uint8Array(b.buffer, b.byteOffset, b.length); };

test("Kim-sync: ein Zugang entsteht nur mit Hauptcode", async () => {
  const { api, zu } = await aufbau();
  try {
    const fremd = await api("/api/kimsync-codes", { method: "POST", body: { kennung: "a".repeat(64), codeHaupt: "eA" } });
    assert.equal(fremd.status, 401);
    const s = await anmelden(api);
    const { r } = await zugangAnlegen(api, s);
    assert.equal(r.status, 201);
    assert.equal(r.daten.art, "kimsync");
  } finally { zu(); }
});

test("Kim-sync: großes Video hin und zurück, Byte für Byte (SHA-256)", async () => {
  const { api, zu, daten } = await aufbau();
  try {
    const s = await anmelden(api);
    const { kennung } = await zugangAnlegen(api, s);
    const roh = inhalt(K.TEIL_BYTES * 2 + 12345); // three parts, last one short
    const { neu, id, teile, ds } = await videoAblegen(api, kennung, roh);
    assert.equal(neu.status, 201);
    assert.equal(teile, 3);
    const tage = (Date.parse(neu.daten.ablauf) - Date.now()) / 86400000;
    assert.ok(tage > 13.9 && tage <= 14, "läuft nach 14 Tagen ab: " + tage);
    const info = await api(`/api/kimsync/dateien/${id}`, { headers: { origin: HERKUNFT } });
    assert.equal(info.status, 200);
    assert.deepEqual(Object.keys(info.daten).sort(), ["ablauf", "groesse", "id", "teile"]);
    const zurueck = await videoHolen(api, id, teile, ds);
    assert.equal(sha(zurueck), sha(roh));
    // the server keeps no name, no type, no key
    const meta = JSON.parse(fs.readFileSync(path.join(daten, "dateien", id, "meta.json"), "utf8"));
    for (const k of ["meta", "schluesselHaupt", "schluesselUpload", "name", "mime", "schluessel"]) assert.ok(!(k in meta), "kein " + k + " auf dem Server");
  } finally { zu(); }
});

test("Kim-sync: der Zugang bleibt — zweimal ablegen geht", async () => {
  const { api, zu } = await aufbau();
  try {
    const s = await anmelden(api);
    const { kennung } = await zugangAnlegen(api, s);
    assert.equal((await videoAblegen(api, kennung, inhalt(1000))).neu.status, 201);
    assert.equal((await videoAblegen(api, kennung, inhalt(2000))).neu.status, 201);
    const l = await api("/api/liste", { token: s.token });
    assert.equal(l.daten.dateien.length, 0, "Kim-sync-Videos stehen nicht in der Dateiliste");
    assert.equal(l.daten.kimsyncCodes.length, 1);
    assert.equal(l.daten.kimsyncCodes[0].videos, 2);
    assert.equal(l.daten.kimsyncCodes[0].bytes, 3000);
  } finally { zu(); }
});

test("Kim-sync: ein falscher Zugang wird abgewiesen und gesperrt", async () => {
  const { api, zu } = await aufbau({ FEHLER_MAX: "3" });
  try {
    const s = await anmelden(api);
    // a code of another kind is not a Kim-sync code
    const code = K.neuerCode();
    const { kennung: k2 } = await K.ableiten(K.normalisiereCode(code), "code");
    await api("/api/upload-codes", { method: "POST", token: s.token, body: { kennung: k2, codeHaupt: await K.textEinpacken(code, s.haupt, "code") } });
    assert.equal((await api("/api/kimsync/dateien", { method: "POST", body: { kennung: k2, groesse: 10 } })).status, 403);
    for (let i = 0; i < 2; i++) assert.equal((await api("/api/kimsync/dateien", { method: "POST", body: { kennung: "b".repeat(64), groesse: 10 } })).status, 403);
    const { kennung } = await zugangAnlegen(api, s);
    assert.equal((await api("/api/kimsync/dateien", { method: "POST", body: { kennung, groesse: 10 } })).status, 429, "nach drei Fehlern gesperrt");
  } finally { zu(); }
});

test("Kim-sync: CORS nur für die eine Herkunft, nie *", async () => {
  const { api, zu } = await aufbau();
  try {
    const vor = await api("/api/kimsync/dateien", { method: "OPTIONS", roh: true, headers: { origin: HERKUNFT, "access-control-request-method": "PUT" } });
    assert.equal(vor.status, 204);
    assert.equal(vor.headers.get("access-control-allow-origin"), HERKUNFT);
    assert.equal(vor.headers.get("access-control-allow-methods"), "GET, POST, PUT, OPTIONS");
    assert.equal(vor.headers.get("access-control-allow-headers"), "content-type, x-schreib-token");
    assert.equal(vor.headers.get("access-control-max-age"), "600");
    assert.match(vor.headers.get("vary") || "", /origin/i);
    const fremd = await api("/api/kimsync/dateien", { method: "OPTIONS", roh: true, headers: { origin: "https://boese.example" } });
    assert.equal(fremd.status, 403);
    assert.equal(fremd.headers.get("access-control-allow-origin"), null);
    const s = await anmelden(api);
    const { kennung } = await zugangAnlegen(api, s);
    const { id } = await videoAblegen(api, kennung, inhalt(500));
    const f = await api(`/api/kimsync/dateien/${id}`, { headers: { origin: "https://boese.example" } });
    assert.equal(f.kopf.get("access-control-allow-origin"), null, "fremde Herkunft bekommt keinen CORS-Kopf");
    assert.notEqual(f.kopf.get("access-control-allow-origin"), "*");
    // the master area stays without CORS
    const l = await api("/api/liste", { token: s.token, headers: { origin: HERKUNFT } });
    assert.equal(l.kopf.get("access-control-allow-origin"), null);
  } finally { zu(); }
});

test("Kim-sync: halbfertig oder abgelaufen gibt 410, das Aufräumen löscht", async () => {
  const { api, zu, daten, server } = await aufbau({ KIMSYNC_TAGE: "3" });
  try {
    const s = await anmelden(api);
    const { kennung } = await zugangAnlegen(api, s);
    const halb = await api("/api/kimsync/dateien", { method: "POST", body: { kennung, groesse: 100 } });
    const tage = (Date.parse(halb.daten.ablauf) - Date.now()) / 86400000;
    assert.ok(tage > 2.9 && tage <= 3, "KIMSYNC_TAGE gilt: " + tage);
    assert.equal((await api(`/api/kimsync/dateien/${halb.daten.id}`)).status, 410, "nicht fertig → 410");
    const { id } = await videoAblegen(api, kennung, inhalt(100));
    const mp = path.join(daten, "dateien", id, "meta.json");
    const m = JSON.parse(fs.readFileSync(mp, "utf8"));
    m.ablauf = new Date(Date.now() - 1000).toISOString();
    fs.writeFileSync(mp, JSON.stringify(m));
    assert.equal((await api(`/api/kimsync/dateien/${id}`)).status, 410, "abgelaufen → 410");
    assert.equal((await api(`/api/kimsync/dateien/${id}/teil/0`)).status, 410, "abgelaufen → auch kein Teil");
    const weg = await server.aufraeumen(Date.now() + 2 * 86400000);
    assert.equal(weg, 2, "abgelaufenes und liegengebliebenes Video werden gelöscht");
    assert.ok(!fs.existsSync(path.join(daten, "dateien", id)));
  } finally { zu(); }
});

test("Kim-sync: Größengrenze und Widerruf", async () => {
  const { api, zu } = await aufbau({ KIMSYNC_MAX_MB: "1" });
  try {
    const s = await anmelden(api);
    const { kennung, r } = await zugangAnlegen(api, s);
    assert.equal((await api("/api/kimsync/dateien", { method: "POST", body: { kennung, groesse: 2 * 1024 * 1024 } })).status, 413);
    const { id } = await videoAblegen(api, kennung, inhalt(1000));
    assert.equal((await api(`/api/codes/${r.daten.id}`, { method: "DELETE", token: s.token })).status, 200);
    assert.equal((await api(`/api/kimsync/dateien/${id}`)).status, 410, "Widerruf nimmt die Videos mit");
    assert.equal((await api("/api/kimsync/dateien", { method: "POST", body: { kennung, groesse: 10 } })).status, 403, "widerrufener Zugang legt nichts mehr ab");
  } finally { zu(); }
});

test("Kim-sync: eine gewöhnliche Datei ist über Kim-sync nicht lesbar", async () => {
  const { api, zu } = await aufbau();
  try {
    const s = await anmelden(api);
    const ds = await K.neuerDateiSchluessel();
    const neu = await api("/api/dateien", { method: "POST", token: s.token, body: {
      meta: await K.textEinpacken("{}", ds, "meta"), groesse: 10, schluesselHaupt: await K.schluesselEinpacken(ds, s.haupt) } });
    assert.equal(neu.status, 201);
    const { id, schreibToken } = neu.daten;
    const p = await K.teilVerschluesseln(ds, new Uint8Array(10), id, 0, 1);
    assert.equal((await api(`/api/dateien/${id}/teil/0`, { method: "PUT", body: p, headers: { "x-schreib-token": schreibToken } })).status, 200);
    assert.equal((await api(`/api/dateien/${id}/fertig`, { method: "POST", headers: { "x-schreib-token": schreibToken } })).status, 200);
    // the ordinary file is complete and real — and still not reachable over the open Kim-sync route
    assert.equal((await api(`/api/kimsync/dateien/${id}`)).status, 410, "Info");
    assert.equal((await api(`/api/kimsync/dateien/${id}/teil/0`)).status, 410, "Teil");
  } finally { zu(); }
});
