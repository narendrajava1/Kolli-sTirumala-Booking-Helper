/**
 * Field resolution and value injection.
 *
 * TTD's booking portal is AngularJS. Two consequences drive everything here:
 *
 *  1. Assigning `el.value = x` updates the DOM but not the scope, so the model
 *     stays empty and the form fails validation on submit. ng-model binds to
 *     the 'input' event, so we set the value through the native property
 *     setter (bypassing any React/Angular value shim) and then dispatch a real
 *     'input' event, which crosses the isolated-world boundary just fine.
 *
 *  2. We cannot touch `window.angular` — content scripts run in an isolated
 *     world and never see page globals. Everything below is pure DOM.
 */

const TTDEngine = (() => {
  const isVisible = (el) => {
    if (!el || !el.isConnected) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none';
  };

  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();

  /** Is this id actually unique? The portal ships id="0" on five inputs. */
  function idIsUnique(id) {
    if (!id) return false;
    try { return document.querySelectorAll(`[id="${CSS.escape(id)}"]`).length === 1; }
    catch { return false; }
  }

  /** Find the visible label text associated with a control. */
  function labelTextFor(el) {
    // label[for] is only meaningful when the id is unique — otherwise every
    // duplicate-id control resolves to the first label on the page.
    if (idIsUnique(el.id)) {
      const byFor = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (byFor) return norm(byFor.textContent);
    }
    const wrapping = el.closest('label');
    if (wrapping) return norm(wrapping.textContent);
    // TTD wraps most controls in a div alongside their label.
    const group = el.closest('.form-group, .field, .row, div');
    const nearby = group && group.querySelector('label');
    if (nearby) return norm(nearby.textContent);
    return '';
  }

  /** Build an ordered list of ways to find this element again later. */
  function describe(el) {
    const strategies = [];
    const push = (kind, value) => value && strategies.push({ kind, value });

    // Order matters: earlier strategies are tried first when re-resolving.
    // ttdevasthanams.ap.gov.in is Next.js, so `name` and the visible label are
    // the durable anchors — the build hashes class names, making CSS paths the
    // least trustworthy option.
    //
    // Every attribute is uniqueness-checked before being recorded. The real
    // pilgrim-details page ships id="0" on all five inputs, so an unchecked
    // id strategy silently resolves every field to the first one. Where an
    // attribute repeats (per-pilgrim rows reuse `name`), it is stored as
    // "value::index" and matched positionally instead of being discarded.
    pushUnique('dataTestId', el.getAttribute('data-testid'), (v) => `[data-testid="${CSS.escape(v)}"]`, el);

    // On the pilgrim rows neither `name` nor `id` is unique, but the pair is
    // (name repeats down the column, id carries the row index). Prefer it over
    // positional matching — it survives DOM reordering.
    const nm = el.getAttribute('name');
    if (nm && el.id) {
      const pair = `[name="${CSS.escape(nm)}"][id="${CSS.escape(el.id)}"]`;
      try {
        if (document.querySelectorAll(pair).length === 1) push('nameId', `${nm}@${el.id}`);
      } catch { /* unusable attribute values */ }
    }

    pushUnique('name', nm, (v) => `[name="${CSS.escape(v)}"]`, el);
    pushUnique('id', el.id, (v) => `[id="${CSS.escape(v)}"]`, el);
    push('ngModel', el.getAttribute('ng-model'));         // legacy tirupatibalaji portal
    push('formControlName', el.getAttribute('formcontrolname'));
    pushUnique('ariaLabel', el.getAttribute('aria-label'), (v) => `[aria-label="${CSS.escape(v)}"]`, el);
    push('label', labelTextFor(el));
    pushUnique('placeholder', el.getAttribute('placeholder'), (v) => `[placeholder="${CSS.escape(v)}"]`, el);
    push('css', cssPath(el));

    function pushUnique(kind, value, toSelector, target) {
      if (!value) return;
      let matches;
      try { matches = [...document.querySelectorAll(toSelector(value))]; } catch { return; }
      if (matches.length === 1) return push(kind, value);
      const index = matches.indexOf(target);
      if (index === -1) return;
      push(`${kind}Nth`, `${value}::${index}`);
    }

    return {
      strategies,
      tag: el.tagName.toLowerCase(),
      inputType: el.getAttribute('type') || '',
      frameUrl: location.href,
    };
  }

  /** Structural fallback selector. Last resort — brittle across redesigns. */
  function cssPath(el) {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 6) {
      let part = node.tagName.toLowerCase();
      if (idIsUnique(node.id)) {
        parts.unshift(`#${CSS.escape(node.id)}`);
        break;
      }
      const parent = node.parentElement;
      if (parent) {
        const siblings = [...parent.children].filter((c) => c.tagName === node.tagName);
        if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.join(' > ');
  }

  /** Split a "value::index" strategy payload back into its parts. */
  function splitNth(v) {
    const at = v.lastIndexOf('::');
    return { value: v.slice(0, at), index: Number(v.slice(at + 2)) };
  }
  const nthFinder = (attr) => (raw) => {
    const { value, index } = splitNth(raw);
    return document.querySelectorAll(`[${attr}="${CSS.escape(value)}"]`)[index] || null;
  };

  const FINDERS = {
    dataTestId: (v) => document.querySelector(`[data-testid="${CSS.escape(v)}"]`),
    dataTestIdNth: nthFinder('data-testid'),
    ngModel: (v) => document.querySelector(`[ng-model="${CSS.escape(v)}"]`),
    // Deliberately not getElementById: it ignores duplicates, and this portal
    // ships five inputs all carrying id="0".
    id: (v) => {
      const hits = document.querySelectorAll(`[id="${CSS.escape(v)}"]`);
      return hits.length === 1 ? hits[0] : null;
    },
    idNth: nthFinder('id'),
    /**
     * Compound name+id, encoded "name@id". On /spat/pilgrim-details every row
     * repeats the same `name` (fname, age, …) while `id` carries the row index
     * 0-5, so neither alone is unique but the pair always is. Preferred over
     * positional nth matching because it survives DOM reordering.
     */
    nameId: (raw) => {
      const at = raw.lastIndexOf('@');
      const name = raw.slice(0, at), id = raw.slice(at + 1);
      return document.querySelector(`[name="${CSS.escape(name)}"][id="${CSS.escape(id)}"]`);
    },
    name: (v) => {
      const hits = document.querySelectorAll(`[name="${CSS.escape(v)}"]`);
      return hits.length === 1 ? hits[0] : null;
    },
    nameNth: nthFinder('name'),
    formControlName: (v) => document.querySelector(`[formcontrolname="${CSS.escape(v)}"]`),
    placeholder: (v) => document.querySelector(`[placeholder="${CSS.escape(v)}"]`),
    placeholderNth: nthFinder('placeholder'),
    ariaLabel: (v) => document.querySelector(`[aria-label="${CSS.escape(v)}"]`),
    ariaLabelNth: nthFinder('aria-label'),
    label: (v) => {
      const controls = document.querySelectorAll('input, select, textarea');
      for (const c of controls) if (labelTextFor(c) === v) return c;
      return null;
    },
    /**
     * Substring label match. The only usable handle for /slot-booking's add-on
     * inputs, whose labels carry trailing noise ("No. of Additional Laddus
     * (₹50.00 per Laddu)") and which have no name, id or placeholder at all.
     * Prefers the shortest matching label so "city" doesn't win a field
     * labelled "city corporation".
     */
    labelContains: (v) => {
      const want = norm(v);
      let best = null, bestLen = Infinity;
      for (const c of document.querySelectorAll('input, select, textarea')) {
        const text = labelTextFor(c);
        if (text && text.includes(want) && text.length < bestLen) {
          best = c;
          bestLen = text.length;
        }
      }
      return best;
    },
    /**
     * Nearest-enclosing-text match, for a control that has NO <label> element
     * at all — only a floating sibling/parent text node. This is the /slot-
     * booking "Additional Laddus" / "Hundi Offerings" pattern: bare React
     * `type="tel"` inputs whose visible caption is a sibling <div>, not a
     * <label>, so `labelContains` (which needs a real <label>) can't see them.
     *
     * Walks up to four ancestors and keeps the EDITABLE input whose smallest
     * enclosing block mentions `v` — so "laddu" and "hundi" each pick their own
     * field and never each other. readOnly/disabled controls (the ticket-count
     * display) are skipped. A miss returns null and the item is simply not
     * filled — it never lands on an unrelated field.
     */
    nearText: (v) => {
      const want = norm(v);
      let best = null, bestLen = Infinity;
      for (const c of document.querySelectorAll('input:not([type="hidden"]), textarea')) {
        if (c.readOnly || c.disabled) continue;
        let node = c, hitLen = Infinity;
        for (let i = 0; i < 4 && node; i++) {
          node = node.parentElement;
          if (!node) break;
          const text = norm(node.innerText || node.textContent || '');
          if (text.includes(want)) { hitLen = text.length; break; }
        }
        if (hitLen < bestLen) { best = c; bestLen = hitLen; }
      }
      return best;
    },
    css: (v) => {
      try { return document.querySelector(v); } catch { return null; }
    },
    // Positional CSS: "selector::index". Used for the per-pilgrim photo file
    // input, which often has no stable name. Out-of-range index → null → the
    // item is simply skipped, so it never attaches to the wrong row.
    cssNth: (raw) => {
      const { value, index } = splitNth(raw);
      try { return document.querySelectorAll(value)[index] || null; } catch { return null; }
    },
  };

  /**
   * Strategies that identify a field by its structure — the durable anchors a
   * seed is built on. If one of these matches, the fill landed where it was
   * meant to.
   */
  const STRUCTURAL_KINDS = new Set([
    'dataTestId', 'dataTestIdNth', 'nameId', 'name', 'nameNth',
    'id', 'idNth', 'ngModel', 'formControlName',
  ]);

  /**
   * Try every recorded strategy in order; first visible hit wins. Returns the
   * element AND which strategy found it, so the caller can tell a clean
   * structural match from a loose fallback (label/placeholder/css) — the latter
   * means TTD probably renamed the field and the fill deserves a second look.
   */
  function resolveFieldMeta(descriptor) {
    if (!descriptor || !descriptor.strategies) return { el: null, via: null };
    let fallback = null, fallbackVia = null;
    for (const { kind, value } of descriptor.strategies) {
      const finder = FINDERS[kind];
      if (!finder) continue;
      let el;
      try { el = finder(value); } catch { continue; }
      if (!el) continue;
      if (isVisible(el)) return { el, via: kind };
      if (!fallback) { fallback = el; fallbackVia = kind; } // present but hidden
    }
    return { el: fallback, via: fallbackVia };
  }

  /** Back-compat: the element alone, for callers that don't need the strategy. */
  function resolveField(descriptor) {
    return resolveFieldMeta(descriptor).el;
  }

  /**
   * Set a value so the framework notices. The native setter sidesteps the
   * property override React installs; AngularJS has no such override but the
   * event dispatch is what it actually listens for.
   */
  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
  }

  function fire(el, ...types) {
    for (const type of types) {
      el.dispatchEvent(new Event(type, { bubbles: true, composed: true }));
    }
  }

  function fillText(el, value) {
    el.focus();
    setNativeValue(el, String(value));
    fire(el, 'input', 'change');
    fire(el, 'blur');
    return true;
  }

  /**
   * Match a <select> option by value, then exact text, then a loose contains.
   *
   * Handles AngularJS ng-options, where the visible text is "Aadhaar Card" but
   * the option's value attribute is an encoded model key like "string:AadharCard"
   * (verified on SRIVANI Break Darshan). Exact text match still finds it; the
   * extra matcher covers the reverse case where only the encoded value is a
   * usable handle.
   *
   * The selection is then set three consistent ways and the events both React
   * and AngularJS listen for are dispatched — a plain value assignment alone did
   * not update the ng-options model. The return value CONFIRMS the option that
   * actually ended up selected, so a dropdown that silently refused is reported
   * rather than assumed filled.
   */
  function fillSelect(el, value) {
    const want = norm(value);
    const wantCompact = want.replace(/\s+/g, '');
    const options = [...el.options];
    const match =
      options.find((o) => o.value === value) ||
      options.find((o) => norm(o.textContent) === want) ||
      options.find((o) => o.value && norm(o.value).replace(/^[^:]+:/, '') === wantCompact) ||
      options.find((o) => norm(o.textContent).includes(want) && want.length > 2);
    if (!match) return false;

    el.focus();
    options.forEach((o) => { o.selected = false; });
    match.selected = true;
    el.selectedIndex = match.index;
    setNativeValue(el, match.value);
    fire(el, 'input', 'change');
    fire(el, 'blur');

    // Confirm what actually stuck — never claim success on an unchanged select.
    return el.selectedIndex === match.index;
  }

  /**
   * fillSelect, but resilient to options that arrive late AND to the value being
   * wiped right after we set it.
   *
   * On the legacy SRIVANI portal the ID-proof list is an AngularJS ng-options
   * bound to a per-row array (dccsc['proofTypes'+n]) that the page fills from its
   * own data AFTER the row renders — and that array can re-initialise a beat
   * later, resetting the <select> back to its blank "Select" option. That is
   * exactly why a FIRST fill left the ID Proof Type unselected while a SECOND
   * fill (moments later, once Angular had settled) worked.
   *
   * So we do two things the old ~1s "try and give up" could not:
   *   1. wait much longer for the options to populate (~4s), and
   *   2. after a successful set, confirm it actually HELD — if Angular reset the
   *      row to its blank option, set it again — until it sticks or we time out.
   */
  /** Is the wanted value actually the selected option? Checked by the option's
   *  text/value, NOT by index (gender has a real option at index 0). */
  function selectHolds(el, value) {
    const want = norm(value);
    const opt = el.options[el.selectedIndex];
    if (!opt) return false;
    const t = norm(opt.textContent);
    return t === want || norm(opt.value) === want || (want.length > 2 && t.includes(want));
  }

  async function fillSelectWhenReady(el, value, delay) {
    // Fill NOW and barely wait — SRIVANI quota goes in seconds, so the fill must
    // not block. If the value is already in place, done. Otherwise one short
    // retry for options that are milliseconds away; anything slower (SRIVANI's
    // late AngularJS ID-proof list) is completed in the BACKGROUND by the content
    // script (finishLateSelects) as the options appear — no waiting, no re-click.
    if (fillSelect(el, value) && selectHolds(el, value)) return true;
    await sleep(Math.max(delay, 50));
    fillSelect(el, value);
    return selectHolds(el, value);
  }

  function fillCheckable(el, value) {
    const want = value === true || norm(value) === 'yes' || norm(value) === 'true';
    if (el.checked !== want) {
      el.click(); // click() keeps framework handlers and label styling in sync
    }
    return true;
  }

  /**
   * File inputs reject direct assignment, but a synthesised DataTransfer
   * produces a real FileList the page accepts.
   */
  async function fillFile(el, stored) {
    if (!stored || !stored.dataUrl) return false;
    const blob = await (await fetch(stored.dataUrl)).blob();
    const file = new File([blob], stored.name || 'upload', { type: stored.type || blob.type });
    const dt = new DataTransfer();
    dt.items.add(file);
    el.files = dt.files;
    fire(el, 'input', 'change');
    return true;
  }

  /**
   * Find the option list belonging to one custom-dropdown trigger.
   *
   * On /spat/pilgrim-details the Gender and Photo ID Proof controls are
   * readOnly text inputs; their <ul> of options is always in the DOM and is
   * merely shown/hidden. With six rows on the page there are six such lists,
   * so we climb until we reach the ancestor owning exactly ONE of them — that
   * is this row's list. Stopping at >1 avoids grabbing a sibling row's.
   */
  function optionListFor(el) {
    let node = el.parentElement;
    for (let i = 0; i < 6 && node; i++, node = node.parentElement) {
      const lists = [...node.querySelectorAll('ul')].filter((u) => u.querySelectorAll('li').length);
      if (!lists.length) continue;
      if (lists.length === 1) return lists[0];
      // Climbing one level too far can capture both dropdowns of the same row
      // (Gender and Photo ID Proof). Only the one we just opened is visible.
      const visible = lists.filter(isVisible);
      return visible.length === 1 ? visible[0] : null;
    }
    return null;
  }

  /**
   * Choose an option by label.
   *
   * Substring matching is actively dangerous here: "Female" CONTAINS "Male",
   * so a loose match for Male silently selects Female. An exact match is
   * therefore required first, and a partial match is only accepted when it is
   * unambiguous — exactly one option matches. Anything else fails loudly
   * rather than picking the wrong gender.
   */
  function pickOption(items, want) {
    const exact = items.find((li) => norm(li.textContent) === want);
    if (exact) return exact;

    const partial = items.filter((li) => {
      const text = norm(li.textContent);
      return text.includes(want) || want.includes(text);
    });
    return partial.length === 1 ? partial[0] : null;
  }

  /**
   * Wait for a dropdown's options to actually render before reading them.
   * A fixed sleep raced the first dropdown on the page, which opens while
   * React is still settling — the list came back empty and the field was
   * skipped.
   */
  async function waitForOptionList(el, timeoutMs = 2200) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const list = optionListFor(el);
      if (list && list.querySelectorAll('li').length && isVisible(list)) return list;
      await sleep(40);
    }
    return optionListFor(el); // last look, even if not yet visible
  }

  /**
   * Set a readOnly custom dropdown by clicking its option.
   *
   * Assigning .value to these does nothing — the page owns the state. The
   * trigger must be clicked to reveal the list, then the matching <li>
   * clicked. Exact label match first, then substring: the portal's real
   * options are "Aadhaar Card" and "Passport", so a stored "Aadhaar" must
   * still resolve.
   */
  /**
   * Close any open dropdown panel.
   *
   * The portal's widget does NOT close when an option is clicked. The panel
   * stays open and physically covers the control BELOW it — the next
   * pilgrim's Gender box — so that row's dropdown cannot be opened or even
   * seen. Left unclosed, the page also just looks broken to the user.
   *
   * Escape and a real outside mousedown/click cover both common patterns for
   * dismissing these widgets.
   */
  // Tracks whether a custom-dropdown option panel is currently open. Every
  // dropdown closes itself when it finishes, so at the start of the next one
  // this is almost always false — letting us skip a redundant dismiss (and its
  // sleep) on the common path while still clearing a panel on the rare occasion
  // one was genuinely left open.
  let panelOpen = false;

  async function dismissPanel(el) {
    try {
      el?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      document.body.click();
    } catch { /* nothing worth failing a fill over */ }
    panelOpen = false;
    await sleep(45);
  }

  async function fillCustomDropdown(el, value, delay) {
    const want = norm(value);

    // Three attempts: the very first dropdown on a freshly-rendered page
    // (and Arjitha's readOnly Gender/ID-Proof widgets) sometimes ignore the
    // opening click entirely until React has fully settled.
    for (let attempt = 0; attempt < 3; attempt++) {
      if (norm(el.value) === want) {
        await dismissPanel(el);
        return true;
      }

      // Clear a panel left open by a previous field before opening this one —
      // but only if one is actually open. The common case (the previous field
      // closed itself, or this is the first field) skips straight to the click,
      // so the very first field reacts at once instead of after a dead pause.
      if (panelOpen) await dismissPanel(null);
      el.click();
      panelOpen = true;
      const list = await waitForOptionList(el);
      if (!list) {
        await dismissPanel(el);
        continue;
      }

      const item = pickOption([...list.querySelectorAll('li')], want);
      if (!item) {
        // Must go through dismissPanel: a bare body.click() fires only a
        // click event, and these widgets close on mousedown.
        await dismissPanel(el);
        return false;          // wrong option is worse than none — fail loudly
      }

      const chosen = norm(item.textContent);
      item.click();
      await sleep(Math.max(delay, 70));
      await dismissPanel(el); // the widget will not close itself

      // Confirm what actually landed. Never report success on a value we did
      // not ask for — a silently wrong gender is exactly the failure mode
      // this guards against.
      if (norm(el.value) === want || norm(el.value) === chosen) return true;
    }
    await dismissPanel(el);
    return false;
  }

  /**
   * Custom multi-select widgets are not real <select multiple> elements —
   * they are div-based dropdowns. Open the control, click each matching
   * option, then close it.
   */
  async function fillMultiSelect(el, values, delay) {
    if (!Array.isArray(values) || !values.length) return false;

    if (el.tagName === 'SELECT' && el.multiple) {
      for (const opt of el.options) opt.selected = values.some((v) => norm(v) === norm(opt.textContent));
      fire(el, 'input', 'change');
      return true;
    }

    el.click();
    panelOpen = true;
    await sleep(delay * 3);
    const panel = document.querySelector('.dropdown-menu.show, .multiselect-container, [role="listbox"]') || document;
    let hits = 0;
    for (const value of values) {
      const items = [...panel.querySelectorAll('li, label, [role="option"], .item')];
      const item = items.find((i) => norm(i.textContent) === norm(value))
        || items.find((i) => norm(i.textContent).includes(norm(value)));
      if (item) {
        (item.querySelector('input[type="checkbox"]') || item).click();
        hits++;
        await sleep(delay);
      }
    }
    await dismissPanel(el); // click alone will not close these widgets
    return hits > 0;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** Poll `cond` until it is true or the timeout elapses. */
  async function waitUntil(cond, timeoutMs = 1800, stepMs = 60) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      try { if (cond()) return true; } catch { /* keep polling */ }
      await sleep(stepMs);
    }
    try { return !!cond(); } catch { return false; }
  }

  /** Dispatch one field to the right filler based on the element it landed on. */
  async function fillOne(el, value, type, delay) {
    if (!el) return { ok: false, reason: 'not-found' };
    if (value == null || value === '' || (Array.isArray(value) && !value.length)) {
      return { ok: false, reason: 'empty' };
    }
    // A field can start `disabled` and only enable once an earlier field in the
    // same row commits — on Arjitha-family flows (Arjitha Seva, Divyanugraha
    // Homam, Local-Temple sevas) the Photo ID Proof dropdown is disabled until
    // Gender is chosen, and the Photo ID Number until the Proof type is. The
    // fill runs Gender → ID Type → ID Number in order, so by the time we reach a
    // disabled one its enabler has just been set; wait briefly for it to enable
    // rather than skipping. Skipping here is what left ID Type + Aadhaar blank on
    // every Arjitha-family booking. If it never enables, we fall through to the
    // same 'disabled' result as before, so this can only help.
    if (el.disabled) {
      const enabled = await waitUntil(() => !el.disabled);
      if (!enabled) return { ok: false, reason: 'disabled' };
    }

    try {
      let ok;
      if (type === 'file' || el.type === 'file') ok = await fillFile(el, value);
      else if (type === 'multiselect') ok = await fillMultiSelect(el, value, delay);
      else if (el.tagName === 'SELECT') ok = await fillSelectWhenReady(el, value, delay);
      else if (el.type === 'checkbox' || el.type === 'radio') ok = fillCheckable(el, value);
      else if (el.readOnly || type === 'dropdown') {
        // readOnly means two very different things on this portal.
        //
        // Gender and Photo ID Proof are readOnly text inputs acting as custom
        // dropdown triggers — their <ul> of options sits in the DOM already,
        // so its presence is the reliable test, and no click is needed to
        // check. (Treating readOnly as "disabled" once silently skipped two
        // required fields per pilgrim.)
        //
        // Other readOnly fields — email prefilled from the logged-in account,
        // for instance — are simply locked. Those are not a mapping problem
        // and must not be reported as one; there is nothing to fix.
        if (norm(el.value) === norm(value)) return { ok: true, reason: 'already-set' };
        if (type !== 'dropdown' && !optionListFor(el)) {
          return { ok: false, reason: 'readonly' };
        }
        ok = await fillCustomDropdown(el, value, delay);
      }
      else ok = fillText(el, value);
      return { ok, reason: ok ? 'filled' : 'no-match' };
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  }

  /**
   * Run a fill plan. Each entry: { fieldKey, descriptor, value, type }.
   * Fields are filled in order with a small pause so Angular's digest cycle
   * can run between writes — firing them all synchronously makes dependent
   * dropdowns (state → district) miss their updates.
   */
  /**
   * Fill order matters on this portal, and getting it wrong corrupts data.
   *
   * Measured on /spat/pilgrim-details: typing an Aadhaar number BEFORE the
   * Photo ID Proof dropdown is set silently drops the last character
   * ("999999999999" → "12345678901"). Setting the dropdown first keeps it
   * intact. maxLength is 12 either way, so this is the field's own onChange
   * transform reacting to an empty id-type, not a length cap.
   *
   * So: dropdowns first (they gate validation of their dependants), then
   * ordinary fields, then files last (upload widgets re-render their section).
   */
  const ORDER = { dropdown: 0, select: 1, multiselect: 2, file: 4 };
  function orderedPlan(plan) {
    return plan
      .map((item, i) => ({ item, i }))
      .sort((a, b) => {
        const ra = ORDER[a.item.type] ?? 3;
        const rb = ORDER[b.item.type] ?? 3;
        return ra - rb || a.i - b.i; // stable within a rank
      })
      .map(({ item }) => item);
  }

  async function runPlan(plan, options = {}) {
    const delay = options.delay ?? 60;
    const results = [];
    const ordered = orderedPlan(plan);
    for (let i = 0; i < ordered.length; i++) {
      const item = ordered[i];
      const { el, via } = resolveFieldMeta(item.descriptor);
      const result = await fillOne(el, item.value, item.type, delay);
      // `loose` = filled, but via a label/placeholder/css fallback rather than
      // the field's name/id. That usually means TTD changed the form, so the
      // popup flags it for the user to verify instead of trusting it silently.
      const loose = result.ok && via != null && !STRUCTURAL_KINDS.has(via);
      results.push({ fieldKey: item.fieldKey, via, loose, ...result });
      if (result.ok) {
        flash(el);
        // The between-field pause lets React/Angular settle before the next
        // write; nothing follows the last field, so don't pay for it there.
        if (i < ordered.length - 1) await sleep(delay);
      }
    }
    // Never hand the page back with a dropdown panel hanging open over the
    // form — it hides controls and looks like the fill failed.
    await dismissPanel(null);
    return results;
  }

  /**
   * Check every pilgrim row the page rendered.
   *
   * The portal renders exactly as many rows as the ticket count chosen on the
   * slot page, and every field in a row is required. So "4 tickets but only 2
   * pilgrims saved" shows up as rows 3 and 4 having empty fields — which is
   * the real check, made against the page rather than against assumptions
   * about what the profile contained.
   *
   * spec: { anchor: 'fname', required: ['fname','age',…] }
   */
  function validateRows({ anchor, required }) {
    let anchors;
    try { anchors = [...document.querySelectorAll(`[name="${CSS.escape(anchor)}"]`)]; }
    catch { return { applicable: false }; }
    if (!anchors.length) return { applicable: false }; // not the pilgrim-details page

    const incomplete = [];
    for (let row = 0; row < anchors.length; row++) {
      const missing = required.filter((attr) => {
        const el = document.querySelector(`[name="${CSS.escape(attr)}"][id="${row}"]`);
        return !el || !String(el.value || '').trim();
      });
      if (missing.length) incomplete.push({ row: row + 1, missing });
    }
    return { applicable: true, rows: anchors.length, incomplete };
  }

  /**
   * Find the "Continue" control — and ONLY that.
   *
   * Continue advances to the review page, which is reversible and costs
   * nothing. Pay Now is not. The match is therefore exact: a button whose
   * entire label is "continue". Anything resembling pay, confirm or submit is
   * explicitly excluded so a relabelled or reordered page can never turn
   * autofill into a payment.
   */
  const NEVER_CLICK = /pay|confirm|submit|book now|proceed to pay|checkout/i;

  function findContinueButton() {
    const candidates = [...document.querySelectorAll(
      'button, input[type="button"], input[type="submit"], a[role="button"]'
    )];
    return candidates.find((b) => {
      const text = norm(b.innerText || b.value || '');
      if (text !== 'continue') return false;
      if (NEVER_CLICK.test(text)) return false;
      return isVisible(b) && !b.disabled;
    }) || null;
  }

  /**
   * Classify the alert TTD shows after Pay Now.
   *
   * The portal funnels several very different failures through one generic
   * popup, and they call for opposite reactions: a lost slot means move on
   * immediately, a server error means retrying is worth it. Under release
   * pressure that distinction is worth seconds, and seconds decide slots.
   *
   * Strings taken verbatim from the review-details bundle. Order matters —
   * the most specific patterns are tested first.
   */
  /**
   * IMPORTANT: "quota full" is not terminal.
   *
   * The server tracks total_slots, booked_slots AND in_progress_slots — the
   * last being slots merely HELD by someone who is mid-payment, not confirmed.
   * A "fully booked" message means only "nothing free at this instant".
   *
   * Every hold that ends in an abandoned payment, a declined card or a gateway
   * timeout returns to the pool, and given how often that payment step fails,
   * plenty do. Retrying the SAME slot frequently succeeds — confirmed against
   * real booking experience, which is why none of these verdicts now say
   * "give up". Telling someone a slot was gone when it was about to free up
   * would cost them the booking.
   */
  const PAYMENT_OUTCOMES = [
    {
      // Tested FIRST — this one is about YOUR OWN hold, not contention with
      // other pilgrims, and it is the one case where hammering is futile.
      //
      // Seen after going to the payment gateway and coming back: the server
      // still holds a block against these pilgrim IDs from the previous
      // attempt, so every new attempt is refused until that hold ages out.
      // The text is not in the site's bundle — it arrives from the server as
      // reason_eng. The alert's button is the popup's DEFAULT label ("Retry"),
      // which is misleading here: retrying at once cannot succeed.
      test: /same pilgrim id is in progress|booking with same pilgrim/i,
      verdict: 'self-hold',
      id: 'self-hold',
      headline: 'Your own previous attempt is still holding these pilgrims',
      advice: 'Not contention — your last try still has these ID numbers locked. Wait a few minutes for it to expire, then try again. Retrying now cannot work.',
      noRetry: true,
    },
    {
      test: /quota for this slot is fully booked|quota is currently unavailable/i,
      verdict: 'retry',
      id: 'quota',
      headline: 'No slot free this instant — keep retrying',
      advice: 'Others are holding slots mid-payment. Those expire when they fail. Retry this same slot.',
    },
    {
      test: /this slot has just been booked/i,
      verdict: 'retry',
      id: 'justbooked',
      headline: 'Someone got in first — retry anyway',
      advice: 'Their hold is not a confirmed booking. Retry this slot; it often frees up.',
    },
    {
      test: /blocked by another pilgrim/i,
      verdict: 'retry',
      id: 'blocked',
      headline: 'Held by another pilgrim mid-payment',
      advice: 'This one is explicitly a temporary hold. Retry — it releases if they do not pay.',
    },
    {
      test: /unable to process your request/i,
      verdict: 'transient',
      id: 'transient',
      headline: 'Server error — nothing was lost',
      advice: 'Not a slot problem at all. Retry immediately.',
    },
    {
      test: /invalid ticket id/i,
      verdict: 'session',
      id: 'session',
      headline: 'Booking context lost',
      advice: 'Your session or ticket expired. Start again from slot selection.',
      noRetry: true,
    },
    {
      /**
       * The hand-off to the payment gateway timed out. Observed live at
       * /api/checkout/payment/myjio/gateway/proceed returning a bare
       * "504 Gateway Time-out" from openresty/APISIX under release-day load.
       *
       * TTD's payment gateway is Jio Payments — their bundle carries
       * router:"JPG", com.jio.myjio and openMyJioUPI. The "myjio" in the path
       * is TTD's own routing, not anything to do with the user's network.
       *
       * Crucially this is a PRE-payment failure: the gateway page never
       * rendered, so no payment method was entered and NO money moved. The
       * real cost is that the attempt still registered a hold against these
       * pilgrim IDs, which locks re-booking for a few minutes — and on SED
       * re-entry also means another pass through the virtual queue.
       */
      test: /\b(50[234])\b[\s\S]{0,40}(gateway time-?out|bad gateway|service (temporarily )?unavailable)|gateway time-?out/i,
      verdict: 'gateway',
      id: 'gateway',
      headline: 'Payment gateway did not respond — you were NOT charged',
      advice: 'The gateway never loaded, so no payment was taken. This attempt has locked your pilgrim ID numbers for a few minutes — wait for that to clear before re-booking, or you will be refused.',
      noRetry: true,
    },
  ];

  /**
   * Pull the live quota numbers out of the stats popup when the portal shows
   * it. `in progress` is the number worth seeing: those are holds, not
   * bookings, and they are what may come back.
   *
   * Note the portal hardcodes its "available" figure to 0, so that one is
   * ignored — it says nothing useful.
   */
  function readQuotaStats(text) {
    const grab = (re) => {
      const m = text.match(re);
      return m ? Number(m[1]) : null;
    };
    const inProgress = grab(/in[\s-]?progress\D{0,24}(\d+)/i);
    const booked = grab(/\bbooked\D{0,24}(\d+)/i);
    const total = grab(/total\s*(?:quota|slots)?\D{0,24}(\d+)/i);
    if (inProgress == null && booked == null && total == null) return null;
    return { inProgress, booked, total };
  }

  /**
   * Is this the virtual queue / waiting room?
   *
   * On release day /slot-booking does not show the calendar — it shows a
   * countdown and "You've been placed in a virtual queue due to exceptionally
   * high demand". Observed on SED, 24 July 2026; Ammavari has no such gate.
   *
   * The queue is the LAST moment a user can fix their saved details. Once it
   * releases, every second is contested — in one measured session, 5,243
   * tickets went during a single 5-minute queue. So this is worth detecting
   * purely to tell the user whether they are ready.
   */
  function isQueuePage(text) {
    return /virtual queue|placed in a queue|exceptionally high demand/i.test(text || '');
  }

  /**
   * Best-effort login state from the page text, for the passive logout warning.
   * Returns 'in', 'out', or 'unknown'. Deliberately conservative: it only says
   * 'out' when a sign-in prompt is present AND none of the logged-in markers are
   * — anything ambiguous is 'unknown' (no warning), so it never nags a signed-in
   * user. Read-only; the warning just tells the user to log in before a release.
   */
  function loginState(text) {
    const t = (text || '').toLowerCase();
    if (!t) return 'unknown';
    // Logged-in markers seen on the live portal header/nav.
    if (/log\s?out|namaskaram|booking history|om namo venkatesaya/.test(t)) return 'in';
    // A visible sign-in prompt with none of the above → signed out.
    if (/\b(log\s?in|sign\s?in|login to continue|please login|session (has )?expired)\b/.test(t)) return 'out';
    return 'unknown';
  }

  /**
   * Best-effort detection of a successful booking (receipt / confirmation page),
   * for the optional local booking log. Heuristic — a false negative only means
   * a booking is not logged, never a wrong action.
   */
  function isBookingSuccess(text, url) {
    if (/\/(receipt|booking-?success|confirmation|success)\b/i.test(url || '')) return true;
    return /booking (is )?confirmed|successfully booked|your (darshan|seva|booking)[^.]{0,30}(booked|confirmed)/i.test(text || '');
  }

  /** Seconds left on the queue countdown, or null if not shown. */
  function queueSecondsLeft(text) {
    const m = (text || '').match(/\b(\d{1,2}):([0-5]\d)\b/);
    if (!m) return null;
    return Number(m[1]) * 60 + Number(m[2]);
  }

  /**
   * Read the portal's own "System Time" (its server clock) and "Quota Release
   * Time" off the page and return how many seconds remain — server-synced, so a
   * user whose PC clock is off still sees the true moment. Verified label format
   * on SRIVANI Break Darshan ("Quota Release Time: 09:03:00 | System Time:
   * 22:53:10"). Returns null if the labels are not present. Purely read-only.
   */
  function parseServerCountdown(text) {
    const t = text || '';
    const secs = (re) => {
      const m = t.match(re);
      return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
    };
    const server = secs(/system\s*time[^0-9]{0,12}(\d{1,2}):([0-5]\d):([0-5]\d)/i);
    const release = secs(/quota\s*release\s*time[^0-9]{0,12}(\d{1,2}):([0-5]\d):([0-5]\d)/i);
    if (server == null || release == null) return null;
    let left = release - server;
    if (left < -60) left += 24 * 3600; // release is tomorrow (past midnight)
    return { serverNowSecs: server, releaseSecs: release, secondsLeft: left };
  }

  function classifyOutcome(text) {
    if (!text) return null;
    const outcome = PAYMENT_OUTCOMES.find((o) => o.test.test(text));
    if (!outcome) return null;

    const stats = readQuotaStats(text);
    if (stats?.inProgress) {
      return {
        ...outcome,
        stats,
        advice: `${stats.inProgress} slot(s) are held by others mid-payment and may be released. ${outcome.advice}`,
      };
    }
    return stats ? { ...outcome, stats } : outcome;
  }

  // There is deliberately NO findPayNowButton. An earlier version had one, for
  // an automated retry loop that re-clicked Pay Now after a failed slot block.
  // Both are gone: retrying fast is precisely what triggers the portal's
  // "same pilgrim id is in progress" lockout, so a feature built to save two
  // seconds could cost five minutes. The extension now contains no code that
  // can locate or click a payment control.

  /** Brief green outline so the user can see what was touched. */
  function flash(el) {
    if (!el) return;
    el.classList.add('ttd-af-filled');
    setTimeout(() => el.classList.remove('ttd-af-filled'), 1200);
  }

  /**
   * Parse TTD's own "Latest Updates" text into a list of upcoming release
   * windows, so the popup can show a live schedule that always matches whatever
   * dates the portal currently advertises (nothing is hardcoded — when TTD
   * changes the month, this changes with it).
   *
   * Handles the phrasings seen live on the dashboard:
   *   "… w.e.f. 24.09.2026, 10:00 AM."      "… w.e.f 25.09.2026 at 10:00 AM"
   *   "… w.e.f. 25.09.2026, 10.00 AM."      "… will be released at 3 PM on 26.8.2026"
   *
   * Returns [{ label, whenMs, dateStr, timeStr, raw }] sorted soonest-first,
   * dropping anything more than 12h in the past or ~2 months out. Read-only.
   */
  function parseReleaseSchedule(text, nowMs = Date.now()) {
    if (!text) return [];
    const HORIZON = 62 * 24 * 3600 * 1000;
    const blocks = text.split(/\n+/).map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
    const seen = new Set();
    const out = [];
    for (const b of blocks) {
      const dm = b.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);            // DD.MM.YYYY
      if (!dm) continue;
      const tm = b.match(/(\d{1,2})(?:[:.](\d{2}))?\s*([ap]\.?m\.?)/i); // 10:00 AM / 10.00 AM / 3 PM
      if (!tm) continue;
      const [, dd, mo, yyyy] = dm;
      let hh = Number(tm[1]);
      const mm = tm[2] ? Number(tm[2]) : 0;
      const pm = /p/i.test(tm[3]);
      if (pm && hh !== 12) hh += 12;
      if (!pm && hh === 12) hh = 0;
      const whenMs = new Date(Number(yyyy), Number(mo) - 1, Number(dd), hh, mm, 0, 0).getTime();
      if (isNaN(whenMs)) continue;
      if (whenMs < nowMs - 12 * 3600 * 1000) continue; // already well past
      if (whenMs > nowMs + HORIZON) continue;           // too far out to matter yet
      let label = b.split(/\s+(?:tickets?|quota|slots?|will be|has been|w\.e\.f|are|is)\b/i)[0].trim();
      label = label.replace(/\s*\(\s*Rs\.?[^)]*\)/i, '').replace(/[.,:;\-\s]+$/, '').trim();
      if (label.length > 72) label = label.slice(0, 72).trim() + '…';
      if (!label) label = b.slice(0, 50);
      const timeStr = `${tm[1]}${tm[2] ? ':' + tm[2] : ''} ${pm ? 'PM' : 'AM'}`;
      const key = `${whenMs}|${label}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ label, whenMs, dateStr: `${dd}.${mo}.${yyyy}`, timeStr, raw: b });
    }
    out.sort((a, b) => a.whenMs - b.whenMs);
    return out;
  }

  return {
    describe, resolveField, resolveFieldMeta, runPlan, fillOne, isVisible,
    isStructuralVia: (via) => STRUCTURAL_KINDS.has(via),
    labelTextFor, sleep, validateRows, findContinueButton, classifyOutcome,
    PAYMENT_OUTCOMES, isQueuePage, loginState, queueSecondsLeft, parseServerCountdown,
    isBookingSuccess, parseReleaseSchedule,
    // For the content script's background finisher for late-loading <select>s.
    fillSelect, selectHolds,
  };
})();

// Node/CommonJS access for unit tests. Harmless in the browser (no `module`).
if (typeof module !== 'undefined') { module.exports = TTDEngine; }
