/**
 * Paste Helper — the fallback for forms where TTD blocks programmatic fill.
 *
 * TTD's newer React portal (ttdevasthanams.ap.gov.in) ignores any value an
 * extension sets: it accepts input only from a real keystroke or paste
 * (event.isTrusted). So we can't fill it — but a human Cmd/Ctrl+V IS accepted.
 *
 * This turns the extension into a paste assistant: the moment the user focuses a
 * field, its saved value is placed on the clipboard, so they just paste.
 * Dropdowns (Gender / Photo ID Proof) are selected by hand — clicks are blocked
 * the same way — and the helper shows which option to pick.
 *
 * Event DELEGATION (one listener on the document, re-resolving the focused field
 * against the live DOM) is deliberate: TTD's React re-renders the inputs whenever
 * a validation error appears, REPLACING the elements. Listeners bound to specific
 * element references would die on that re-render — which is exactly the bug that
 * made every field copy the same stale value. Delegation survives it.
 *
 * It only ever reads saved values and writes them to the clipboard; it never
 * submits, never advances, never touches Pay Now.
 */
(() => {
  'use strict';

  let active = false;
  let items = [];                 // [{ descriptor, value, fieldKey }]
  const done = new Set();         // indices completed by a real paste
  let panel = null, cueEl = null, valEl = null, progFill = null, progTxt = null;
  let onFocusIn = null, onCommit = null, onOver = null;
  let chips = [];                 // one floating chip per text field
  let tip = null;                 // hover tooltip showing a field's saved value
  let lastPos = null;             // remembered panel position (drag), kept across re-arms
  let rafId = null;

  // t() returns the KEY itself when a string is missing, so fall back to the
  // English default d whenever the lookup gives back the key (or nothing).
  const T = (k, d) => { try { const v = (typeof t === 'function') ? t(k) : null; return (v && v !== k) ? v : d; } catch { return d; } };
  const resolve = (it) => { try { return TTDEngine.resolveField(it.descriptor); } catch { return null; } };

  // Show the right paste shortcut for the user's OS: ⌘V on macOS, Ctrl+V on
  // Windows / Linux / everywhere else (most devotees are on Windows). PASTE_KEY
  // is the tight chip label; PASTE_COMBO reads in a sentence. TP() resolves an
  // i18n string and localises any "⌘V" it contains, so the 7 translated strings
  // never have to be edited per platform.
  const IS_MAC = (() => {
    try {
      const p = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
      return /mac/i.test(p);
    } catch { return false; }
  })();
  const PASTE_KEY = IS_MAC ? '⌘V' : 'Ctrl V';
  const PASTE_COMBO = IS_MAC ? '⌘V' : 'Ctrl+V';
  const TP = (k, d) => T(k, d).replace(/⌘\s?V/g, PASTE_COMBO).replace(/⌘/g, IS_MAC ? '⌘' : 'Ctrl');

  // Copy SYNCHRONOUSLY via execCommand, so the clipboard holds the right value
  // the instant a field is focused — the user can press Cmd/Ctrl+V immediately,
  // with no "wait a moment". navigator.clipboard.writeText is asynchronous and
  // raced the user's paste (the old "only the first field pastes" problem).
  // Selecting an off-screen span does NOT move focus, so the field stays focused
  // and the paste lands in it. Falls back to the async API if execCommand fails.
  function clipCopy(v) {
    try {
      let span = document.getElementById('ttd-paste-src');
      if (!span) {
        span = document.createElement('span');
        span.id = 'ttd-paste-src';
        span.style.cssText = 'position:fixed;left:-9999px;top:0;white-space:pre;user-select:text;opacity:0';
        document.body.appendChild(span);
      }
      span.textContent = String(v);
      const range = document.createRange();
      range.selectNodeContents(span);
      const sel = window.getSelection();
      const prev = sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
      sel.removeAllRanges();
      sel.addRange(range);
      const ok = document.execCommand('copy');
      sel.removeAllRanges();
      if (prev) { try { sel.addRange(prev); } catch { /* */ } }
      if (ok) return true;
    } catch { /* fall through */ }
    try { navigator.clipboard.writeText(String(v)); return true; } catch { return false; }
  }

  // Which stored item does this focused element correspond to? Re-resolved live,
  // so it is correct even after React swaps the input elements.
  function indexForEl(el) {
    if (!el) return -1;
    for (let i = 0; i < items.length; i++) { if (resolve(items[i]) === el) return i; }
    return -1;
  }
  const isPick = (el) => !!el && (el.tagName === 'SELECT' || el.readOnly);
  // Can the field actually receive a paste? TTD blocks paste on number inputs
  // (Age) — those must be typed — and dropdowns are picked. Only real text-like
  // inputs are pasteable, so only they get a copy chip.
  const pasteable = (el) => !!el && el.tagName === 'INPUT' && !el.readOnly
    && !/^(number|checkbox|radio|file|button|submit|reset|hidden|image|range|color|date|time)$/i.test(el.type || 'text');
  // Three task kinds: 'paste' (text → copy + ⌘V), 'pick' (dropdown → choose by
  // hand) and 'type' (number fields like Age, which TTD blocks paste on → must
  // be keyed in). Only paste + type get an on-field chip; pick is cued on focus.
  const kindOf = (el) => (pasteable(el) ? 'paste' : (isPick(el) ? 'pick' : 'type'));
  const labelFor = (el, it) => (el && (el.getAttribute('label') || el.getAttribute('placeholder') || el.getAttribute('aria-label'))) || (it && it.fieldKey) || 'Field';

  // A chip shows EITHER "⌘V" (paste it) or the literal value to type (Age), so a
  // number field carries its own answer: the user looks at "⌨ 34" and types 34.
  function styleChip(chip, kind, value) {
    if (kind === 'type') {
      chip.className = 'ttd-paste-chip ttd-paste-chip-type';
      chip.textContent = '⌨ ' + String(value);
      chip.title = T('paste.chipType', 'TTD blocks paste here — type this number');
    } else if (kind === 'pick') {
      const v = String(value);
      chip.className = 'ttd-paste-chip ttd-paste-chip-pick';
      chip.textContent = '▾ ' + (v.length > 16 ? v.slice(0, 15) + '…' : v);
      chip.title = T('paste.chipPick', 'Open this dropdown and choose: ') + v;
    } else {
      chip.className = 'ttd-paste-chip';
      chip.textContent = PASTE_KEY;
      chip.title = TP('paste.chip', 'Copy this value, then press ⌘V');
    }
  }

  function activate(planItems) {
    deactivate();
    items = (planItems || []).filter((x) => x && x.descriptor && x.value != null && String(x.value).trim() !== '');
    if (!items.length) return false;
    active = true;
    buildPanel();
    buildTip();
    onFocusIn = (e) => handleFocus(e.target);
    onCommit = (e) => handleCommit(e);
    onOver = (e) => handleHover(e.target);
    document.addEventListener('focusin', onFocusIn, true);
    document.addEventListener('input', onCommit, true);
    document.addEventListener('paste', onCommit, true);
    document.addEventListener('mouseover', onOver, true);
    buildChips();
    update();
    return true;
  }

  // A small tooltip that shows a field's saved value the moment the cursor is
  // over it — so the user sees exactly what belongs there before pasting. Purely
  // informational (pointer-events:none); the copy still happens on focus/click.
  function buildTip() {
    document.getElementById('ttd-paste-tip')?.remove();
    tip = document.createElement('div');
    tip.id = 'ttd-paste-tip';
    tip.className = 'ttd-paste-tip';
    tip.style.display = 'none';
    document.body.appendChild(tip);
  }

  function handleHover(el) {
    const i = indexForEl(el);
    if (i < 0 || done.has(i)) { hideTip(); return; }
    const it = items[i];
    const k = kindOf(el);
    const txt = k === 'type' ? ('⌨ ' + it.value)
      : k === 'pick' ? ('▾ ' + it.value)
      : (it.value + '  ·  ' + PASTE_COMBO);
    if (!tip) return;
    tip.textContent = txt;
    tip.style.display = '';
    const r = el.getBoundingClientRect();
    const tw = tip.offsetWidth || 120, th = tip.offsetHeight || 26;
    let top = r.top - th - 6; if (top < 2) top = r.bottom + 6;
    let left = r.left; if (left + tw > window.innerWidth - 4) left = window.innerWidth - tw - 4;
    tip.style.top = Math.round(top) + 'px';
    tip.style.left = Math.round(Math.max(4, left)) + 'px';
  }
  function hideTip() { if (tip) tip.style.display = 'none'; }

  // A tap-target on each text field: click it to copy THAT field's value and
  // focus the field, so the next keystroke (Cmd/Ctrl+V) pastes it right there.
  function buildChips() {
    chips = items.map((it, i) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.dataset.idx = String(i);
      const kind = kindOf(resolve(it));
      chip.dataset.kind = kind;
      styleChip(chip, kind, it.value);
      // mousedown.preventDefault keeps the field's focus from flickering to the chip
      chip.addEventListener('mousedown', (e) => e.preventDefault());
      chip.addEventListener('click', (e) => { e.preventDefault(); onChip(i); });
      document.body.appendChild(chip);
      return chip;
    });
    positionLoop();
  }

  function onChip(i) {
    const el = resolve(items[i]);
    if (!el || done.has(i)) return;
    try { el.focus(); } catch { /* */ }
    document.querySelectorAll('[data-ttd-cur]').forEach((n) => n.removeAttribute('data-ttd-cur'));
    el.setAttribute('data-ttd-cur', '1');
    chips.forEach((c) => c && c.classList.remove('ttd-paste-chip-hot'));
    if (chips[i]) chips[i].classList.add('ttd-paste-chip-hot');

    const k = kindOf(el);
    // Age / number fields: TTD blocks paste, so just park the cursor there (and
    // select any existing digits so typing replaces them) and show the number.
    if (k === 'type') {
      try { el.select && el.select(); } catch { /* */ }
      setCue('Type “' + items[i].value + '” for ' + labelFor(el, items[i]), 'pick');
      showVal(items[i], el, true); // show the value, no Copy button (paste won't work here)
      return;
    }
    // Dropdowns: the green chip is a non-interactive label (pointer-events:none),
    // so a click lands on the dropdown itself and opens it normally — we never
    // synthesise a click (TTD rejects it and it caused an open/retract flicker).
    if (k === 'pick') {
      setCue('Pick “' + items[i].value + '” for ' + labelFor(el, items[i]), 'pick');
      showVal(items[i], el, true);
      return;
    }
    const ok = clipCopy(items[i].value);
    setCue((ok ? '✓ ' : '') + labelFor(el, items[i]) + ' copied — now press ' + PASTE_COMBO, 'ready');
    showVal(items[i], el, ok);
  }

  // Keep each chip pinned to its field as the page scrolls or React re-renders.
  // Resolve each item to {el, via}. A chip is only shown for a STRUCTURAL match
  // (by name/id) — a loose label/css fallback is exactly what lands on the wrong
  // field (the live bug: contact.email's labelContains fallback grabbing the
  // Gender box and showing "pingpangboy1@gm…" there). Among structural matches,
  // one owner per element (first wins) so two chips never stack on one field.
  // Returns an array parallel to items: {el, kind, owns}.
  function layout() {
    const metas = items.map((it) => {
      try { return TTDEngine.resolveFieldMeta(it.descriptor); }
      catch { return { el: null, via: null }; }
    });
    const eligible = metas.map((m) => !!m.el && TTDEngine.isStructuralVia(m.via));
    // When two fields land on the same box, a per-pilgrim-ROW field outranks a
    // shared / General-Details field. So on a page with no General-Details block
    // (Ammavari SED), a contact field (email/city/…) can never steal a pilgrim
    // row's box; where General Details DO exist (Srivari SED) they resolve to
    // their own boxes and still get chips. Lower number = higher priority.
    const prio = (fk) => (/^people\./.test(fk || '') ? 0 : (/^contact\./.test(fk || '') ? 2 : 1));
    const owner = new Map(); // el -> winning item index (structural only)
    for (let i = 0; i < items.length; i++) {
      if (!eligible[i]) continue;
      const el = metas[i].el;
      const cur = owner.get(el);
      if (cur == null || prio(items[i].fieldKey) < prio(items[cur].fieldKey)) owner.set(el, i);
    }
    return metas.map((m, i) => ({
      el: m.el,
      via: m.via,
      kind: m.el ? kindOf(m.el) : null,
      owns: eligible[i] && owner.get(m.el) === i,
    }));
  }

  function positionLoop() {
    if (!active) { rafId = null; return; }
    const vw = window.innerWidth, vh = window.innerHeight;
    const lay = layout();
    for (let i = 0; i < items.length; i++) {
      const chip = chips[i]; if (!chip) continue;
      const { el, via, kind, owns } = lay[i];
      // Diagnostic breadcrumbs (readable from the page): which plan field this
      // chip is and how it resolved. Lets a wrong-field chip be traced.
      chip.dataset.fk = items[i].fieldKey || '';
      chip.dataset.via = via || '';
      // Every guided field gets a chip: text → ⌘V, Age → the number to type,
      // dropdown → the option to choose. Hidden once the field holds a value
      // (picked or auto-selected), once completed, if it doesn't resolve, or if
      // another item is the rightful owner of this element (dedupe).
      const filled = !!el && kind === 'pick' && String(el.value || '').trim() !== '';
      if (!el || !owns || done.has(i) || filled) { chip.style.display = 'none'; continue; }
      if (chip.dataset.kind !== kind) { styleChip(chip, kind, items[i].value); chip.dataset.kind = kind; }
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) { chip.style.display = 'none'; continue; }
      chip.style.display = '';
      const w = chip.offsetWidth || 40, h = chip.offsetHeight || 24;
      // Dropdowns carry a native chevron on the right — sit the chip left of it.
      const rightPad = kind === 'pick' ? 26 : 4;
      chip.style.left = Math.round(r.right - w - rightPad) + 'px';
      chip.style.top = Math.round(r.top + r.height / 2 - h / 2) + 'px';
    }
    rafId = requestAnimationFrame(positionLoop);
  }

  function deactivate() {
    active = false;
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    if (onFocusIn) document.removeEventListener('focusin', onFocusIn, true);
    if (onCommit) { document.removeEventListener('input', onCommit, true); document.removeEventListener('paste', onCommit, true); }
    if (onOver) document.removeEventListener('mouseover', onOver, true);
    chips.forEach((c) => c && c.remove());
    document.getElementById('ttd-paste-src')?.remove();
    tip?.remove();
    clearMarks();
    panel?.remove();
    panel = cueEl = valEl = progFill = progTxt = onFocusIn = onCommit = onOver = tip = null;
    chips = []; items = []; done.clear();
  }

  function clearMarks() {
    document.querySelectorAll('[data-ttd-cur],[data-ttd-done]').forEach((el) => {
      el.removeAttribute('data-ttd-cur'); el.removeAttribute('data-ttd-done');
    });
  }

  async function handleFocus(el) {
    const i = indexForEl(el);
    if (i < 0) return;
    const it = items[i];
    // highlight only the focused field
    document.querySelectorAll('[data-ttd-cur]').forEach((n) => n.removeAttribute('data-ttd-cur'));
    if (!done.has(i)) el.setAttribute('data-ttd-cur', '1');

    if (!pasteable(el)) {
      // Dropdowns are picked; number fields (Age) must be typed — TTD blocks
      // pasting into them. Either way, show the value so the user can do it.
      const verb = isPick(el) ? 'Pick' : 'Type';
      setCue(verb + ' “' + it.value + '” for ' + labelFor(el, it), 'pick');
      hideVal();
      return;
    }
    const ok = clipCopy(it.value); // synchronous — clipboard is ready at once
    setCue((ok ? '✓ ' : '') + labelFor(el, it) + (ok ? ' copied — press ' + PASTE_COMBO : ' — tap Copy, then paste'), 'ready');
    showVal(it, el, ok);
  }

  // A real human action only (isTrusted) completes a field; our own synthetic
  // fills and the finisher's retries (which TTD reverts) must never count.
  function handleCommit(e) {
    if (e && e.isTrusted === false) return;
    const el = e.target;
    const i = indexForEl(el);
    if (i < 0 || done.has(i)) return;
    const check = () => { if (String(el.value || '').trim()) markDone(i, el); };
    if (e.type === 'paste') setTimeout(check, 0); else check();
  }

  function markDone(i, el) {
    done.add(i);
    try { el.setAttribute('data-ttd-done', '1'); el.removeAttribute('data-ttd-cur'); } catch { /* */ }
    update();
    if (done.size >= items.length) {
      setCue(T('paste.allDone', '✓ All fields done — review and pay as usual'), 'done');
      hideVal();
    }
  }

  // ---------------------------------------------------------------- panel UI
  function buildPanel() {
    document.querySelector('.ttd-paste-panel')?.remove();
    panel = document.createElement('div');
    panel.className = 'ttd-paste-panel';
    const head = document.createElement('div'); head.className = 'ttd-paste-head';
    const grip = document.createElement('span'); grip.className = 'ttd-paste-grip'; grip.textContent = '⠿'; grip.title = T('paste.drag', 'Drag to move');
    const badge = document.createElement('span'); badge.className = 'ttd-paste-badge'; badge.textContent = 'TTV';
    const title = document.createElement('span'); title.className = 'ttd-paste-title'; title.textContent = T('paste.title', 'Paste Helper');
    const x = document.createElement('button'); x.className = 'ttd-paste-x'; x.textContent = '×'; x.title = T('paste.close', 'Close');
    x.addEventListener('click', deactivate);
    head.append(grip, badge, title, x);
    const note = document.createElement('div'); note.className = 'ttd-paste-note';
    note.textContent = TP('paste.note', 'This form blocks auto-fill, so paste instead: focus a field, then ⌘V. Pick dropdowns by hand.');
    cueEl = document.createElement('div'); cueEl.className = 'ttd-paste-cue'; cueEl.textContent = T('paste.start', 'Click the first field to begin');
    valEl = document.createElement('div'); valEl.className = 'ttd-paste-val'; valEl.hidden = true;
    const prog = document.createElement('div'); prog.className = 'ttd-paste-prog';
    const bar = document.createElement('div'); bar.className = 'ttd-paste-bar';
    progFill = document.createElement('i'); bar.appendChild(progFill);
    progTxt = document.createElement('span'); progTxt.className = 'ttd-paste-count';
    prog.append(bar, progTxt);
    panel.append(head, note, buildLegend(), cueEl, valEl, prog, buildCopyList());
    document.body.appendChild(panel);
    makeDraggable(panel); // whole panel is the drag surface (except buttons/rows)
    if (lastPos) applyPos(panel); // keep where the user dragged it last time
  }

  // Set the panel position. The base CSS pins left/bottom with !important, so we
  // must write these with 'important' priority to override it when dragging.
  function setPos(el, left, top) {
    el.style.setProperty('left', left + 'px', 'important');
    el.style.setProperty('top', top + 'px', 'important');
    el.style.setProperty('right', 'auto', 'important');
    el.style.setProperty('bottom', 'auto', 'important');
  }

  // Clamp a saved position back inside the viewport and apply it (switches the
  // panel from its default bottom-left anchor to explicit top/left).
  function applyPos(el) {
    const w = el.offsetWidth || 290, h = el.offsetHeight || 200;
    const left = Math.max(0, Math.min(lastPos.left, window.innerWidth - w));
    const top = Math.max(0, Math.min(lastPos.top, window.innerHeight - h));
    setPos(el, left, top);
  }

  // Drag the whole panel from any empty area. Pointer events cover mouse +
  // touch. Drags that start on an interactive bit (close button, a copy row, the
  // Copy button) are ignored so those still click normally.
  function makeDraggable(el) {
    let sx = 0, sy = 0, ox = 0, oy = 0, pid = null;
    const move = (e) => {
      if (pid == null || e.pointerId !== pid) return;
      const w = el.offsetWidth, h = el.offsetHeight;
      let nx = ox + (e.clientX - sx), ny = oy + (e.clientY - sy);
      nx = Math.max(0, Math.min(nx, window.innerWidth - w));
      ny = Math.max(0, Math.min(ny, window.innerHeight - h));
      setPos(el, nx, ny);
      lastPos = { left: nx, top: ny };
      e.preventDefault();
    };
    const up = (e) => {
      if (pid == null || (e && e.pointerId !== pid)) return;
      try { el.releasePointerCapture(pid); } catch { /* */ }
      pid = null;
    };
    el.addEventListener('pointerdown', (e) => {
      if (e.button != null && e.button !== 0) return; // left / primary only
      if (e.target.closest && e.target.closest('.ttd-paste-x, .ttd-paste-row, .ttd-paste-copy, button, a, input, select, textarea')) return;
      const r = el.getBoundingClientRect();
      setPos(el, r.left, r.top);
      sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top; pid = e.pointerId;
      // Pointer capture routes every move/up to this element even if the cursor
      // outruns it — the robust drag pattern that works across browsers + touch.
      try { el.setPointerCapture(pid); } catch { /* */ }
      e.preventDefault();
    });
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('lostpointercapture', up);
  }

  // Which action a value needs, from the plan item's type (works even when the
  // field isn't on the page): 'paste' (text → ⌘V), 'type' (Age / number → key it
  // in; TTD blocks paste there) or 'pick' (dropdown → choose by hand).
  function kindOfItem(it) {
    const ty = String((it && it.type) || '').toLowerCase();
    if (ty === 'number') return 'type';
    if (ty === 'dropdown' || ty === 'select' || ty === 'multiselect') return 'pick';
    return 'paste';
  }

  // A one-line legend that spells out the three actions, so it is obvious which
  // fields are easy copy-paste and which need a human (Age typed, dropdowns picked).
  function buildLegend() {
    const w = document.createElement('div'); w.className = 'ttd-paste-legend';
    const mk = (cls, icon, label) => {
      const s = document.createElement('span'); s.className = 'ttd-paste-leg ' + cls;
      s.textContent = icon + ' ' + label; return s;
    };
    w.append(
      mk('leg-paste', PASTE_KEY, T('paste.legPaste', 'paste text')),
      mk('leg-type', '⌨', T('paste.legType', 'type Age')),
      mk('leg-pick', '▾', T('paste.legPick', 'pick dropdown')),
    );
    return w;
  }

  // Human label for a plan field key, for the copy list.
  function labelFromKey(fk) {
    fk = fk || '';
    const C = {
      'contact.email': 'Email', 'contact.mobile': 'Mobile', 'contact.city': 'City',
      'contact.state': 'State', 'contact.country': 'Country', 'contact.pincode': 'PIN code',
    };
    if (C[fk]) return C[fk];
    const m = fk.match(/^people\.(\d+)\.(\w+)/);
    if (m) {
      const P = { name: 'Name', age: 'Age', gender: 'Gender', idType: 'ID type', idNumber: 'ID number' };
      const multi = items.some((x) => /^people\.[1-9]/.test(x.fieldKey || ''));
      return (P[m[2]] || m[2]) + (multi ? ' · P' + (Number(m[1]) + 1) : '');
    }
    return fk;
  }

  /**
   * The universal fallback: a tap-to-copy list of EVERY saved value, shown
   * whether or not the field could be located on the page. This is what covers
   * the "General details" section (name / email / address) on forms where our
   * field mapping misses — the user taps a value to copy it, clicks the field,
   * and pastes. Contact/General values are listed first (that's the gap);
   * pilgrim values follow. Never depends on resolveField, so it can't break when
   * TTD renames a field.
   */
  function buildCopyList() {
    const wrap = document.createElement('div'); wrap.className = 'ttd-paste-list';
    const h = document.createElement('div'); h.className = 'ttd-paste-list-h';
    h.textContent = TP('paste.copyList', 'Copy any saved value (incl. General details), then click the field and press ⌘V:');
    wrap.appendChild(h);
    const rank = (fk) => (/^contact\./.test(fk || '') ? 0 : 1);
    const order = items.map((it, i) => ({ it, i })).sort((a, b) => rank(a.it.fieldKey) - rank(b.it.fieldKey));
    for (const { it } of order) {
      const k = kindOfItem(it);
      const row = document.createElement('button');
      row.type = 'button'; row.className = 'ttd-paste-row ttd-paste-row-' + k;
      // A colored action glyph per row: ⌘V = paste (easy), ⌨ = type Age by hand,
      // ▾ = pick dropdown by hand. So the "needs a human" fields stand out.
      const rk = document.createElement('span'); rk.className = 'ttd-paste-rk rk-' + k;
      rk.textContent = k === 'type' ? '⌨' : k === 'pick' ? '▾' : PASTE_KEY;
      const lbl = document.createElement('span'); lbl.className = 'ttd-paste-row-lbl';
      const base = labelFromKey(it.fieldKey); lbl.textContent = base;
      const val = document.createElement('span'); val.className = 'ttd-paste-row-val'; val.textContent = String(it.value);
      row.append(rk, lbl, val);
      row.title = k === 'type' ? T('paste.chipType', 'TTD blocks paste here — type this number')
        : k === 'pick' ? (T('paste.chipPick', 'Open this dropdown and choose: ') + it.value)
        : TP('paste.chip', 'Copy this value, then press ⌘V');
      row.addEventListener('mousedown', (e) => e.preventDefault()); // don't steal focus from a field
      row.addEventListener('click', (e) => {
        e.preventDefault();
        const ok = clipCopy(it.value);
        row.classList.add('ttd-paste-row-copied');
        lbl.textContent = ok ? T('paste.copied', 'Copied ✓') : base;
        setTimeout(() => { row.classList.remove('ttd-paste-row-copied'); lbl.textContent = base; }, 1300);
      });
      wrap.appendChild(row);
    }
    return wrap;
  }

  function setCue(text, kind) {
    if (!cueEl) return;
    cueEl.className = 'ttd-paste-cue' + (kind ? ' ttd-paste-' + kind : '');
    cueEl.textContent = text;
  }

  function showVal(it, el, copied) {
    if (!valEl) return;
    valEl.hidden = false; valEl.innerHTML = '';
    const code = document.createElement('code'); code.className = 'ttd-paste-code'; code.textContent = String(it.value);
    valEl.appendChild(code);
    if (!copied) {
      const btn = document.createElement('button'); btn.className = 'ttd-paste-copy'; btn.textContent = T('paste.copy', 'Copy');
      btn.addEventListener('click', () => {
        if (clipCopy(it.value)) btn.textContent = T('paste.copied', 'Copied ✓');
        else { const r = document.createRange(); r.selectNodeContents(code); const s = window.getSelection(); s.removeAllRanges(); s.addRange(r); }
      });
      valEl.appendChild(btn);
    }
  }
  function hideVal() { if (valEl) { valEl.hidden = true; valEl.innerHTML = ''; } }

  function update() {
    if (!progFill || !progTxt) return;
    progFill.style.width = items.length ? Math.round((done.size / items.length) * 100) + '%' : '0%';
    progTxt.textContent = done.size + ' / ' + items.length;
  }

  window.TTDPaste = {
    activate, deactivate, isActive: () => active,
    _debug: () => items.map((it, i) => { const el = resolve(it); const kind = pasteable(el) ? 'paste' : (isPick(el) ? 'pick' : 'type'); return (el && el.getAttribute('name')) + '#' + (el && el.getAttribute('id')) + ':' + kind + ':' + it.value + (done.has(i) ? ':done' : ''); }),
  };
})();
