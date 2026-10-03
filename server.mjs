// Datei-Post — the server. Node 22, no dependencies.
//
// It stores ciphertext and hands it out again. It never sees a file's
// content, its name, a share code or the master code: all of that is
// encrypted or derived in the browser (public/krypto.js). What it does
// decide is WHO may do WHAT: master session, one-time codes, size, space.
//
//   node server.mjs                     start (PORT, DATEN from env)
//   node server.mjs hauptcode-setzen    set the master code (reads stdin)

import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { ableiten, TEIL_BYTES, teileFuer } from "./public/krypto.js";

const HIER = path.dirname(fileURLToPath(import.meta.url));
const OEFFENTLICH = path.join(HIER, "public");

export function einstellungen(env = process.env) {
  return {
    port: Number(env.PORT || 8080),
    daten: env.DATEN || path.join(HIER, "daten"),
    maxBytes: Number(env.MAX_DATEI_MB || 4096) * 1024 * 1024,
    platzGrenze: Number(env.PLATZ_GRENZE ?? 0.95),
    warnGrenze: Number(env.WARN_GRENZE ?? 0.8),
    fehlerMax: Number(env.FEHLER_MAX || 10),
    sperrMs: Number(env.SPERR_MINUTEN || 15) * 60 * 1000,
    // Kim-sync (a messenger on another origin) parks big videos here.
    // Only that origin gets CORS headers, never "*".
    kimsyncHerkunft: env.KIMSYNC_HERKUNFT || "https://lausiklauskn-png.github.io",
    kimsyncTage: Number(env.KIMSYNC_TAGE || 14),
    kimsyncMaxBytes: Number(env.KIMSYNC_MAX_MB || 1024) * 1024 * 1024,
  };
}

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const zufall = (n = 32) => crypto.randomBytes(n).toString("hex");
const gleich = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const istHex = (s, n) => typeof s === "string" && new RegExp(`^[0-9a-f]{${n}}$`).test(s);
const istB64 = (s, max = 4096) => typeof s === "string" && s.length > 0 && s.length <= max && /^[A-Za-z0-9+/=]+$/.test(s);

// ── master code ─────────────────────────────────────────────────────
// The browser derives a verifier ("kennung") from the master code with
// 600k PBKDF2; only that verifier is sent. Here it goes through scrypt
// once more, so a leaked hauptcode.json is not a login.
export async function hauptcodeSetzen(daten, hauptcode) {
  if (String(hauptcode).length < 10) throw new Error("Der Hauptcode braucht mindestens 10 Zeichen.");
  const { kennung } = await ableiten(hauptcode, "haupt");
  const salz = zufall(16);
  const hash = crypto.scryptSync(kennung, salz, 32).toString("hex");
  await fsp.mkdir(daten, { recursive: true });
  const ziel = path.join(daten, "hauptcode.json");
  await fsp.writeFile(ziel, JSON.stringify({ salz, hash, gesetzt: new Date().toISOString() }), { mode: 0o600 });
}

function hauptcodePruefen(daten, kennung) {
  let d;
  try { d = JSON.parse(fs.readFileSync(path.join(daten, "hauptcode.json"), "utf8")); }
  catch { return "fehlt"; }
  if (!istHex(kennung, 64)) return false;
  return gleich(crypto.scryptSync(kennung, d.salz, 32).toString("hex"), d.hash);
}

// ── storage ─────────────────────────────────────────────────────────
function pfade(daten) {
  return {
    dateien: path.join(daten, "dateien"),
    codes: path.join(daten, "codes"),
  };
}
const dateiOrdner = (daten, id) => path.join(pfade(daten).dateien, id);
const codeDatei = (daten, kh) => path.join(pfade(daten).codes, kh + ".json");

async function jsonLesen(p) {
  try { return JSON.parse(await fsp.readFile(p, "utf8")); } catch { return null; }
}
async function jsonSchreiben(p, obj) {
  const tmp = p + "." + zufall(4) + ".tmp";
  await fsp.writeFile(tmp, JSON.stringify(obj));
  await fsp.rename(tmp, p); // never a half-written record
}

export function platz(daten, cfg) {
  const s = fs.statfsSync(daten);
  const gesamt = s.blocks * s.bsize;
  const frei = s.bavail * s.bsize;
  const anteil = gesamt ? 1 - frei / gesamt : 1;
  return { gesamt, frei, belegt: gesamt - frei, anteil,
    warnung: anteil >= cfg.warnGrenze, voll: anteil >= cfg.platzGrenze };
}

// ── server ──────────────────────────────────────────────────────────
const TYPEN = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json" };
const STATISCH = new Set(["index.html", "app.js", "krypto.js", "style.css", "icon.svg", "manifest.webmanifest"]);

export function starten(cfg = einstellungen()) {
  for (const p of Object.values(pfade(cfg.daten))) fs.mkdirSync(p, { recursive: true });
  const sitzungen = new Map();   // token -> expiry
  const fehlversuche = new Map(); // ip -> { n, bis }

  const ipVon = (req) => String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
  const gesperrt = (ip) => { const f = fehlversuche.get(ip); return f && f.n >= cfg.fehlerMax && f.bis > Date.now(); };
  const fehler = (ip) => {
    const f = fehlversuche.get(ip);
    if (!f || f.bis <= Date.now()) fehlversuche.set(ip, { n: 1, bis: Date.now() + cfg.sperrMs });
    else f.n++;
  };

  function antwort(res, code, obj, kopf = {}) {
    const body = obj === undefined ? "" : JSON.stringify(obj);
    res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...kopf });
    res.end(body);
  }
  async function jsonKoerper(req, max = 64 * 1024) {
    const teile = []; let n = 0;
    for await (const c of req) { n += c.length; if (n > max) throw Object.assign(new Error("zu gross"), { status: 413 }); teile.push(c); }
    try { return JSON.parse(Buffer.concat(teile).toString("utf8") || "{}"); }
    catch { throw Object.assign(new Error("kein JSON"), { status: 400 }); }
  }
  function hauptOk(req) {
    const t = String(req.headers.authorization || "").replace(/^Bearer /, "");
    const bis = sitzungen.get(t);
    if (!bis || bis < Date.now()) { if (bis) sitzungen.delete(t); return false; }
    return true;
  }
  async function codeLesen(kennung) {
    if (!istHex(kennung, 64)) return null;
    const kh = sha256(kennung);
    const c = await jsonLesen(codeDatei(cfg.daten, kh));
    return c ? { ...c, kh } : null;
  }

  async function dateiAnlegen(req, res, ip) {
    const b = await jsonKoerper(req);
    let uploadCode = null;
    if (!hauptOk(req)) {
      if (gesperrt(ip)) return antwort(res, 429, { fehler: "gesperrt" });
      uploadCode = await codeLesen(b.uploadKennung);
      if (!uploadCode || uploadCode.art !== "hochladen" || uploadCode.status !== "offen") {
        fehler(ip); return antwort(res, 403, { fehler: "code" });
      }
    }
    const groesse = Number(b.groesse);
    if (!Number.isInteger(groesse) || groesse < 0) return antwort(res, 400, { fehler: "groesse" });
    if (groesse > cfg.maxBytes) return antwort(res, 413, { fehler: "zu_gross", max: cfg.maxBytes });
    if (!istB64(b.meta)) return antwort(res, 400, { fehler: "meta" });
    if (uploadCode ? !istB64(b.schluesselUpload) : !istB64(b.schluesselHaupt)) return antwort(res, 400, { fehler: "schluessel" });
    const p = platz(cfg.daten, cfg);
    if (p.voll || (p.frei - groesse) / p.gesamt < 1 - cfg.platzGrenze) return antwort(res, 507, { fehler: "voll", platz: p });

    const id = zufall(12);
    const schreib = zufall(32);
    await fsp.mkdir(path.join(dateiOrdner(cfg.daten, id), "teile"), { recursive: true });
    await jsonSchreiben(path.join(dateiOrdner(cfg.daten, id), "meta.json"), {
      id, meta: b.meta, groesse, teile: teileFuer(groesse), erstellt: new Date().toISOString(), fertig: false,
      schluesselHaupt: uploadCode ? null : b.schluesselHaupt,
      schluesselUpload: uploadCode ? b.schluesselUpload : null,
      uploadCode: uploadCode ? uploadCode.kh.slice(0, 16) : null,
      schreibHash: sha256(schreib),
    });
    antwort(res, 201, { id, teile: teileFuer(groesse), schreibToken: schreib });
  }

  async function dateiLesen(id) {
    if (!istHex(id, 24)) return null;
    return jsonLesen(path.join(dateiOrdner(cfg.daten, id), "meta.json"));
  }

  async function teilSchreiben(req, res, id, n) {
    const d = await dateiLesen(id);
    const t = String(req.headers["x-schreib-token"] || "");
    if (!d || d.fertig || !gleich(sha256(t), d.schreibHash)) return antwort(res, 403, { fehler: "schreiben" });
    if (!(n >= 0 && n < d.teile)) return antwort(res, 400, { fehler: "teil" });
    const max = TEIL_BYTES + 28;
    const ziel = path.join(dateiOrdner(cfg.daten, id), "teile", n + ".bin");
    const tmp = ziel + "." + zufall(4) + ".tmp";
    const aus = fs.createWriteStream(tmp);
    let laenge = 0, zuGross = false;
    try {
      for await (const c of req) {
        laenge += c.length;
        if (laenge > max) { zuGross = true; break; }
        if (!aus.write(c)) await new Promise((r) => aus.once("drain", r));
      }
    } finally { await new Promise((r) => aus.end(r)); }
    if (zuGross || laenge < 28) { await fsp.rm(tmp, { force: true }); return antwort(res, zuGross ? 413 : 400, { fehler: "teilgroesse" }); }
    await fsp.rename(tmp, ziel);
    antwort(res, 200, { ok: true, n });
  }

  async function dateiFertig(req, res, id) {
    const d = await dateiLesen(id);
    const t = String(req.headers["x-schreib-token"] || "");
    if (!d || !gleich(sha256(t), d.schreibHash)) return antwort(res, 403, { fehler: "schreiben" });
    for (let n = 0; n < d.teile; n++) {
      if (!fs.existsSync(path.join(dateiOrdner(cfg.daten, id), "teile", n + ".bin"))) return antwort(res, 409, { fehler: "unvollstaendig", fehlt: n });
    }
    d.fertig = true;
    delete d.schreibHash;
    await jsonSchreiben(path.join(dateiOrdner(cfg.daten, id), "meta.json"), d);
    if (d.uploadCode) {
      const c = await codeNachId(d.uploadCode);
      if (c) { const { kh, ...ohne } = c; await jsonSchreiben(codeDatei(cfg.daten, kh), { ...ohne, status: "benutzt", benutzt: new Date().toISOString(), dateiId: id }); }
    }
    antwort(res, 200, { ok: true });
  }

  // ── Kim-sync ──────────────────────────────────────────────────────
  // A reusable access code (art "kimsync") lets the messenger store
  // encrypted video parts. The server keeps no name, no type, no key:
  // only size, part count and expiry. The file key travels inside the
  // encrypted room message, never here.
  const KS_KOPF = (req) => {
    const o = req.headers.origin;
    return o && o === cfg.kimsyncHerkunft ? { "access-control-allow-origin": o, vary: "origin" } : { vary: "origin" };
  };
  async function ksAnlegen(req, res, ip) {
    const kopf = KS_KOPF(req);
    if (gesperrt(ip)) return antwort(res, 429, { fehler: "gesperrt" }, kopf);
    const b = await jsonKoerper(req);
    const c = await codeLesen(b.kennung);
    if (!c || c.art !== "kimsync" || c.status !== "offen") { fehler(ip); return antwort(res, 403, { fehler: "code" }, kopf); }
    const groesse = Number(b.groesse);
    if (!Number.isInteger(groesse) || groesse < 1) return antwort(res, 400, { fehler: "groesse" }, kopf);
    const max = Math.min(cfg.maxBytes, cfg.kimsyncMaxBytes);
    if (groesse > max) return antwort(res, 413, { fehler: "zu_gross", max }, kopf);
    const p = platz(cfg.daten, cfg);
    if (p.voll || p.frei - groesse < (1 - cfg.platzGrenze) * p.gesamt) return antwort(res, 507, { fehler: "voll" }, kopf);
    const id = zufall(12);
    const schreib = zufall(32);
    const ablauf = new Date(Date.now() + cfg.kimsyncTage * 86400 * 1000).toISOString();
    await fsp.mkdir(path.join(dateiOrdner(cfg.daten, id), "teile"), { recursive: true });
    await jsonSchreiben(path.join(dateiOrdner(cfg.daten, id), "meta.json"), {
      id, art: "kimsync", groesse, teile: teileFuer(groesse), erstellt: new Date().toISOString(), ablauf,
      fertig: false, kimsyncCode: c.kh.slice(0, 16), schreibHash: sha256(schreib),
    });
    antwort(res, 201, { id, teile: teileFuer(groesse), schreibToken: schreib, ablauf }, kopf);
  }
  const ksAbgelaufen = (d) => !d.ablauf || Date.parse(d.ablauf) <= Date.now();
  async function ksDatei(req, res, id, rest) {
    const kopf = KS_KOPF(req);
    const d = await dateiLesen(id);
    if (!d || d.art !== "kimsync") return antwort(res, 410, { fehler: "geloescht" }, kopf);
    if (req.method === "PUT" || (req.method === "POST" && rest === "/fertig")) {
      if (ksAbgelaufen(d)) return antwort(res, 410, { fehler: "abgelaufen" }, kopf);
      for (const [k, v] of Object.entries(kopf)) res.setHeader(k, v);
      const m = rest.match(/^\/teil\/(\d+)$/);
      if (req.method === "PUT" && m) return teilSchreiben(req, res, id, Number(m[1]));
      if (req.method === "POST") return dateiFertig(req, res, id);
      return antwort(res, 404, { fehler: "weg" }, kopf);
    }
    if (req.method !== "GET") return antwort(res, 405, {}, kopf);
    if (!d.fertig) return antwort(res, 410, { fehler: "unvollstaendig" }, kopf);
    if (ksAbgelaufen(d)) return antwort(res, 410, { fehler: "abgelaufen" }, kopf);
    if (!rest) return antwort(res, 200, { id: d.id, groesse: d.groesse, teile: d.teile, ablauf: d.ablauf }, kopf);
    const m = rest.match(/^\/teil\/(\d+)$/);
    if (!m || Number(m[1]) >= d.teile) return antwort(res, 404, { fehler: "teil" }, kopf);
    const p = path.join(dateiOrdner(cfg.daten, d.id), "teile", Number(m[1]) + ".bin");
    const st = await fsp.stat(p);
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": st.size, "cache-control": "no-store", ...kopf });
    return fs.createReadStream(p).pipe(res);
  }
  // Expired Kim-sync files go away; so do uploads that never finished
  // (a day is plenty for a phone on mobile data).
  async function aufraeumen(jetzt = Date.now()) {
    let weg = 0;
    for (const id of await fsp.readdir(pfade(cfg.daten).dateien).catch(() => [])) {
      const d = await dateiLesen(id);
      if (!d || d.art !== "kimsync") continue;
      const alt = !d.fertig && Date.parse(d.erstellt) + 86400 * 1000 <= jetzt;
      if (Date.parse(d.ablauf) <= jetzt || alt) { await fsp.rm(dateiOrdner(cfg.daten, id), { recursive: true, force: true }); weg++; }
    }
    return weg;
  }

  async function alleCodes() {
    const out = [];
    for (const f of await fsp.readdir(pfade(cfg.daten).codes)) {
      if (!f.endsWith(".json")) continue;
      const c = await jsonLesen(path.join(pfade(cfg.daten).codes, f));
      if (c) out.push({ ...c, kh: f.slice(0, -5) });
    }
    return out;
  }
  async function codeNachId(codeId) {
    if (!istHex(codeId, 16)) return null;
    return (await alleCodes()).find((c) => c.kh.startsWith(codeId)) || null;
  }
  const codeAussen = (c) => ({ id: c.kh.slice(0, 16), art: c.art, status: c.status, erstellt: c.erstellt,
    abgeholt: c.abgeholt || null, benutzt: c.benutzt || null, codeHaupt: c.codeHaupt, dateiId: c.dateiId || null });

  async function liste(res) {
    const codes = await alleCodes();
    const dateien = [];
    for (const id of await fsp.readdir(pfade(cfg.daten).dateien)) {
      const d = await dateiLesen(id);
      if (!d || !d.fertig || d.art === "kimsync") continue;
      dateien.push({ id: d.id, meta: d.meta, groesse: d.groesse, teile: d.teile, erstellt: d.erstellt,
        schluesselHaupt: d.schluesselHaupt, schluesselUpload: d.schluesselUpload, uploadCode: d.uploadCode,
        codes: codes.filter((c) => c.art === "abholen" && c.dateiId === d.id).map(codeAussen) });
    }
    dateien.sort((a, b) => b.erstellt.localeCompare(a.erstellt));
    const uploadCodes = codes.filter((c) => c.art === "hochladen").map(codeAussen);
    const ks = [];
    for (const id of await fsp.readdir(pfade(cfg.daten).dateien)) {
      const d = await dateiLesen(id);
      if (d && d.art === "kimsync" && d.fertig) ks.push(d);
    }
    const kimsyncCodes = codes.filter((c) => c.art === "kimsync").map((c) => {
      const meine = ks.filter((d) => d.kimsyncCode === c.kh.slice(0, 16));
      return { ...codeAussen(c), videos: meine.length, bytes: meine.reduce((s, d) => s + d.groesse, 0) };
    });
    antwort(res, 200, { dateien, uploadCodes, kimsyncCodes, kimsync: { tage: cfg.kimsyncTage, herkunft: cfg.kimsyncHerkunft }, platz: platz(cfg.daten, cfg) });
  }

  async function codeAnlegen(req, res, art, dateiId) {
    const b = await jsonKoerper(req);
    if (!istHex(b.kennung, 64) || !istB64(b.codeHaupt)) return antwort(res, 400, { fehler: "code" });
    if (art === "abholen") {
      const d = await dateiLesen(dateiId);
      if (!d || !d.fertig) return antwort(res, 404, { fehler: "datei" });
      if (!istB64(b.schluessel)) return antwort(res, 400, { fehler: "schluessel" });
    }
    const kh = sha256(b.kennung);
    if (fs.existsSync(codeDatei(cfg.daten, kh))) return antwort(res, 409, { fehler: "doppelt" });
    const c = { art, status: "offen", erstellt: new Date().toISOString(), codeHaupt: b.codeHaupt,
      dateiId: art === "abholen" ? dateiId : null, schluessel: art === "abholen" ? b.schluessel : null };
    await jsonSchreiben(codeDatei(cfg.daten, kh), c);
    antwort(res, 201, codeAussen({ ...c, kh }));
  }

  async function abholen(req, res, ip, kennung, rest) {
    if (gesperrt(ip)) return antwort(res, 429, { fehler: "gesperrt" });
    const c = await codeLesen(kennung);
    if (!c || c.art !== "abholen") { fehler(ip); return antwort(res, 404, { fehler: "code" }); }
    if (c.status !== "offen") return antwort(res, 410, { fehler: c.status });
    const d = await dateiLesen(c.dateiId);
    if (!d || !d.fertig) return antwort(res, 410, { fehler: "geloescht" });
    if (!rest && req.method === "GET") {
      return antwort(res, 200, { dateiId: d.id, meta: d.meta, groesse: d.groesse, teile: d.teile, schluessel: c.schluessel });
    }
    const m = rest.match(/^\/teil\/(\d+)$/);
    if (m && req.method === "GET") {
      const n = Number(m[1]);
      if (n >= d.teile) return antwort(res, 404, { fehler: "teil" });
      const p = path.join(dateiOrdner(cfg.daten, d.id), "teile", n + ".bin");
      const st = await fsp.stat(p);
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": st.size, "cache-control": "no-store" });
      return fs.createReadStream(p).pipe(res);
    }
    if (rest === "/fertig" && req.method === "POST") {
      c.status = "abgeholt"; c.abgeholt = new Date().toISOString();
      const { kh, ...ohne } = c;
      await jsonSchreiben(codeDatei(cfg.daten, kh), ohne);
      return antwort(res, 200, { ok: true });
    }
    antwort(res, 404, { fehler: "weg" });
  }

  async function statisch(res, url) {
    const name = url === "/" ? "index.html" : url.slice(1);
    if (!STATISCH.has(name)) return antwort(res, 404, { fehler: "nicht gefunden" });
    const body = await fsp.readFile(path.join(OEFFENTLICH, name));
    res.writeHead(200, { "content-type": TYPEN[path.extname(name)] || "application/octet-stream",
      "cache-control": "no-cache",
      "content-security-policy": "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" });
    res.end(body);
  }

  const server = http.createServer(async (req, res) => {
    const ip = ipVon(req);
    const url = new URL(req.url, "http://x").pathname;
    try {
      if (!url.startsWith("/api/")) return req.method === "GET" ? await statisch(res, url) : antwort(res, 405, {});
      let m;
      if (url === "/api/anmelden" && req.method === "POST") {
        if (gesperrt(ip)) return antwort(res, 429, { fehler: "gesperrt" });
        const b = await jsonKoerper(req);
        const ok = hauptcodePruefen(cfg.daten, b.kennung);
        if (ok === "fehlt") return antwort(res, 503, { fehler: "kein_hauptcode" });
        if (!ok) { fehler(ip); return antwort(res, 401, { fehler: "falsch" }); }
        const token = zufall(32);
        sitzungen.set(token, Date.now() + 12 * 3600 * 1000);
        return antwort(res, 200, { token });
      }
      if (url === "/api/dateien" && req.method === "POST") return await dateiAnlegen(req, res, ip);
      if ((m = url.match(/^\/api\/dateien\/([0-9a-f]+)\/teil\/(\d+)$/)) && req.method === "PUT") return await teilSchreiben(req, res, m[1], Number(m[2]));
      if ((m = url.match(/^\/api\/dateien\/([0-9a-f]+)\/fertig$/)) && req.method === "POST") return await dateiFertig(req, res, m[1]);
      if ((m = url.match(/^\/api\/hochladen\/([0-9a-f]{64})$/)) && req.method === "GET") {
        if (gesperrt(ip)) return antwort(res, 429, { fehler: "gesperrt" });
        const c = await codeLesen(m[1]);
        if (!c || c.art !== "hochladen") { fehler(ip); return antwort(res, 404, { fehler: "code" }); }
        if (c.status !== "offen") return antwort(res, 410, { fehler: c.status });
        return antwort(res, 200, { ok: true, maxBytes: cfg.maxBytes });
      }
      if ((m = url.match(/^\/api\/abholen\/([0-9a-f]{64})(\/.*)?$/))) return await abholen(req, res, ip, m[1], m[2] || "");
      if (url.startsWith("/api/kimsync/")) {
        if (req.method === "OPTIONS") {
          const kopf = KS_KOPF(req);
          if (!kopf["access-control-allow-origin"]) { res.writeHead(403, { vary: "origin" }); return res.end(); }
          res.writeHead(204, { ...kopf, "access-control-allow-methods": "GET, POST, PUT, OPTIONS",
            "access-control-allow-headers": "content-type, x-schreib-token", "access-control-max-age": "600" });
          return res.end();
        }
        if (url === "/api/kimsync/dateien" && req.method === "POST") return await ksAnlegen(req, res, ip);
        if ((m = url.match(/^\/api\/kimsync\/dateien\/([0-9a-f]{24})(\/.*)?$/))) return await ksDatei(req, res, m[1], m[2] || "");
        return antwort(res, 404, { fehler: "weg" }, KS_KOPF(req));
      }

      // everything below: master only
      if (!hauptOk(req)) return antwort(res, 401, { fehler: "anmelden" });
      if (url === "/api/liste" && req.method === "GET") return await liste(res);
      if (url === "/api/upload-codes" && req.method === "POST") return await codeAnlegen(req, res, "hochladen");
      if (url === "/api/kimsync-codes" && req.method === "POST") return await codeAnlegen(req, res, "kimsync");
      if ((m = url.match(/^\/api\/dateien\/([0-9a-f]{24})\/codes$/)) && req.method === "POST") return await codeAnlegen(req, res, "abholen", m[1]);
      if ((m = url.match(/^\/api\/dateien\/([0-9a-f]{24})\/haupt$/)) && req.method === "POST") {
        const d = await dateiLesen(m[1]); const b = await jsonKoerper(req);
        if (!d) return antwort(res, 404, {});
        if (!istB64(b.schluesselHaupt)) return antwort(res, 400, {});
        d.schluesselHaupt = b.schluesselHaupt;
        await jsonSchreiben(path.join(dateiOrdner(cfg.daten, d.id), "meta.json"), d);
        return antwort(res, 200, { ok: true });
      }
      if ((m = url.match(/^\/api\/dateien\/([0-9a-f]{24})$/)) && req.method === "DELETE") {
        if (!(await dateiLesen(m[1]))) return antwort(res, 404, {});
        for (const c of await alleCodes()) if (c.dateiId === m[1] && c.art === "abholen") await fsp.rm(codeDatei(cfg.daten, c.kh), { force: true });
        await fsp.rm(dateiOrdner(cfg.daten, m[1]), { recursive: true, force: true });
        return antwort(res, 200, { ok: true });
      }
      if ((m = url.match(/^\/api\/codes\/([0-9a-f]{16})$/)) && req.method === "DELETE") {
        const c = await codeNachId(m[1]);
        if (!c) return antwort(res, 404, {});
        await fsp.rm(codeDatei(cfg.daten, c.kh), { force: true });
        if (c.art === "kimsync") { // its videos go with it
          for (const id of await fsp.readdir(pfade(cfg.daten).dateien).catch(() => [])) {
            const d = await dateiLesen(id);
            if (d && d.art === "kimsync" && d.kimsyncCode === m[1]) await fsp.rm(dateiOrdner(cfg.daten, id), { recursive: true, force: true });
          }
        }
        return antwort(res, 200, { ok: true });
      }
      if (url === "/api/abmelden" && req.method === "POST") {
        sitzungen.delete(String(req.headers.authorization || "").replace(/^Bearer /, ""));
        return antwort(res, 200, { ok: true });
      }
      antwort(res, 404, { fehler: "weg" });
    } catch (e) {
      if (!res.headersSent) antwort(res, e.status || 500, { fehler: e.status ? e.message : "server" });
      if (!e.status) console.error(e);
    }
  });
  server.requestTimeout = 0; // a 100 MB upload over mobile must not be cut off
  const putzer = setInterval(() => aufraeumen().catch((e) => console.error(e)), 3600 * 1000);
  putzer.unref();
  server.on("close", () => clearInterval(putzer));
  server.aufraeumen = aufraeumen; // for the probe
  return server;
}

// ── entry ───────────────────────────────────────────────────────────
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cfg = einstellungen();
  if (process.argv[2] === "hauptcode-setzen") {
    const zeilen = fs.readFileSync(0, "utf8").split(/\r?\n/);
    const [a, b] = zeilen;
    if (!a || a !== b) { console.error("Die zwei Eingaben stimmen nicht überein. Nichts geändert."); process.exit(2); }
    if (fs.existsSync(path.join(cfg.daten, "hauptcode.json")) && !process.argv.includes("--neu")) {
      console.error("Es gibt schon einen Hauptcode. Ein neuer macht die vorhandenen Dateien für dich unlesbar.\nWer das will, hängt --neu an.");
      process.exit(2);
    }
    try { await hauptcodeSetzen(cfg.daten, a); } catch (e) { console.error(e.message); process.exit(2); }
    console.log("Hauptcode gesetzt.");
  } else {
    starten(cfg).listen(cfg.port, () => console.log(`Datei-Post hört auf ${cfg.port}, Daten in ${cfg.daten}`));
  }
}
