#!/usr/bin/env bash
# Datei-Post auf dem Hetzner-Cloud-Server einrichten (NICHT Termux, NICHT Webhosting).
# Wiederholbar: was schon da ist, wird nicht noch einmal angelegt.
# Vor jeder Änderung eine Sicherung; lehnt Caddy den Block ab, wird zurückgelegt,
# BEVOR neu geladen wird — die bestehenden Seiten bleiben also unberührt.
set -euo pipefail
cd /opt/relay
STEMPEL=$(date +%Y%m%d-%H%M%S)
cp docker-compose.yml "docker-compose.yml.bak-dateipost-$STEMPEL"
cp Caddyfile "Caddyfile.bak-dateipost-$STEMPEL"
echo "== Sicherungen: docker-compose.yml.bak-dateipost-$STEMPEL, Caddyfile.bak-dateipost-$STEMPEL"

mkdir -p /srv/datei-post-daten
chmod 700 /srv/datei-post-daten

if ! grep -q '^  datei-post:' docker-compose.yml; then
  # insert the service right before the top-level "volumes:" line
  awk -v blk=/srv/datei-post/deploy/compose-dienst.yml '
    /^volumes:/ && !x { while ((getline l < blk) > 0) print l; x=1 } { print }' docker-compose.yml > docker-compose.yml.neu
  mv docker-compose.yml.neu docker-compose.yml
  echo "== Dienst datei-post in docker-compose.yml eingetragen"
else
  echo "== Dienst datei-post steht schon in docker-compose.yml"
fi
docker compose config -q || { cp "docker-compose.yml.bak-dateipost-$STEMPEL" docker-compose.yml; echo "!! compose-Datei ungültig, zurückgelegt"; exit 1; }
# the awk insert silently does nothing if there is no top-level "volumes:" line — check the result, not the intent
if ! docker compose config --services | grep -qx datei-post; then
  cp "docker-compose.yml.bak-dateipost-$STEMPEL" docker-compose.yml
  echo "!! Dienst datei-post ist nach dem Eintragen NICHT in der compose-Datei — zurückgelegt. Bitte Ausgabe von: grep -n '^[a-z]' docker-compose.yml"
  exit 1
fi

docker compose up -d datei-post
echo "== Container datei-post läuft"

if ! grep -q 'dateien.family-projekt.de' Caddyfile; then
  cat /srv/datei-post/deploy/Caddyfile.block >> Caddyfile   # >> keeps the inode the container sees
  echo "== Caddy-Block angehängt"
fi
if ! docker exec caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1; then
  cat "Caddyfile.bak-dateipost-$STEMPEL" > Caddyfile
  echo "!! Caddy lehnt die neue Fassung ab — alte Fassung zurückgelegt, nichts neu geladen."
  docker exec caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile || true
  exit 1
fi
docker exec caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
echo "== Caddy neu geladen"

# pull main every 5 minutes; restart only if something changed
ZEILE='*/5 * * * * cd /srv/datei-post && git fetch -q origin main && [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ] && git reset -q --hard origin/main && docker restart datei-post >/dev/null # datei-post auto-deploy'
( crontab -l 2>/dev/null | grep -v 'datei-post auto-deploy'; echo "$ZEILE" ) | crontab -
echo "== Auto-Update alle 5 Minuten eingerichtet"
echo "== fertig. Jetzt noch den Hauptcode setzen (eigener Befehl)."
