import test from "node:test";
import assert from "node:assert/strict";
import * as K from "../public/krypto.js";

test("ein neuer Code hat 12 Zeichen aus dem Alphabet, in Vierergruppen", () => {
  const gesehen = new Set();
  for (let i = 0; i < 200; i++) {
    const c = K.neuerCode();
    assert.match(c, /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/);
    gesehen.add(c);
  }
  assert.equal(gesehen.size, 200, "Codes wiederholen sich");
});

test("Eingabe wird verziehen, wo sie eindeutig ist — sonst nicht", () => {
  assert.equal(K.normalisiereCode("7k4m p2qx-9trb"), "7K4MP2QX9TRB");
  assert.equal(K.normalisiereCode("7K4M-P2QX-9TR"), null, "zu kurz");
  assert.equal(K.normalisiereCode("0K4M-P2QX-9TRB"), null, "0 gibt es nicht");
  assert.equal(K.normalisiereCode(""), null);
  assert.equal(K.normalisiereCode(null), null);
});

test("Ableiten ist fest und trennt Zweck und Code", async () => {
  const a = await K.ableiten("7K4MP2QX9TRB", "code");
  const b = await K.ableiten("7K4MP2QX9TRB", "code");
  const c = await K.ableiten("7K4MP2QX9TRB", "haupt");
  assert.equal(a.kennung, b.kennung);
  assert.notEqual(a.kennung, c.kennung);
  assert.match(a.kennung, /^[0-9a-f]{64}$/);
});

test("Dateischlüssel: einpacken und nur mit dem richtigen Schlüssel auspacken", async () => {
  const ds = await K.neuerDateiSchluessel();
  const { schluessel } = await K.ableiten("AAAABBBBCCCC", "code");
  const { schluessel: falsch } = await K.ableiten("AAAABBBBCCCD", "code");
  const paket = await K.schluesselEinpacken(ds, schluessel);
  const zurueck = await K.schluesselAuspacken(paket, schluessel);
  const t = await K.textEinpacken("hallo", zurueck, "meta");
  assert.equal(await K.textAuspacken(t, ds, "meta"), "hallo");
  await assert.rejects(K.schluesselAuspacken(paket, falsch));
});

test("ein Teil ist an Datei, Stelle und Gesamtzahl gebunden", async () => {
  const ds = await K.neuerDateiSchluessel();
  const bytes = new TextEncoder().encode("Inhalt");
  const p = await K.teilVerschluesseln(ds, bytes, "aa", 1, 3);
  assert.deepEqual(await K.teilEntschluesseln(ds, p, "aa", 1, 3), bytes);
  await assert.rejects(K.teilEntschluesseln(ds, p, "aa", 0, 3), "falsche Stelle");
  await assert.rejects(K.teilEntschluesseln(ds, p, "bb", 1, 3), "fremde Datei");
  await assert.rejects(K.teilEntschluesseln(ds, p, "aa", 1, 2), "letzter Teil weggelassen");
  assert.ok(!Buffer.from(p).includes(Buffer.from("Inhalt")), "Klartext im Paket");
});

test("Teilezahl", () => {
  assert.equal(K.teileFuer(0), 1);
  assert.equal(K.teileFuer(K.TEIL_BYTES), 1);
  assert.equal(K.teileFuer(K.TEIL_BYTES + 1), 2);
});
