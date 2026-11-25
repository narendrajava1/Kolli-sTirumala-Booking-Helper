/**
 * Message router for the page side.
 *
 * The popup owns storage and builds the fill plan; this script executes it.
 * It can also fill the page on its own — but only when the user has opted in
 * (settings.autoFillOnLoad) and the active profile is Ready. Everything
 * side-effectful still goes through the same engine, which has no code that can
 * find or click a payment control.
 */

(() => {
  // ------------------------------------------------------ small helpers

  /** Read a dotted path like 'people.2.name' out of a profile. */
  const readPath = (obj, path) =>
    path.split('.').reduce((acc, part) => (acc == null ? undefined : acc[part]), obj);

  const leafKey = (fieldKey) => fieldKey.split('.').pop();

  const FIELD_BY_KEY = Object.fromEntries(
    // 'photo' (file) and 'gothram' (text) are optional, seva-only fields kept
    // OUT of PERSON_FIELDS so they never count toward readiness.
    [...PERSON_FIELDS, ...CONTACT_FIELDS,
      { key: 'photo', type: 'file' }, { key: 'gothram', type: 'text' }].map((f) => [f.key, f])
  );
  const CONTACT_KEY_SET = new Set(CONTACT_FIELDS.map((f) => f.key));
  const fieldType = (fieldKey) => (FIELD_BY_KEY[leafKey(fieldKey)]?.type) || 'text';

  // ------------------------------------------------------ message router

  api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg.type) {
      case 'PING':
        sendResponse({
          ok: true,
          url: location.href,
          // Lets the popup describe the page instead of blindly offering to
          // fill it — the virtual queue has no form at all.
          inQueue: TTDEngine.isQueuePage(document.body?.innerText || ''),
          hasForm: !!document.querySelector('input[name="fname"], input[name="emailId"], input[name="name"], input[name="pilgrimEmail"], input[name="sevakName"], input[name="idType"]'),
        });
        return false;

      case 'RUN_PLAN': {
        // The message goes to every frame. A sub-frame that recognises none of
        // the fields stays silent so the frame that actually holds the form
        // wins the single available sendResponse.
        const resolvable = msg.plan.filter((item) => TTDEngine.resolveField(item.descriptor));
        if (!resolvable.length && window !== window.top) return false;

        (async () => {
          // Same INSTANT pivot the on-page button gets: on the blocked portal,
          // don't run a doomed fill and wait for a heuristic — show the Paste
          // Helper right away, so "Fill this page" behaves like the float button.
          const flow = flowFromUrl(location.href) || DEFAULT_FLOW;
          if (window === window.top && flow !== FLOWS.SRIVANI && window.TTDPaste
              && (window.TTDPaste.isActive() || isBlockedPortal() || await blockedByCanary(msg.plan))) {
            if (!window.TTDPaste.isActive()) {
              const r = await reactThenPaste(msg.plan, msg.reactFill !== false);
              sendResponse({ ok: true, react: r.mode, paste: r.mode !== 'react-all', results: [] });
              return;
            }
            if (armPasteHelper(msg.plan)) { sendResponse({ ok: true, paste: true, results: [] }); return; }
          }
          try {
            const { results, advance } = await runFill(msg.plan, { delay: msg.delay, autoContinue: msg.autoContinue, rowCheck: msg.rowCheck });
            recordLastFill(flow, results);
            toast(summarise(results, advance));
            sendResponse({ ok: true, results, advance });
          } catch (err) { sendResponse({ ok: false, error: err.message }); }
        })();
        return true; // async
      }

      case 'START_PICKER':
        TTDPicker.start(msg.fieldKey, msg.fieldLabel);
        sendResponse({ ok: true });
        return false;

      case 'STOP_PICKER':
        TTDPicker.stop();
        sendResponse({ ok: true });
        return false;

      case 'PREVIEW_MAPPING':
        sendResponse({ ok: true, found: TTDPicker.preview(msg.mappings) });
        return false;

      // Fill triggered from the page itself (keyboard shortcut Alt+Shift+F).
      // Goes to every frame; only the one holding the form has resolvable
      // fields, so the rest no-op inside fillNow().
      case 'FILL_NOW':
        fillNow({ interactive: true }); // popup button / shortcut — give feedback
        sendResponse({ ok: true });
        return false;

      // B3 "Test this page" — resolve one pilgrim row + the contact block for
      // this flow and report which seeded fields are missing, so a TTD form
      // change is visible before release day.
      case 'HEALTH_CHECK': {
        const flow = msg.flow || flowFromUrl(location.href) || DEFAULT_FLOW;

        // Srivari Seva volunteer profile: resolve the seed descriptor for every
        // field (independent of what the user has saved) and report any that no
        // longer resolve — so a TTD form change is caught before it matters.
        if (flow === FLOWS.SRIVARI) {
          const missing = [];
          let total = 0;
          for (const f of VOLUNTEER_FIELDS) {
            if (f.type === 'file') continue;             // file inputs are often hidden
            total++;
            // Use a representative value so gender's value-specific descriptor
            // still resolves the radio.
            const probe = f.type === 'radio' ? (f.options[0]) : (f.type === 'checkbox' ? true : 'x');
            const d = volunteerSeed(f.key, probe);
            if (!TTDEngine.resolveField(d)) missing.push(f.key);
          }
          sendResponse({ ok: true, total, missing });
          return false;
        }

        const seeds = buildSeeds(flow, MAX_PILGRIMS);
        const keys = [
          ...PERSON_FIELDS.map((f) => `people.0.${f.key}`),
          ...CONTACT_FIELDS.map((f) => `contact.${f.key}`),
        ];
        const missing = [];
        let total = 0;
        for (const k of keys) {
          const d = seeds[k];
          if (!d) continue;            // not seeded for this flow (e.g. no contact block)
          total++;
          if (!TTDEngine.resolveField(d)) missing.push(k);
        }
        sendResponse({ ok: true, total, missing });
        return false;
      }

      // "Report a field problem" — capture the STRUCTURE of the form (field
      // names/ids/labels/types/options), so a TTD form change can be reported
      // and fixed. Deliberately captures NO values: not one character the user
      // typed leaves the page, keeping the extension's no-PII promise intact.
      case 'CAPTURE_FIELDS': {
        const fields = [...document.querySelectorAll('input, select, textarea')].map((el) => {
          const r = el.getBoundingClientRect();
          const o = {
            tag: el.tagName.toLowerCase(),
            type: el.type || '',
            name: el.name || '',
            id: el.id || '',
            label: TTDEngine.labelTextFor(el) || '',
            placeholder: el.placeholder || '',
            required: el.required || el.getAttribute('aria-required') === 'true',
            readOnly: el.readOnly || el.getAttribute('aria-readonly') === 'true',
            disabled: el.disabled,
            maxLength: el.maxLength > 0 ? el.maxLength : undefined,
            visible: r.width > 0 && r.height > 0,
          };
          if (el.tagName.toLowerCase() === 'select') o.options = [...el.options].map((x) => x.text.trim());
          return o; // NOTE: no `value` — structure only.
        });
        // pathname only, never the query string (which can carry tokens).
        sendResponse({ ok: true, path: location.pathname, flow: flowFromUrl(location.href) || DEFAULT_FLOW, fields });
        return false;
      }

      // Server-synced seconds-to-release for the popup Stats panel (read-only).
      case 'GET_COUNTDOWN': {
        const c = TTDEngine.parseServerCountdown(document.body?.innerText || '');
        sendResponse({ ok: true, secondsLeft: c ? c.secondsLeft : null });
        return false;
      }

      default:
        return false;
    }
  });

  /**
   * Build the plan for the current flow and fill — the in-page equivalent of
   * the popup's "Fill this page". Used by the keyboard shortcut and the
   * floating button. Fills whatever the profile holds (user-initiated), and
   * only acts in the frame that actually has the form.
   */


  // Shared across every fill entry point (fillNow + maybeAutoFill). See fillNow.
  let fillInFlight = false;

  /**
   * Read the profile store, transparently handling at-rest encryption.
   *
   * When the vault is unlocked, the popup has cached the DECRYPTED store in
   * chrome.storage.session (memory only). When encryption is off, the plaintext
   * store is in local as before. Returns undefined when encryption is ON but
   * the vault is still LOCKED — there is no plaintext on disk to read, so
   * auto-fill / the floating button simply wait until the user unlocks in the
   * popup. Never decrypts here: the content script never sees the passphrase.
   */
  async function readProfileRaw() {
    try {
      const s = await api.storage.session.get('profile');
      if (s && s.profile != null) return s.profile;
    } catch { /* no session access on this browser */ }
    try {
      return (await api.storage.local.get('profile')).profile; // undefined if locked
    } catch { return undefined; }
  }

  async function fillNow(opts = {}) {
    // One fill at a time. Auto-fill-on-load, the floating button, the popup
    // button and the Alt+Shift+F shortcut all land here or in maybeAutoFill;
    // two running at once fight over the SAME open dropdown panel (one opens
    // it, the other dismisses it), so the readOnly Photo-ID-Proof / Gender
    // pickers read an empty list and silently miss. The shared lock serializes
    // them — a second request while one is in flight is simply ignored.
    // `opts.interactive` is set by the floating button / shortcut so an explicit
    // tap that finds nothing to do SAYS so, instead of failing silently.
    if (fillInFlight) return;
    fillInFlight = true;
    try {
      let profileRaw, mappings;
      try {
        profileRaw = await readProfileRaw();
        mappings = (await api.storage.local.get('mappings')).mappings;
      } catch { return; }
      if (profileRaw == null) { // encrypted + locked
        if (window === window.top) toast(t('lock.needUnlock'));
        return;
      }
      const store = migrateStore(profileRaw);
      setLang(store.settings.language || 'en');
      const flow = flowFromUrl(location.href) || DEFAULT_FLOW;

      // Srivari Seva volunteer profile — a single flat record, not pilgrim rows,
      // and NEVER auto-advanced (saving the profile is the user's decision).
      if (flow === FLOWS.SRIVARI) {
        const vplan = buildVolunteerPlan(activeVolunteer(store), mappings)
          .filter((item) => item.value !== '' && item.value != null);
        if (!vplan.length) { if (window === window.top) toast(t('status.nothingToFill')); return; }
        if (!vplan.some((item) => TTDEngine.resolveField(item.descriptor))) return; // not this frame / form
        const { results } = await runFill(vplan, { delay: store.settings.fillDelayMs, autoContinue: false });
        toast(summarise(results, null));
        return;
      }

      const p = activeProfile(store);
      const plan = buildAutoPlan(store, mappings, flow, p)
        .filter((item) => item.value !== '' && item.value != null);
      if (!plan.length) { if (window === window.top) toast(t('status.nothingToFill')); return; }
      // No pilgrim/field on this frame resolves. Usually a not-yet-rendered form
      // or the wrong frame (stay silent then); but if the user explicitly tapped
      // the button, tell them the form isn't here (e.g. the slot was reset).
      if (!plan.some((item) => TTDEngine.resolveField(item.descriptor))) {
        if (opts.interactive && window === window.top) toast(t('status.formNotReady'));
        return;
      }
      // Pilgrim rows render lazily, one at a time. Wait for the WHOLE chosen set
      // before filling so a tap doesn't leave the last pilgrim(s) blank
      // ("filled 4 of 5"). waitForPilgrimRows returns once every row is present,
      // once the page's rows have settled below that, or at its timeout.
      await waitForPilgrimRows(plan);
      if (!pilgrimRowsReady(plan)) {
        // Still short of the chosen count. If NOT ONE pilgrim row is on the page
        // it's the wrong frame or an unrendered form — say so. If some rows are
        // present the page simply has fewer than chosen; fill them anyway and
        // let the completeness summary flag the shortfall.
        const anyRow = plan.some((it) => /^people\.\d+\./.test(it.fieldKey) && TTDEngine.resolveField(it.descriptor));
        if (!anyRow) { if (window === window.top) toast(t('status.formNotReady')); return; }
      }

      // Copy-paste mode (chooser): still auto-fill whatever the extension can,
      // then hand the user the Paste Helper for ONLY the fields that didn't fill
      // — a real fallback, not "paste the whole form". On a blocked form nothing
      // sticks so it all becomes paste; on a working form little or nothing is
      // left. reactThenPaste does exactly that (fill what React can, arm paste
      // for the rest).
      if (opts.mode === 'paste') {
        if (window === window.top) await reactThenPaste(plan, true);
        return;
      }
      // Autofill: the chooser's "autofill" pick forces React on; otherwise the
      // saved reactFill setting decides.
      const wantReact = opts.mode === 'autofill' ? true : (store.settings.reactFill !== false);

      // Fast pivot: the ttdevasthanams React portal rejects programmatic input
      // and reverts our fill. Probe one field; if it's blocked, switch straight
      // to the Paste Helper instead of running a doomed multi-second fill of
      // every row (dropdowns and all) and only noticing afterwards. SRIVANI (the
      // legacy portal) still accepts fills, so it is never probed.
      if (window === window.top && flow !== FLOWS.SRIVANI && window.TTDPaste
          && (window.TTDPaste.isActive() || isBlockedPortal() || await blockedByCanary(plan))) {
        if (!window.TTDPaste.isActive()) { await reactThenPaste(plan, wantReact); return; }
        if (armPasteHelper(plan)) return;
      }
      const { results, advance } = await runFill(plan, {
        delay: fillDelayForFlow(flow, store.settings.fillDelayMs),
        autoContinue: store.settings.autoContinue && flow !== FLOWS.SRIVANI,
        rowCheck: rowCheckSpec(flow),
      });
      recordLastFill(flow, results);
      toast(summarise(results, advance));
    } finally {
      fillInFlight = false;
    }
  }

  /**
   * Record a compact, PII-free summary of the most recent fill so the popup can
   * ask "did this fill correctly?" and we learn which flows misbehave in the
   * wild. Stores only the flow id, a timestamp and the filled/total counts —
   * never any field value. Overwritten by each fill; cleared once the user answers.
   */
  async function recordLastFill(flow, results) {
    try {
      const filled = results.filter((r) => r.ok).length;
      await api.storage.local.set({
        ttvLastFill: { flow, ts: Date.now(), filled, total: results.length, rated: false },
      });
    } catch { /* storage unavailable — the nudge simply won't appear */ }
  }

  /** Run the plan, then optionally advance to review. Shared by manual + auto. */
  async function runFill(plan, { delay, autoContinue, rowCheck }) {
    noteFill(flowFromUrl(location.href) || DEFAULT_FLOW); // begins timing (if the log is on)
    bumpUsage(); // always-on, local-only count so the popup can time a rate nudge
    const results = await TTDEngine.runPlan(plan, { delay });
    finishLatePlan(plan); // background: re-apply anything that didn't "take" (SRIVANI late ID dropdown + its number)
    offerPasteIfBlocked(plan); // if TTD reverted our fill, switch to the Paste Helper
    const advance = autoContinue ? await tryContinue(rowCheck) : null;
    return { results, advance };
  }

  /**
   * Detect TTD's anti-autofill guard and fall back to the Paste Helper.
   *
   * The ttdevasthanams React portal now ignores programmatic input (it accepts
   * only `isTrusted` events) and reverts the text fields we set back to empty.
   * So, a short moment after a fill, we re-check the text fields we filled: if
   * most are empty again, this form blocks us — turn on the Paste Helper (which
   * loads each value onto the clipboard so the user can paste it). On a form that
   * accepts our fill (SRIVANI and the rest), the fields keep their values and
   * nothing changes. Top frame only, and it never submits anything.
   */
  function isTextPlanItem(it) {
    return it.type !== 'dropdown' && it.type !== 'select' && it.type !== 'multiselect' && it.type !== 'file';
  }

  /**
   * Switch the page into Paste-Helper mode. Hand it the plan's items themselves
   * (descriptor + value); it re-resolves each field against the LIVE DOM on
   * every focus, so React re-rendering the inputs (which it does when validation
   * errors appear) can't leave it pointing at dead elements. Files are excluded.
   * Returns whether the helper actually turned on.
   */
  function armPasteHelper(plan) {
    if (!window.TTDPaste) return false;
    const items = (plan || [])
      .filter((it) => it.type !== 'file' && it.descriptor && String(it.value ?? '').trim() !== '')
      .map((it) => ({ descriptor: it.descriptor, value: it.value, fieldKey: it.fieldKey, type: it.type }));
    const on = window.TTDPaste.activate(items);
    if (on) toast(t('paste.active'));
    return on;
  }

  // ---- React autofill (Chrome only; MAIN-world companion) -------------------
  // react-fill.js fills the blocked portal by driving TTD's own React onChange,
  // so values stick WITHOUT chrome.debugger. We tag each resolvable field with
  // data-ttv-fill (the only thing that crosses the isolated/MAIN boundary), ask
  // the companion to fill them, and it reports which held. Whatever didn't hold
  // (custom dropdowns, or a field TTD changed) falls back to the Paste Helper.
  // Absent on Firefox (no MAIN world) → _reactReady stays false → paste fallback.
  let _reactReady = false;
  if (window === window.top) {
    try {
      window.addEventListener('message', (e) => {
        if (e.source === window && e.data && e.data.__ttv === 'react-fill-ready') _reactReady = true;
      });
      window.postMessage({ __ttv: 'react-fill-ping' }, '*');
    } catch { /* */ }
  }

  // Fill via the React companion. Returns { ran, held:Set<planIndex> }.
  async function tryReactFill(plan, enabled) {
    // No host check needed: react-fill.js (and thus _reactReady) only exists on
    // the ttdevasthanams portal, where it is declared; elsewhere it stays false.
    if (!enabled || window !== window.top || !_reactReady) return { ran: false, held: new Set() };
    const tagged = [];
    for (let i = 0; i < plan.length; i++) {
      const it = plan[i];
      if (it.type === 'file' || !it.descriptor || String(it.value ?? '').trim() === '') continue;
      const el = TTDEngine.resolveField(it.descriptor);
      if (!el) continue; // tag even if disabled (ID number) — it's filled after its dropdown enables it
      el.setAttribute('data-ttv-fill', String(i));
      tagged.push({ i, value: it.value, type: it.type, fieldKey: it.fieldKey });
    }
    if (!tagged.length) return { ran: false, held: new Set() };
    const res = await new Promise((resolve) => {
      const onDone = (e) => {
        if (e.source === window && e.data && e.data.__ttv === 'react-fill-done') {
          window.removeEventListener('message', onDone, true); resolve(e.data.res || []);
        }
      };
      window.addEventListener('message', onDone, true);
      try { window.postMessage({ __ttv: 'react-fill', items: tagged }, '*'); } catch { resolve(null); }
      // The companion opens + picks each dropdown in turn (seconds), so give it
      // plenty of time; it posts react-fill-done as soon as it is finished.
      setTimeout(() => { window.removeEventListener('message', onDone, true); resolve(null); }, 12000);
    });
    for (const t of tagged) { const el = document.querySelector('[data-ttv-fill="' + t.i + '"]'); if (el) el.removeAttribute('data-ttv-fill'); }
    return { ran: true, held: new Set((res || []).filter((r) => r.held).map((r) => r.i)) };
  }

  // After a React fill, hand the Paste Helper ONLY the fields that didn't hold
  // (custom dropdowns, or anything that reverted), so the user finishes just
  // those. Returns true if anything still needs the user.
  function armPasteForRemaining(plan, heldSet) {
    const remaining = plan.filter((it, i) => !heldSet.has(i) && it.type !== 'file'
      && it.descriptor && String(it.value ?? '').trim() !== '' && TTDEngine.resolveField(it.descriptor));
    if (!remaining.length) return false;
    return armPasteHelper(remaining);
  }

  // Blocked-portal pivot shared by fillNow / RUN_PLAN / maybeAutoFill: try the
  // React fill first (if on); fill what it can, guide the rest in the Paste
  // Helper; if React can't run at all, fall back to the full Paste Helper.
  // Returns { done, mode } — mode is 'react-all' | 'react-partial' | 'paste'.
  async function reactThenPaste(plan, enabled) {
    const rf = await tryReactFill(plan, enabled);
    if (rf.ran && rf.held.size) {
      const fillable = plan.filter((it) => it.type !== 'file' && it.descriptor
        && String(it.value ?? '').trim() !== '' && TTDEngine.resolveField(it.descriptor)).length;
      if (rf.held.size >= fillable) { toast(t('paste.reactAll')); return { done: true, mode: 'react-all' }; }
      if (armPasteForRemaining(plan, rf.held)) { toast(t('paste.reactPartial')); return { done: true, mode: 'react-partial' }; }
      toast(t('paste.reactAll')); return { done: true, mode: 'react-all' };
    }
    return { done: armPasteHelper(plan), mode: 'paste' };
  }

  /**
   * Is this form rejecting our fill? Write the first text field and, one React
   * cycle later, read it back: if it reverted to empty, the ttdevasthanams
   * isTrusted guard is active and the WHOLE form will reject us. Probing one
   * field up front (≈140ms) lets us pivot to the Paste Helper instantly, instead
   * of sitting through a multi-second fill of every row that was never going to
   * take. A single canary write on a blocked form is harmless — it reverts too.
   */
  // The ttdevasthanams React portal blocks programmatic input wholesale, so on
  // that host we don't bother probing — one click shows the Paste Helper at
  // once. Other hosts still fall back to the canary probe below.
  function isBlockedPortal() {
    try { return /(^|\.)ttdevasthanams\.ap\.gov\.in$/i.test(location.hostname); }
    catch { return false; }
  }

  // The SRIVANI portal (tirupatibalaji, legacy AngularJS) actively detects
  // autofill extensions and refuses to open its booking fields if it finds one.
  // On that host the extension therefore adds NOTHING to the page at load — no
  // floating button, no countdown chip, no banners, no captcha focus, no
  // history (pushState) hooks — so there is nothing for the site to detect while
  // the form renders. One-click fill still works fully on demand (popup "Fill
  // this page" button or Alt+Shift+F → fillNow), which only touches the page
  // after the user asks for it, by which point the fields are already open.
  const IS_SRIVANI = (() => {
    try { return /(^|\.)tirupatibalaji\.ap\.gov\.in$/i.test(location.hostname); }
    catch { return false; }
  })();

  async function blockedByCanary(plan) {
    try {
      // Probe the first text field that actually resolves on THIS page — not
      // merely the first in plan order, which may be a contact field the form
      // doesn't have (then we'd wrongly conclude "not blocked").
      let item = null;
      for (const it of (plan || [])) {
        if (!isTextPlanItem(it) || String(it.value ?? '').trim() === '') continue;
        const el = TTDEngine.resolveField(it.descriptor);
        if (el && !el.disabled && !el.readOnly) { item = it; break; }
      }
      if (!item) return false;
      await TTDEngine.runPlan([item], { delay: 0 }); // fill just this one field
      await TTDEngine.sleep(140);                     // let a controlled-input revert land
      const after = TTDEngine.resolveField(item.descriptor); // React may have swapped the node
      return !after || !String(after.value || '').trim();    // empty again → blocked
    } catch { return false; }
  }

  /**
   * Safety net behind the canary pivot: a short moment after a full fill, if
   * most of the text fields we set are empty again, the form blocked us — turn
   * on the Paste Helper. The canary in fillNow normally catches the main portal
   * first; this still covers any form that passes the canary but reverts later.
   */
  function offerPasteIfBlocked(plan) {
    if (window !== window.top || !window.TTDPaste) return;
    setTimeout(() => {
      try {
        const textItems = (plan || []).filter((it) => isTextPlanItem(it) && String(it.value ?? '').trim() !== '');
        const resolved = textItems
          .map((it) => ({ it, el: TTDEngine.resolveField(it.descriptor) }))
          .filter((x) => x.el && !x.el.disabled && !x.el.readOnly);
        if (resolved.length < 1) return;
        const empty = resolved.filter((x) => !String(x.el.value || '').trim());
        if (empty.length < Math.ceil(resolved.length * 0.6)) return; // fill held → not blocked
        armPasteHelper(plan);
      } catch { /* never break a fill over the fallback */ }
    }, 650);
  }

  /**
   * Finish a fill in the BACKGROUND so the main fill stays instant — critical on
   * SRIVANI, whose quota goes in seconds.
   *
   * Two SRIVANI quirks make a single fast pass sometimes incomplete:
   *   - the ID-proof <select> is AngularJS ng-options that load a moment late, so
   *     it may not be set on the first pass; and
   *   - setting that ID type CLEARS / re-enables the ID number field — so a
   *     number filled before the type was set gets wiped.
   * This is exactly why a first fill left the ID number empty while a second fill
   * (everything already set) worked.
   *
   * So we re-apply, in the background, ONLY the plan items that have not taken —
   * a <select> not holding its value, or a text field left empty though it has a
   * value — dropdowns first (setting a type may clear its number), then the text.
   * It stops the instant everything is in place (usually one or two ticks), never
   * touches a field the user has since typed into except a still-empty planned
   * one, and never advances the page.
   */
  function finishLatePlan(plan) {
    const items = (plan || []).filter((it) => {
      try { return !!TTDEngine.resolveField(it.descriptor); } catch { return false; }
    });
    if (!items.length) return;

    const pending = (it) => {
      const el = TTDEngine.resolveField(it.descriptor);
      if (!el) return false;
      if (el.tagName === 'SELECT') return !TTDEngine.selectHolds(el, it.value);
      if (el.type === 'checkbox' || el.type === 'radio' || it.type === 'file') return false;
      // A text field that should have a value but is empty (e.g. an ID number
      // the form cleared when its type changed).
      return String(it.value ?? '').trim() !== '' && String(el.value || '').trim() === '';
    };
    if (!items.some(pending)) return; // the fast pass already did everything

    // Dropdowns/selects before text, so a type is set before we (re)fill its number.
    const ordered = items.slice().sort((a, b) =>
      (a.type === 'dropdown' ? 0 : 1) - (b.type === 'dropdown' ? 0 : 1));

    let tries = 0;
    const tick = async () => {
      // If the Paste Helper has taken over (TTD is reverting our fills), stop
      // re-filling: every retry just fires more synthetic events the helper would
      // have to ignore, and it fights the user's own pasting.
      if (window.TTDPaste && window.TTDPaste.isActive()) return;
      tries++;
      for (const it of ordered) {
        if (!pending(it)) continue;
        const el = TTDEngine.resolveField(it.descriptor);
        if (!el) continue;
        if (el.tagName === 'SELECT') {
          TTDEngine.fillSelect(el, it.value);            // late options / reset
        } else if (!el.disabled) {
          await TTDEngine.fillOne(el, it.value, it.type, 20); // re-fill a cleared/empty field
        }
      }
      if (!items.some(pending) || tries >= 16) return;   // ~16 × 300ms ≈ 5s cap
      setTimeout(tick, 300);
    };
    setTimeout(tick, 250);
  }

  /** A tiny local tally of successful fills — a plain number, never any PII,
   *  never transmitted. Only used to decide when to show the one-time rate
   *  nudge in the popup. */
  async function bumpUsage() {
    try {
      const u = (await api.storage.local.get('usage')).usage || { fills: 0 };
      u.fills = (u.fills || 0) + 1;
      await api.storage.local.set({ usage: u });
    } catch { /* storage unavailable — the nudge just waits */ }
  }

  /**
   * Advance to the review page, but only when every rendered pilgrim row is
   * complete.
   *
   * The portal renders one row per ticket, so selecting 4 tickets with only 2
   * pilgrims saved leaves rows 3 and 4 empty. Continuing then would push a
   * half-filled booking forward and fail at the far end, so it stops and says
   * what is missing instead.
   */
  async function tryContinue(rowCheck) {
    const check = rowCheck ? TTDEngine.validateRows(rowCheck) : { applicable: false };

    if (check.applicable && check.incomplete.length) {
      return {
        clicked: false,
        reason: 'incomplete',
        rows: check.rows,
        incomplete: check.incomplete,
      };
    }

    const btn = TTDEngine.findContinueButton();
    if (!btn) return { clicked: false, reason: 'no-continue-button' };

    await TTDEngine.sleep(150); // let the last field's change settle first
    noteIntentionalNav(); // our own advance must not trip the draft-close guard
    btn.click();
    return { clicked: true, rows: check.rows ?? null };
  }

  function summarise(results, advance) {
    const filled = results.filter((r) => r.ok).length;
    const missing = results.filter((r) => r.reason === 'not-found').length;
    let text = t('toast.filled', { filled, total: results.length });
    if (missing) text += t('toast.notFound', { n: missing });

    if (advance?.reason === 'incomplete') {
      const list = advance.incomplete.map((i) => i.row).join(', ');
      text += t('toast.notContinuing', { rows: advance.rows, list });
    } else if (advance?.clicked) {
      text += t('toast.continuing');
    }
    return text;
  }

  // A small "TTV" pill prepended to every message the extension shows on the
  // page, so a user never mistakes our banner/toast for one of TTD's own system
  // alerts. (TTV = Tirumala Tirupati Vlogs, the maker of this helper.)
  function brandTag() {
    const b = document.createElement('span');
    b.className = 'ttd-af-brand';
    b.textContent = 'TTV';
    return b;
  }

  function toast(text) {
    document.querySelector('.ttd-af-toast')?.remove();
    const el = document.createElement('div');
    el.className = 'ttd-af-toast';
    el.append(brandTag(), document.createTextNode(text));
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 4000);
  }

  // ---------------------------------------------- booking log (v1.4, local)
  //
  // Strictly on-device and opt-in (settings.bookingLog). It records booking
  // OUTCOMES the extension already sees, so the user gets their own stats.
  // NOTHING is ever transmitted — no server, no network request. The popup
  // reads and clears it; here we only append.

  async function settingsNow() {
    try {
      const raw = await readProfileRaw();
      if (raw == null) return {}; // locked: no settings visible until unlock
      return migrateStore(raw).settings || {};
    } catch { return {}; }
  }
  async function statsGet() {
    try { return (await api.storage.local.get('stats')).stats || { events: [], session: null }; }
    catch { return { events: [], session: null }; }
  }
  const statsSave = (s) => { try { return api.storage.local.set({ stats: s }); } catch { return Promise.resolve(); } };

  /** A fill happened — begin timing this attempt (once per session). */
  async function noteFill(flow) {
    if (!(await settingsNow()).bookingLog) return;
    const s = await statsGet();
    if (!s.session) { s.session = { startAt: Date.now(), tries: 0, flow }; await statsSave(s); }
  }
  /** Record one booking outcome. kind 'success' ends the session. */
  async function logOutcome(kind, outcome, flow) {
    if (!(await settingsNow()).bookingLog) return;
    const s = await statsGet();
    const now = Date.now();
    if (kind === 'success') {
      const tries = (s.session ? s.session.tries : 0) + 1;
      s.events.push({ at: now, flow: flow || s.session?.flow || null, kind, outcome: 'success',
        tries, durationMs: s.session ? now - s.session.startAt : null });
      s.session = null;
    } else {
      if (s.session) s.session.tries = (s.session.tries || 0) + 1;
      s.events.push({ at: now, flow, kind: 'fail', outcome, tries: s.session ? s.session.tries : 1 });
    }
    if (s.events.length > 300) s.events = s.events.slice(-300);
    await statsSave(s);
  }
  let successLogged = false;
  async function scanForSuccess() {
    if (successLogged) return;
    if (!TTDEngine.isBookingSuccess(document.body?.innerText || '', location.href)) return;
    clearBookingLock(); // a confirmed booking resolves any in-progress hold note
    // Only consume the once-per-page flag if the log is actually on — otherwise
    // a confirmation seen while logging is off would block a later real log.
    if (!(await settingsNow()).bookingLog) return;
    successLogged = true;
    logOutcome('success', 'success', flowFromUrl(location.href) || DEFAULT_FLOW);
  }

  // -------------------------------------- server-synced release countdown (v1.4)
  //
  // Opt-in (settings.pageCountdown), off by default → no on-page element unless
  // the user turns it on. Read-only: it reads TTD's own "System Time" and
  // "Quota Release Time" and ticks down. It NEVER clicks or books anything.

  let cdEl = null, cdTimer = null, cdDeadline = null;
  let cdAlerted = false;      // fired the "quota open" alert for this window?
  let cdAlertEnabled = true;  // settings.releaseAlert (cached each parse)
  function removeCountdown() {
    document.querySelectorAll('.ttd-af-countdown').forEach((e) => e.remove());
    cdEl = null;
    if (cdTimer) { clearInterval(cdTimer); cdTimer = null; }
    cdDeadline = null;
  }
  // Device-clock vs TTD-server-clock offset (seconds). Positive = the device is
  // AHEAD (fast) of TTD; negative = BEHIND (slow) — the risky one, you act late.
  let cdDrift = null;
  function deviceISTSecs() {
    try {
      const [h, m, s] = new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour12: false })
        .split(':').map(Number);
      return h * 3600 + m * 60 + s;
    } catch { return null; }
  }
  function computeDrift(serverNowSecs) {
    const dev = deviceISTSecs();
    if (dev == null || serverNowSecs == null) return null;
    let d = dev - serverNowSecs;
    if (d > 43200) d -= 86400; else if (d < -43200) d += 86400; // midnight wrap
    return d;
  }
  function renderCountdown() {
    if (cdDeadline == null) return;
    const left = Math.round((cdDeadline - Date.now()) / 1000);
    if (!cdEl) {
      cdEl = document.createElement('div');
      cdEl.className = 'ttd-af-countdown';
      const txt = document.createElement('span'); txt.className = 'ttd-af-cd-text';
      const drift = document.createElement('span'); drift.className = 'ttd-af-drift';
      const close = document.createElement('button');
      close.className = 'ttd-af-countdown-close'; close.textContent = '×';
      close.addEventListener('click', removeCountdown);
      cdEl.append(txt, drift, close);
      document.body.appendChild(cdEl);
    }
    const txt = cdEl.querySelector('.ttd-af-cd-text');
    if (left <= 0) {
      cdEl.classList.add('open');
      txt.textContent = t('countdown.open');
      // Fire the release alert exactly once as the window opens.
      if (!cdAlerted && cdAlertEnabled) { cdAlerted = true; fireReleaseAlert(); }
    } else {
      const mm = String(Math.floor(left / 60)).padStart(2, '0');
      const ss = String(left % 60).padStart(2, '0');
      txt.textContent = t('countdown.opensIn', { t: `${mm}:${ss}` });
    }
    // Drift badge (read-only): trust the countdown, not a wrong PC clock.
    const dEl = cdEl.querySelector('.ttd-af-drift');
    if (cdDrift == null) { dEl.hidden = true; }
    else {
      dEl.hidden = false;
      const a = Math.abs(cdDrift);
      dEl.classList.remove('ok', 'fast', 'slow');
      if (a <= 1) { dEl.classList.add('ok'); dEl.textContent = '✓ ' + t('drift.sync'); }
      else if (cdDrift > 0) { dEl.classList.add('fast'); dEl.textContent = '⚠ ' + t('drift.fast', { n: a }); }
      else { dEl.classList.add('slow'); dEl.textContent = '⚠ ' + t('drift.slow', { n: a }); }
    }
  }
  async function updateCountdown() {
    const c = TTDEngine.parseServerCountdown(document.body?.innerText || '');
    const s = await settingsNow();
    if (!c || !s.pageCountdown) { removeCountdown(); return; }
    setLang(s.language || 'en');
    cdAlertEnabled = s.releaseAlert !== false;
    cdDrift = computeDrift(c.serverNowSecs); // recompute the clock offset each parse
    if (c.secondsLeft > 2) cdAlerted = false; // a fresh future window re-arms the alert
    cdDeadline = Date.now() + c.secondsLeft * 1000; // resync to server each parse
    if (!cdTimer) { renderCountdown(); cdTimer = setInterval(renderCountdown, 1000); }
  }

  /**
   * The quota window just opened — grab the user's attention without any new
   * permission: a short beep (Web Audio), a flashing tab title (so a user on
   * another tab notices), and the chip already pulses via CSS. Read-only and
   * harmless: it never books or clicks anything.
   */
  let titleFlashTimer = null, savedTitle = null;
  function stopFlashTitle() {
    if (titleFlashTimer) { clearInterval(titleFlashTimer); titleFlashTimer = null; }
    if (savedTitle != null) { document.title = savedTitle; savedTitle = null; }
    document.removeEventListener('visibilitychange', onVisRestore);
  }
  function onVisRestore() { if (document.visibilityState === 'visible') stopFlashTitle(); }
  function flashTitle() {
    if (titleFlashTimer || typeof document.title !== 'string') return;
    savedTitle = document.title;
    const msg = '🔔 ' + t('countdown.open');
    let on = true, ticks = 0;
    titleFlashTimer = setInterval(() => {
      document.title = on ? msg : (savedTitle || 'TTD');
      on = !on;
      if (++ticks > 40 || document.visibilityState === 'visible') stopFlashTitle();
    }, 800);
    document.addEventListener('visibilitychange', onVisRestore);
  }
  function fireReleaseAlert() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) {
        const ctx = new AC();
        if (ctx.resume) ctx.resume();
        const beep = (freq, start, dur) => {
          const o = ctx.createOscillator(), g = ctx.createGain();
          o.type = 'sine'; o.frequency.value = freq;
          o.connect(g); g.connect(ctx.destination);
          const t0 = ctx.currentTime + start;
          g.gain.setValueAtTime(0.0001, t0);
          g.gain.exponentialRampToValueAtTime(0.3, t0 + 0.02);
          g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
          o.start(t0); o.stop(t0 + dur + 0.02);
        };
        beep(880, 0, 0.18); beep(1175, 0.22, 0.18); beep(880, 0.44, 0.3);
        setTimeout(() => { try { ctx.close(); } catch { /* */ } }, 1600);
      }
    } catch { /* audio blocked — the title flash still fires */ }
    flashTitle();
  }

  // ------------------------------------------------ auto-fill on load

  /**
   * Fill the pilgrim page the moment it renders — WITHOUT the popup being
   * opened. Strictly opt-in and deliberately cautious:
   *
   *   - only when settings.autoFillOnLoad is on,
   *   - only on a real /pilgrim-details form (never the queue, slot or review
   *     page, never a payment page),
   *   - only when the active profile is Ready (no blank or malformed fields),
   *   - only in the frame that actually holds the form,
   *   - exactly once per page load.
   *
   * It runs the identical plan the manual button runs, and (like the button)
   * only ever clicks Continue, never Pay Now. If the profile is not ready it
   * does nothing and leaves the on-page banner to say why — auto-filling half a
   * booking would be worse than filling none.
   */
  // idle: eligible to run · checking: a run is being evaluated (sync lock) ·
  // running: filling · done: filled, don't repeat · skip: not applicable here.
  // A 'skip' can be re-armed to 'idle' when settings/profile change (e.g. the
  // user ticks auto-fill), so it takes effect without a page reload.
  let autoState = 'idle';

  /**
   * Which pages auto-fill may act on. The main flows expose the form at
   * /pilgrim-details; SRIVANI is a hash route on the legacy portal, so it is
   * recognised by flow instead of path. The resolvable-fields check later is
   * what actually confirms the form is present, so this only has to be
   * permissive enough to include every booking form.
   */
  function autoFillablePage() {
    return /\/pilgrim-details/i.test(location.pathname)
      || /\/unified-profile/i.test(location.pathname) // Srivari Seva volunteer form
      || flowFromUrl(location.href) === FLOWS.SRIVANI;
  }

  // Are there editable fields on the page right now? Used to light the floating
  // button's "ready" glow. It must NOT key off `[name]` alone: SED's Gender /
  // Photo ID Proof are nameless custom dropdowns and its text inputs carry no
  // name attribute either, so a name-only test left the button muted on a page
  // it fills perfectly. Any real input/select/textarea is enough — this only
  // ever runs on an autoFillablePage(), so it can't light up on a payment page.
  function hasFillableFields() {
    return !!document.querySelector(
      'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"]), select, textarea, [contenteditable="true"]'
    );
  }

  /** Pilgrims chosen for THIS booking. A person is included unless explicitly
   *  turned off (include === false), so old profiles default to "all in". */
  const includedPeople = (p) => p.people.filter((person) => person.include !== false);

  function profileReady(p) {
    const chosen = includedPeople(p);
    if (!chosen.length) return false; // nothing selected to book
    const eachComplete = chosen.every((person) =>
      PERSON_FIELDS.every((f) => String(person[f.key] ?? '').trim()) &&
      validatePerson(person).length === 0
    );
    return eachComplete && findDuplicateIds(chosen).length === 0;
  }

  function buildAutoPlan(store, userMappings, flow, p) {
    const seeds = buildSeeds(flow, MAX_PILGRIMS);
    const merged = { ...seeds, ...((userMappings || {})[flow] || {}) };
    // Subset picker: only the chosen pilgrims are filled, and they are COMPACTED
    // onto the page's first rows (row 0,1,2…) regardless of their position in
    // the saved list — the portal renders one row per selected ticket.
    const chosen = includedPeople(p);
    const plan = [];
    for (const [fieldKey, descriptor] of Object.entries(merged)) {
      let value;
      if (fieldKey.startsWith('people.')) {
        const dot = fieldKey.indexOf('.', 7);
        const row = Number(fieldKey.slice(7, dot));
        const leaf = fieldKey.slice(dot + 1);
        if (!Number.isInteger(row) || row >= chosen.length) continue; // no chosen pilgrim for this row
        value = chosen[row][leaf];
        // A blank per-pilgrim contact field falls back to the shared block.
        if (store.settings.propagateAddress && (value === '' || value == null) && CONTACT_KEY_SET.has(leaf)) {
          value = readPath(p, `contact.${leaf}`);
        }
      } else if (fieldKey === 'gothram') {
        // Form-level Gothram is ONE value per booking (e.g. Virtual Seva), but
        // the editor stores it on a pilgrim row (shown once). Use the first
        // non-empty Gothram among the chosen pilgrims, else any saved pilgrim.
        const pick = (list) => (list || []).map((x) => x.gothram).find((g) => String(g ?? '').trim());
        value = pick(chosen) || pick(p.people) || '';
      } else {
        value = readPath(p, fieldKey);
      }
      if (value === '' || value == null) continue;
      plan.push({ fieldKey, descriptor, value, type: fieldType(fieldKey) });
    }
    return plan;
  }

  /**
   * One representative field per planned pilgrim row, keyed by row index.
   * Used to count how many of the chosen rows are actually on the page.
   */
  function plannedPilgrimRows(plan) {
    const byRow = new Map();
    for (const it of plan) {
      const m = /^people\.(\d+)\./.exec(it.fieldKey);
      if (m && !byRow.has(Number(m[1]))) byRow.set(Number(m[1]), it);
    }
    return byRow;
  }

  function resolvedRowCount(byRow) {
    let n = 0;
    for (const [, it] of byRow) if (TTDEngine.resolveField(it.descriptor)) n++;
    return n;
  }

  /**
   * True only once EVERY chosen pilgrim's row is on the page — not merely the
   * first.
   *
   * Some flows (Arjitha / Virtual Seva / Angapradakshina) render the contact
   * block immediately but add the pilgrim rows a beat later, one at a time. The
   * old gate waited for row 0 alone, so a fill that fired while rows 1-4 were
   * still rendering filled only the rows present and silently skipped the rest —
   * exactly how a 5-pilgrim booking came out "filled 4 of 5" (the last row's
   * name/Aadhaar/dropdowns resolve to null and are dropped). Gating on the whole
   * set makes a fill wait for all of them.
   */
  function pilgrimRowsReady(plan) {
    const byRow = plannedPilgrimRows(plan);
    if (!byRow.size) return true; // this flow has no pilgrim rows
    return resolvedRowCount(byRow) >= byRow.size;
  }

  /**
   * Give lazily-rendered pilgrim rows a moment to ALL appear before filling, so
   * a manual tap doesn't fill a half-rendered form. Resolves as soon as every
   * chosen row is present; or, if rows stop appearing below that target for a
   * few polls, once the page's real row count has settled (fill what's there
   * rather than hang); or at the timeout. Returns false only when no pilgrim row
   * resolves at all (wrong frame / nothing rendered yet) so the caller can wait
   * and retry. Never blocks a flow without pilgrim rows.
   */
  async function waitForPilgrimRows(plan, timeoutMs = 6000) {
    const byRow = plannedPilgrimRows(plan);
    if (!byRow.size) return true;
    const target = byRow.size;
    const start = Date.now();
    const deadline = start + timeoutMs;
    // Don't fall back to "fill the rows that exist" until we've waited a real
    // beat: a normal lazy render adds every row within a second or two, so an
    // early settle would mistake an inter-row gap for the page's final count
    // and refill the "4 of 5" bug. Only a page genuinely stuck below target
    // past this point (chose more pilgrims than the seva allows) proceeds short.
    const SETTLE_AFTER = 2500;
    let last = -1, stable = 0;
    for (;;) {
      const n = resolvedRowCount(byRow);
      if (n >= target) return true;                 // every chosen row is on the page
      stable = n === last ? stable + 1 : 0;         // growth resets the settle counter
      last = n;
      if (n > 0 && Date.now() - start >= SETTLE_AFTER && stable >= 4) return true;
      if (Date.now() >= deadline) return n > 0;     // timed out: proceed iff any row exists
      await TTDEngine.sleep(200);
    }
  }

  async function maybeAutoFill() {
    if (autoState !== 'idle') return;
    // A manual/floating fill is already running — don't overlap it (that fight
    // over the shared dropdown panel is exactly what drops the ID-Proof pick).
    // Stay 'idle' so armAutoFill retries once that fill releases the lock.
    if (fillInFlight) return;
    autoState = 'checking'; // synchronous lock: never let two runs overlap

    try {
      // 'skip' = genuinely not applicable (wrong page, or the setting is off).
      // Everything transient returns to 'idle' so a retry (form finished
      // rendering, profile became Ready, setting just turned on) can proceed.
      if (!autoFillablePage()) { autoState = 'skip'; return; }
      // The Srivari Seva volunteer profile is filled only on demand (the Fill
      // button or floating launcher), never automatically on load — it is a
      // one-time account setup, not a race against a release window.
      if (flowFromUrl(location.href) === FLOWS.SRIVARI) { autoState = 'skip'; return; }
      if (TTDEngine.isQueuePage(document.body?.innerText || '')) { autoState = 'idle'; return; }

      const profileRaw = await readProfileRaw();
      if (profileRaw == null) { autoState = 'idle'; return; } // locked — wait for unlock
      const mappings = (await api.storage.local.get('mappings')).mappings;
      const store = migrateStore(profileRaw);
      setLang(store.settings.language || 'en');
      if (!store.settings.autoFillOnLoad) { autoState = 'skip'; return; }

      const p = activeProfile(store);
      if (!profileReady(p)) { autoState = 'idle'; return; } // retry once it's Ready

      const flow = flowFromUrl(location.href) || DEFAULT_FLOW;
      const plan = buildAutoPlan(store, mappings, flow, p)
        .filter((item) => item.value !== '' && item.value != null);
      // Only the frame holding the form should act; elsewhere nothing resolves.
      if (!plan.some((item) => TTDEngine.resolveField(item.descriptor))) { autoState = 'idle'; return; }
      // Wait until EVERY chosen pilgrim row has rendered — filling a partly-built
      // form leaves the last pilgrims' Aadhaar/dropdowns blank ("4 of 5"). Stay
      // 'idle' so armAutoFill re-polls (every 300ms, ~15s) as the rows appear.
      if (!pilgrimRowsReady(plan)) { autoState = 'idle'; return; }

      // Take the shared fill lock so a floating-button / shortcut fill cannot
      // start on top of this one. Re-check it under the sync 'checking' state
      // to close the tiny gap since the top-of-function check.
      if (fillInFlight) { autoState = 'idle'; return; }
      fillInFlight = true;
      autoState = 'running';
      try {
        // Same fast pivot as the manual button: on a blocked React form, switch
        // to the Paste Helper at once rather than filling every row in vain.
        if (window === window.top && flow !== FLOWS.SRIVANI && window.TTDPaste
            && (window.TTDPaste.isActive() || isBlockedPortal() || await blockedByCanary(plan))) {
          if (!window.TTDPaste.isActive()) { await reactThenPaste(plan, store.settings.reactFill !== false); autoState = 'done'; return; }
          if (armPasteHelper(plan)) { autoState = 'done'; return; }
        }
        const { results, advance } = await runFill(plan, {
          delay: fillDelayForFlow(flow, store.settings.fillDelayMs),
          // Never auto-advance SRIVANI: it is captcha- and quota-gated.
          autoContinue: store.settings.autoContinue && flow !== FLOWS.SRIVANI,
          rowCheck: rowCheckSpec(flow),
        });
        toast(summarise(results, advance));
      } finally {
        fillInFlight = false;
      }
      autoState = 'done';
    } catch {
      autoState = 'idle'; // let a later attempt retry
    }
  }

  /**
   * Kick off auto-fill and keep retrying as the (often async) form renders —
   * on any route, including the SRIVANI hash route that `watchOutcomes` does
   * not observe. Stops the moment it fills ('done') or rules the page out
   * ('skip'), or after ~15s. Arjitha adds its pilgrim rows several seconds
   * after the contact block, so the window is generous.
   */
  function armAutoFill() {
    maybeAutoFill();
    updateFloatingButton();
    let tries = 0;
    const iv = setInterval(() => {
      updateFloatingButton();
      if (autoState === 'done' || autoState === 'skip' || ++tries > 50) {
        clearInterval(iv);
        return;
      }
      maybeAutoFill();
    }, 300);
  }

  /**
   * A3 — an optional "Fill" button drawn on the TTD page itself, so a fill is
   * possible without opening the popup. Opt-in (settings.floatingButton), only
   * on a booking form (never a payment/review page, via autoFillablePage), and
   * only once a form is actually present. Clicking it runs the same fillNow().
   */
  let floatBusy = false;

  /** Build the floating launcher: a TTV badge + label pill. */
  function buildFloatButton() {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ttd-af-float';
    const mark = document.createElement('span');
    mark.className = 'ttd-af-float-mark';
    mark.textContent = 'TTV';
    const label = document.createElement('span');
    label.className = 'ttd-af-float-label';
    btn.append(mark, label);
    // Always safe: this only ever opens the on-page chooser, whose options run
    // the booking-form fill (fillNow) — known pilgrim fields and NOTHING else.
    // On a page with no such form it reports "nothing to fill"; it can never
    // touch payment.
    btn.addEventListener('click', (e) => { e.preventDefault(); showModeChooser(); });
    return btn;
  }

  /**
   * On-page mode chooser (the gold pill opens this): the user picks One-click
   * autofill or Copy-paste, right on the booking page. Both are ALWAYS offered —
   * if TTD ever blocks autofill, copy-paste is one tap away (and autofill also
   * falls back to paste on its own). Shown only once the install is unlocked.
   */
  async function showModeChooser() {
    document.querySelector('.ttv-chooser')?.remove();
    const el = (tag, cls, txt) => { const n = document.createElement(tag); if (cls) n.className = cls; if (txt != null) n.textContent = txt; return n; };
    const panel = el('div', 'ttv-chooser');

    const head = el('div', 'ttv-chooser-head');
    const x = el('button', 'ttd-paste-x', '×'); x.title = t('paste.close'); x.addEventListener('click', () => panel.remove());
    head.append(el('span', 'ttd-paste-badge', 'TTV'), el('span', 'ttv-chooser-title', t('chooser.title')), x);

    const mkOpt = (cls, title, desc, run) => {
      const b = el('button', 'ttv-chooser-opt ' + cls);
      const col = el('div', 'ttv-chooser-opt-text');
      col.append(el('div', 'ttv-chooser-opt-title', title), el('div', 'ttv-chooser-opt-desc', desc));
      b.appendChild(col);
      b.addEventListener('click', (e) => { e.preventDefault(); panel.remove(); run(); });
      return b;
    };

    panel.append(
      head,
      el('div', 'ttv-chooser-sub', t('chooser.sub')),
      mkOpt('ttv-chooser-primary', t('chooser.autofill'), t('chooser.autofillDesc'), () => fillNow({ interactive: true, mode: 'autofill' })),
      mkOpt('ttv-chooser-secondary', t('chooser.paste'), t('chooser.pasteDesc'), () => fillNow({ interactive: true, mode: 'paste' })),
      el('div', 'ttv-chooser-note', t('chooser.safety')),
    );
    document.body.appendChild(panel);
  }

  async function updateFloatingButton() {
    if (floatBusy) return;
    floatBusy = true;
    try {
      const profileRaw = await readProfileRaw();
      const existing = document.querySelector('.ttd-af-float');
      // Locked (encrypted, not yet unlocked): settings are unreadable, so hide
      // the button until the user unlocks in the popup.
      if (profileRaw == null) { existing?.remove(); return; }
      const store = migrateStore(profileRaw);
      setLang(store.settings.language || 'en');

      // Show whenever the user has ticked it, on ANY page of the two domains
      // (top frame only — one button). It stays a pure launcher for the
      // booking-form fill and never interacts with payment, so it is safe to
      // show everywhere. Where there is no form to fill it shows a muted state.
      const show = store.settings.floatingButton && window === window.top;
      if (!show) { existing?.remove(); return; }

      const active = autoFillablePage() && hasFillableFields();
      // On the blocked React portal the button opens the Paste Helper (it can't
      // fill), so name it honestly; on SRIVANI / the legacy portal it still
      // fills, so it keeps "Fill Details Govinda".
      const label = isBlockedPortal() ? t('float.labelPaste') : t('float.label');
      const btn = existing || buildFloatButton();
      btn.dataset.active = active ? '1' : '0';
      btn.querySelector('.ttd-af-float-label').textContent = label;
      btn.title = active ? label : t('status.nothingToFill');
      if (!existing) document.body.appendChild(btn);
    } finally {
      floatBusy = false;
    }
  }

  // ------------------------------------------------------ payment outcomes

  let lastVerdictKey = '';
  let verdictTimer = null;

  // ----- "booking in progress" self-hold lock ------------------------------
  // After a payment is aborted or errors out, TTD keeps the pilgrim IDs locked
  // ("Booking with same pilgrim id is in progress. Please try again after some
  // time"). The user can't tell how long it has been held or whether the failed
  // attempt actually went through. We mark the moment it's first seen — locally,
  // no PII, just a timestamp + flow — so the on-page banner can show a live
  // elapsed timer that survives a refresh, and the popup can remind them to
  // check Booking History if the tab is closed. We never auto-retry.
  let lockTimer = null;        // interval id for the elapsed ticker
  let lockMarked = false;      // have we written a marker this session?
  const LOCK_VERDICTS = new Set(['self-hold', 'gateway']);
  const LOCK_STALE_MS = 2 * 60 * 60 * 1000; // older than 2h = a new incident

  async function noteBookingLock(flow) {
    try {
      const cur = (await api.storage.local.get('bookingLock')).bookingLock;
      const fresh = cur && (Date.now() - cur.ts) < LOCK_STALE_MS;
      const mark = fresh ? cur : { ts: Date.now(), flow: flow || (cur && cur.flow) || '' };
      if (!fresh) await api.storage.local.set({ bookingLock: mark });
      lockMarked = true;
      return mark.ts;
    } catch { return Date.now(); }
  }

  function clearBookingLock() {
    if (!lockMarked) return;          // nothing we set this session — skip the write
    lockMarked = false;
    try { api.storage.local.remove('bookingLock'); } catch { /* storage gone — fine */ }
  }

  function fmtElapsed(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
    const h = Math.floor(m / 60);
    return `${h}h ${String(m % 60).padStart(2, '0')}m`;
  }

  // Open TTD's own Booking History — the one thing worth doing after an errored
  // payment, since the attempt may actually have gone through. We click the
  // site's existing nav link (in-app navigation), never a reconstructed URL.
  function openBookingHistory() {
    const cand = [...document.querySelectorAll('a, button, [role="menuitem"], li, span')]
      .find((e) => /booking\s*history/i.test((e.textContent || '').trim()) && e.offsetParent !== null);
    if (cand) { noteIntentionalNav(); cand.click(); return true; }
    toast(t('lockbar.historyHint'));
    return false;
  }

  // Add the live elapsed timer + "Check Booking History" button to a self-hold
  // / gateway verdict box. Async because the first-seen timestamp is read from
  // storage (so it continues across refreshes rather than resetting).
  async function attachLockMeta(box, flow) {
    const ts = await noteBookingLock(flow);
    if (!document.body.contains(box)) return; // box was replaced while we waited
    const close = box.querySelector('.ttd-af-verdict-close');

    const timer = document.createElement('div');
    timer.className = 'ttd-af-verdict-timer';
    const actions = document.createElement('div');
    actions.className = 'ttd-af-verdict-actions';
    const hist = document.createElement('button');
    hist.className = 'ttd-af-verdict-history';
    hist.textContent = t('lockbar.history');
    hist.addEventListener('click', (e) => { e.preventDefault(); openBookingHistory(); });
    actions.append(hist);
    box.insertBefore(timer, close);
    box.insertBefore(actions, close);

    // The hold clears in about 5 minutes (measured live), so once past that mark
    // switch from "usually clears in ~5 min" to "should be clear now — try Retry".
    const READY_MS = 5 * 60 * 1000;
    const paint = () => {
      const ms = Date.now() - ts;
      timer.textContent = t(ms >= READY_MS ? 'lockbar.ready' : 'lockbar.elapsed', { t: fmtElapsed(ms) });
    };
    paint();
    if (lockTimer) clearInterval(lockTimer);
    lockTimer = setInterval(() => {
      if (!document.body.contains(timer)) { clearInterval(lockTimer); lockTimer = null; return; }
      paint();
    }, 1000);
  }

  function scanForOutcome() {
    const outcome = TTDEngine.classifyOutcome(document.body?.innerText || '');
    if (!outcome) {
      lastVerdictKey = ''; // alert dismissed — allow the next one to announce
      return;
    }
    if (outcome.verdict === lastVerdictKey) return; // don't re-announce
    lastVerdictKey = outcome.verdict;
    showVerdict(outcome);
    logOutcome('fail', outcome.id, flowFromUrl(location.href)); // no-op unless the log is on
  }

  function showVerdict(outcome) {
    // Prefer a localized verdict; fall back to the English text the engine
    // baked in (which, for English, already carries any quota-stats prefix).
    let headline = outcome.headline;
    let advice = outcome.advice;
    if (currentLang() !== 'en' && outcome.id) {
      headline = t(`verdict.${outcome.id}.head`);
      advice = t(`verdict.${outcome.id}.advice`);
      if (outcome.stats?.inProgress) {
        advice = t('verdict.statsPrefix', { n: outcome.stats.inProgress }) + advice;
      }
    }

    if (lockTimer) { clearInterval(lockTimer); lockTimer = null; } // stop a prior ticker
    document.querySelector('.ttd-af-verdict')?.remove();
    const box = document.createElement('div');
    box.className = `ttd-af-verdict ttd-af-${outcome.verdict}`;
    const h = document.createElement('strong');
    h.textContent = headline;
    const p = document.createElement('div');
    p.textContent = advice;
    const close = document.createElement('button');
    close.textContent = '×';
    close.className = 'ttd-af-verdict-close';
    close.addEventListener('click', () => {
      if (lockTimer) { clearInterval(lockTimer); lockTimer = null; }
      clearBookingLock(); // dismissing is the user acknowledging the hold
      box.remove();
    });
    box.append(brandTag(), h, p, close);
    document.body.appendChild(box);
    // The self-hold / gateway holds are the ones where "how long has it been?"
    // matters — enrich those with a live timer and a Booking-History shortcut.
    if (LOCK_VERDICTS.has(outcome.verdict)) attachLockMeta(box, flowFromUrl(location.href));
  }

  /**
   * Watch the booking and payment pages, and debounce — these are busy React
   * pages and reading innerText on every mutation would be wasteful.
   *
   * /api/checkout and /gateway are included because the payment proxy can
   * return a bare "504 Gateway Time-out" there, with no TTD UI at all. That
   * page is static, so the observer never fires on it — hence the immediate
   * scan below, which is what actually catches it.
   */
  const WATCHED = /review-details|booking-details|pilgrim-details|slot-booking|api\/checkout|gateway|receipt|success|confirmation/;

  let outcomeObserver = null;

  // Always run (any TTD route): the countdown chip, success scan, the floating
  // button's active/muted state, captcha focus, the logout warning.
  function runAlways() {
    updateCountdown();
    scanForSuccess();
    updateFloatingButton();
    maybeFocusCaptcha();
    checkLogout();
  }

  // Only on the booking/payment routes: outcome verdicts, the queue banner, slot
  // add-ons, and the Srivari slot helpers.
  function runWatched() {
    if (!WATCHED.test(location.pathname)) return;
    scanForOutcome(); // static error pages never mutate — catch them here
    checkQueue();
    maybeFillSlotAddOns(); // opt-in laddus/hundi on the slot page
    maybeHandleSrivariSlot(); // Srivari Seva slot: highlight/location/declaration
  }

  function watchOutcomes() {
    runAlways();
    runWatched();
    // Attach the observer once we are on — or arrive at — a booking/payment
    // route. TTD is a single-page app, so this is also called on in-app route
    // changes (see start()): previously the observer only attached if the FIRST
    // page the script saw was a booking page, which left the extension
    // "half-alive" (button muted, fill unreliable) whenever the user arrived via
    // in-app navigation from the login/dashboard page. Gating to WATCHED keeps
    // non-booking pages — and the countdown chip's own ticks — from driving a
    // re-scan loop; once attached the observer persists for the session.
    if (outcomeObserver || !WATCHED.test(location.pathname)) return;
    outcomeObserver = new MutationObserver(() => {
      clearTimeout(verdictTimer);
      verdictTimer = setTimeout(() => { runAlways(); runWatched(); }, 200);
    });
    outcomeObserver.observe(document.body, { childList: true, subtree: true });
  }

  // ------------------------------------------------------ virtual queue

  /**
   * While the user waits in the virtual queue, tell them whether their saved
   * details are actually complete — AND well-formed. A short Aadhaar caught
   * here, in the dead minutes of the queue, is a saved booking; caught at the
   * gate, it is a lost one.
   *
   * This only reads and displays. It never touches the queue, never refreshes
   * and never polls the server — the user's place in line is server-side and
   * interfering with it could lose their turn.
   */
  let queueBanner = null;
  let queueBusy = false;
  let wasQueue = false; // were we on the virtual-queue page a moment ago?

  async function checkQueue() {
    const text = document.body?.innerText || '';
    if (!TTDEngine.isQueuePage(text)) {
      // The queue just cleared and the booking page swapped in (same URL, client
      // side) — the user's turn has arrived. Give the same no-permission nudge
      // the release countdown uses (beep + tab-title flash), so someone who
      // stepped away during the wait comes back. Gated on the same "alert me"
      // preference (cdAlertEnabled ← settings.releaseAlert), fired once, and
      // never on a payment/receipt page.
      if (wasQueue) {
        wasQueue = false;
        const onBooking = /slot-booking|pilgrim-details/.test(location.pathname);
        if (cdAlertEnabled && onBooking) fireReleaseAlert();
      }
      queueBanner?.remove();
      queueBanner = null;
      return;
    }
    wasQueue = true;
    if (queueBusy) return;      // one storage read in flight is enough
    queueBusy = true;

    try {
      const profileRaw = await readProfileRaw();
      if (profileRaw == null) { queueBanner?.remove(); queueBanner = null; return; } // locked
      const store = migrateStore(profileRaw);
      setLang(store.settings.language || 'en');
      const p = activeProfile(store);

      const problems = [];
      p.people.forEach((person, i) => {
        const missingKeys = PERSON_FIELDS
          .filter((f) => !String(person[f.key] ?? '').trim())
          .map((f) => f.key);
        const invalid = validatePerson(person);
        if (missingKeys.length || invalid.length) problems.push({ n: i + 1, missingKeys, invalid });
      });
      const duplicates = findDuplicateIds(p.people);

      showQueueBanner(p, problems, duplicates);
    } catch {
      /* storage unavailable — the queue page is not ours to break */
    } finally {
      queueBusy = false;
    }
  }

  // -------------------------------------------- release schedule (read-only)


  // -------------------------------------------- passive logout warning

  /**
   * If the user appears to be signed OUT of the TTD portal, show a prominent
   * (dismissible) banner telling them to log in — so they are not caught logged
   * out the moment a release opens. Entirely passive: it reads the page text
   * only, makes NO network request, and never touches the login form. Detection
   * is conservative (TTDEngine.loginState only says 'out' on a clear sign-in
   * page), so a signed-in user is never nagged.
   */
  let logoutBanner = null;
  let logoutDismissed = false;
  async function checkLogout() {
    if (logoutDismissed) return;
    const state = TTDEngine.loginState(document.body?.innerText || '');
    if (state !== 'out') { logoutBanner?.remove(); logoutBanner = null; return; }
    if (logoutBanner) return; // already showing

    let warn = true, lang = 'en';
    try {
      const raw = await readProfileRaw();
      if (raw) { const st = migrateStore(raw).settings; warn = st.logoutWarn !== false; lang = st.language || 'en'; }
    } catch { /* locked or unavailable — default to warning; it is harmless */ }
    if (!warn) return;
    setLang(lang);
    showLogoutBanner();
  }

  function showLogoutBanner() {
    document.querySelectorAll('.ttd-af-logout').forEach((el) => el.remove());
    const box = document.createElement('div');
    box.className = 'ttd-af-logout';
    const head = document.createElement('strong');
    head.textContent = t('logout.head');
    const body = document.createElement('div');
    body.textContent = t('logout.body');
    const close = document.createElement('button');
    close.className = 'ttd-af-logout-x';
    close.textContent = t('logout.dismiss');
    close.addEventListener('click', () => { logoutDismissed = true; box.remove(); logoutBanner = null; });
    box.append(brandTag(), head, body, close);
    document.body.appendChild(box);
    logoutBanner = box;
  }

  // -------------------------------------------- slot add-ons (laddus / hundi)

  /**
   * Fill the optional PAID add-ons on /slot-booking — additional laddus and the
   * hundi offering — but ONLY when the user has explicitly opted in
   * (settings.slotAddOns.enabled) AND entered a value. Both cost real money, so
   * this is deliberately conservative:
   *
   *   - never on the queue page (the fields aren't there yet);
   *   - never overwrites a value the user already typed;
   *   - never touches the date, slot or ticket count (those are decisions);
   *   - and it NEVER clicks Continue — the amounts are always left on screen to
   *     be seen before paying. That last point is the whole safety story.
   *
   * A malformed stored amount is skipped rather than pushed. The signature guard
   * stops the mutation observer re-filling on every DOM tick, while still
   * retrying if a field hasn't rendered yet.
   */
  let slotAddOnsSig = null;

  async function maybeFillSlotAddOns() {
    if (!/\/slot-booking\b/.test(location.pathname)) return;
    if (TTDEngine.isQueuePage(document.body?.innerText || '')) return; // still in the queue

    let store;
    try {
      const raw = await readProfileRaw();
      if (raw == null) return;             // encrypted + locked
      store = migrateStore(raw);
    } catch { return; }

    const s = store.settings.slotAddOns;
    if (!s || !s.enabled) return;
    const laddus = String(s.laddus ?? '').trim();
    const hundi = String(s.hundi ?? '').trim();
    if (laddus === '' && hundi === '') return;
    if (validateSlotAddOns(s).length) return; // don't push a malformed amount

    const sig = `${location.pathname}|${laddus}|${hundi}`;
    if (slotAddOnsSig === sig) return;        // already handled this page + values

    const plan = [];
    let unresolved = 0;
    const consider = (key, value) => {
      if (value === '') return;
      const el = TTDEngine.resolveField(SLOT_ADDON_SEEDS[key]);
      if (!el) { unresolved++; return; }                     // not on the page yet → retry later
      if (String(el.value || '').trim() !== '') return;      // user already typed one → leave it
      plan.push({ fieldKey: key, descriptor: SLOT_ADDON_SEEDS[key], value, type: 'text' });
    };
    consider('addon.laddus', laddus);
    consider('addon.hundi', hundi);

    if (plan.length) {
      setLang(store.settings.language || 'en');
      await TTDEngine.runPlan(plan, { delay: store.settings.fillDelayMs });
      if (window === window.top) {
        // Verify it actually took — the ttdevasthanams portal reverts our fill.
        // Only claim success when every amount really held; otherwise tell the
        // truth so the user types the paid add-ons themselves (never silently
        // "filled" when nothing was written).
        const held = plan.every((it) => {
          const el = TTDEngine.resolveField(it.descriptor);
          return el && String(el.value || '').trim() === String(it.value).trim();
        });
        if (held) {
          const parts = [];
          if (laddus !== '') parts.push(t('slot.laddusN', { n: laddus }));
          if (hundi !== '') parts.push(t('slot.hundiN', { n: hundi }));
          toast(t('slot.addOnsFilled', { what: parts.join(' + ') }));
        } else {
          toast(t('slot.addOnsBlocked'));
        }
      }
    }
    // Lock the signature only once nothing is still waiting to render, so a
    // late-appearing field is not missed; a field the user pre-filled counts as
    // resolved (consider() didn't increment unresolved for it).
    if (unresolved === 0) slotAddOnsSig = sig;
  }

  // -------------------------------------------- Srivari Seva slot page helpers
  //
  // On /srivari-seva/slot-booking the extension offers three OPTIONAL helpers.
  // Date, location and the declaration are the user's decisions, so every one is
  // conservative and none ever clicks Continue/Book:
  //   1. read-only: outline the Available (green) dates so an open day is easy to
  //      spot. It never selects a date.
  //   2. pre-select the user's saved preferred location in the "Seva Name"
  //      dropdown — only when they have named one, and only once per page load
  //      (so a manual change afterwards is never overridden).
  //   3. tick the "I hereby declare…" checkbox — OPT-IN and OFF by default,
  //      because it is the user's own declaration. Ticks that one box only.

  const AVAIL_RGB = [1, 109, 1]; // legend "Available" green (verified live)
  function parseRgb(str) {
    const m = String(str || '').match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    return m ? [+m[1], +m[2], +m[3]] : null;
  }
  function isAvailableGreen(rgb) {
    if (!rgb) return false;
    const d = Math.hypot(rgb[0] - AVAIL_RGB[0], rgb[1] - AVAIL_RGB[1], rgb[2] - AVAIL_RGB[2]);
    return d < 70; // green is far from every other legend colour, so this is safe
  }
  /** The coloured ancestor of a day number, or null. Availability lives only in
   *  a background colour here (no class / title), so we read the colour. */
  function dayColorNode(leaf) {
    let n = leaf;
    for (let i = 0; i < 4 && n; i++) {
      const rgb = parseRgb(getComputedStyle(n).backgroundColor);
      if (rgb && !(rgb[0] > 245 && rgb[1] > 245 && rgb[2] > 245)) return n; // skip white/transparent
      n = n.parentElement;
    }
    return null;
  }
  function dayNumberLeaves() {
    return [...document.querySelectorAll('td, td *, [class*="calendar" i] *')]
      .filter((e) => e.children.length === 0 && /^\d{1,2}$/.test((e.textContent || '').trim()));
  }
  function highlightAvailableDates() {
    for (const leaf of dayNumberLeaves()) {
      const node = dayColorNode(leaf);
      if (node && isAvailableGreen(parseRgb(getComputedStyle(node).backgroundColor))) {
        node.classList.add('ttd-af-avail');
      }
    }
  }
  function clearAvailableHighlights() {
    document.querySelectorAll('.ttd-af-avail').forEach((e) => e.classList.remove('ttd-af-avail'));
  }
  function findDeclarationCheckbox() {
    const boxes = [...document.querySelectorAll('input[type="checkbox"]')];
    const byText = boxes.find((c) => {
      const w = c.closest('label, div, tr, section') || c.parentElement;
      return w && /declare|terms|instructions/i.test(w.textContent || '');
    });
    return byText || (boxes.length === 1 ? boxes[0] : null);
  }

  let srivariLocSig = null;
  let srivariDeclSig = null;
  async function maybeHandleSrivariSlot() {
    if (!/\/srivari-seva\/slot-booking\b/.test(location.pathname)) return;
    if (TTDEngine.isQueuePage(document.body?.innerText || '')) return;

    let store;
    try {
      const raw = await readProfileRaw();
      if (raw == null) return;           // encrypted + locked
      store = migrateStore(raw);
    } catch { return; }
    const s = store.settings.srivariSlot || {};
    setLang(store.settings.language || 'en');

    // 1) read-only Available-date highlight.
    if (s.highlightAvailable !== false) highlightAvailableDates();
    else clearAvailableHighlights();

    // 2) pre-select the preferred location, once per page load + value. Never
    //    overrides a location the user changes afterwards.
    const loc = String(s.location || '').trim();
    if (loc && srivariLocSig !== `${location.pathname}|${loc}`) {
      const el = document.querySelector('input[name="sevaName"]');
      if (el) {
        srivariLocSig = `${location.pathname}|${loc}`;
        if (norm(el.value) !== norm(loc)) {
          await TTDEngine.runPlan([{
            fieldKey: 'sevaName',
            descriptor: { strategies: [{ kind: 'name', value: 'sevaName' }] },
            value: loc, type: 'dropdown',
          }], { delay: store.settings.fillDelayMs });
          if (window === window.top) toast(t('srivari.locSet', { loc }));
        }
      }
    }

    // 3) opt-in declaration tick — never clicks Continue. (The date itself is
    //    always the user's choice — TTD assigns/blocks Srivari Seva dates, so the
    //    extension only highlights the available ones, never selects one.)
    if (s.autoDeclaration && srivariDeclSig !== location.pathname) {
      const box = findDeclarationCheckbox();
      if (box) {
        srivariDeclSig = location.pathname;
        if (!box.checked) {
          box.click();
          if (window === window.top) toast(t('srivari.declTicked'));
        }
      }
    }
  }
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();

  /**
   * Re-check the moment the user edits their details (or switches language).
   * The banner exists so they can FIX something during the queue, so it has to
   * reflect that fix — a one-shot read would keep saying NOT READY after they
   * had already corrected it, which is worse than saying nothing.
   */
  try {
    api.storage.onChanged.addListener((changes, area) => {
      // 'local' + profile → a plaintext edit. 'session' + profile → the vault
      // was just unlocked or locked in the popup; the content script must
      // re-evaluate so the button/auto-fill appear (or disappear) with no
      // page reload.
      const changed = (area === 'local' && changes.profile)
        || (area === 'session' && changes.profile);
      if (changed) {
        checkQueue();
        // A settings/profile edit — turning auto-fill on, or completing the
        // profile so it becomes Ready — should apply to the page already open,
        // with no reload. Re-arm a prior 'skip' and re-evaluate.
        if (autoState === 'skip') autoState = 'idle';
        maybeAutoFill();
        updateFloatingButton();
        updateCountdown(); // reflect the page-countdown toggle without a reload
        refreshDraftGuard();
        // Turning on Slot add-ons (or editing the amounts) in the popup should
        // apply to a slot page already open. Clear the guard so it re-fires.
        slotAddOnsSig = null;
        maybeFillSlotAddOns();
        // Editing the Srivari Seva slot settings (location / highlight /
        // declaration) should apply to an open slot page without a reload.
        srivariLocSig = null;
        srivariDeclSig = null;
        maybeHandleSrivariSlot();
      }
    });
  } catch { /* no storage events available; the observer still re-checks */ }

  function showQueueBanner(profile, problems, duplicates = []) {
    // Remove by selector as well as by reference: a re-injected content
    // script has a fresh `queueBanner`, but the old node is still on the page.
    document.querySelectorAll('.ttd-af-queue').forEach((el) => el.remove());
    queueBanner?.remove();
    const box = document.createElement('div');
    const ok = problems.length === 0 && duplicates.length === 0;
    box.className = `ttd-af-queue ${ok ? 'ttd-af-queue-ok' : 'ttd-af-queue-bad'}`;

    const head = document.createElement('strong');
    const body = document.createElement('div');

    if (ok) {
      head.textContent = t('queue.readyHead', { who: nPilgrims(profile.people.length), name: profile.name });
      body.textContent = t('queue.readyBody');
    } else if (problems.length) {
      const first = problems[0];
      if (first.missingKeys.length) {
        head.textContent = t('queue.notHead', {
          n: first.n,
          missing: first.missingKeys.map((k) => t(`field.${k}`)).join(', '),
        });
      } else {
        const pr = first.invalid[0];
        head.textContent = t('ready.invalid', { n: first.n, problem: t(`problem.${pr.code}`, pr.params) });
      }
      body.textContent = problems.length > 1
        ? t('queue.notBodyMany', { count: problems.length })
        : t('queue.notBodyOne');
    } else {
      // Details complete and well-formed, but two pilgrims share an ID number.
      const list = duplicates[0].pilgrims.map((i) => t('lbl.pilgrim', { n: i + 1 })).join(', ');
      head.textContent = t('ready.duplicate', { list });
      body.textContent = t('queue.notBodyOne');
    }

    const close = document.createElement('button');
    close.className = 'ttd-af-queue-close';
    close.textContent = '×';
    close.addEventListener('click', () => box.remove());

    box.append(brandTag(), head, body, close);
    document.body.appendChild(box);
    queueBanner = box;   // so the next render can replace it
  }

  // ------------------------------------------------------ startup

  /** Set the language up front so any early toast/verdict reads correctly. */
  async function primeLanguage() {
    try {
      const raw = await readProfileRaw();
      if (raw != null) setLang(migrateStore(raw).settings.language || 'en');
    } catch { /* default English (also while the vault is locked) */ }
  }

  // ------------------------------------------------ draft protection
  //
  // Warn before an ACCIDENTAL close of a filled pilgrim form. The trap with
  // beforeunload is that it also fires on the legitimate "Continue" click; so
  // we suppress it whenever the user has just clicked a button/link/submit in
  // the page (an intentional navigation). Closing the tab or typing a new URL
  // involves no such click, so those still prompt. Opt-out via settings.
  let draftGuardOn = true;
  let captchaFocusOn = true;
  let lastNavClickAt = 0;
  async function refreshDraftGuard() {
    const s = await settingsNow();
    draftGuardOn = s.draftProtection !== false;
    captchaFocusOn = s.captchaFocus !== false;
  }
  function formHasData() {
    if (!autoFillablePage()) return false;
    for (const el of document.querySelectorAll('input[name], textarea[name]')) {
      const type = (el.type || '').toLowerCase();
      if (['hidden', 'checkbox', 'radio', 'button', 'submit', 'file'].includes(type)) continue;
      if (String(el.value || '').trim()) return true;
    }
    return false;
  }
  document.addEventListener('click', (e) => {
    if (e.target?.closest?.('button, input[type="submit"], input[type="button"], a, [role="button"]')) {
      lastNavClickAt = Date.now();
    }
  }, true);
  /** Called by tryContinue right before it clicks, so auto-advance never prompts. */
  function noteIntentionalNav() { lastNavClickAt = Date.now(); }
  window.addEventListener('beforeunload', (e) => {
    if (!draftGuardOn) return;
    if (Date.now() - lastNavClickAt < 5000) return; // an intentional in-page nav
    if (!formHasData()) return;
    e.preventDefault();
    e.returnValue = ''; // browsers show their own generic "Leave site?" text
  });

  // ------------------------------------------------ CAPTCHA auto-focus
  //
  // When a captcha field appears, scroll to it and put the cursor in it so the
  // user can type and submit without hunting — saving precious seconds at
  // release time. It READS NOTHING and SOLVES NOTHING: it only moves focus to
  // an input the user must fill themselves. Fires once, never steals focus from
  // a field the user is already typing in, and is opt-out via settings.
  let captchaFocused = false;
  function findCaptchaInput() {
    // Direct: an input whose own attributes mention captcha.
    let el = document.querySelector(
      'input[name*="captcha" i], input[id*="captcha" i], input[placeholder*="captcha" i], input[aria-label*="captcha" i]');
    if (el && isFillableCaptcha(el)) return el;
    // Indirect: a text input sitting next to a captcha image.
    const img = document.querySelector('img[src*="captcha" i], img[alt*="captcha" i], canvas[id*="captcha" i]');
    if (img) {
      const scope = img.closest('div, form, section, td, tr') || document;
      el = scope.querySelector('input[type="text"], input:not([type])');
      if (el && isFillableCaptcha(el)) return el;
    }
    return null;
  }
  function isFillableCaptcha(el) {
    return el && !el.disabled && !el.readOnly && el.offsetParent !== null && !String(el.value || '').trim();
  }
  function maybeFocusCaptcha() {
    if (captchaFocused || !captchaFocusOn) return;
    const el = findCaptchaInput();
    if (!el) return;
    // Do not yank focus away from a field the user is already typing in.
    const active = document.activeElement;
    if (active && active !== el && /^(input|textarea|select)$/i.test(active.tagName)) return;
    captchaFocused = true;
    try {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.focus({ preventScroll: true });
    } catch { /* focus is a convenience, never worth throwing over */ }
  }

  function start() {
    refreshDraftGuard();
    primeLanguage().finally(() => { if (!IS_SRIVANI) { watchOutcomes(); armAutoFill(); } });
    // SRIVANI: stop here. No passive page footprint at all — no captcha focus,
    // no SPA route hooks, no history.pushState override. The onMessage listener
    // (fillNow) is registered at module top and keeps working, so popup/shortcut
    // fill is unaffected; it just acts only when the user asks.
    if (IS_SRIVANI) return;
    // Retry captcha focus briefly: it may be in the DOM before layout is ready
    // (so it reads as hidden for a beat), or render a moment after load. Stops
    // as soon as it fires, or after ~4s. The observer still covers later ones.
    let ct = 0;
    const ci = setInterval(() => { maybeFocusCaptcha(); if (captchaFocused || ++ct > 16) clearInterval(ci); }, 250);
    // Keep the extension in step with TTD's in-app (SPA) navigation. The
    // MutationObserver (always-on now) already refreshes the button and the
    // scans on any DOM change, but auto-fill must be RE-ARMED when a new route's
    // form appears — otherwise a user who reaches pilgrim-details without a full
    // reload gets no auto-fill. pushState/replaceState are the SPA's own route
    // changes; popstate/hashchange cover back/forward and hash routes.
    let lastRoutePath = location.pathname;
    const onRoute = () => {
      const changed = location.pathname !== lastRoutePath;
      lastRoutePath = location.pathname;
      // Leaving the booking form (e.g. bounced to the dashboard) → tear the Paste
      // Helper down, so its chips don't linger over the next page.
      if (changed && window.TTDPaste && window.TTDPaste.isActive() && !autoFillablePage()) {
        try { window.TTDPaste.deactivate(); } catch { /* */ }
      }
      // A genuinely new route re-arms auto-fill, so a form reached by in-app
      // navigation fills exactly like one reached by a full page load. Gated on a
      // real pathname change so a same-page replaceState (query/hash churn, which
      // TTD does often) can't re-fill over something the user just edited.
      if (changed && (autoState === 'skip' || autoState === 'done')) autoState = 'idle';
      watchOutcomes();
      armAutoFill();
    };
    for (const m of ['pushState', 'replaceState']) {
      const orig = history[m];
      if (typeof orig !== 'function' || orig.__ttdHooked) continue;
      const hooked = function (...args) {
        const r = orig.apply(this, args);
        try { window.dispatchEvent(new Event('ttd:route')); } catch { /* ignore */ }
        return r;
      };
      hooked.__ttdHooked = true;
      try { history[m] = hooked; } catch { /* some pages freeze history — fine */ }
    }
    window.addEventListener('ttd:route', onRoute);
    window.addEventListener('popstate', onRoute);
    window.addEventListener('hashchange', onRoute);
  }

  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start);
})();
