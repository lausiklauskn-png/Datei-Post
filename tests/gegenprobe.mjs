// Gegenprobe: builds a fault into a THROWAWAY copy and demands that the
// named test turns red. A guard nobody has seen fail is just a green tick.
//   node tests/gegenprobe.mjs          all cases
//   NUR_ANKER=1 node tests/gegenprobe.mjs   only check every anchor hits exactly once
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const WURZEL = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const FAELLE = [
  ["der Code wird nach fertigem Download nicht verbraucht", "server.mjs",
    'c.status = "abgeholt";', 'c.status = "offen";', "verbraucht"],
  ["Durchprobieren wird nicht gesperrt", "server.mjs",
    "const gesperrt = (ip) => {", "const gesperrt = (ip) => { return false;", "Durchprobieren"],
  ["der Code zum Abgeben wird nicht verbraucht", "server.mjs",
    'status: "benutzt", benutzt', 'status: "offen", benutzt', "Code zum Abgeben"],
  ["jede Sitzung gilt als angemeldet", "server.mjs",
    "if (!bis || bis < Date.now())", "if (false)", "ohne Hauptcode"],
  ["der Server liefert jede Datei aus", "server.mjs",
    "if (!STATISCH.has(name))", "if (false)", "ausgeliefert"],
  ["voller Speicher nimmt weiter an", "server.mjs",
    "if (p.voll || (p.frei - groesse) / p.gesamt < 1 - cfg.platzGrenze)", "if (false)", "voller Speicher"],
  ["die Größengrenze fehlt", "server.mjs",
    "if (groesse > cfg.maxBytes)", "if (false)", "zu große Dateien"],
  ["Löschen lässt die Codes stehen", "server.mjs",
    'if (c.dateiId === m[1] && c.art === "abholen") await fsp.rm', 'if (false) await fsp.rm', "löschen nimmt"],
  ["Teile sind nicht an ihre Stelle gebunden", "public/krypto.js",
    "return `teil:${dateiId}:${n}:${teile}`;", 'return "teil";', "gebunden"],
  ["zu große Teile werden angenommen", "server.mjs",
    "if (laenge > max) { zuGross = true; break; }", ";", "fremde Schreib-Token"],
  ["fertig ohne alle Teile", "server.mjs",
    'return antwort(res, 409, { fehler: "unvollstaendig", fehlt: n });', ";", "fremde Schreib-Token"],
  ["ein fremder Schreib-Token darf schreiben", "server.mjs",
    'if (!d || d.fertig || !gleich(sha256(t), d.schreibHash)) return antwort(res, 403, { fehler: "schreiben" });',
    'if (!d || d.fertig) return antwort(res, 403, { fehler: "schreiben" });', "fremde Schreib-Token"],
  ["ein falscher Hauptcode wird angenommen", "server.mjs",
    "return gleich(crypto.scryptSync(kennung, d.salz, 32).toString(\"hex\"), d.hash);", "return true;", "ohne Hauptcode"],
  ["der Code aus dem Link wird nicht eingetragen", "public/app.js",
    "ausAdresse();\nwindow.addEventListener", "window.addEventListener", "im Browser"],
  ["der WhatsApp-Text trägt keinen Code", "public/app.js",
    '$("#teilen-wa").href = "https://wa.me/?text=" + encodeURIComponent(text);', '$("#teilen-wa").href = "https://wa.me/";', "im Browser"],
  ["die Seite setzt Namen als HTML", "public/app.js",
    "for (const k of kinder) e.append(k);", "for (const k of kinder) e.insertAdjacentHTML(\"beforeend\", String(k));", "im Browser"],
];

let tot = 0;
for (const [name, datei, anker] of FAELLE) {
  const n = fs.readFileSync(path.join(WURZEL, datei), "utf8").split(anker).length - 1;
  if (n !== 1) { console.log(`✗ TOTER ANKER (${n}×): ${name}`); tot++; }
}
if (process.env.NUR_ANKER) { console.log(`${FAELLE.length} Anker · ${tot} tot`); process.exit(tot ? 1 : 0); }

let kopie = "";
const lauf = () => {
  try { execFileSync("node", ["--test", "tests/*.test.mjs"], { cwd: kopie, stdio: "pipe", encoding: "utf8" }); return ""; }
  catch (e) { return String(e.stdout || ""); }
};
let gefangen = 0, blind = 0, falsch = 0;
for (const [name, datei, anker, ersatz, erwartet] of FAELLE) {
  // a fresh throwaway copy per case; node_modules is linked, never copied
  kopie = fs.mkdtempSync(path.join(os.tmpdir(), "dp-gegenprobe-"));
  fs.cpSync(WURZEL, kopie, { recursive: true, filter: (p) => !/\/(\.git|node_modules)(\/|$)/.test(p.slice(WURZEL.length)) });
  if (fs.existsSync(path.join(WURZEL, "node_modules"))) fs.symlinkSync(path.join(WURZEL, "node_modules"), path.join(kopie, "node_modules"));
  const ziel = path.join(kopie, datei);
  fs.writeFileSync(ziel, fs.readFileSync(ziel, "utf8").replace(anker, ersatz));
  const aus = lauf();
  const rot = aus.split("\n").filter((z) => /^not ok \d+ - /.test(z)).map((z) => z.replace(/^not ok \d+ - /, ""));
  if (!rot.length) { console.log(`✗ BLIND: ${name}`); blind++; }
  else if (!rot.some((r) => r.includes(erwartet))) { console.log(`✗ ROT AUS FALSCHEM GRUND: ${name} → ${rot.join(" | ")}`); falsch++; }
  else { console.log(`✓ ${name} → ${rot.join(" | ")}`); gefangen++; }
  fs.rmSync(kopie, { recursive: true, force: true });
}
console.log(`\n${gefangen} gefangen · ${blind} blind · ${falsch} aus falschem Grund · ${tot} tote Anker`);
process.exit(blind || falsch || tot ? 1 : 0);
