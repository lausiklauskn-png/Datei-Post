/* Knopf „Installieren" (Klaus 2026-09-30).
 *
 * Anlass: am Tablet stand „App konnte nicht geöffnet werden", während die Seite
 * offen war. Die Meldung kommt NICHT von der Seite (sie trägt den Satz nirgends),
 * sondern von Android/Chrome. Der Knopf zeigt, was der Browser über die
 * Installation weiß:
 *   · läuft die Seite schon als installierte App  → kein Knopf, keine Meldung
 *                                                   (Klaus 2026-10-02: „Es ist nichts mehr zu tun“)
 *   · der Browser bietet die Installation an      → Tipp öffnet seinen Dialog
 *   · er bietet sie nicht an                      → Tipp nennt die Gründe und den
 *                                                   Weg über das Chrome-Menü
 * Am Tablet bestätigt im Sende-Prüfer (#38) und im Auslieferungsprüfer (#24).
 * Deutsch und Englisch nach <html lang>; fehlt die Datei, fehlt nur der Knopf.
 * Texte nur über textContent. */
(function () {
  "use strict";
  var ereignis = null;
  /* Gemeinsame Fassung (Sage, Mein-Tresor, Jasons-Tresor, 2026-09-30), aus dem
     Auslieferungsprüfer: <script src="…installieren.js" data-name="App" data-vor="knopf-id">.
     data-vor nennt den Knopf, VOR den der neue kommt; dessen Klasse wird übernommen. */
  var me = document.currentScript;
  var NAME = (me && me.getAttribute("data-name")) || document.title;
  var VOR = (me && me.getAttribute("data-vor")) || "";
  /* data-fest: der Knopf steht fest oben rechts ÜBER allem. Nötig in den Tresoren —
     dort liegt beim Öffnen der Eingang (Safe, Tür) über der Kopfleiste und verdeckte
     ihn (Klaus 2026-09-30: „kein Installieren-Button gewesen“). */
  var FEST = !!(me && me.hasAttribute("data-fest"));
  /* data-in (Klaus 2026-10-18: „unter Einstellungen, Installier-Button hinten … wie bei meinem
     Rezeptbuch“): ein CSS-Selektor für den Behälter der Einstellungen. Der Knopf wird dort HINTEN
     angehängt — auch wenn der Behälter erst später entsteht (Fenster beim Öffnen gebaut).
     data-klasse: Klasse für diesen Knopf (sonst die des letzten Knopfs im Behälter).
     data-vor und data-in dürfen zusammen stehen: dann gibt es zwei Knöpfe, beide verschwinden,
     sobald die App installiert ist. */
  var IN = (me && me.getAttribute("data-in")) || "";
  var KLASSE = (me && me.getAttribute("data-klasse")) || "";
  var OBEN = 2147483000;

  function alsApp() {
    try {
      return (window.matchMedia && (matchMedia("(display-mode: standalone)").matches ||
        matchMedia("(display-mode: window-controls-overlay)").matches ||
        matchMedia("(display-mode: minimal-ui)").matches)) || navigator.standalone === true;
    } catch (_e) { return false; }
  }

  function en() { return document.documentElement.lang === "en"; }
  function T(de, eng) { return en() ? eng : de; }

  function melde(text) {
    var m = document.getElementById("install-meldung");
    if (!m) {
      m = document.createElement("div");
      m.id = "install-meldung";
      m.setAttribute("role", "status");
      m.style.cssText = "position:fixed;right:12px;top:64px;z-index:" + (OBEN + 1) + ";max-width:min(420px,calc(100vw - 24px));" +
        "background:var(--flaeche,#fff);color:inherit;border:1px solid var(--linie,#ccc);border-radius:12px;" +
        "padding:12px 14px;box-shadow:0 10px 30px rgb(0 0 0/.2);font-size:.9rem;line-height:1.4;white-space:pre-line";
      var zu = document.createElement("button");
      zu.type = "button"; zu.className = "knopf"; zu.textContent = "✕";
      zu.setAttribute("aria-label", "Meldung schließen");
      zu.style.cssText = "float:right;margin:-4px -4px 4px 8px";
      zu.addEventListener("click", function () { m.hidden = true; });
      m.appendChild(zu);
      var t = document.createElement("span"); t.id = "install-meldung-text"; m.appendChild(t);
      document.body.appendChild(m);
      lesbar(m);
    }
    document.getElementById("install-meldung-text").textContent = text;
    m.hidden = false;
  }

  /* Lesbar machen (Klaus 2026-10-18, Handy: „helle Schrift auf hellem Hintergrund“).
     color:inherit erbt die Schrift der Seite, --flaeche fehlt in manchen Apps → weiß.
     Ist der Kontrast unter 4,5, steht die Meldung fest dunkel auf weiß. */
  function farbe(c) {
    var z = String(c).match(/[\d.]+/g); if (!z || z.length < 3) return null;
    var a = z.length > 3 ? +z[3] : 1; return a < 0.5 ? null : [+z[0], +z[1], +z[2]];
  }
  function hell(f) {
    var l = f.map(function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    return 0.2126 * l[0] + 0.7152 * l[1] + 0.0722 * l[2];
  }
  function kontrast(a, b) { var x = hell(a), y = hell(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }
  function lesbar(m) {
    try {
      var s = getComputedStyle(m), g = farbe(s.backgroundColor), t = farbe(s.color);
      if (!g || !t || kontrast(g, t) < 4.5) {
        m.style.background = "#fff"; m.style.color = "#1a1a1a"; m.style.borderColor = "#bbb";
        m.setAttribute("data-lesbar", "fest");
      } else m.setAttribute("data-lesbar", "seite");
    } catch (_e) { m.style.background = "#fff"; m.style.color = "#1a1a1a"; }
  }

  function knopfZeichnen() {
    var alle = document.querySelectorAll("[data-install-knopf]");
    for (var i = 0; i < alle.length; i++) zeichneEinen(alle[i]);
  }
  function zeichneEinen(k) {
    var app = alsApp();
    k.hidden = app; k.style.display = app ? "none" : "";   /* als App: weg, nicht „✓ App“ */
    k.dataset.lage = app ? "app" : (ereignis ? "angeboten" : "nicht-angeboten");
    k.querySelector("[data-z]").textContent = app ? "✓" : "⬇";
    k.querySelector(".t").textContent = app ? " App" : T(" Installieren", " Install");
    k.title = app ? T("Läuft als installierte App", "Running as installed app") :
      (ereignis ? T("Als App installieren", "Install as app") :
        T("Installieren — der Browser bietet es gerade nicht an, ein Tipp sagt warum",
          "Install — the browser is not offering it right now, tap to see why"));
    k.setAttribute("aria-label", k.title);
  }

  function klick() {
    if (alsApp()) return;   /* als App gibt es keinen Knopf (Klaus 2026-10-02) */
    if (ereignis) {
      var e = ereignis; ereignis = null;
      e.prompt();
      e.userChoice.then(function (w) {
        melde(w && w.outcome === "accepted"
          ? T("Installiert. Die App liegt jetzt auf dem Startbildschirm bzw. in der App-Liste.",
              "Installed. The app is now on the home screen or in the app list.")
          : T("Nicht installiert — abgebrochen.", "Not installed — cancelled."));
        knopfZeichnen();
      }).catch(function () { knopfZeichnen(); });
      return;
    }
    melde(T("Der Browser bietet die Installation gerade nicht an.\n\n" +
      "Häufigster Grund: Chrome hält ihn schon für installiert. Trägt das Symbol auf dem Startbildschirm " +
      "ein kleines Chrome-Zeichen, ist es nur eine VERKNÜPFUNG (öffnet in Chrome), keine App.\n\n" +
      "So wird es eine App: Symbol lange drücken → Entfernen bzw. Deinstallieren, diese Seite neu laden, " +
      "dann hier „Installieren“ tippen.\n\n" +
      "Sonst von Hand: Chrome ⋮ → „App installieren“ bzw. „Zum Startbildschirm hinzufügen“.\n\n" +
      "„App konnte nicht geöffnet werden“ kommt vom Gerät, nicht von dieser Seite. Hilft nichts: " +
      "die App unter Android-Einstellungen → Apps deinstallieren, Chrome ganz schließen, diese Seite neu laden und noch einmal installieren. Bitte NICHT „Websitedaten löschen“: alle Apps unter dieser Adresse teilen sich einen Speicher, das löschte die Daten aller.",
      "The browser is not offering installation right now.\n\n" +
      "Most common reason: Chrome thinks it is already installed. If the home-screen icon carries a small " +
      "Chrome badge, it is only a SHORTCUT (opens in Chrome), not an app.\n\n" +
      "To make it an app: long-press the icon → Remove or Uninstall, reload this page, then tap “Install” here.\n\n" +
      "Otherwise by hand: Chrome ⋮ → “Install app” or “Add to home screen”.\n\n" +
      "“App could not be opened” comes from the device, not from this page. If nothing helps: " +
      "uninstall the app under Android Settings → Apps, close Chrome completely, reload this page and install again. Please do NOT “delete site data”: all apps at this address share one storage, that would delete the data of all of them."));
  }

  function neuerKnopf(id, klasse) {
    var k = document.createElement("button");
    k.type = "button"; k.className = klasse || ""; k.id = id; k.setAttribute("data-install-knopf", "");
    var z = document.createElement("span"); z.setAttribute("aria-hidden", "true"); z.setAttribute("data-z", "");
    var t = document.createElement("span"); t.className = "t";
    k.appendChild(z); k.appendChild(t);
    k.addEventListener("click", klick);
    return k;
  }

  /* In den Einstellungen: hinten an den Behälter (data-in). */
  function einstellungenEinhaengen() {
    if (!IN) return;
    var b; try { b = document.querySelector(IN); } catch (_e) { return; }
    if (!b || b.querySelector("[data-install-knopf]")) return;
    var muster = b.querySelectorAll("button");
    var k = neuerKnopf("installieren-einstellungen",
      KLASSE || (muster.length ? muster[muster.length - 1].className : ""));
    k.setAttribute("data-ort", "einstellungen");
    b.appendChild(k);
    zeichneEinen(k);
  }

  function einhaengen() {
    einstellungenEinhaengen();
    if (IN) {
      try {
        var wartet = false;
        new MutationObserver(function () {
          if (wartet) return; wartet = true;
          (window.requestAnimationFrame || setTimeout)(function () { wartet = false; einstellungenEinhaengen(); });
        }).observe(document.body, { childList: true, subtree: true });
      } catch (_e) {}
    }
    if (document.getElementById("installieren")) return;
    var vor = VOR && document.getElementById(VOR);
    if (!vor || !vor.parentNode) {
      try { new MutationObserver(knopfZeichnen).observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] }); } catch (_e) {}
      return;
    }
    var k = neuerKnopf("installieren", vor.className);
    if (vor.getAttribute("style")) k.setAttribute("style", vor.getAttribute("style"));
    vor.parentNode.insertBefore(k, vor);
    if (FEST) { k.style.position = "fixed"; k.style.top = "10px"; k.style.right = "10px"; k.style.left = "auto"; k.style.bottom = "auto"; k.style.margin = "0"; k.style.zIndex = String(OBEN); k.setAttribute("data-fest", ""); }
    /* Die Sprache kann nach dem Laden wechseln — dann neu beschriften. */
    try { new MutationObserver(knopfZeichnen).observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] }); } catch (_e) {}
    knopfZeichnen();
  }

  window.addEventListener("beforeinstallprompt", function (e) {
    e.preventDefault(); ereignis = e; knopfZeichnen();
  });
  window.addEventListener("appinstalled", function () {
    ereignis = null; knopfZeichnen(); melde("Installiert.");
  });
  try { matchMedia("(display-mode: standalone)").addEventListener("change", knopfZeichnen); } catch (_e) {}

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", einhaengen);
  else einhaengen();

  window.APP_INSTALL = { alsApp: alsApp, lage: function () { var k = document.querySelector("[data-install-knopf]"); return k ? k.dataset.lage : null; } };
})();
