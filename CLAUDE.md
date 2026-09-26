# Datei-Post — Sitzungs-Anker

Dateien per **Einmal-Code** über Klaus' Hetzner-Cloud-Server weitergeben,
**im Browser verschlüsselt**. Node 22 ohne Abhängigkeiten, kein Build-Schritt.
Läuft als Container `datei-post` hinter Caddy (`dateien.family-projekt.de`).

## Prüfen

```bash
npm install --no-save playwright-core && npm test
node tests/gegenprobe.mjs      # 21 Fälle, jeder muss rot werden — mit dem richtigen Namen
```

## Was hier leicht kaputtgeht

- **`public/krypto.js` ist die einzige Stelle für Krypto** — Browser UND Server
  (Hauptcode setzen) holen sie dort. Wer `ITERATIONEN`, die Zweck-Salze oder die
  Teil-Bindung ändert, macht jede vorhandene Datei und jeden ausgegebenen Code
  unbrauchbar.
- **Der Server bekommt nie einen Code**, nur `kennung` (abgeleitet). Neue
  Endpunkte dürfen daran nichts ändern.
- **Namen von Fremden sind Text, nie HTML** (`el()` hängt Zeichenketten als
  Textknoten an). Die Browser-Probe lädt eine Datei mit `<b>` im Namen hoch.
- **`STATISCH` in `server.mjs` ist eine geschlossene Liste** — `server.mjs`,
  `daten/` und alles andere wird nie ausgeliefert.
- **Caddyfile auf dem Server nur mit `>>` / `cat >` ändern, nie mit `cp`/`sed -i`**:
  der Container sieht die Datei über ihren Inode.
- Headless-Chromium nennt jeden Download mit Nicht-ASCII-Namen „download" — die
  Probe liest den Namen aus `window.__dateiPost.letzterDownload`.

- **Der E-Mail-Weg wird je Browser gewählt** (`dateipost_mailweg_v1`, Klaus
  2026-09-26: auf einem alten Windows öffnete `mailto:` Edge). Eigene Adressen
  nur `http(s)`; ein unsauberer gespeicherter Wert wird nicht geglaubt.
- **playwright-core muss zum installierten Chromium passen.** Mit 1.63 suchte es
  eine Fassung, die im Behälter fehlt, und die Browser-Probe **hing**, statt rot
  zu werden. Hier: `npm install --no-save playwright-core@1.56.1`.

## Stand auf dem Server (2026-09-26)

Eingerichtet und live: DNS `dateien` → `167.233.204.72` (INWX), Container
`datei-post`, Caddy-Block, Auto-Update alle 5 min, Hauptcode gesetzt. Klaus hat
Hochladen am Tablet und Abholen an einem Windows-Rechner bestätigt.

## Netzweit

Freibrief · frisch von `origin/main` · Ton · kein PII · Ehrlichkeit:
[Sage-Protokol/docs/NETZWEIT.md](https://github.com/lausiklauskn-png/Sage-Protokol/blob/main/docs/NETZWEIT.md)
