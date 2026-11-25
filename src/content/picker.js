/**
 * Click-to-map field picker.
 *
 * The popup puts the page into picking mode for one field key. The user hovers
 * (elements highlight), clicks a control, and we send back a selector
 * descriptor that the popup stores. This is how the extension learns TTD's
 * markup without anyone hardcoding IDs that break at the next redesign.
 */

const TTDPicker = (() => {
  let active = false;
  let pendingField = null;
  let hovered = null;
  let banner = null;

  const CONTROL_SELECTOR = 'input, select, textarea, [contenteditable="true"]';

  function start(fieldKey, fieldLabel) {
    if (active) stop();
    active = true;
    pendingField = fieldKey;

    banner = document.createElement('div');
    banner.className = 'ttd-af-banner';
    banner.textContent = `Click the field for: ${fieldLabel || fieldKey}  —  Esc to cancel`;
    document.body.appendChild(banner);

    document.addEventListener('mouseover', onHover, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey, true);
  }

  function stop() {
    active = false;
    pendingField = null;
    unhighlight();
    banner?.remove();
    banner = null;
    document.removeEventListener('mouseover', onHover, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKey, true);
  }

  function unhighlight() {
    hovered?.classList.remove('ttd-af-hover');
    hovered = null;
  }

  function onHover(e) {
    if (!active) return;
    const el = e.target.closest(CONTROL_SELECTOR);
    if (el === hovered) return;
    unhighlight();
    if (el) {
      hovered = el;
      el.classList.add('ttd-af-hover');
    }
  }

  function onClick(e) {
    if (!active) return;
    const el = e.target.closest(CONTROL_SELECTOR);
    if (!el) return;

    // Swallow the click so we don't submit anything or open a date picker.
    e.preventDefault();
    e.stopPropagation();

    const descriptor = TTDEngine.describe(el);
    api.runtime.sendMessage({
      type: 'PICKER_RESULT',
      fieldKey: pendingField,
      descriptor,
      preview: {
        tag: el.tagName.toLowerCase(),
        label: TTDEngine.labelTextFor(el),
        name: el.getAttribute('name') || el.id || '',
      },
    });
    stop();
  }

  function onKey(e) {
    if (active && e.key === 'Escape') {
      e.preventDefault();
      api.runtime.sendMessage({ type: 'PICKER_CANCELLED', fieldKey: pendingField });
      stop();
    }
  }

  /** Highlight every field the current mapping can already resolve. */
  function preview(mappings) {
    document.querySelectorAll('.ttd-af-mapped').forEach((el) => el.classList.remove('ttd-af-mapped'));
    let found = 0;
    for (const descriptor of Object.values(mappings || {})) {
      const el = TTDEngine.resolveField(descriptor);
      if (el) {
        el.classList.add('ttd-af-mapped');
        found++;
      }
    }
    setTimeout(() => {
      document.querySelectorAll('.ttd-af-mapped').forEach((el) => el.classList.remove('ttd-af-mapped'));
    }, 2500);
    return found;
  }

  return { start, stop, preview, isActive: () => active };
})();
