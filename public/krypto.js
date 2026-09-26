// Datei-Post — shared crypto (browser AND Node 22, WebCrypto only).
// Everything secret happens here, on the device. The server only ever
// sees ciphertext, opaque lookup ids and a verifier for the master code.

const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();

// No 0/O, 1/I/L: a code is read aloud and typed from WhatsApp.
export const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export const CODE_LAENGE = 12;            // 31^12 ≈ 2^59
export const ITERATIONEN = 600000;        // same as the other apps' vaults
export const TEIL_BYTES = 8 * 1024 * 1024; // plaintext per chunk

export function b64(bytes) {
  let s = "";
  const u = new Uint8Array(bytes);
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}
export function unb64(text) {
  const s = atob(text);
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u;
}
function hex(bytes) {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function neuerCode() {
  const out = [];
  const buf = new Uint8Array(1);
  while (out.length < CODE_LAENGE) {
    globalThis.crypto.getRandomValues(buf);
    if (buf[0] < 248) out.push(ALPHABET[buf[0] % 31]); // 248 = 8*31, no bias
  }
  return formatiereCode(out.join(""));
}

export function formatiereCode(roh) {
  return roh.match(/.{1,4}/g).join("-");
}

// Returns the 12 canonical characters or null. Typing mistakes that are
// unambiguous (lowercase, spaces, dashes) are forgiven; anything else is not.
export function normalisiereCode(eingabe) {
  const s = String(eingabe || "").toUpperCase().replace(/[\s\-_.]/g, "");
  if (s.length !== CODE_LAENGE) return null;
  for (const c of s) if (!ALPHABET.includes(c)) return null;
  return s;
}

// One slow derivation, two outputs: an AES key that never leaves the
// device, and a lookup id ("kennung") the server may see. Both come from
// the same 600k PBKDF2, so guessing a code offline is as slow as guessing
// the key itself.
export async function ableiten(geheimnis, zweck) {
  const basis = await subtle.importKey("raw", enc.encode(geheimnis), "PBKDF2", false, ["deriveBits"]);
  const bits = new Uint8Array(await subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: enc.encode("datei-post:" + zweck), iterations: ITERATIONEN },
    basis, 512));
  const schluessel = await subtle.importKey("raw", bits.slice(0, 32), "AES-GCM", false, ["encrypt", "decrypt"]);
  return { schluessel, kennung: hex(bits.slice(32)) };
}

export async function neuerDateiSchluessel() {
  return subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
}

async function verschluesselt(schluessel, bytes, zusatz) {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const p = { name: "AES-GCM", iv };
  if (zusatz) p.additionalData = enc.encode(zusatz);
  const ct = new Uint8Array(await subtle.encrypt(p, schluessel, bytes));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv); out.set(ct, 12);
  return out;
}
async function entschluesselt(schluessel, paket, zusatz) {
  const u = new Uint8Array(paket);
  const p = { name: "AES-GCM", iv: u.subarray(0, 12) };
  if (zusatz) p.additionalData = enc.encode(zusatz);
  return new Uint8Array(await subtle.decrypt(p, schluessel, u.subarray(12)));
}

// File key wrapped by a derived key (code or master). Base64 text.
export async function schluesselEinpacken(dateiSchluessel, mitSchluessel) {
  const roh = await subtle.exportKey("raw", dateiSchluessel);
  return b64(await verschluesselt(mitSchluessel, roh, "dateischluessel"));
}
export async function schluesselAuspacken(paket, mitSchluessel) {
  const roh = await entschluesselt(mitSchluessel, unb64(paket), "dateischluessel");
  return subtle.importKey("raw", roh, "AES-GCM", true, ["encrypt", "decrypt"]);
}

// Small text (file name, a code shown again later) under a key.
export async function textEinpacken(text, schluessel, zweck) {
  return b64(await verschluesselt(schluessel, enc.encode(text), zweck));
}
export async function textAuspacken(paket, schluessel, zweck) {
  return dec.decode(await entschluesselt(schluessel, unb64(paket), zweck));
}

// A chunk is bound to its file, its position and the total: the server
// cannot reorder, swap between files, or silently drop the last chunk.
function teilZusatz(dateiId, n, teile) { return `teil:${dateiId}:${n}:${teile}`; }
export async function teilVerschluesseln(dateiSchluessel, bytes, dateiId, n, teile) {
  return verschluesselt(dateiSchluessel, bytes, teilZusatz(dateiId, n, teile));
}
export async function teilEntschluesseln(dateiSchluessel, paket, dateiId, n, teile) {
  return entschluesselt(dateiSchluessel, paket, teilZusatz(dateiId, n, teile));
}

export function teileFuer(groesse) {
  return Math.max(1, Math.ceil(groesse / TEIL_BYTES));
}
