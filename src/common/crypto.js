/**
 * At-rest encryption primitives — Web Crypto only, no libraries.
 *
 * Scheme (matches what a careful password manager does):
 *   - PBKDF2-SHA256, 250,000 iterations, derives a 256-bit key from the
 *     passphrase and a random 16-byte salt.
 *   - AES-GCM-256 with a random 12-byte IV encrypts the JSON. GCM's auth tag
 *     means a wrong passphrase (or any tampering) fails to decrypt rather than
 *     returning garbage — that is how we detect a bad passphrase.
 *
 * Salt and IV are NOT secret and travel next to the ciphertext. There is no
 * key escrow and no backdoor: without the passphrase the data cannot be read.
 * That is the whole point, and it is why a lost passphrase is unrecoverable.
 *
 * Available in every secure context (popup, service worker, and content
 * scripts on the https TTD pages). Exposed as the `CRYPTOBOX` global.
 */
const CRYPTOBOX = (() => {
  const KDF = 'PBKDF2';
  const HASH = 'SHA-256';
  const ITER = 250000;
  const KDF_LABEL = 'PBKDF2-SHA256';
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const subtle = () => globalThis.crypto.subtle;

  const toB64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
  const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

  function randomBytes(n) {
    const a = new Uint8Array(n);
    globalThis.crypto.getRandomValues(a);
    return a;
  }

  /** Derive an AES-GCM key from a passphrase + salt (extractable, so the raw
   *  bytes can be cached in session storage for the unlocked session). */
  async function deriveKey(passphrase, salt, iterations = ITER) {
    const base = await subtle().importKey(
      'raw', enc.encode(passphrase), { name: KDF }, false, ['deriveKey']);
    return subtle().deriveKey(
      { name: KDF, salt, iterations, hash: HASH },
      base,
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt']);
  }

  /** Encrypt an object with a passphrase → self-describing envelope. */
  async function encryptObject(obj, passphrase, saltBytesOrB64) {
    const salt = saltBytesOrB64
      ? (typeof saltBytesOrB64 === 'string' ? fromB64(saltBytesOrB64) : saltBytesOrB64)
      : randomBytes(16);
    const key = await deriveKey(passphrase, salt);
    const env = await encryptWithKey(obj, key);
    return { v: 1, kdf: KDF_LABEL, iter: ITER, salt: toB64(salt), iv: env.iv, ct: env.ct };
  }

  /** Decrypt an envelope with a passphrase. Throws on a wrong passphrase. */
  async function decryptObject(envelope, passphrase) {
    const key = await deriveKey(passphrase, fromB64(envelope.salt), envelope.iter || ITER);
    return decryptWithKey(envelope, key);
  }

  // --- key-based (fast path: no PBKDF2) for re-encrypting during a session ---

  async function encryptWithKey(obj, key) {
    const iv = randomBytes(12);
    const ct = await subtle().encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj)));
    return { iv: toB64(iv), ct: toB64(ct) };
  }
  async function decryptWithKey(envelope, key) {
    const ptBuf = await subtle().decrypt(
      { name: 'AES-GCM', iv: fromB64(envelope.iv) }, key, fromB64(envelope.ct));
    return JSON.parse(dec.decode(ptBuf));
  }

  /** Export/import the raw derived key so a fresh popup can re-encrypt without
   *  re-prompting for the passphrase (the bytes live only in session memory). */
  async function exportRawKey(key) { return toB64(await subtle().exportKey('raw', key)); }
  async function importRawKey(rawB64) {
    return subtle().importKey('raw', fromB64(rawB64), { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);
  }

  return {
    ITER, KDF_LABEL,
    randomBytes, deriveKey,
    encryptObject, decryptObject,
    encryptWithKey, decryptWithKey,
    exportRawKey, importRawKey,
    toB64, fromB64,
  };
})();

if (typeof module !== 'undefined') module.exports = { CRYPTOBOX };
