// Datei-Post — the page. All encryption happens here (krypto.js).
import * as K from "./krypto.js";

const $ = (s) => document.querySelector(s);
const sitzung = { token: null, schluessel: null };

// ── small helpers ───────────────────────────────────────────────────
function el(tag, attrs = {}, ...kinder) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "onclick") e.addEventListener("click", v); else e.setAttribute(k, v);
  }
  for (const k of kinder) e.append(k); // strings become text nodes: no HTML from outside
  return e;
}
function melden(text, art = "") {
  const m = $("#meldung");
  m.textContent = text;
  m.className = "meldung " + art;
}
function groesse(b) {
  if (b < 1024) return b + " B";
  if (b < 1024 ** 2) return (b / 1024).toFixed(0) + " KB";
  if (b < 1024 ** 3) return (b / 1024 ** 2).toFixed(1).replace(".", ",") + " MB";
  return (b / 1024 ** 3).toFixed(2).replace(".", ",") + " GB";
}
const datum = (iso) => iso ? new Date(iso).toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" }) : "";
function fortschritt(text, wert) {
  const f = $("#fortschritt");
  if (text === null) { f.hidden = true; return; }
  f.hidden = false;
  $("#fortschritt-text").textContent = text;
  $("#fortschritt-balken").value = wert ?? 0;
}
function zeige(id) {
  for (const s of ["start", "abholen", "hochladen", "haupt"]) $("#" + s).hidden = s !== id;
  melden("");
}
const FEHLER = {
  code: "Diesen Code kennt der Server nicht. Bitte genau abschreiben.",
  abgeholt: "Dieser Code wurde schon benutzt. Bitte beim Absender einen neuen anfragen.",
  benutzt: "Mit diesem Code wurde schon eine Datei abgegeben.",
  geloescht: "Die Datei gibt es nicht mehr.",
  gesperrt: "Zu viele falsche Versuche. Bitte in 15 Minuten noch einmal.",
  voll: "Der Speicher auf dem Server ist voll. Der Absender muss erst Platz schaffen.",
  zu_gross: "Die Datei ist größer, als der Server annimmt.",
  falsch: "Der Hauptcode stimmt nicht.",
  kein_hauptcode: "Auf dem Server ist noch kein Hauptcode eingerichtet.",
};
async function api(pfad, opt = {}) {
  const kopf = { ...(opt.headers || {}) };
  if (sitzung.token) kopf.authorization = "Bearer " + sitzung.token;
  let body = opt.body;
  if (body && !(body instanceof Uint8Array)) { body = JSON.stringify(body); kopf["content-type"] = "application/json"; }
  let r;
  try { r = await fetch(pfad, { method: opt.method || "GET", headers: kopf, body }); }
  catch { throw new Error("Keine Verbindung zum Server."); }
  if (opt.roh && r.ok) return r;
  const daten = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (r.status === 401 && sitzung.token && daten.fehler === "anmelden") { abmelden(); throw new Error("Die Anmeldung ist abgelaufen. Bitte neu anmelden."); }
    const e = new Error(FEHLER[daten.fehler] || `Der Server hat abgelehnt (${r.status}).`);
    e.status = r.status; e.fehler = daten.fehler; throw e;
  }
  return daten;
}
const warten = (ms) => new Promise((r) => setTimeout(r, ms));
async function mitWiederholung(fn, versuche = 3) {
  for (let i = 1; ; i++) {
    try { return await fn(); }
    catch (e) { if (i >= versuche || (e.status && e.status < 500 && e.status !== 429)) throw e; await warten(1500 * i); }
  }
}
function codeAusFeld(sel) {
  const roh = K.normalisiereCode($(sel).value);
  if (!roh) throw new Error("Ein Code hat 12 Zeichen, zum Beispiel 7K4M-P2QX-9TRB.");
  return roh;
}

// ── upload (shared by master and by upload codes) ──────────────────
async function verschluesseltHochladen(datei, { schluesselHaupt, uploadKennung, schluesselUpload, dateiSchluessel }) {
  const meta = await K.textEinpacken(JSON.stringify({ name: datei.name, typ: datei.type, groesse: datei.size }), dateiSchluessel, "meta");
  const neu = await api("/api/dateien", { method: "POST", body: { meta, groesse: datei.size, schluesselHaupt, uploadKennung, schluesselUpload } });
  for (let n = 0; n < neu.teile; n++) {
    fortschritt(`Verschlüsseln und hochladen … Teil ${n + 1} von ${neu.teile}`, n / neu.teile);
    const bytes = new Uint8Array(await datei.slice(n * K.TEIL_BYTES, (n + 1) * K.TEIL_BYTES).arrayBuffer());
    const paket = await K.teilVerschluesseln(dateiSchluessel, bytes, neu.id, n, neu.teile);
    await mitWiederholung(() => api(`/api/dateien/${neu.id}/teil/${n}`, { method: "PUT", body: paket, headers: { "x-schreib-token": neu.schreibToken } }));
  }
  await mitWiederholung(() => api(`/api/dateien/${neu.id}/fertig`, { method: "POST", headers: { "x-schreib-token": neu.schreibToken } }));
  fortschritt(null);
  return neu.id;
}

// ── share panel ────────────────────────────────────────────────────
function teilenZeigen(code, art) {
  const link = `${location.origin}${location.pathname}#${art}=${code}`;
  const text = art === "abholen"
    ? `Hier ist eine Datei für dich:\n${link}\n\nCode: ${code}\nDer Code gilt für ein Mal.`
    : `Hier kannst du mir eine Datei schicken:\n${link}\n\nCode: ${code}\nDer Code gilt für eine Datei.`;
  $("#teilen-titel").textContent = art === "abholen" ? "Code zum Abholen" : "Code zum Abgeben";
  $("#teilen-code").textContent = code;
  $("#teilen-hinweis").textContent = art === "abholen"
    ? "Gilt für einen vollständigen Download. Du findest den Code später auch in deiner Liste."
    : "Die Person kann damit genau eine Datei für dich ablegen.";
  $("#teilen-wa").href = "https://wa.me/?text=" + encodeURIComponent(text);
  teilenText = text;
  $("#mail-wahl").hidden = true;
  mailGemerktZeigen();
  $("#teilen-kopie").onclick = async () => {
    try { await navigator.clipboard.writeText(text); melden("In die Zwischenablage kopiert.", "gut"); }
    catch { melden("Kopieren ging nicht. Bitte den Code oben abschreiben.", "fehler"); }
  };
  $("#teilen-system").hidden = !navigator.share;
  $("#teilen-system").onclick = () => navigator.share({ title: "Datei-Post", text }).catch(() => {});
  $("#teilen").hidden = false;
  $("#teilen").scrollIntoView({ behavior: "smooth", block: "center" });
}
$("#teilen-zu").onclick = () => { $("#teilen").hidden = true; };

// ── e-mail: which program, remembered per browser ──────────────────
// A mailto: link opens whatever the DEVICE has registered — on an old
// Windows that is often Edge, not the mail program. So the user picks
// once; the choice lives in this browser only (github.io-style shared
// origins are not an issue here, but the key is app-specific anyway).
let teilenText = "";
const MAILWEG_SCHLUESSEL = "dateipost_mailweg_v1";
const enc = encodeURIComponent;
const MAILWEGE = {
  geraet: { name: "das E-Mail-Programm dieses Geräts", adresse: (b, t) => `mailto:?subject=${enc(b)}&body=${enc(t)}` },
  gmail: { name: "Gmail", adresse: (b, t) => `https://mail.google.com/mail/?view=cm&fs=1&su=${enc(b)}&body=${enc(t)}` },
  outlook: { name: "Outlook.com", adresse: (b, t) => `https://outlook.live.com/mail/0/deeplink/compose?subject=${enc(b)}&body=${enc(t)}` },
  eigen: { name: null, adresse: null },
};
// Only http(s) — never javascript:, data: or anything else. A missing scheme
// ("www.gmx.net") gets https:// in front.
function eigeneAdresse(roh) {
  let s = String(roh || "").trim();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = "https://" + s;
  try { const u = new URL(s); return (u.protocol === "https:" || u.protocol === "http:") && u.hostname.includes(".") ? u.href : null; }
  catch { return null; }
}
function mailwegLesen() {
  try {
    const w = JSON.parse(localStorage.getItem(MAILWEG_SCHLUESSEL) || "null");
    if (w && MAILWEGE[w.weg] && (w.weg !== "eigen" || eigeneAdresse(w.adresse) === w.adresse)) return w;
  } catch { /* storage blocked or garbage: ask again */ }
  return null;
}
function mailGemerktZeigen() {
  const w = mailwegLesen();
  $("#mail-gemerkt").hidden = !w;
  if (w) $("#mail-gemerkt-name").textContent = w.weg === "eigen" ? new URL(w.adresse).hostname : MAILWEGE[w.weg].name;
}
function mailSenden(w) {
  if (w.weg === "eigen") {
    // start the copy while this page still has focus, THEN open the tab
    let kopiert;
    try { kopiert = navigator.clipboard.writeText(teilenText); } catch (e) { kopiert = Promise.reject(e); }
    window.__dateiPost.letzteMail = w.adresse;
    window.open(w.adresse, "_blank", "noopener");
    kopiert.then(() => melden("Der Text ist kopiert. In der neuen Mail einfügen.", "gut"),
      () => melden("Kopieren ging nicht. Bitte zuerst „Kopieren“ drücken, dann einfügen.", "fehler"));
    return;
  }
  const url = MAILWEGE[w.weg].adresse("Datei-Post", teilenText);
  window.__dateiPost.letzteMail = url;
  if (w.weg === "geraet") location.href = url;
  else window.open(url, "_blank", "noopener");
}
function mailWahlOeffnen() {
  const w = mailwegLesen();
  for (const r of document.querySelectorAll('input[name="mailweg"]')) r.checked = !!w && r.value === w.weg;
  $("#mail-eigen").value = w && w.weg === "eigen" ? w.adresse : "";
  $("#mail-eigen-teil").hidden = !(w && w.weg === "eigen");
  $("#mail-wahl").hidden = false;
}
for (const r of document.querySelectorAll('input[name="mailweg"]')) {
  r.addEventListener("change", () => { $("#mail-eigen-teil").hidden = r.value !== "eigen" || !r.checked; });
}
$("#teilen-mail").onclick = () => { const w = mailwegLesen(); if (w) mailSenden(w); else mailWahlOeffnen(); };
$("#mail-aendern").onclick = mailWahlOeffnen;
$("#mail-abbrechen").onclick = () => { $("#mail-wahl").hidden = true; };
$("#mail-ok").onclick = () => {
  const gewaehlt = document.querySelector('input[name="mailweg"]:checked');
  if (!gewaehlt) return melden("Bitte eine Möglichkeit wählen.", "fehler");
  const w = { weg: gewaehlt.value };
  if (w.weg === "eigen") {
    w.adresse = eigeneAdresse($("#mail-eigen").value);
    if (!w.adresse) return melden("Das ist keine Internet-Adresse. Beispiel: https://www.gmx.net", "fehler");
  }
  try { localStorage.setItem(MAILWEG_SCHLUESSEL, JSON.stringify(w)); } catch { /* still send once */ }
  $("#mail-wahl").hidden = true;
  mailGemerktZeigen();
  mailSenden(w);
};

// ── pick up ────────────────────────────────────────────────────────
let abholung = null;
$("#abholen-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  $("#abholen-datei").hidden = true;
  try {
    const roh = codeAusFeld("#abholen-code");
    fortschritt("Code wird geprüft … das dauert ein paar Sekunden.", 0);
    const { schluessel, kennung } = await K.ableiten(roh, "code");
    const info = await api("/api/abholen/" + kennung);
    const dateiSchluessel = await K.schluesselAuspacken(info.schluessel, schluessel);
    const meta = JSON.parse(await K.textAuspacken(info.meta, dateiSchluessel, "meta"));
    abholung = { kennung, info, dateiSchluessel, meta };
    $("#abholen-name").textContent = `${meta.name} · ${groesse(info.groesse)}`;
    $("#abholen-datei").hidden = false;
    fortschritt(null); melden("");
  } catch (e) { fortschritt(null); melden(e.message, "fehler"); }
});
$("#abholen-los").addEventListener("click", async () => {
  const a = abholung; if (!a) return;
  $("#abholen-los").disabled = true;
  try {
    const teile = [];
    for (let n = 0; n < a.info.teile; n++) {
      fortschritt(`Herunterladen und entschlüsseln … Teil ${n + 1} von ${a.info.teile}`, n / a.info.teile);
      const r = await mitWiederholung(() => api(`/api/abholen/${a.kennung}/teil/${n}`, { roh: true }));
      teile.push(await K.teilEntschluesseln(a.dateiSchluessel, await r.arrayBuffer(), a.info.dateiId, n, a.info.teile));
    }
    const blob = new Blob(teile, { type: a.meta.typ || "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const link = el("a", { href: url, download: a.meta.name });
    document.body.append(link); link.click(); link.remove();
    window.__dateiPost.letzterDownload = a.meta.name;
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    await api(`/api/abholen/${a.kennung}/fertig`, { method: "POST" });
    fortschritt(null);
    melden(`„${a.meta.name}" ist heruntergeladen. Der Code ist damit verbraucht.`, "gut");
    $("#abholen-datei").hidden = true; abholung = null;
  } catch (e) {
    fortschritt(null);
    melden(e.message + " Der Code gilt weiter, du kannst es noch einmal versuchen.", "fehler");
  } finally { $("#abholen-los").disabled = false; }
});

// ── hand in with an upload code ────────────────────────────────────
$("#hochladen-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const knopf = ev.submitter; if (knopf) knopf.disabled = true;
  try {
    const roh = codeAusFeld("#hochladen-code");
    const datei = $("#hochladen-datei").files[0];
    if (!datei) throw new Error("Bitte eine Datei wählen.");
    fortschritt("Code wird geprüft … das dauert ein paar Sekunden.", 0);
    const { schluessel, kennung } = await K.ableiten(roh, "code");
    const pruef = await api("/api/hochladen/" + kennung);
    if (datei.size > pruef.maxBytes) throw new Error(FEHLER.zu_gross);
    const dateiSchluessel = await K.neuerDateiSchluessel();
    const schluesselUpload = await K.schluesselEinpacken(dateiSchluessel, schluessel);
    await verschluesseltHochladen(datei, { uploadKennung: kennung, schluesselUpload, dateiSchluessel });
    melden(`„${datei.name}" ist abgegeben. Der Code ist damit verbraucht.`, "gut");
    $("#hochladen-form").reset();
  } catch (e) { fortschritt(null); melden(e.message, "fehler"); }
  finally { if (knopf) knopf.disabled = false; }
});

// ── master area ─────────────────────────────────────────────────────
$("#anmelden").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  try {
    fortschritt("Anmelden … das dauert ein paar Sekunden.", 0);
    const { schluessel, kennung } = await K.ableiten($("#hauptcode").value, "haupt");
    const { token } = await api("/api/anmelden", { method: "POST", body: { kennung } });
    sitzung.token = token; sitzung.schluessel = schluessel;
    $("#hauptcode").value = "";
    fortschritt(null);
    zeige("haupt");
    await listeZeichnen();
  } catch (e) { fortschritt(null); melden(e.message, "fehler"); }
});
function abmelden() {
  if (sitzung.token) fetch("/api/abmelden", { method: "POST", headers: { authorization: "Bearer " + sitzung.token } }).catch(() => {});
  sitzung.token = null; sitzung.schluessel = null;
  $("#teilen").hidden = true;
  zeige("start");
}
$("#abmelden").onclick = abmelden;

async function codeFuerDatei(dateiId, dateiSchluessel) {
  const code = K.neuerCode();
  const { schluessel, kennung } = await K.ableiten(K.normalisiereCode(code), "code");
  await api(`/api/dateien/${dateiId}/codes`, { method: "POST", body: {
    kennung,
    schluessel: await K.schluesselEinpacken(dateiSchluessel, schluessel),
    codeHaupt: await K.textEinpacken(code, sitzung.schluessel, "code"),
  } });
  return code;
}

$("#haupt-hochladen").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const knopf = ev.submitter; if (knopf) knopf.disabled = true;
  try {
    const datei = $("#haupt-datei").files[0];
    if (!datei) throw new Error("Bitte eine Datei wählen.");
    const dateiSchluessel = await K.neuerDateiSchluessel();
    const schluesselHaupt = await K.schluesselEinpacken(dateiSchluessel, sitzung.schluessel);
    const id = await verschluesseltHochladen(datei, { schluesselHaupt, dateiSchluessel });
    fortschritt("Code wird erzeugt …", 1);
    const code = await codeFuerDatei(id, dateiSchluessel);
    fortschritt(null);
    $("#haupt-hochladen").reset();
    teilenZeigen(code, "abholen");
    await listeZeichnen();
  } catch (e) { fortschritt(null); melden(e.message, "fehler"); }
  finally { if (knopf) knopf.disabled = false; }
});

$("#upload-code-neu").addEventListener("click", async () => {
  try {
    fortschritt("Code wird erzeugt …", 0);
    const code = K.neuerCode();
    const { kennung } = await K.ableiten(K.normalisiereCode(code), "code");
    await api("/api/upload-codes", { method: "POST", body: { kennung, codeHaupt: await K.textEinpacken(code, sitzung.schluessel, "code") } });
    fortschritt(null);
    teilenZeigen(code, "hochladen");
    await listeZeichnen();
  } catch (e) { fortschritt(null); melden(e.message, "fehler"); }
});

// A file handed in by someone else carries its key under THEIR code.
// The master's browser opens it once and re-wraps it under the master key.
async function dateiSchluesselFuer(d, uploadCodes) {
  if (d.schluesselHaupt) return K.schluesselAuspacken(d.schluesselHaupt, sitzung.schluessel);
  const uc = uploadCodes.find((c) => c.id === d.uploadCode);
  if (!uc) throw new Error("Code zum Abgeben fehlt");
  const code = await K.textAuspacken(uc.codeHaupt, sitzung.schluessel, "code");
  const { schluessel } = await K.ableiten(K.normalisiereCode(code), "code");
  const ds = await K.schluesselAuspacken(d.schluesselUpload, schluessel);
  await api(`/api/dateien/${d.id}/haupt`, { method: "POST", body: { schluesselHaupt: await K.schluesselEinpacken(ds, sitzung.schluessel) } });
  return ds;
}

const STATUS = { offen: "offen", abgeholt: "abgeholt", benutzt: "benutzt" };
async function listeZeichnen() {
  const daten = await api("/api/liste");
  const p = daten.platz;
  const platzEl = $("#platz");
  platzEl.className = "platz" + (p.voll ? " voll" : p.warnung ? " warn" : "");
  platzEl.querySelector("span").style.width = (p.anteil * 100).toFixed(1) + "%";
  platzEl.querySelector("p").textContent = `${groesse(p.belegt)} von ${groesse(p.gesamt)} belegt (${Math.round(p.anteil * 100)} %)`
    + (p.voll ? " · voll, neue Dateien werden nicht angenommen" : p.warnung ? " · bitte bald aufräumen" : "");

  const liste = $("#liste"); liste.replaceChildren();
  if (!daten.dateien.length) liste.append(el("li", { class: "info" }, "Noch keine Dateien."));
  for (const d of daten.dateien) {
    const li = el("li");
    liste.append(li);
    let ds = null, meta = { name: "(nicht lesbar)" };
    try {
      ds = await dateiSchluesselFuer(d, daten.uploadCodes);
      meta = JSON.parse(await K.textAuspacken(d.meta, ds, "meta"));
    } catch { /* stays "(nicht lesbar)" — e.g. after a master code change */ }
    const herkunft = d.uploadCode ? " · von jemandem abgegeben" : "";
    li.append(el("div", { class: "name" }, meta.name), el("div", { class: "info" }, `${groesse(d.groesse)} · ${datum(d.erstellt)}${herkunft}`));
    const codes = el("ul", { class: "codes" });
    for (const c of d.codes) {
      const zeile = el("li", {}, `Code vom ${datum(c.erstellt)}: ${STATUS[c.status] || c.status}${c.abgeholt ? " am " + datum(c.abgeholt) : ""} `);
      if (c.status === "offen") {
        zeile.append(el("button", { onclick: async () => {
          try { teilenZeigen(await K.textAuspacken(c.codeHaupt, sitzung.schluessel, "code"), "abholen"); } catch (e) { melden(e.message, "fehler"); }
        } }, "zeigen"), " ", el("button", { onclick: async () => {
          if (!confirm("Diesen Code zurückziehen? Er funktioniert danach nicht mehr.")) return;
          try { await api("/api/codes/" + c.id, { method: "DELETE" }); await listeZeichnen(); } catch (e) { melden(e.message, "fehler"); }
        } }, "zurückziehen"));
      }
      codes.append(zeile);
    }
    if (d.codes.length) li.append(codes);
    li.append(el("div", { class: "aktionen" },
      el("button", { onclick: async () => {
        if (!ds) return melden("Diese Datei lässt sich mit dem jetzigen Hauptcode nicht öffnen.", "fehler");
        try { teilenZeigen(await codeFuerDatei(d.id, ds), "abholen"); await listeZeichnen(); } catch (e) { melden(e.message, "fehler"); }
      } }, "🔗 Neuer Code"),
      el("button", { onclick: async () => {
        if (!confirm(`„${meta.name}" endgültig löschen? Alle Codes dafür hören auf zu funktionieren.`)) return;
        try { await api("/api/dateien/" + d.id, { method: "DELETE" }); await listeZeichnen(); } catch (e) { melden(e.message, "fehler"); }
      } }, "🗑 Löschen")));
  }

  const ul = $("#upload-liste"); ul.replaceChildren();
  const offen = daten.uploadCodes.filter((c) => c.status === "offen");
  if (!offen.length) ul.append(el("li", { class: "info" }, "Keine."));
  for (const c of offen) {
    ul.append(el("li", {}, `Code vom ${datum(c.erstellt)} `,
      el("button", { onclick: async () => {
        try { teilenZeigen(await K.textAuspacken(c.codeHaupt, sitzung.schluessel, "code"), "hochladen"); } catch (e) { melden(e.message, "fehler"); }
      } }, "zeigen"), " ",
      el("button", { onclick: async () => {
        if (!confirm("Diesen Code zurückziehen?")) return;
        try { await api("/api/codes/" + c.id, { method: "DELETE" }); await listeZeichnen(); } catch (e) { melden(e.message, "fehler"); }
      } }, "zurückziehen")));
  }
}

// ── navigation + link with code ─────────────────────────────────────
$("#zu-abholen").onclick = () => zeige("abholen");
$("#zu-hochladen").onclick = () => zeige("hochladen");
for (const b of document.querySelectorAll(".zurueck")) b.onclick = () => zeige("start");

// The code rides in the #fragment: browsers never send it to the server.
function ausAdresse() {
  const m = location.hash.match(/^#(abholen|hochladen)=([A-Za-z0-9-]+)$/);
  if (!m) return;
  zeige(m[1]);
  $(`#${m[1]}-code`).value = m[2];
  history.replaceState(null, "", location.pathname); // keep it out of the history list
}
ausAdresse();
window.addEventListener("hashchange", ausAdresse);
window.__dateiPost = { sitzung }; // for the browser probe
