/**
 * React autofill companion — runs in the PAGE's MAIN world (Chrome only;
 * declared only in manifest.json, ttdevasthanams host only).
 *
 * The ttdevasthanams React form rejects synthetic input on its TEXT fields
 * (isTrusted guard), so we fill those by calling the input's own React
 * onChange/onBlur (read off __reactProps$) with a plain-object event — a JS
 * handler accepts isTrusted as an ordinary property. Its custom DROPDOWNS
 * (Gender / Photo ID Proof) are not isTrusted-gated: we open the trigger, then
 * click the matching <li> in the ".dropdown_scroll" panel. The Photo ID Number
 * field is disabled until the ID type is picked, so it is filled in a second
 * pass after the dropdowns.
 *
 * It only writes values the user saved and reads them back to report what held;
 * it never submits, never clicks Continue, never touches payment. The isolated
 * content script gates it and tags the target elements with data-ttv-fill (the
 * one thing that crosses the isolated/MAIN boundary); this script re-finds them
 * by that attribute.
 */
(() => {
  'use strict';

  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  const tagEl = (i) => document.querySelector('[data-ttv-fill="' + i + '"]');
  const isPick = (t) => { t = String(t || '').toLowerCase(); return t === 'dropdown' || t === 'select' || t === 'multiselect'; };

  function setNative(el, value) {
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const d = Object.getOwnPropertyDescriptor(proto, 'value');
    if (d && d.set) d.set.call(el, value); else el.value = value;
  }
  function reactProps(el) {
    try { const k = Object.keys(el).find((x) => x.indexOf('__reactProps$') === 0); return k ? el[k] : null; }
    catch (e) { return null; }
  }
  function stateValue(el) { const p = reactProps(el); return (p && 'value' in p) ? String(p.value) : null; }
  function ev(el, type) {
    return { target: el, currentTarget: el, isTrusted: true, bubbles: true, type,
      nativeEvent: { isTrusted: true, target: el }, preventDefault() {}, stopPropagation() {},
      persist() {}, getModifierState() { return false; } };
  }

  // Text/number field: set value + fire the React onChange ONLY. No native DOM
  // input/change events — the isTrusted guard reverts those to empty; React's own
  // onChange commits the value without tripping the guard. `doFocus` is false on
  // the fast batch pass: focusing each field blurs the previous one before React
  // commits it (that is the clobber), so the fast pass skips focus entirely and
  // only the sequential fallback focuses.
  function setValue(el, value, doFocus) {
    if (doFocus !== false) { try { el.focus(); } catch (e) { /* */ } }
    setNative(el, value);
    const props = reactProps(el);
    if (props) for (const h of ['onChange', 'onInput']) {
      if (typeof props[h] === 'function') { try { props[h](ev(el, 'change')); } catch (e) { /* */ } }
    }
  }
  // Blur via the React onBlur ONLY (marks touched + re-validates → clears the
  // "required" / "please enter …" error). No native blur/focusout either.
  function blurField(el) {
    const props = reactProps(el);
    if (props && typeof props.onBlur === 'function') { try { props.onBlur(ev(el, 'blur')); } catch (e) { /* */ } }
  }

  // Custom dropdown: open the trigger, then click whichever visible option
  // matches the value. Class-agnostic (the site uses hashed CSS-module classes),
  // so it looks for any visible <li> / [role=option] by text, polling because the
  // options render a moment after the panel opens.
  const visible = (el) => { try { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; } catch (e) { return false; } };
  function findOption(want) {
    const opts = Array.from(document.querySelectorAll('li, [role="option"]'));
    return opts.find((x) => visible(x) && (x.textContent || '').trim().toLowerCase() === want)
      || opts.find((x) => visible(x) && (x.textContent || '').trim().length < 40 && (x.textContent || '').trim().toLowerCase().indexOf(want) !== -1);
  }
  function fireClick(el) {
    for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click']) {
      try { el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window })); } catch (e) { /* */ }
    }
    // Also call React's own click/mousedown handler directly (bypasses any
    // isTrusted gate the way our onChange does for text fields).
    const p = reactProps(el);
    if (p) for (const h of ['onClick', 'onMouseDown', 'onPointerDown']) {
      if (typeof p[h] === 'function') { try { p[h](ev(el, 'click')); } catch (e) { /* */ } }
    }
  }
  function openTrigger(el) {
    try { el.focus(); } catch (e) { /* */ }
    fireClick(el);
  }
  function closeAnyPanel() { try { document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); } catch (e) { /* */ } }
  async function selectDropdown(trigger, value) {
    const want = String(value).toLowerCase().trim();
    // Retry the whole open→find→click a few times and verify it took — with
    // two identical dropdowns per row (Gender, Photo ID Proof ×N rows) the
    // first one sometimes misses silently, leaving its dependent ID-number
    // field disabled.
    for (let attempt = 0; attempt < 3; attempt++) {
      closeAnyPanel(); await delay(60);
      openTrigger(trigger);
      let li = findOption(want);
      for (let t = 0; t < 12 && !li; t++) { await delay(45); li = findOption(want); } // breaks the instant options render
      // Some triggers open on a parent/wrapper rather than the input itself.
      if (!li && trigger.parentElement) {
        openTrigger(trigger.parentElement);
        for (let t = 0; t < 8 && !li; t++) { await delay(45); li = findOption(want); }
      }
      if (li) {
        try { li.scrollIntoView({ block: 'nearest' }); } catch (e) { /* */ }
        fireClick(li);
        await delay(150);
        if (held(trigger, value)) return true; // selection stuck
      }
    }
    closeAnyPanel();
    return false;
  }

  function held(el, value) {
    if (!el) return false;
    const want = String(value).trim().toLowerCase();
    const sv = String(stateValue(el) || '').trim().toLowerCase();
    const dv = String(el.value || '').trim().toLowerCase();
    if (sv === want || dv === want) return true;
    // A selected dropdown often shows its chosen label as TEXT in the field's
    // wrapper rather than on the input's .value — accept that too.
    const wrap = el.closest('[class*="dropdown"], [class*="Dropdown"], [class*="select"], .form-group, .field') || el.parentElement;
    const tx = (wrap ? wrap.textContent : '').trim().toLowerCase();
    return !!tx && want.length > 1 && tx.indexOf(want) !== -1;
  }


  // FAST pass: set every field in one quick batch WITHOUT focusing (no
  // focus-steal between fields = no clobber), then fire every onBlur to clear
  // the "required" errors. The common case fills the whole form here in well
  // under a second.
  const fastSet = (list) => { for (const it of list) { const el = tagEl(it.i); if (el && !el.disabled) setValue(el, it.value, false); } };
  const fastBlur = (list) => { for (const it of list) { const el = tagEl(it.i); if (el) blurField(el); } };
  const notHeld = (list) => list.filter((it) => { const el = tagEl(it.i); return el && !el.disabled && !held(el, it.value); });

  // RELIABLE fallback: refill ONE field at a time (focus, set, beat, blur,
  // settle) — slower, but guaranteed. Only the stragglers the fast pass missed
  // ever reach this, so the worst case is rare and small.
  async function fillSequential(list) {
    for (const it of list) {
      const el = tagEl(it.i);
      if (!el || el.disabled) continue;
      setValue(el, it.value);
      await delay(90);
      blurField(el);
      await delay(200);
    }
  }

  async function run(items) {
    const picks = items.filter((it) => isPick(it.type));
    const texts = items.filter((it) => !isPick(it.type));

    // Pass 1 (FAST): batch-set all text, no focus, then blur all.
    fastSet(texts); await delay(70); fastBlur(texts); await delay(130);

    // Pass 2: pick the dropdowns one at a time (an ID-type pick enables its
    // ID-number field). This re-renders the form; a beat between each lets the
    // previous panel close before the next opens.
    for (const it of picks) { const el = tagEl(it.i); if (el) { await selectDropdown(el, it.value); await delay(120); } }

    // Pass 3 (FAST): batch-fill the now-enabled ID numbers (and anything the
    // re-render disturbed), then blur all.
    fastSet(notHeld(texts)); await delay(70); fastBlur(texts); await delay(150);

    // Pass 4 (FALLBACK): only the fields that still aren't holding get the slow,
    // guaranteed one-at-a-time treatment. Usually empty, so usually instant.
    const stragglers = notHeld(texts);
    if (stragglers.length) await fillSequential(stragglers);

    // Verify.
    await delay(150);
    return items.map((it) => ({ i: it.i, held: held(tagEl(it.i), it.value) }));
  }

  const ack = () => { try { window.postMessage({ __ttv: 'react-fill-ready' }, '*'); } catch (e) { /* */ } };

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || typeof e.data !== 'object') return;
    if (e.data.__ttv === 'react-fill-ping') { ack(); return; }
    if (e.data.__ttv !== 'react-fill') return;
    const items = e.data.items || [];
    run(items).then((res) => { try { window.postMessage({ __ttv: 'react-fill-done', res }, '*'); } catch (e) { /* */ } });
  });

  ack(); // announce presence (content also pings once it is listening)
  try { window.__ttvReactFill = 'loaded'; } catch (e) { /* */ } // console marker
})();
