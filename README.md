# Datei-Post

Dateien mit einem **Einmal-Code** weitergeben, über den eigenen Server
(`dateien.family-projekt.de`, Hetzner Cloud, Caddy im Docker).

- **Du** meldest dich mit deinem Hauptcode an, lädst eine Datei hoch und bekommst
  einen Code wie `7K4M-P2QX-9TRB` — mit Knöpfen für WhatsApp, E-Mail, Kopieren.
- **Der Empfänger** öffnet die Seite (oder den Link), gibt den Code ein und lädt
  herunter. Nach einem **vollständigen** Download ist der Code verbraucht; ein
  abgebrochener Download am Handy darf wiederholt werden.
- **Die Datei bleibt**, bis du sie löschst. Mit dem Hauptcode erzeugst du jederzeit
  einen neuen Code, siehst offene Codes noch einmal oder ziehst sie zurück.
- **Codes zum Abgeben:** Du erzeugst einen Code, mit dem eine Person **eine** Datei
  für dich ablegen kann. Sie erscheint danach in deiner Liste.

## Was der Server sieht — und was nicht

Alles wird **im Browser** verschlüsselt (AES-256-GCM, WebCrypto), bevor es
hinausgeht. Der Schlüssel steckt im Code; der Code selbst geht nie an den Server,
nur eine daraus abgeleitete Kennung (PBKDF2-SHA256, 600 000 Runden — wie in den
Tresoren der anderen Apps).

| | der Server sieht |
|---|---|
| Inhalt, Dateiname, Dateityp | **nein** — nur verschlüsselt |
| Codes, Hauptcode | **nein** — nur abgeleitete Kennungen |
| Dateigröße, Zeitpunkte, IP-Adressen | **ja** |

Im Link steht der Code hinter `#` — dieser Teil wird vom Browser nie an einen
Server geschickt.

## Benannte Grenzen

- **Wer den Server beherrscht, kann eine veränderte Seite ausliefern**, die Codes
  mitliest. Das gilt für jede Verschlüsselung im Browser; sie schützt die
  **abgelegten** Daten (Einbruch in die Platte, Sicherungskopien), nicht gegen
  den eigenen Server im laufenden Betrieb.
- **„Verbraucht" meldet der Browser des Empfängers.** Ein Empfänger, der das
  absichtlich unterdrückt, kann denselben Code weiter benutzen. Für vertraute
  Personen gebaut, nicht gegen sie.
- **Der Hauptcode lässt sich nicht einfach wechseln:** die Dateischlüssel liegen
  unter ihm. Ein neuer Hauptcode macht die vorhandenen Dateien für dich
  unlesbar (die Codes, die schon draußen sind, funktionieren weiter).
- **Der Download wird im Arbeitsspeicher des Geräts zusammengesetzt.** 100 MB sind
  kein Problem; mehrere GB auf einem Handy sind es wahrscheinlich. Nicht gemessen.
- **Sperre gegen Durchprobieren:** 10 Fehlversuche je Adresse, dann 15 Minuten Pause.
- Platz: ab 80 % belegt warnt die Seite, ab 95 % nimmt sie nichts mehr an — die
  Webseite und das Relais liegen auf derselben Platte.

## Große Videos für Kim-sync

Kim-sync (der Mini-Messenger) schickt Videos über 20 MB nicht über die Relais,
sondern legt sie hier ab — verschlüsselt im Browser, wie jede andere Datei.

1. Mit dem Hauptcode anmelden, **„🎞 Zugang für Kim-sync erzeugen"** drücken.
2. Den Code in Kim-sync unter Einstellungen → „Große Videos" eingeben.

Der Zugangscode ist **wiederverwendbar** (anders als ein Abhol-Code) und kann
nur Videos ablegen. Kim-sync speichert nur die daraus abgeleitete Kennung, nie
den Code. Der Server sieht weder Code noch Dateinamen noch Schlüssel.

| Umgebungsvariable | Vorgabe | |
|---|---|---|
| `KIMSYNC_HERKUNFT` | `https://lausiklauskn-png.github.io` | die **eine** Herkunft, die per CORS lesen und schreiben darf — nie `*` |
| `KIMSYNC_TAGE` | `14` | danach antwortet ein Video mit 410 und wird beim Aufräumen gelöscht |
| `KIMSYNC_MAX_MB` | `1024` | Größengrenze je Video (zusätzlich zur allgemeinen) |

Widerruft man den Zugang, gehen seine Videos mit. Kim-sync-Videos stehen nicht
in der normalen Dateiliste.

## Prüfen

```bash
npm install --no-save playwright-core   # einmalig, für die Browser-Probe
npm test                                 # Krypto · Server · echter Browser
node tests/gegenprobe.mjs                # baut 33 Fehler ein, jeder MUSS auffallen
NUR_ANKER=1 node tests/gegenprobe.mjs    # nur: trifft jeder Anker genau einmal?
```

## Auf dem Server

Siehe [`deploy/EINRICHTEN.md`](deploy/EINRICHTEN.md).
