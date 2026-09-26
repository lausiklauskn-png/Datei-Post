# Datei-Post auf dem Hetzner-Cloud-Server einrichten

Alle Befehle werden in **Termux auf dem Tablet** eingefügt und melden sich selbst
am Server an (`167.233.204.72`). Nichts davon gehört ins Webhosting.

## 0 · Voraussetzungen

- DNS: Eintrag **A · `dateien` · `167.233.204.72`** beim Anbieter von
  `family-projekt.de` (INWX).
  Prüfen **über den Server** — Termux kennt `getent` nicht (gemessen 2026-09-26):
  `ssh root@167.233.204.72 'getent hosts dateien.family-projekt.de'`
  Zeigt er noch die alte Nummer (Zwischenspeicher bis 1 h), fragt man INWX direkt:
  `ssh root@167.233.204.72 'resolvectl flush-caches; dig +short dateien.family-projekt.de @ns.inwx.de'`
- Der Server muss das Repo holen können (öffentlich, oder mit Deploy-Schlüssel).

## 1 · Holen und einrichten

```bash
ssh root@167.233.204.72 'git clone https://github.com/lausiklauskn-png/Datei-Post.git /srv/datei-post && bash /srv/datei-post/deploy/einrichten.sh'
```

Das Skript sichert `docker-compose.yml` und `Caddyfile` mit Zeitstempel, trägt den
Dienst `datei-post` ein, hängt den Caddy-Block an, prüft ihn **vor** dem Neuladen
(und legt bei Ablehnung die alte Fassung zurück) und richtet ein Auto-Update alle
5 Minuten ein.

## 2 · Hauptcode setzen

```bash
ssh -t root@167.233.204.72 'read -rsp "Hauptcode (mind. 10 Zeichen): " a; echo; read -rsp "Nochmal: " b; echo; printf "%s\n%s\n" "$a" "$b" | docker exec -i datei-post node server.mjs hauptcode-setzen'
```

Die Eingabe erscheint nicht auf dem Schirm. Der Hauptcode steht danach **nirgends**
im Klartext — nur ein doppelt abgeleiteter Prüfwert in `/srv/datei-post-daten`.

## 3 · Prüfen

`https://dateien.family-projekt.de` öffnen → 🔑 Mit Hauptcode anmelden.

## Zurück

```bash
ssh root@167.233.204.72 'cd /opt/relay && ls -1 *.bak-dateipost-*'
```

zeigt die Sicherungen; mit `cp <sicherung> docker-compose.yml` bzw.
`cat <sicherung> > Caddyfile` (nicht `cp` — der Container sieht die Datei über
ihren Inode) und `docker compose up -d && docker exec caddy caddy reload --config /etc/caddy/Caddyfile`
ist der alte Stand zurück. Die Dateien liegen in `/srv/datei-post-daten`.
