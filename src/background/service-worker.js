/**
 * The popup closes the moment the user clicks into the page, which kills any
 * listener it registered. The picker therefore reports back here, and the
 * popup reads the result when it reopens.
 */

// The background context is its own scope, so it carries its own copy of the
// shim rather than loading src/common/api.js — on Firefox the background is a
// plain script list, and loading api.js there too would redeclare `api`.
// See src/common/api.js for why `browser` is preferred over `chrome`.
const api = (typeof globalThis.browser !== 'undefined' && globalThis.browser.runtime)
  ? globalThis.browser
  : globalThis.chrome;

const PENDING_PICK = 'pendingPick';

/**
 * Let the content scripts on TTD pages read the UNLOCKED (decrypted) profile
 * that the popup caches in chrome.storage.session. Session storage is
 * memory-only and never written to disk, so the AES-GCM ciphertext in local
 * storage stays the ONLY on-disk copy. Only our own content script can read it
 * — web pages have no access to chrome.storage at all.
 *
 * If the browser lacks this API (older Chrome / some Firefox builds), at-rest
 * encryption still works; auto-fill simply needs the popup opened + unlocked
 * once per session before it can read the data.
 */
function armSessionAccess() {
  try {
    const p = api.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' });
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch { /* not supported here */ }
}
armSessionAccess();

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'PICKER_RESULT') {
    api.storage.local.set({
      [PENDING_PICK]: {
        fieldKey: msg.fieldKey,
        descriptor: msg.descriptor,
        preview: msg.preview,
        tabId: sender.tab?.id,
        at: Date.now(),
      },
    });
    // Badge tells the user the pick landed and the popup is worth reopening.
    api.action.setBadgeText({ text: '1' });
    api.action.setBadgeBackgroundColor({ color: '#16a34a' });
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === 'PICKER_CANCELLED') {
    api.storage.local.remove(PENDING_PICK);
    api.action.setBadgeText({ text: '' });
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === 'CLEAR_BADGE') {
    api.action.setBadgeText({ text: '' });
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

const TTD_MATCHES = [
  'https://ttdevasthanams.ap.gov.in/*',
  'https://*.ttdevasthanams.ap.gov.in/*',
  'https://ttdsevaonline.com/*',
  'https://*.ttdsevaonline.com/*',
  'https://tirupatibalaji.ap.gov.in/*',
  'https://*.tirupatibalaji.ap.gov.in/*',
  'https://srivanitrust.ap.gov.in/*',
  'https://*.srivanitrust.ap.gov.in/*',
];

// MUST match content_scripts[0].js in the manifest, in the same order.
// api.js and schema.js were missing here once; re-attach then injected a
// broken bundle that threw on its first reference to `api`.
const CONTENT_SCRIPTS = [
  'src/common/api.js',
  'src/common/schema.js',
  'src/common/seed-mappings.js',
  'src/common/i18n.js',
  'src/content/engine.js',
  'src/content/picker.js',
  'src/content/paste-helper.js',
  'src/content/content.js',
];

/**
 * Re-attach to TTD tabs that were already open.
 *
 * Installing or reloading the extension orphans the content scripts in
 * existing tabs — Chrome does not re-inject them. Without this, the first fill
 * after an update fails with "Receiving end does not exist" until the user
 * manually reloads the page, which is a confusing thing to hit mid-booking.
 *
 * PING first so a tab that already has a live script is left alone; injecting
 * over it would redeclare its top-level consts and throw.
 */
async function reattachOpenTabs() {
  let tabs = [];
  try { tabs = await api.tabs.query({ url: TTD_MATCHES }); } catch { return; }

  for (const tab of tabs) {
    if (!tab.id) continue;
    try {
      const res = await api.tabs.sendMessage(tab.id, { type: 'PING' });
      if (res?.ok) continue; // already listening
    } catch { /* not injected — carry on */ }

    try {
      await api.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        files: CONTENT_SCRIPTS,
      });
      await api.scripting.insertCSS({
        target: { tabId: tab.id, allFrames: true },
        files: ['src/content/overlay.css'],
      });
    } catch { /* restricted tab, or it navigated away — nothing to do */ }
  }
}

/**
 * Keyboard shortcut (Alt+Shift+F) → fill the current TTD page.
 *
 * Fires the same in-page fill the popup button does, without opening the popup.
 * Only acts on a TTD tab; ensures the content script is present first (a shortcut
 * pressed right after an extension reload would otherwise hit no listener).
 */
api.commands?.onCommand.addListener(async (command) => {
  if (command !== 'fill-page') return;
  let tab;
  try { [tab] = await api.tabs.query({ active: true, currentWindow: true }); }
  catch { return; }
  if (!tab?.id || !TTD_MATCHES.some((m) => matchesGlob(m, tab.url || ''))) return;

  try {
    await api.tabs.sendMessage(tab.id, { type: 'FILL_NOW' });
  } catch {
    // No listener yet — inject, then retry once.
    try {
      await api.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: CONTENT_SCRIPTS });
      await api.scripting.insertCSS({ target: { tabId: tab.id, allFrames: true }, files: ['src/content/overlay.css'] });
      await api.tabs.sendMessage(tab.id, { type: 'FILL_NOW' });
    } catch { /* restricted or navigated tab — nothing to do */ }
  }
});

/** Minimal glob match for the "https://host/*" match patterns above. */
function matchesGlob(pattern, url) {
  const re = new RegExp('^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
  return re.test(url);
}

// Was the build we are updating FROM older than the first gated release (1.16.0)?
api.runtime.onInstalled.addListener(({ reason }) => {
  armSessionAccess();
  reattachOpenTabs();
  if (reason === 'install') {
    api.tabs.create({ url: api.runtime.getURL('src/popup/popup.html?welcome=1') });
  }
});

// Fires when the service worker spins up, including after an update.
api.runtime.onStartup?.addListener(() => { armSessionAccess(); reattachOpenTabs(); });
