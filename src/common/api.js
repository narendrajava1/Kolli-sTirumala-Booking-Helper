/**
 * Cross-browser extension API shim.
 *
 * Chrome exposes `chrome.*`, which returns promises in Manifest V3 when no
 * callback is passed. Firefox exposes `browser.*`, which is promise-based by
 * definition — and also a `chrome.*` alias that is CALLBACK-based for
 * compatibility. Since every call in this extension is awaited, reaching for
 * `chrome.*` on Firefox would silently return undefined instead of a promise.
 *
 * So: prefer `browser` where it exists, fall back to `chrome`. Everything else
 * in the codebase calls `api.*` and neither browser is special-cased.
 *
 * Loaded first in every context that needs it, so `api` is a shared global for
 * the popup scripts and for the content-script bundle.
 */
const api = (typeof globalThis.browser !== 'undefined' && globalThis.browser.runtime)
  ? globalThis.browser
  : globalThis.chrome;

/** True on Firefox, where MV3 host permissions are opt-in rather than granted. */
const IS_FIREFOX = typeof globalThis.browser !== 'undefined'
  && typeof globalThis.browser.runtime?.getBrowserInfo === 'function';

if (typeof module !== 'undefined') module.exports = { api, IS_FIREFOX };
