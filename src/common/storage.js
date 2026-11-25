/**
 * Thin wrapper over api.storage.local.
 *
 * Everything stays on this machine — there is no server, no sync, no
 * telemetry. api.storage.sync is deliberately avoided: it would push ID
 * numbers through Google's sync servers, and caps at 8 KB per item anyway.
 */

const KEYS = {
  STORE: 'profile',    // key name kept from v1 so existing installs migrate
  MAPPINGS: 'mappings',
};

// ---------------------------------------------------- at-rest encryption
//
// Opt-in. When ON, the profile store lives ONLY as an AES-GCM ciphertext in
// local storage (key 'vault'); the plaintext 'profile' key is removed from
// disk. On unlock, the decrypted store + the raw key are cached in
// chrome.storage.session (memory only, cleared when the browser closes), so
// the content script can read it and the popup can re-encrypt on save without
// re-prompting. A lost passphrase is unrecoverable by design.
const VAULT_KEY = 'vault';
const SESSION_STORE = 'profile';  // decrypted store, in session (memory only)
const SESSION_DEK = 'dek';        // raw AES key (base64), in session

async function sessionGet(key) {
  try { const o = await api.storage.session.get(key); return o[key]; } catch { return undefined; }
}
async function sessionSet(obj) { try { await api.storage.session.set(obj); } catch { /* no session */ } }
async function sessionClear() { try { await api.storage.session.remove([SESSION_STORE, SESSION_DEK]); } catch { /* */ } }

async function getVault() {
  const { [VAULT_KEY]: v } = await api.storage.local.get(VAULT_KEY);
  return v || null;
}
async function isEncrypted() { return !!(await getVault()); }
async function vaultHint() { return (await getVault())?.hint || ''; }

/** Unlocked = nothing to unlock, or the decrypted copy is present in session. */
async function isUnlocked() {
  if (!(await isEncrypted())) return true;
  return (await sessionGet(SESSION_STORE)) != null;
}

/** Load the store. When encrypted AND locked, returns null — the caller must
 *  show the unlock screen rather than treating it as an empty store. */
async function getStore() {
  if (await isEncrypted()) {
    const s = await sessionGet(SESSION_STORE);
    return s == null ? null : migrateStore(s);
  }
  const { [KEYS.STORE]: stored } = await api.storage.local.get(KEYS.STORE);
  return migrateStore(stored);
}

async function saveStore(store) {
  if (await isEncrypted()) {
    const rawKey = await sessionGet(SESSION_DEK);
    if (!rawKey) throw new Error('locked'); // never silently drop a save
    const key = await CRYPTOBOX.importRawKey(rawKey);
    const v = await getVault();
    const env = await CRYPTOBOX.encryptWithKey(store, key); // same salt, fresh IV
    await api.storage.local.set({ [VAULT_KEY]: { ...v, iv: env.iv, ct: env.ct } });
    await sessionSet({ [SESSION_STORE]: store });
    return;
  }
  await api.storage.local.set({ [KEYS.STORE]: store });
}

/** Turn ON encryption: encrypt the current store, delete the plaintext copy,
 *  and leave the session unlocked so the user is not immediately asked. */
async function enableEncryption(passphrase, hint) {
  if (await isEncrypted()) throw new Error('already-encrypted');
  const { [KEYS.STORE]: stored } = await api.storage.local.get(KEYS.STORE);
  const store = migrateStore(stored);
  const env = await CRYPTOBOX.encryptObject(store, passphrase);
  env.hint = hint || '';
  await api.storage.local.set({ [VAULT_KEY]: env });
  await api.storage.local.remove(KEYS.STORE);
  const key = await CRYPTOBOX.deriveKey(passphrase, CRYPTOBOX.fromB64(env.salt));
  await sessionSet({ [SESSION_STORE]: store, [SESSION_DEK]: await CRYPTOBOX.exportRawKey(key) });
}

/** Unlock for this browser session. Returns true on success, false on a wrong
 *  passphrase (GCM auth failure), so the caller can show "wrong passphrase". */
async function unlock(passphrase) {
  const v = await getVault();
  if (!v) return true;
  let store;
  try { store = await CRYPTOBOX.decryptObject(v, passphrase); }
  catch { return false; }
  const key = await CRYPTOBOX.deriveKey(passphrase, CRYPTOBOX.fromB64(v.salt));
  await sessionSet({ [SESSION_STORE]: migrateStore(store), [SESSION_DEK]: await CRYPTOBOX.exportRawKey(key) });
  return true;
}

/** Forget the in-memory copy — re-lock without disabling encryption. */
async function lock() { await sessionClear(); }

/** Turn OFF encryption (must be unlocked): write plaintext back, drop the vault. */
async function disableEncryption() {
  const store = await getStore();
  if (store == null) throw new Error('locked');
  await api.storage.local.set({ [KEYS.STORE]: store });
  await api.storage.local.remove(VAULT_KEY);
  await sessionClear();
}

/** Re-key with a new passphrase (must be unlocked). */
async function changePassphrase(newPass, hint) {
  const store = await getStore();
  if (store == null) throw new Error('locked');
  const env = await CRYPTOBOX.encryptObject(store, newPass);
  env.hint = hint || '';
  await api.storage.local.set({ [VAULT_KEY]: env });
  const key = await CRYPTOBOX.deriveKey(newPass, CRYPTOBOX.fromB64(env.salt));
  await sessionSet({ [SESSION_STORE]: store, [SESSION_DEK]: await CRYPTOBOX.exportRawKey(key) });
}

// ------------------------------------------------------------------ profiles

function addProfile(store, name) {
  const p = emptyProfile(name || `Profile ${store.profiles.length + 1}`);
  store.profiles.push(p);
  store.activeProfileId = p.id;
  return p;
}

/** Copy a profile, including its pilgrims — handy for "same party, one extra". */
function duplicateProfile(store, id) {
  const src = store.profiles.find((p) => p.id === id);
  if (!src) return null;
  const copy = {
    ...structuredClone(src),
    id: uid(),
    name: `${src.name} copy`,
  };
  store.profiles.push(copy);
  store.activeProfileId = copy.id;
  return copy;
}

/** Refuses to remove the last profile — there must always be one to edit. */
function removeProfile(store, id) {
  if (store.profiles.length <= 1) return false;
  const i = store.profiles.findIndex((p) => p.id === id);
  if (i === -1) return false;
  store.profiles.splice(i, 1);
  if (store.activeProfileId === id) {
    store.activeProfileId = store.profiles[Math.max(0, i - 1)].id;
  }
  return true;
}

// ------------------------------------------------------------------ mappings

/**
 * Mappings are keyed by flow, then by field key:
 *   { spat: { 'people.0.name': <descriptor>, ... }, ... }
 *
 * Seeds captured from the live portal are layered underneath, so a fresh
 * install already fills almost everything. Anything the user picks themselves
 * overrides the seed for that field.
 */
async function getMappings() {
  const { [KEYS.MAPPINGS]: stored } = await api.storage.local.get(KEYS.MAPPINGS);
  const user = stored || {};
  const merged = {};
  // Seeds are per-flow now: Arjitha's field names differ from SED/SPAT, so each
  // flow gets its own selector set layered under the user's own picks.
  for (const flow of Object.values(FLOWS)) {
    const seeds = typeof buildSeeds !== 'undefined' ? buildSeeds(flow, MAX_PILGRIMS) : {};
    merged[flow] = { ...seeds, ...(user[flow] || {}) };
  }
  for (const [flow, fields] of Object.entries(user)) {
    if (!merged[flow]) merged[flow] = fields;
  }
  return merged;
}

/** Only the user's own picks — drives the map button's state. */
async function getUserMappings() {
  const { [KEYS.MAPPINGS]: stored } = await api.storage.local.get(KEYS.MAPPINGS);
  return stored || {};
}

// Both writers operate on the USER layer only. Using the merged view would
// bake every seed into storage on the first pick, so later seed corrections
// shipped with an update would never reach existing installs.
async function saveMapping(flow, fieldKey, descriptor) {
  const all = await getUserMappings();
  all[flow] = all[flow] || {};
  all[flow][fieldKey] = descriptor;
  await api.storage.local.set({ [KEYS.MAPPINGS]: all });
}

async function deleteMapping(flow, fieldKey) {
  const all = await getUserMappings();
  if (all[flow]) delete all[flow][fieldKey];
  await api.storage.local.set({ [KEYS.MAPPINGS]: all });
}

// --------------------------------------------------------------------- paths

/** Read a dotted path like 'people.2.name' out of a profile. */
function readPath(obj, path) {
  return path.split('.').reduce((acc, part) => (acc == null ? undefined : acc[part]), obj);
}

/** Write a dotted path, creating intermediate objects/arrays as needed. */
function writePath(obj, path, value) {
  const parts = path.split('.');
  const last = parts.pop();
  let cur = obj;
  for (const part of parts) {
    if (cur[part] == null) cur[part] = /^\d+$/.test(part) ? [] : {};
    cur = cur[part];
  }
  cur[last] = value;
  return obj;
}

// ------------------------------------------------------------- backup / load

function mergeMappings(existing, incoming) {
  const result = { ...(existing || {}) };
  for (const [flow, fields] of Object.entries(incoming || {})) {
    result[flow] = { ...(result[flow] || {}), ...(fields || {}) };
  }
  return result;
}

function mergeStores(existing, incoming) {
  const oldStore = migrateStore(existing);
  const importedStore = migrateStore(incoming);
  const profiles = [...oldStore.profiles];
  const ids = new Set(profiles.map((p) => p.id));

  for (const imported of importedStore.profiles) {
    const index = profiles.findIndex((p) => p.id === imported.id);
    if (index >= 0) {
      profiles[index] = structuredClone(imported);
    } else {
      const copy = structuredClone(imported);
      if (!copy.id || ids.has(copy.id)) copy.id = uid();
      ids.add(copy.id);
      profiles.push(copy);
    }
  }

  const volunteers = [...(oldStore.volunteers || [])];
  const volunteerIds = new Set(volunteers.map((v) => v.id));
  for (const imported of (importedStore.volunteers || [])) {
    const index = volunteers.findIndex((v) => v.id === imported.id);
    if (index >= 0) {
      volunteers[index] = structuredClone(imported);
    } else {
      const copy = structuredClone(imported);
      if (!copy.id || volunteerIds.has(copy.id)) copy.id = uid();
      volunteerIds.add(copy.id);
      volunteers.push(copy);
    }
  }

  const active = profiles.find((p) => p.id === oldStore.activeProfileId)
    ? oldStore.activeProfileId
    : profiles[0]?.id;

  return {
    ...oldStore,
    ...importedStore,
    profiles,
    volunteers,
    activeProfileId: active,
    settings: { ...oldStore.settings, ...(importedStore.settings || {}) },
  };
}

async function exportAll() {
  const profile = await getStore();
  if (profile == null) throw new Error('locked');
  const { [KEYS.MAPPINGS]: mappings } = await api.storage.local.get(KEYS.MAPPINGS);
  return JSON.stringify({ profile, mappings: mappings || {}, exportedAt: new Date().toISOString() }, null, 2);
}

async function importAll(json) {
  const parsed = JSON.parse(json);
  if (parsed.type === 'encrypted-backup') {
    throw new Error('This is an encrypted backup — use "Import encrypted" and enter its passphrase.');
  }
  if (!parsed.profile) throw new Error('File does not contain any profiles.');
  const importedStore = migrateStore(parsed.profile); // older backups load fine
  const existingStore = await getStore();
  if (existingStore == null) throw new Error('locked');
  const store = mergeStores(existingStore, importedStore);
  if (await isEncrypted()) {
    if (!(await isUnlocked())) throw new Error('locked');
    await saveStore(store); // keep it encrypted at rest
  } else {
    await api.storage.local.set({ [KEYS.STORE]: store });
  }
  const { [KEYS.MAPPINGS]: existingMappings } = await api.storage.local.get(KEYS.MAPPINGS);
  await api.storage.local.set({ [KEYS.MAPPINGS]: mergeMappings(existingMappings, parsed.mappings) });
}

/** A passphrase-encrypted backup file: nothing readable without the passphrase.
 *  Must be unlocked (or unencrypted) to read the current data out. */
async function exportEncrypted(passphrase) {
  const store = await getStore();
  if (store == null) throw new Error('locked');
  const { [KEYS.MAPPINGS]: mappings } = await api.storage.local.get(KEYS.MAPPINGS);
  const payload = { profile: store, mappings: mappings || {}, exportedAt: new Date().toISOString() };
  const env = await CRYPTOBOX.encryptObject(payload, passphrase);
  return JSON.stringify({ app: 'ttv-booking-helper', type: 'encrypted-backup', ...env }, null, 2);
}

async function importEncrypted(json, passphrase) {
  const parsed = JSON.parse(json);
  if (parsed.type !== 'encrypted-backup' || !parsed.ct) {
    throw new Error('Not an encrypted backup file.');
  }
  let payload;
  try { payload = await CRYPTOBOX.decryptObject(parsed, passphrase); }
  catch { throw new Error('Wrong passphrase for this backup.'); }
  if (!payload.profile) throw new Error('Backup contains no profiles.');
  const importedStore = migrateStore(payload.profile);
  const existingStore = await getStore();
  if (existingStore == null) throw new Error('locked');
  const store = mergeStores(existingStore, importedStore);
  if (await isEncrypted()) {
    if (!(await isUnlocked())) throw new Error('locked');
    await saveStore(store);
  } else {
    await api.storage.local.set({ [KEYS.STORE]: store });
  }
  const { [KEYS.MAPPINGS]: existingMappings } = await api.storage.local.get(KEYS.MAPPINGS);
  await api.storage.local.set({ [KEYS.MAPPINGS]: mergeMappings(existingMappings, payload.mappings) });
}


// ------------------------------------------------------------------- stats
// v1.4 booking log — strictly local, opt-in. The content script appends; the
// popup reads and clears. Never transmitted.
const STATS_KEY = 'stats';
async function getStats() {
  const { [STATS_KEY]: s } = await api.storage.local.get(STATS_KEY);
  return s || { events: [], session: null };
}
async function clearStats() {
  await api.storage.local.set({ [STATS_KEY]: { events: [], session: null } });
}
/**
 * Manually record a successful booking (the "Mark as booked ✓" button).
 * De-dupes against any success recorded in the last 2 minutes — so a click
 * right after the receipt-page auto-detection has already logged it does not
 * double-count. Closes the current attempt session. Strictly local.
 * Returns { added, stats }.
 */
async function markBooked(flow) {
  const s = await getStats();
  const now = Date.now();
  const last = s.events[s.events.length - 1];
  if (last && last.kind === 'success' && (now - last.at) < 120000) {
    return { added: false, stats: s };
  }
  const tries = (s.session ? s.session.tries : 0) + 1;
  s.events.push({
    at: now, flow: flow || s.session?.flow || null, kind: 'success', outcome: 'success',
    tries, durationMs: s.session ? now - s.session.startAt : null, manual: true,
  });
  s.session = null;
  if (s.events.length > 300) s.events = s.events.slice(-300);
  await api.storage.local.set({ [STATS_KEY]: s });
  return { added: true, stats: s };
}

if (typeof module !== 'undefined') {
  module.exports = {
    KEYS, getStore, saveStore,
    addProfile, duplicateProfile, removeProfile,
    getMappings, getUserMappings, saveMapping, deleteMapping,
    readPath, writePath, exportAll, importAll, getStats, clearStats, markBooked,
    isEncrypted, isUnlocked, vaultHint,
    enableEncryption, disableEncryption, unlock, lock, changePassphrase,
    exportEncrypted, importEncrypted,
  };
}
