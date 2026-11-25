/**
 * Popup controller.
 *
 * Owns all state: reads/writes storage, renders the profile editor, and builds
 * the fill plan the content script executes.
 *
 * Field keys are paths into the ACTIVE profile — 'contact.email',
 * 'people.2.name' — so switching profiles swaps the whole dataset without
 * touching mappings.
 */

const TTD_HOSTS = /(ttdevasthanams\.ap\.gov\.in|ttdsevaonline\.com|tirupatibalaji\.ap\.gov\.in|srivanitrust\.ap\.gov\.in)/;

const state = {
  store: null,
  mappings: {},      // merged: seeds + user picks
  userMappings: {},  // user picks only
  flow: DEFAULT_FLOW,
  // Mapping buttons are hidden by default. They are insurance against a TTD
  // redesign breaking a selector, not something to look at while typing — and
  // at six pilgrims they put 35 buttons on screen for no daily benefit.
  showMapping: false,
  // Fields the last fill could not handle. Their button is shown regardless,
  // so a broken field surfaces its own fix exactly when it matters.
  problemFields: new Set(),
  // Fields whose stored value is present but malformed (short Aadhaar, etc.).
  // Outlined red so the user sees the problem before booking, not after.
  invalidFields: new Set(),
};

const FIELD_BY_KEY = Object.fromEntries(
  [...PERSON_FIELDS, ...CONTACT_FIELDS].map((f) => [f.key, f])
);
const CONTACT_KEYS = new Set(CONTACT_FIELDS.map((f) => f.key));

// Flows where the extension must NOT auto-click Continue after filling. SRIVANI
// Break Darshan gates Continue behind a CAPTCHA and a quota-release time, and
// its own instructions warn that clicking early is treated as suspicious
// activity — so there it fills the rows only and the user proceeds by hand.
const NO_AUTOCONTINUE_FLOWS = new Set([FLOWS.SRIVANI]);

const profile = () => activeProfile(state.store);

/** Keep the "Assist my whole booking" checkbox in step with its three
 *  sub-settings — it is on only when all three are on. */
function syncAssistToggle() {
  const s = state.store.settings;
  const on = s.autoFillOnLoad && s.autoContinue && s.floatingButton;
  s.assistMode = on;
  const box = $('assistMode');
  if (box) box.checked = on;
}

// ---------------------------------------------------------------- DOM helper

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null) continue;
    el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}

const $ = (id) => document.getElementById(id);

// -------------------------------------------------------------------- status

let statusTimer = null;
function setStatus(text, kind = 'info') {
  const box = $('status');
  box.textContent = text;
  box.classList.toggle('error', kind === 'error');
  box.hidden = false;
  clearTimeout(statusTimer);
  if (kind !== 'error') statusTimer = setTimeout(() => { box.hidden = true; }, 6000);
}

// ------------------------------------------------------------------- persist

let saveTimer = null;
function markDirty() {
  $('saveState').textContent = t('save.saving');
  $('saveState').classList.add('dirty');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    await saveStore(state.store);
    $('saveState').textContent = t('save.saved');
    $('saveState').classList.remove('dirty');
  }, 400);
}

/** Persist immediately — for structural changes that must not be lost. */
async function saveNow() {
  clearTimeout(saveTimer);
  await saveStore(state.store);
  $('saveState').textContent = t('save.saved');
  $('saveState').classList.remove('dirty');
}

// ----------------------------------------------------------------- language

/**
 * Fill in the static (HTML-declared) strings in the active language. Elements
 * carry data-i18n / data-i18n-title with a translation key; dynamically-built
 * DOM (the profile editor, the fields) is translated at build time via t().
 */
function applyStaticI18n() {
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.getAttribute('data-i18n'));
  });
  document.querySelectorAll('[data-i18n-title]').forEach((el) => {
    el.title = t(el.getAttribute('data-i18n-title'));
  });
  document.documentElement.lang = currentLang();
}

function renderLangSelect() {
  const sel = $('langSelect');
  sel.replaceChildren(
    ...Object.entries(LANG_NAMES).map(([code, name]) =>
      h('option', { value: code, ...(code === currentLang() ? { selected: true } : {}) }, name)
    )
  );
  sel.value = currentLang();
}

// --------------------------------------------------------------------- paths

const personPath = (i, key) => `people.${i}.${key}`;
const contactPath = (key) => `contact.${key}`;

function fieldSpecForKey(fieldKey) {
  const leaf = fieldKey.split('.').pop();
  return FIELD_BY_KEY[leaf] || { key: leaf, type: 'text', label: leaf };
}

/** The localized label for a field spec, e.g. 'name' → "Full name" / "పూర్తి పేరు". */
function fieldLabel(spec) {
  return t(`field.${spec.key}`);
}

/** "Gender (Pilgrim 1)" — so a reported failure says which row it was. */
function describeField(fieldKey) {
  const label = fieldLabel(fieldSpecForKey(fieldKey));
  const m = fieldKey.match(/^people\.(\d+)\./);
  return m ? `${label} (${t('lbl.pilgrim', { n: Number(m[1]) + 1 })})` : label;
}

// -------------------------------------------------------------- profile bar

function renderProfileBar() {
  const bar = $('profilebar');

  // The Srivari Seva volunteer profile is one record for the whole account, not
  // one of the switchable travelling-party profiles — so the profile switcher
  // does not apply here. Show a plain label instead.
  if (state.flow === FLOWS.SRIVARI) {
    bar.replaceChildren(
      h('span', { class: 'bar-label', text: t('vol.barLabel') }),
      h('span', { class: 'profile-name vol-bar-note', text: t('vol.barNote') })
    );
    return;
  }

  const sel = h('select', { id: 'profileSelect', title: 'Switch profile' },
    state.store.profiles.map((p) =>
      h('option', { value: p.id, ...(p.id === state.store.activeProfileId ? { selected: true } : {}) },
        `${p.name} (${p.people.length})`)
    )
  );
  sel.value = state.store.activeProfileId;
  sel.addEventListener('change', async () => {
    state.store.activeProfileId = sel.value;
    await saveNow();
    render();
  });

  const nameInput = h('input', {
    type: 'text',
    class: 'profile-name',
    value: profile().name,
    placeholder: 'Profile name',
    title: 'Rename this profile',
    maxlength: 40,
  });
  nameInput.addEventListener('input', () => {
    profile().name = nameInput.value;
    markDirty();
    // Keep the dropdown label in step without re-rendering the whole editor.
    const opt = sel.querySelector(`option[value="${CSS.escape(profile().id)}"]`);
    if (opt) opt.textContent = `${nameInput.value} (${profile().people.length})`;
  });

  bar.replaceChildren(
    h('span', { class: 'bar-label', text: t('lbl.profile') }),
    sel,
    nameInput,
    h('button', {
      class: 'ghost-btn',
      text: t('btn.newProfile'),
      title: 'Start a new, empty profile',
      onclick: async () => { addProfile(state.store); await saveNow(); render(); },
    }),
    h('button', {
      class: 'ghost-btn',
      text: t('btn.duplicate'),
      title: 'Copy this profile and its pilgrims',
      onclick: async () => { duplicateProfile(state.store, state.store.activeProfileId); await saveNow(); render(); },
    }),
    h('button', {
      class: 'ghost-btn danger',
      text: t('btn.delete'),
      title: state.store.profiles.length <= 1 ? 'The last profile cannot be deleted' : 'Delete this profile',
      ...(state.store.profiles.length <= 1 ? { disabled: true } : {}),
      onclick: async () => {
        const name = profile().name;
        // Deleting takes real data with it, so make it a two-step action.
        if (!confirmDelete(name)) return;
        removeProfile(state.store, state.store.activeProfileId);
        await saveNow();
        render();
        setStatus(`Deleted profile "${name}".`);
      },
    })
  );
}

/**
 * Two-click delete confirmation. window.confirm() is unreliable inside an
 * extension popup — it can dismiss the popup entirely — so the button asks for
 * a second click instead.
 */
let pendingDelete = null;
function confirmDelete(name) {
  if (pendingDelete === state.store.activeProfileId) {
    pendingDelete = null;
    return true;
  }
  pendingDelete = state.store.activeProfileId;
  setStatus(`Click Delete again to remove "${name}" and its pilgrims.`, 'error');
  setTimeout(() => { pendingDelete = null; }, 5000);
  return false;
}

// -------------------------------------------------------------------- render

function renderTabs() {
  $('tabs').replaceChildren(
    ...Object.values(FLOWS).map((flow) =>
      h('button', {
        class: `tab${flow === state.flow ? ' active' : ''}`,
        text: FLOW_LABELS[flow],
        onclick: () => { state.flow = flow; applySevaSelection(flow); render(); },
      })
    )
  );
}

/**
 * Pre-flight check.
 *
 * Discovering a blank Aadhaar number three seconds after quota opens costs the
 * slot — the whole margin this extension buys is time, and fixing data during
 * a release spends it. So the popup states readiness plainly, every time it is
 * opened, before anything else.
 *
 * Contact details are advisory: SPAT does not render that block at all, so a
 * missing city is not a blocker there. Pilgrim rows are mandatory — every
 * field on them is required by the portal.
 */
function readiness() {
  const p = profile();
  const blocking = [];
  const invalid = [];
  const invalidKeys = new Set();

  // Only the pilgrims chosen for this booking are checked (subset picker). The
  // original index is kept for labels and red outlines; the compaction onto the
  // page's first rows happens at fill time.
  const chosen = p.people.map((person, i) => ({ person, i })).filter((x) => x.person.include !== false);

  for (const { person, i } of chosen) {
    // Layer 1: required fields left blank.
    const missing = PERSON_FIELDS
      .filter((f) => !String(person[f.key] ?? '').trim())
      .map((f) => f.key);
    if (missing.length) blocking.push({ pilgrim: i + 1, missing });

    // Layer 2: fields that ARE filled but malformed (short Aadhaar, bad age).
    for (const pr of validatePerson(person)) {
      invalid.push({ pilgrim: i + 1, ...pr });
      invalidKeys.add(personPath(i, pr.key));
    }
  }

  // Layer 3: two chosen pilgrims sharing one ID number — TTD rejects that.
  const duplicates = findDuplicateIds(chosen.map((x) => x.person))
    .map((d) => ({ ...d, pilgrims: d.pilgrims.map((idx) => chosen[idx].i) }));
  for (const d of duplicates) {
    for (const i of d.pilgrims) invalidKeys.add(personPath(i, 'idNumber'));
  }

  const advisory = CONTACT_FIELDS
    .filter((f) => f.key !== 'mobile' && !String(p.contact[f.key] ?? '').trim())
    .map((f) => f.key);

  const noneChosen = chosen.length === 0;
  return {
    ok: !noneChosen && blocking.length === 0 && invalid.length === 0 && duplicates.length === 0,
    blocking, invalid, duplicates, invalidKeys, advisory, count: chosen.length, noneChosen,
  };
}

function renderReadiness() {
  const bar = $('readiness');

  // Volunteer profile has its own single-record readiness (no pilgrim rows).
  if (state.flow === FLOWS.SRIVARI) { renderVolunteerReadiness(bar); return; }

  const r = readiness();
  state.invalidFields = r.invalidKeys; // drives the red field outlines
  // The whole banner opens the detailed preflight checklist.
  bar.style.cursor = 'pointer';
  bar.title = t('preflight.open');
  bar.onclick = openPreflight;

  if (!r.ok) {
    bar.className = 'readiness not-ready';
    // Missing fields are the most fundamental problem, so they lead; then a
    // duplicate ID (a certain booking rejection); then a malformed value.
    if (r.noneChosen) {
      bar.textContent = t('ready.noneChosen');
    } else if (r.blocking.length) {
      const worst = r.blocking[0];
      const missing = worst.missing.map((k) => t(`field.${k}`)).join(', ');
      bar.textContent = t('ready.not', { n: worst.pilgrim, missing })
        + (r.blocking.length > 1 ? t('ready.notMore', { extra: r.blocking.length - 1 }) : '');
    } else if (r.duplicates.length) {
      const list = r.duplicates[0].pilgrims.map((i) => t('lbl.pilgrim', { n: i + 1 })).join(', ');
      bar.textContent = t('ready.duplicate', { list });
    } else {
      const first = r.invalid[0];
      const problem = t(`problem.${first.code}`, first.params);
      bar.textContent = t('ready.invalid', { n: first.pilgrim, problem });
    }
    return;
  }

  bar.className = 'readiness ready';
  let text = t('ready.ok', { who: nPilgrims(r.count), name: profile().name });
  if (r.advisory.length) {
    text += t('ready.advisory', { list: r.advisory.map((k) => t(`field.${k}`)).join(', ') });
  }
  bar.textContent = text;
}

/**
 * Toggle the red "invalid" outline on fields without a full re-render, so a
 * malformed value clears its highlight the moment it is corrected.
 */
function applyInvalidMarks() {
  document.querySelectorAll('#content .field[data-key]').forEach((el) => {
    el.classList.toggle('invalid', !!state.invalidFields?.has(el.getAttribute('data-key')));
  });
}

/**
 * If a booking was interrupted (payment aborted/errored → TTD holds the pilgrim
 * IDs), the content script saved a local marker. Surface a reminder at the top
 * of the popup so that, even if the booking tab was closed, the user remembers
 * to check Booking History before re-booking. No PII — only a timestamp + flow.
 */
async function renderLockNote(main) {
  let mark;
  try { mark = (await api.storage.local.get('bookingLock')).bookingLock; } catch { return; }
  if (!mark || !mark.ts || (Date.now() - mark.ts) > 2 * 60 * 60 * 1000) return;
  main.querySelector('.lock-note')?.remove();
  const flowName = FLOW_LABELS[mark.flow] || 'TTD';
  const time = new Date(mark.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const note = h('div', { class: 'lock-note' },
    h('div', { class: 'lock-note-body', text: t('lockbar.popupBody', { flow: flowName, time }) }),
    h('div', { class: 'lock-note-actions' },
      h('a', { class: 'lock-note-link', href: 'https://ttdevasthanams.ap.gov.in/',
        target: '_blank', rel: 'noopener', text: t('lockbar.history') }),
      h('button', { class: 'lock-note-dismiss', text: t('lockbar.dismiss'),
        onclick: async () => {
          try { await api.storage.local.remove('bookingLock'); } catch { /* fine */ }
          note.remove();
        } })
    )
  );
  main.insertBefore(note, main.firstChild);
}

function render() {
  renderProfileBar();
  renderTabs();
  renderReadiness();
  const main = $('content');
  main.replaceChildren();
  renderLockNote(main); // async: a reminder if a booking was left mid-flight

  // Srivari Seva volunteer profile is a single account-wide record, not pilgrim
  // rows, so it has its own editor and skips the contact/pilgrims layout.
  if (state.flow === FLOWS.SRIVARI) { renderVolunteer(main); return; }

  main.appendChild(h('div', { class: 'section-title', text: t('sec.general') }));
  main.appendChild(
    h('div', { class: 'card' },
      h('div', { class: 'card-body' },
        CONTACT_FIELDS.map((f) => renderField(contactPath(f.key), f)),
        // Single family Gothram — shown on the Arjitha tab because only that
        // flow's Divyanugraha Homam seva renders the field. Optional; fills only
        // where the field exists, and never blocks readiness.
        state.flow === FLOWS.ARJITHA
          ? renderField('gothram', { key: 'gothram', type: 'text', maxLength: 40 })
          : null)
    )
  );

  const people = profile().people;
  const flowMax = flowMaxPilgrims(state.flow); // SRIVANI 4, others 6
  main.appendChild(h('div', { class: 'section-title', text: t('sec.pilgrims', { count: people.length, max: flowMax }) }));
  people.forEach((_, i) => main.appendChild(renderPersonCard(i)));

  // Subset picker feedback + "remember this selection for this seva".
  const selected = people.filter((x) => x.include !== false).length;
  if (selected !== people.length) {
    main.appendChild(h('p', { class: 'hint subset-hint', text: t('hint.subset', { n: selected, total: people.length }) }));
  }
  if (people.length > 1) {
    main.appendChild(h('button', {
      class: 'link-btn', text: t('seva.remember', { seva: FLOW_LABELS[state.flow] }),
      onclick: () => saveSevaSelection(state.flow),
    }));
  }

  if (people.length < flowMax) {
    main.appendChild(h('button', {
      class: 'ghost-btn',
      text: t('btn.addPilgrim'),
      onclick: () => { people.push(emptyPerson()); markDirty(); render(); },
    }));
  } else if (people.length > flowMax) {
    // Profile carries more pilgrims than this flow's form allows (SRIVANI = 4).
    main.appendChild(h('p', { class: 'hint', text: t('hint.pilgrimCap', { max: flowMax }) }));
  }

  main.appendChild(h('p', { class: 'hint', text: t('hint.passport') }));
  main.appendChild(h('p', { class: 'hint', text: t('hint.slot') }));
  if (state.flow === FLOWS.SRIVANI) {
    main.appendChild(h('p', { class: 'hint', text: t('hint.srivani') }));
    main.appendChild(h('p', { class: 'hint', text: t('hint.srivaniButton') }));
  }

  // Escape hatch for a TTD redesign. Tucked at the bottom because it is needed
  // rarely, and a failing field reveals its own button anyway.
  main.appendChild(h('button', {
    class: 'link-btn mapping-toggle',
    text: state.showMapping ? t('map.hide') : t('map.fix'),
    title: 'Re-teach the extension where a field goes, if TTD changes their form',
    onclick: () => { state.showMapping = !state.showMapping; render(); },
  }));
}

// ------------------------------------------------ Srivari Seva volunteer profile

/** The live volunteer record (one per install). */
const volunteer = () => {
  if (!Array.isArray(state.store.volunteers) || !state.store.volunteers.length) ensureVolunteers(state.store);
  return activeVolunteer(state.store);
};
/** Display name for a Sevak in the selector — their name, else "Sevak N". */
const volunteerLabel = (v, i) => (String(v.sevakName || '').trim() || t('vol.sevakN', { n: i + 1 }));

function renderVolunteerReadiness(bar) {
  state.invalidFields = new Set();
  const r = validateVolunteer(volunteer());
  bar.style.cursor = 'default';
  bar.title = '';
  bar.onclick = null;

  if (!r.ok) {
    bar.className = 'readiness not-ready';
    if (r.missing.length) {
      const list = r.missing.slice(0, 3).map((k) => t(`field.${k}`)).join(', ');
      bar.textContent = t('vol.ready.missing', { list })
        + (r.missing.length > 3 ? t('vol.ready.more', { extra: r.missing.length - 3 }) : '');
    } else {
      const p = r.problems[0];
      bar.textContent = t('vol.ready.invalid', { problem: t(`problem.${p.code}`, p.params || {}) });
    }
    return;
  }
  bar.className = 'readiness ready';
  let text = t('vol.ready.ok', { name: volunteer().sevakName || t('vol.sevak') });
  if (r.advisory.length) {
    text += t('ready.advisory', { list: r.advisory.slice(0, 4).map((k) => t(`field.${k}`)).join(', ') });
  }
  bar.textContent = text;
}

function renderVolunteer(main) {
  main.appendChild(h('p', { class: 'hint vol-intro', text: t('vol.intro') }));
  renderSevakBar(main);

  for (const section of VOLUNTEER_SECTIONS) {
    main.appendChild(h('div', { class: 'section-title', text: t(`vol.sec.${section.title}`) }));
    main.appendChild(
      h('div', { class: 'card' },
        h('div', { class: 'card-body' },
          section.fields.map((f) => renderVolunteerField(f))))
    );
  }

  main.appendChild(h('p', { class: 'hint', text: t('vol.hintUploads') }));
  main.appendChild(h('p', { class: 'hint', text: t('vol.hintOnce') }));

  renderSrivariSlotSettings(main);
}

/**
 * Sevak selector for the Srivari Seva tab — a Group Leader saves up to
 * MAX_VOLUNTEERS Sevaks and fills the same Add-Sevak form once per member. The
 * editor below always edits the SELECTED Sevak; "Fill this page" fills that one.
 */
function renderSevakBar(main) {
  const list = state.store.volunteers;
  const sel = h('select', { class: 'sevak-select', title: t('vol.pickSevak') },
    list.map((v, i) => h('option', { value: v.id, ...(v.id === state.store.activeVolunteerId ? { selected: true } : {}) },
      volunteerLabel(v, i))));
  sel.value = state.store.activeVolunteerId;
  sel.addEventListener('change', () => { state.store.activeVolunteerId = sel.value; markDirty(); render(); });

  const addBtn = h('button', {
    class: 'ghost-btn', text: t('vol.addSevak'),
    ...(list.length >= MAX_VOLUNTEERS ? { disabled: true, title: t('vol.maxSevaks', { max: MAX_VOLUNTEERS }) } : {}),
    onclick: () => { addVolunteer(state.store); markDirty(); render(); },
  });
  const delBtn = h('button', {
    class: 'ghost-btn danger', text: t('btn.remove'),
    ...(list.length <= 1 ? { disabled: true } : {}),
    onclick: () => { removeVolunteer(state.store, state.store.activeVolunteerId); markDirty(); render(); },
  });

  main.appendChild(h('div', { class: 'sevak-bar' },
    h('span', { class: 'bar-label', text: t('vol.sevakBar', { n: list.length, max: MAX_VOLUNTEERS }) }),
    sel, addBtn, delBtn));
  if (list.length > 1) main.appendChild(h('p', { class: 'hint', text: t('vol.group.hint') }));
}

/**
 * Optional helpers for the Srivari Seva slot-booking page: pre-select a
 * preferred location, highlight Available (green) dates (read-only), and
 * optionally tick the declaration (opt-in, off by default). The date is never
 * auto-picked and the page is never auto-continued.
 */
function renderSrivariSlotSettings(main) {
  const s = state.store.settings.srivariSlot
    || (state.store.settings.srivariSlot = { location: '', highlightAvailable: true, autoDeclaration: false });

  main.appendChild(h('div', { class: 'section-title', text: t('srivari.sec') }));

  const locInput = h('input', {
    type: 'text', value: s.location || '', placeholder: t('srivari.locPlaceholder'), maxlength: 80,
  });
  locInput.addEventListener('input', () => {
    state.store.settings.srivariSlot.location = locInput.value.trim();
    markDirty();
  });

  const highlight = h('input', { type: 'checkbox' });
  highlight.checked = s.highlightAvailable !== false;
  highlight.addEventListener('change', () => {
    state.store.settings.srivariSlot.highlightAvailable = highlight.checked; markDirty();
  });

  const decl = h('input', { type: 'checkbox' });
  decl.checked = !!s.autoDeclaration;
  decl.addEventListener('change', () => {
    state.store.settings.srivariSlot.autoDeclaration = decl.checked; markDirty();
  });

  main.appendChild(
    h('div', { class: 'card' },
      h('div', { class: 'card-body' },
        h('div', { class: 'field' },
          h('label', { text: t('srivari.locLabel') }),
          h('div', { class: 'field-row' }, locInput)),
        h('p', { class: 'hint', text: t('srivari.locHint') }),
        h('label', { class: 'check' }, highlight, h('span', { text: t('srivari.highlight') })),
        h('label', { class: 'check' }, decl, h('span', { text: t('srivari.declaration') })),
        h('p', { class: 'hint', text: t('srivari.declHint') })))
  );
}

function renderVolunteerField(f) {
  const v = volunteer();
  const label = t(`field.${f.key}`);
  const req = VOLUNTEER_REQUIRED.includes(f.key);

  if (f.type === 'file') return renderVolunteerFile(f, label);

  if (f.type === 'checkbox') {
    const box = h('input', { type: 'checkbox' });
    box.checked = v[f.key] === true;
    box.addEventListener('change', () => { v[f.key] = box.checked; markDirty(); });
    return h('div', { class: 'field vol-check' },
      h('label', { class: 'check' }, box, h('span', { text: label })));
  }

  let control;
  if (f.type === 'dropdown' || f.type === 'radio') {
    // gender (radio on the page) is a simple picker in our own popup.
    control = h('select', {},
      h('option', { value: '', text: '—' }),
      f.options.map((o) => h('option', { value: o, text: o })));
    control.value = v[f.key] || '';
    control.addEventListener('change', () => {
      v[f.key] = control.value; markDirty(); renderReadiness();
    });
  } else {
    control = h('input', {
      type: f.type === 'date' ? 'date' : f.type === 'email' ? 'email' : 'text',
      value: f.key === 'idNumber' ? displayId(v.idNumber, v.idType) : (v[f.key] || ''),
      placeholder: label,
      ...(f.maxLength ? { maxlength: f.maxLength } : {}),
    });
    control.addEventListener('input', () => {
      if (f.key === 'idNumber') {
        // Aadhaar → grouped display, digits stored; Passport/PAN → upper-cased.
        v.idNumber = formatIdNumber(control, v.idType);
        markDirty(); renderReadiness(); return;
      }
      let val = control.value;
      if (f.key === 'pincode') val = val.replace(/\D/g, '').slice(0, 6);
      if (control.value !== val) control.value = val;
      v[f.key] = val; markDirty(); renderReadiness();
    });
  }

  return h('div', { class: `field${req ? ' vol-req' : ''}`, 'data-key': f.key },
    h('label', { text: label + (req ? ' *' : '') }),
    h('div', { class: 'field-row' }, control));
}

function renderVolunteerFile(f, label) {
  const v = volunteer();
  const stored = v[f.key];
  const fileInput = h('input', { type: 'file', accept: 'image/png,image/jpeg' });
  fileInput.style.display = 'none';
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    try {
      // TTD caps these at 1 MB and accepts jpg/png only, so downscale to a small
      // JPEG (same helper the pilgrim photo uses).
      v[f.key] = { dataUrl: await downscaleImage(file, 800, 0.85), name: file.name || `${f.key}.jpg`, type: 'image/jpeg' };
      markDirty(); render();
    } catch { setStatus(t('photo.badImage'), 'error'); }
  });
  const thumb = stored
    ? h('img', { class: 'photo-thumb', src: stored.dataUrl, alt: '' })
    : h('div', { class: 'photo-thumb empty' }, f.key === 'photo' ? '🙂' : '📄');
  return h('div', { class: 'field photo-field' },
    h('label', { text: label }),
    h('div', { class: 'photo-row' },
      thumb,
      h('div', { class: 'photo-actions' },
        h('button', { class: 'ghost-btn', text: stored ? t('photo.change') : t('photo.add'), onclick: () => fileInput.click() }),
        stored ? h('button', { class: 'link-btn', text: t('btn.remove'), onclick: () => { v[f.key] = null; markDirty(); render(); } }) : null),
      fileInput));
}

function renderPersonCard(index) {
  const people = profile().people;
  const person = people[index];
  const included = person.include !== false;
  const toggle = h('input', { type: 'checkbox', class: 'incl-toggle' });
  toggle.checked = included;
  toggle.title = t('pilgrim.include');
  toggle.addEventListener('change', () => { person.include = toggle.checked; markDirty(); render(); });
  return h('div', { class: 'card' + (included ? '' : ' excluded') },
    h('div', { class: 'card-head' },
      h('label', { class: 'incl' }, toggle, h('span', { class: 'pilgrim-badge', text: t('lbl.pilgrim', { n: index + 1 }) })),
      h('div', { class: 'row-actions' },
        people.length > 1 ? h('button', {
          class: 'link-btn',
          text: t('btn.remove'),
          onclick: () => { people.splice(index, 1); markDirty(); render(); },
        }) : null
      )
    ),
    h('div', { class: 'card-body' },
      PERSON_FIELDS.map((f) => renderField(personPath(index, f.key), f)),
      renderPassportExpiry(index),
      renderGothram(index),
      renderPhotoField(index))
  );
}

// Flows whose form actually has a Gothram field. Virtual Seva renders a single
// mandatory form-level Gothram (name="pilgrimGothram") on EVERY seva — VERIFIED
// live 2026-11-21. Arjitha does NOT (Gothram there belongs to Srinivasa
// Divyanugraha Homam, not yet a separate flow). Because the live field is one
// per booking (not per pilgrim), the input is shown once, on the first pilgrim.
const GOTHRAM_FLOWS = new Set([FLOWS.VSEVA]);

/** Optional Gothram — shown once (first pilgrim) for the flows that ask for it. */
function renderGothram(index) {
  if (!GOTHRAM_FLOWS.has(state.flow)) return null;
  if (index !== 0) return null; // a SINGLE form-level field per booking
  const person = profile().people[index];
  const input = h('input', { type: 'text', value: person.gothram || '', placeholder: t('field.gothram'), maxlength: '40' });
  input.addEventListener('input', () => { person.gothram = input.value; markDirty(); });
  return h('div', { class: 'field', 'data-key': personPath(index, 'gothram') },
    h('label', { text: t('field.gothram') }),
    h('div', { class: 'field-row' }, input));
}

/**
 * Downscale a chosen image to keep storage small (TTD photos need only be
 * modest), returning a JPEG data URL. A 3 MB phone photo becomes ~40–80 KB.
 */
function downscaleImage(file, maxDim = 600, quality = 0.82) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      let { width, height } = img;
      if (Math.max(width, height) > maxDim) {
        const s = maxDim / Math.max(width, height);
        width = Math.round(width * s); height = Math.round(height * s);
      }
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      canvas.getContext('2d').drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('bad image')); };
    img.src = url;
  });
}

/** Optional per-pilgrim photo (attached on sevas that require an upload). */
function renderPhotoField(index) {
  const person = profile().people[index];
  const photo = person.photo;
  const fileInput = h('input', { type: 'file', accept: 'image/*' });
  fileInput.style.display = 'none';
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    try {
      person.photo = { dataUrl: await downscaleImage(file), name: file.name || 'photo.jpg', type: 'image/jpeg' };
      markDirty(); render();
    } catch { setStatus(t('photo.badImage'), 'error'); }
  });
  const thumb = photo
    ? h('img', { class: 'photo-thumb', src: photo.dataUrl, alt: '' })
    : h('div', { class: 'photo-thumb empty' }, '🙂');
  return h('div', { class: 'field photo-field' },
    h('label', { text: t('photo.label') }),
    h('div', { class: 'photo-row' },
      thumb,
      h('div', { class: 'photo-actions' },
        h('button', { class: 'ghost-btn', text: photo ? t('photo.change') : t('photo.add'), onclick: () => fileInput.click() }),
        photo ? h('button', { class: 'link-btn', text: t('btn.remove'), onclick: () => { delete person.photo; markDirty(); render(); } }) : null),
      fileInput));
}

function renderField(fieldKey, spec) {
  const value = readPath(profile(), fieldKey);
  // Show the mapping control only when explicitly revealed, or when this
  // specific field failed to fill — then it is the fix, not clutter.
  const isProblem = state.problemFields.has(fieldKey);
  const isInvalid = state.invalidFields.has(fieldKey);
  const showButton = state.showMapping || isProblem;
  return h('div', {
    class: `field${isProblem ? ' problem' : ''}${isInvalid ? ' invalid' : ''}`,
    'data-key': fieldKey,
  },
    h('label', { text: fieldLabel(spec) }),
    h('div', { class: 'field-row' },
      buildControl(fieldKey, spec, value),
      showButton ? mapButton(fieldKey, spec) : null)
  );
}

/** How an ID number should be DISPLAYED in the popup: Aadhaar grouped as
 *  "9999 9999 9999" for readability, everything else as-is. */
function displayId(value, idType) {
  if (/aadhaar|aadhar/i.test(idType || '')) {
    const digits = (String(value || '').match(/\d/g) || []).join('').slice(0, 12);
    return digits.replace(/(\d{4})(?=\d)/g, '$1 ');
  }
  return value || '';
}

/**
 * Reformat an ID-number input as the user types and return the value to STORE.
 * Aadhaar: strip to digits (max 12) and show grouped "9999 9999 9999" — but only
 * the 12 digits are stored/filled, so a numeric TTD field never receives spaces.
 * Passport/PAN: upper-case. Caret is preserved by counting digits.
 */
function formatIdNumber(inputEl, idType) {
  const raw = inputEl.value;
  if (/aadhaar|aadhar/i.test(idType || '')) {
    const caret = inputEl.selectionStart ?? raw.length;
    const digitsBeforeCaret = (raw.slice(0, caret).match(/\d/g) || []).length;
    const digits = (raw.match(/\d/g) || []).join('').slice(0, 12);
    const grouped = digits.replace(/(\d{4})(?=\d)/g, '$1 ');
    if (inputEl.value !== grouped) {
      inputEl.value = grouped;
      let pos = 0, seen = 0;
      while (pos < grouped.length && seen < digitsBeforeCaret) { if (/\d/.test(grouped[pos])) seen++; pos++; }
      try { inputEl.setSelectionRange(pos, pos); } catch { /* */ }
    }
    return digits; // store digits only
  }
  const up = raw.toUpperCase();
  if (inputEl.value !== up) {
    const pos = inputEl.selectionStart;
    inputEl.value = up;
    try { inputEl.setSelectionRange(pos, pos); } catch { /* */ }
  }
  return up;
}

function buildControl(fieldKey, spec, value) {
  // 'dropdown' is a readOnly custom widget on the page, but in our own popup
  // it is just a picker — render it as a plain <select>.
  if ((spec.type === 'select' || spec.type === 'dropdown') && spec.options) {
    const sel = h('select', {},
      h('option', { value: '', text: '—' }),
      spec.options.map((o) => h('option', { value: o, text: o }))
    );
    sel.value = value || '';
    sel.addEventListener('change', () => {
      writePath(profile(), fieldKey, sel.value);
      markDirty();
      renderReadiness();
      applyInvalidMarks(); // ID-type change can make a number valid/invalid
    });
    return sel;
  }

  const isIdNum = fieldKey.endsWith('.idNumber');
  const idTypeNow = isIdNum ? String(readPath(profile(), fieldKey.replace(/idNumber$/, 'idType')) || '') : '';
  const input = h('input', {
    type: spec.type === 'number' ? 'number'
      : spec.type === 'tel' ? 'tel'
      : spec.type === 'email' ? 'email' : 'text',
    // Show a saved Aadhaar grouped for readability; other fields as-is.
    value: isIdNum ? displayId(value, idTypeNow) : (value || ''),
    placeholder: spec.label,
    ...(spec.maxLength ? { maxlength: spec.maxLength } : {}),
  });
  input.addEventListener('input', () => {
    let toStore = input.value;
    // Aadhaar → grouped display + digits stored; Passport/PAN → upper-cased.
    if (isIdNum) {
      const idType = String(readPath(profile(), fieldKey.replace(/idNumber$/, 'idType')) || '');
      toStore = formatIdNumber(input, idType);
    }
    writePath(profile(), fieldKey, toStore);
    markDirty();
    renderReadiness();   // keep the banner honest as you type
    applyInvalidMarks(); // and clear/raise the red outline live
  });
  return input;
}

/** Optional passport-expiry date — shown only when the ID type is Passport. */
function renderPassportExpiry(index) {
  const person = profile().people[index];
  if (!/passport/i.test(String(person.idType || ''))) return null;
  const key = personPath(index, 'passportExpiry');
  const input = h('input', { type: 'date', value: person.passportExpiry || '' });
  input.addEventListener('change', () => {
    person.passportExpiry = input.value; markDirty(); renderReadiness(); applyInvalidMarks();
  });
  return h('div', { class: `field${state.invalidFields.has(key) ? ' invalid' : ''}`, 'data-key': key },
    h('label', { text: t('field.passportExpiry') }),
    h('div', { class: 'field-row' }, input));
}

// ------------------------------------------------------------------- mapping

/**
 * Three states: unmapped, seeded (shipped selector, verified against the live
 * portal), and picked (the user mapped it themselves — always wins).
 */
function mapButton(fieldKey, spec) {
  const picked = !!state.userMappings[state.flow]?.[fieldKey];
  const seeded = !picked && fieldKey in buildSeeds(state.flow, MAX_PILGRIMS);
  const btn = h('button', {
    class: `map-btn${picked ? ' mapped' : seeded ? ' seeded' : ''}`,
    title: picked ? 'Mapped by you — click to re-map, shift-click to clear'
      : seeded ? 'Using a built-in selector verified against the live portal. Click to override.'
      : 'Click, then click this field on the TTD page',
    text: picked ? '✓ map' : seeded ? '◆ auto' : 'map',
  });
  btn.addEventListener('click', async (e) => {
    if (e.shiftKey && picked) {
      await deleteMapping(state.flow, fieldKey);
      await refreshMappings();
      render();
      return;
    }
    await startPicking(fieldKey, spec.label);
  });
  return btn;
}

async function refreshMappings() {
  state.mappings = await getMappings();
  state.userMappings = await getUserMappings();
}

async function startPicking(fieldKey, fieldLabel) {
  const tab = await getTargetTab();
  if (!tab) return;
  if (!(await ensureContentScript(tab.id))) return;
  await api.storage.local.set({ pickContext: { flow: state.flow, fieldKey } });
  try {
    await api.tabs.sendMessage(tab.id, { type: 'START_PICKER', fieldKey, fieldLabel });
    await api.tabs.update(tab.id, { active: true });
    window.close(); // get out of the way so the user can click the page
  } catch {
    setStatus('Could not reach the TTD page. Reload it, then try again.', 'error');
  }
}

/** Apply a pick that landed while the popup was closed. */
async function consumePendingPick() {
  const { pendingPick, pickContext } = await api.storage.local.get(['pendingPick', 'pickContext']);
  if (!pendingPick || !pickContext) return;
  await saveMapping(pickContext.flow, pickContext.fieldKey, pendingPick.descriptor);
  await api.storage.local.remove(['pendingPick', 'pickContext']);
  api.runtime.sendMessage({ type: 'CLEAR_BADGE' });
  await refreshMappings();
  state.flow = pickContext.flow;
  const spec = fieldSpecForKey(pickContext.fieldKey);
  setStatus(`Mapped "${spec.label}" → ${pendingPick.preview?.name || pendingPick.preview?.label || pendingPick.preview?.tag}`);
}

// ---------------------------------------------------------------------- fill

async function getTargetTab() {
  const [active] = await api.tabs.query({ active: true, currentWindow: true });
  if (active && TTD_HOSTS.test(active.url || '')) return active;

  const all = await api.tabs.query({});
  const ttdTab = all.find((t) => TTD_HOSTS.test(t.url || ''));
  if (ttdTab) return ttdTab;

  setStatus('Open a TTD booking page in another tab first.', 'error');
  return null;
}

// MUST match content_scripts[0].js in the manifest, in the same order.
const CONTENT_SCRIPTS = [
  'src/common/api.js',
  'src/common/schema.js',
  'src/common/seed-mappings.js',
  'src/common/i18n.js',
  'src/content/engine.js',
  'src/content/picker.js',
  'src/content/content.js',
];

/**
 * Guarantee a listener exists in the tab before messaging it.
 *
 * Reloading the extension (chrome://extensions ↻) orphans the content scripts
 * in tabs that were already open: the old script is disconnected and the new
 * one is never auto-injected. The page looks fine but nothing is listening, so
 * every message fails with "Receiving end does not exist" — which surfaced as
 * a spurious "reload the TTD page" error mid-booking.
 *
 * PING first, and only inject when there is no answer — re-running the files
 * over a live script would redeclare its top-level consts and throw.
 */
async function ensureContentScript(tabId) {
  try {
    const res = await api.tabs.sendMessage(tabId, { type: 'PING' });
    if (res?.ok) return true;
  } catch { /* nothing listening — fall through and inject */ }

  try {
    await api.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: CONTENT_SCRIPTS,
    });
    await api.scripting.insertCSS({
      target: { tabId, allFrames: true },
      files: ['src/content/overlay.css'],
    });
    return true;
  } catch {
    // Injection can fail because a script is in fact already running (its
    // top-level consts would be redeclared). Ask the page directly rather
    // than trusting the error.
    try {
      const res = await api.tabs.sendMessage(tabId, { type: 'PING' });
      if (res?.ok) return true;
    } catch { /* genuinely unreachable */ }
    setStatus('Could not attach to this page. Reload the TTD tab, then try again.', 'error');
    return false;
  }
}

function buildPlan(flow) {
  const flowMappings = state.mappings[flow] || {};
  const p = profile();
  const plan = [];

  for (const [fieldKey, descriptor] of Object.entries(flowMappings)) {
    const spec = fieldSpecForKey(fieldKey);
    let value = readPath(p, fieldKey);

    // A blank per-pilgrim contact field falls back to the shared block.
    if (
      state.store.settings.propagateAddress &&
      (value === '' || value == null) &&
      CONTACT_KEYS.has(spec.key) &&
      fieldKey.startsWith('people.')
    ) {
      value = readPath(p, contactPath(spec.key));
    }

    plan.push({ fieldKey, descriptor, value, type: spec.type });
  }

  // Ordering is the engine's job — dropdowns first (the portal truncates an ID
  // number typed before its ID type is set), files last.
  return plan;
}

async function fillPage() {
  const tab = await getTargetTab();
  if (!tab) return;
  if (!(await ensureContentScript(tab.id))) return;

  // The virtual queue has no form on it at all. Filling would report
  // "0 of 12 fields", which reads like a failure rather than "not yet".
  try {
    const page = await api.tabs.sendMessage(tab.id, { type: 'PING' });
    if (page?.inQueue) {
      setStatus(t('status.inQueue'));
      return;
    }
  } catch { /* fall through and try the fill anyway */ }

  // Srivari Seva volunteer profile: a single flat record, never auto-advanced.
  const isVolunteer = state.flow === FLOWS.SRIVARI;
  const plan = (isVolunteer
    ? buildVolunteerPlan(activeVolunteer(state.store), state.mappings)
    : buildPlan(state.flow)
  ).filter((p) => p.value !== '' && p.value != null);
  if (!plan.length) {
    setStatus(t('status.nothingToFill'), 'error');
    return;
  }

  try {
    const res = await api.tabs.sendMessage(tab.id, {
      type: 'RUN_PLAN',
      plan,
      delay: fillDelayForFlow(state.flow, state.store.settings.fillDelayMs),
      autoContinue: !isVolunteer && state.store.settings.autoContinue && !NO_AUTOCONTINUE_FLOWS.has(state.flow),
      rowCheck: isVolunteer ? null : rowCheckSpec(state.flow),
      reactFill: state.store.settings.reactFill !== false,
    });
    if (!res?.ok) throw new Error(res?.error || 'no response');

    // Blocked portal: React autofill filled everything it could.
    if (res.react === 'react-all') { setStatus(t('paste.reactAll')); return; }
    if (res.react === 'react-partial') { setStatus(t('paste.reactPartial')); return; }
    // Otherwise the content script switched the page into Paste-Helper mode.
    if (res.paste) { setStatus(t('paste.active')); return; }
    // Locked (defence in depth — the early check above normally catches it).
    if (res.locked) { setStatus(t('license.locked'), 'error'); return; }

    const filled = res.results.filter((r) => r.ok).length;
    const notFound = res.results.filter((r) => r.reason === 'not-found');
    // Fields that WERE found but would not accept the value. These matter more
    // than missing ones — a dropdown that refuses its option leaves a required
    // field blank on a page that otherwise looks filled.
    //
    // Excluded, because none of these are the user's problem to fix:
    //   not-found — absent from this page (SPAT has no General Details block)
    //   empty     — nothing stored for it
    //   readonly  — the portal locked it, e.g. email prefilled from the account
    //   disabled  — likewise
    const NOT_A_PROBLEM = new Set(['not-found', 'empty', 'readonly', 'disabled', 'already-set']);
    const refused = res.results.filter((r) => !r.ok && !NOT_A_PROBLEM.has(r.reason));
    const locked = res.results.filter((r) => r.reason === 'readonly' || r.reason === 'disabled');
    // Filled, but via a label/placeholder fallback instead of the field's own
    // name — a sign TTD changed the form. Not a failure, but worth a look.
    const loose = res.results.filter((r) => r.ok && r.loose);

    // Any field that resolved but refused its value is a mapping problem —
    // reveal its button so the fix is one click away, without turning the
    // other 34 back on. Fields simply absent from this page are not problems:
    // SPAT has no General Details block at all.
    state.problemFields = new Set(refused.map((r) => r.fieldKey));
    if (refused.length) render();

    const describeList = (list, n = 4) => list.map((r) => describeField(r.fieldKey)).slice(0, n).join(', ');

    const fillName = isVolunteer ? (activeVolunteer(state.store)?.sevakName || t('vol.sevak')) : profile().name;
    let msg = t('status.filled', { filled, total: plan.length, name: fillName });
    if (refused.length) msg += t('status.check', { list: describeList(refused) });
    if (loose.length) msg += t('status.loose', { list: describeList(loose) });
    if (locked.length) msg += t('status.locked', { list: describeList(locked, locked.length) });
    if (notFound.length) msg += t('status.notOnPage', { n: notFound.length });

    // A ticket/pilgrim mismatch is the most actionable thing we can report, so
    // it wins the status line outright.
    const advance = res.advance;
    if (advance?.reason === 'incomplete') {
      const list = advance.incomplete.map((i) => t('lbl.pilgrim', { n: i.row })).join(', ');
      const isare = advance.incomplete.length === 1 ? t('word.is') : t('word.are');
      setStatus(t('status.incomplete', {
        rows: advance.rows, list, isare,
        need: advance.incomplete.length, name: profile().name,
      }), 'error');
      return;
    }

    if (advance?.clicked) msg += t('status.continuing');
    else if (advance?.reason === 'no-continue-button') msg += t('status.noContinueBtn');

    setStatus(msg, refused.length || notFound.length === plan.length ? 'error' : 'info');
  } catch {
    setStatus(t('status.cantReach'), 'error');
  }
}

/**
 * B3 — "Test this page". Ask the content script whether this flow's fields
 * still resolve on the current TTD form, and report any that don't — so a TTD
 * form change is caught before release day, not during it.
 */
async function healthCheck() {
  const tab = await getTargetTab();
  if (!tab) return;
  if (!(await ensureContentScript(tab.id))) return;
  try {
    const res = await api.tabs.sendMessage(tab.id, { type: 'HEALTH_CHECK', flow: state.flow });
    if (!res?.ok) throw new Error('no response');
    if (!res.missing.length) {
      setStatus(t('health.ok', { n: res.total }));
    } else {
      const list = res.missing.map((k) => describeField(k)).slice(0, 6).join(', ');
      setStatus(t('health.changed', { missing: res.missing.length, total: res.total, list }), 'error');
    }
  } catch {
    setStatus(t('status.cantReach'), 'error');
  }
}

/**
 * "Report a field problem" — capture the current TTD form's STRUCTURE (never any
 * typed values; see content.js CAPTURE_FIELDS) and copy a compact report to the
 * clipboard so the user can send it to us. This is how field drift on the live
 * portal gets flagged quickly, by anyone, without pasting anything by hand.
 */
async function reportFields() {
  const tab = await getTargetTab();
  if (!tab) return;
  if (!(await ensureContentScript(tab.id))) return;
  try {
    const res = await api.tabs.sendMessage(tab.id, { type: 'CAPTURE_FIELDS' });
    if (!res?.ok) throw new Error('no response');
    const v = api.runtime.getManifest().version;
    const report = [
      `TTD field report — v${v}`,
      `flow: ${res.flow}`,
      `page: ${res.path}`,
      `fields (${res.fields.length}):`,
      ...res.fields.map((f) => {
        const flags = [f.readOnly && 'ro', f.disabled && 'disabled', f.required && 'req', !f.visible && 'hidden']
          .filter(Boolean).join(',');
        const opts = f.options && f.options.length ? ` {${f.options.filter(Boolean).join(' | ')}}` : '';
        const ml = f.maxLength ? ` max${f.maxLength}` : '';
        return `• ${f.name || f.id || '(no name)'} [${f.type}${ml}${flags ? ' ' + flags : ''}]${f.label ? ' — ' + f.label : ''}${opts}`;
      }),
      '',
      '(Field structure only — no personal data.)',
    ].join('\n');
    try {
      await navigator.clipboard.writeText(report);
      setStatus(t('report.copied'));
    } catch {
      setStatus(t('report.copyFail'), 'error');
    }
  } catch {
    setStatus(t('status.cantReach'), 'error');
  }
}

// ----------------------------------------------------- booking stats (v1.4)
// Reads the local, opt-in booking log and shows the user their own stats plus
// a live session timer and (if the page exposes it) a server-synced countdown.
// Never transmits anything; a Share button just copies text for the USER to post.

let statsTick = null;

/** Live IST clock (HH:MM:SS) in the header — a steady time reference while the
 *  popup is open. Uses the device clock rendered in the Asia/Kolkata zone, so it
 *  reads IST wherever the user is (accurate only if their device clock is). */
function startISTClock() {
  const el = $('istClock');
  if (!el) return;
  const tick = () => {
    try { el.textContent = 'IST ' + new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour12: false }); }
    catch { el.textContent = ''; }
  };
  tick();
  setInterval(tick, 1000);
}

const fmtClock = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
const fmtDur = (ms) => {
  if (ms == null) return '—';
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};
function computeStats(events) {
  const attempts = events.length;
  const succ = events.filter((e) => e.kind === 'success');
  const rate = attempts ? Math.round((succ.length / attempts) * 100) : 0;
  const tries = succ.map((e) => e.tries).filter((n) => n > 0);
  const avg = tries.length ? tries.reduce((a, b) => a + b, 0) / tries.length : null;
  const durs = succ.map((e) => e.durationMs).filter((n) => n > 0);
  const fastest = durs.length ? Math.min(...durs) : null;
  return { attempts, successes: succ.length, rate, avg, fastest };
}

async function openStats() { await renderStats(); $('stats').hidden = false; }
function closeStats() {
  $('stats').hidden = true;
  if (statsTick) { clearInterval(statsTick); statsTick = null; }
}

async function shareStats(s) {
  const text = t('stats.shareText', { rate: s.attempts ? s.rate : 0, n: s.successes });
  try { await navigator.clipboard.writeText(text); setStatus(t('stats.shared')); }
  catch { setStatus(text); }
}

async function renderStats() {
  const body = $('statsBody');
  $('statsTitle').textContent = t('stats.title');
  if (statsTick) { clearInterval(statsTick); statsTick = null; }

  if (!state.store.settings.bookingLog) {
    body.replaceChildren(
      h('p', { class: 'stats-intro', text: t('stats.enableDesc') }),
      h('button', {
        class: 'primary-btn', text: t('stats.enable'),
        onclick: async () => { state.store.settings.bookingLog = true; await saveNow(); renderStats(); },
      })
    );
    return;
  }

  const data = await getStats();
  const s = computeStats(data.events);

  // countdown deadline from the active tab (null if the page doesn't show one)
  let cdDeadline = null;
  try {
    const tab = await getTargetTab();
    if (tab) {
      const r = await api.tabs.sendMessage(tab.id, { type: 'GET_COUNTDOWN' });
      if (r?.secondsLeft != null) cdDeadline = Date.now() + r.secondsLeft * 1000;
    }
  } catch { /* not on a countdown page */ }

  const sessionStart = data.session ? data.session.startAt : null;
  const sessionTries = data.session ? (data.session.tries || 0) + 1 : null;

  const istEl = h('div', { class: 'st-ist' });
  const timerEl = h('div', { class: 'st-timer' });
  const cdEl = cdDeadline != null ? h('div', { class: 'st-cd' }) : null;
  const cell = (n, l, cls) => h('div', { class: 'st-cell' },
    h('div', { class: `st-n${cls ? ' ' + cls : ''}`, text: n }), h('div', { class: 'st-l', text: l }));

  const recent = data.events.slice(-8).reverse().map((e) => {
    const cls = e.kind === 'success' ? 'g' : (/gateway|session/.test(e.outcome) ? 'r' : 'a');
    const label = e.kind === 'success' ? t('stats.booked') : t(`verdict.${e.outcome}.head`);
    return h('div', { class: 'st-row' },
      h('span', { class: `st-dot ${cls}` }),
      h('span', { class: 'st-out', text: label }),
      h('span', { class: 'st-when', text: new Date(e.at).toLocaleDateString() }));
  });

  const countdownToggle = h('input', { type: 'checkbox' });
  countdownToggle.checked = state.store.settings.pageCountdown;
  countdownToggle.addEventListener('change', async () => {
    state.store.settings.pageCountdown = countdownToggle.checked; await saveNow(); renderStats();
  });

  const alertToggle = h('input', { type: 'checkbox' });
  alertToggle.checked = state.store.settings.releaseAlert !== false;
  alertToggle.addEventListener('change', async () => {
    state.store.settings.releaseAlert = alertToggle.checked; await saveNow();
  });

  body.replaceChildren(
    istEl,
    timerEl,
    ...(cdEl ? [cdEl] : []),
    h('div', { class: 'st-grid' },
      cell(String(s.attempts), t('stats.total')),
      cell(s.attempts ? s.rate + '%' : '—', t('stats.rate'), 'ok'),
      cell(s.avg != null ? s.avg.toFixed(1) : '—', t('stats.avgTries')),
      cell(fmtDur(s.fastest), t('stats.fastest'))),
    h('div', { class: 'st-recent-h', text: t('stats.recent') }),
    recent.length ? h('div', { class: 'st-recent' }, ...recent)
      : h('p', { class: 'stats-intro', text: t('stats.empty') }),
    h('button', { class: 'primary-btn st-mark', text: t('stats.markBooked'),
      onclick: async () => {
        const r = await markBooked(state.flow);
        setStatus(r.added ? t('stats.marked') : t('stats.alreadyBooked'));
        renderStats();
      } }),
    h('div', { class: 'st-actions' },
      h('button', { class: 'ghost-btn', text: t('stats.share'), onclick: () => shareStats(s) }),
      h('button', { class: 'ghost-btn danger', text: t('stats.clear'),
        onclick: async () => { await clearStats(); renderStats(); } })),
    h('label', { class: 'check st-toggle' }, countdownToggle, h('span', { text: t('stats.pageCountdown') })),
    state.store.settings.pageCountdown
      ? h('label', { class: 'check st-toggle' }, alertToggle, h('span', { text: t('stats.releaseAlert') }))
      : null,
    h('button', { class: 'link-btn', text: t('stats.disable'),
      onclick: async () => { state.store.settings.bookingLog = false; await saveNow(); renderStats(); } })
  );

  const paint = () => {
    try { istEl.textContent = '🕐 IST ' + new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour12: false }); }
    catch { istEl.textContent = ''; }
    timerEl.textContent = sessionStart
      ? `${t('stats.session')} · ${fmtClock(Date.now() - sessionStart)} · ${t('stats.try', { n: sessionTries })}`
      : t('stats.noSession');
    if (cdEl) {
      const left = cdDeadline - Date.now();
      cdEl.textContent = '🛕 ' + (left <= 0 ? t('countdown.open') : t('countdown.opensIn', { t: fmtClock(left) }));
      cdEl.classList.toggle('open', left <= 0);
    }
  };
  paint();
  statsTick = setInterval(paint, 1000);
}

// --------------------------------------------------------------------- theme

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === 'auto'
    ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : theme;
}

// ------------------------------------------------------------ import/export

function downloadText(text, name) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

async function doExport() {
  downloadText(await exportAll(), 'ttd-autofill-backup.json');
  setStatus('Backup downloaded — it contains ID numbers, so keep it private.');
}

// ---------------------------------------------------- security (encryption UI)

function updateLockIcon() {
  isEncrypted().then((on) => { const b = $('securityBtn'); if (b) b.textContent = on ? '🔒' : '🔓'; })
    .catch(() => {});
}

/** Full-screen unlock gate. On success the popup reloads and inits normally. */
async function showUnlock() {
  const hint = await vaultHint();
  $('unlockTitle').textContent = t('unlock.title');
  $('unlockDesc').textContent = t('unlock.desc');
  $('unlockBtn').textContent = t('unlock.btn');
  const pass = $('unlockPass');
  const err = $('unlockErr');
  const hintEl = $('unlockHint');
  pass.value = '';
  pass.setAttribute('placeholder', t('sec.pass'));
  if (hint) { hintEl.textContent = t('sec.hintShort') + ': ' + hint; hintEl.hidden = false; }
  else hintEl.hidden = true;
  err.hidden = true;
  $('unlock').hidden = false;
  setTimeout(() => pass.focus(), 50);

  const attempt = async () => {
    if (await unlock(pass.value)) location.reload();
    else { err.textContent = t('unlock.wrong'); err.hidden = false; pass.select(); }
  };
  $('unlockBtn').onclick = attempt;
  pass.onkeydown = (e) => { if (e.key === 'Enter') attempt(); };
}

async function openSecurity() { await renderSecurity(); $('security').hidden = false; }

const passField = (id, ph) =>
  h('input', { type: 'password', id, class: 'sec-input', autocomplete: 'off', spellcheck: 'false', placeholder: ph });
const textField = (id, ph) =>
  h('input', { type: 'text', id, class: 'sec-input', maxlength: '80', placeholder: ph });
function secMsg(text, isErr) {
  const m = $('secMsg'); if (!m) return;
  m.textContent = text; m.classList.toggle('err', !!isErr); m.hidden = false;
}

async function renderSecurity() {
  const body = $('securityBody');
  const on = await isEncrypted();
  $('securityTitle').textContent = t('sec.btn');
  const rows = [h('div', { class: 'sec-state' + (on ? ' on' : ''), text: on ? t('sec.titleOn') : t('sec.titleOff') })];

  if (!on) {
    rows.push(h('p', { class: 'stats-intro', text: t('sec.descOff') }));
    rows.push(h('p', { class: 'sec-warn', text: t('sec.warn') }));
    rows.push(h('button', { class: 'primary-btn sec-block', text: t('sec.enable'), onclick: securityEnableForm }));
  } else {
    rows.push(h('div', { class: 'sec-actions2' },
      h('button', { class: 'ghost-btn', text: t('sec.change'), onclick: securityChangeForm }),
      h('button', { class: 'ghost-btn', text: t('sec.lockNow'), onclick: async () => { await lock(); location.reload(); } })));
    rows.push(h('button', { class: 'ghost-btn danger sec-block', text: t('sec.disable'), onclick: securityDisable }));
  }

  rows.push(h('div', { class: 'sec-divider' }));
  rows.push(h('div', { class: 'sec-sub', text: t('sec.backup') }));
  rows.push(h('div', { class: 'sec-actions2' },
    h('button', { class: 'ghost-btn', text: t('sec.expEnc'), onclick: securityExportForm }),
    h('button', { class: 'ghost-btn', text: t('sec.impEnc'), onclick: securityImportPick })));
  rows.push(h('p', { class: 'sec-msg', id: 'secMsg', hidden: true }));
  body.replaceChildren(...rows);
}

function securityEnableForm() {
  const p1 = passField('secP1', t('sec.pass'));
  const p2 = passField('secP2', t('sec.confirm'));
  const hint = textField('secHint', t('sec.hint'));
  $('securityBody').replaceChildren(
    h('div', { class: 'sec-sub', text: t('sec.enable') }),
    h('p', { class: 'sec-warn', text: t('sec.warn') }),
    p1, p2, hint,
    h('p', { class: 'sec-msg', id: 'secMsg', hidden: true }),
    h('div', { class: 'sec-actions2' },
      h('button', { class: 'primary-btn', text: t('sec.save'), onclick: async () => {
        if (p1.value.length < 8) return secMsg(t('sec.short'), true);
        if (p1.value !== p2.value) return secMsg(t('sec.mismatch'), true);
        await enableEncryption(p1.value, hint.value.trim());
        updateLockIcon(); setStatus(t('sec.enabledOk')); $('security').hidden = true;
      } }),
      h('button', { class: 'ghost-btn', text: t('sec.cancel'), onclick: renderSecurity })));
  setTimeout(() => p1.focus(), 50);
}

function securityChangeForm() {
  const p1 = passField('secC1', t('sec.pass'));
  const p2 = passField('secC2', t('sec.confirm'));
  const hint = textField('secCH', t('sec.hint'));
  $('securityBody').replaceChildren(
    h('div', { class: 'sec-sub', text: t('sec.change') }),
    p1, p2, hint,
    h('p', { class: 'sec-msg', id: 'secMsg', hidden: true }),
    h('div', { class: 'sec-actions2' },
      h('button', { class: 'primary-btn', text: t('sec.save'), onclick: async () => {
        if (p1.value.length < 8) return secMsg(t('sec.short'), true);
        if (p1.value !== p2.value) return secMsg(t('sec.mismatch'), true);
        await changePassphrase(p1.value, hint.value.trim());
        updateLockIcon(); setStatus(t('sec.changedOk')); $('security').hidden = true;
      } }),
      h('button', { class: 'ghost-btn', text: t('sec.cancel'), onclick: renderSecurity })));
  setTimeout(() => p1.focus(), 50);
}

function securityDisable() {
  $('securityBody').replaceChildren(
    h('div', { class: 'sec-sub', text: t('sec.disable') }),
    h('p', { class: 'sec-warn', text: t('sec.disableConfirm') }),
    h('p', { class: 'sec-msg', id: 'secMsg', hidden: true }),
    h('div', { class: 'sec-actions2' },
      h('button', { class: 'ghost-btn danger', text: t('sec.disable'), onclick: async () => {
        try { await disableEncryption(); } catch { return secMsg(t('unlock.wrong'), true); }
        updateLockIcon(); setStatus(t('sec.disabledOk')); location.reload();
      } }),
      h('button', { class: 'ghost-btn', text: t('sec.cancel'), onclick: renderSecurity })));
}

function securityExportForm() {
  const p1 = passField('secE1', t('sec.pass'));
  const p2 = passField('secE2', t('sec.confirm'));
  $('securityBody').replaceChildren(
    h('div', { class: 'sec-sub', text: t('sec.expEnc') }),
    h('p', { class: 'stats-intro', text: t('sec.warn') }),
    p1, p2,
    h('p', { class: 'sec-msg', id: 'secMsg', hidden: true }),
    h('div', { class: 'sec-actions2' },
      h('button', { class: 'primary-btn', text: t('sec.save'), onclick: async () => {
        if (p1.value.length < 8) return secMsg(t('sec.short'), true);
        if (p1.value !== p2.value) return secMsg(t('sec.mismatch'), true);
        let json;
        try { json = await exportEncrypted(p1.value); } catch { return secMsg(t('unlock.wrong'), true); }
        downloadText(json, 'ttv-encrypted-backup.json');
        setStatus(t('sec.exportedOk')); $('security').hidden = true;
      } }),
      h('button', { class: 'ghost-btn', text: t('sec.cancel'), onclick: renderSecurity })));
  setTimeout(() => p1.focus(), 50);
}

function securityImportPick() {
  const inp = h('input', { type: 'file', accept: 'application/json' });
  inp.style.display = 'none';
  document.body.appendChild(inp);
  inp.addEventListener('change', async () => {
    const file = inp.files?.[0]; inp.remove();
    if (file) securityImportForm(await file.text());
  });
  inp.click();
}

function securityImportForm(fileText) {
  const p1 = passField('secI1', t('sec.pass'));
  $('securityBody').replaceChildren(
    h('div', { class: 'sec-sub', text: t('sec.impEnc') }),
    p1,
    h('p', { class: 'sec-msg', id: 'secMsg', hidden: true }),
    h('div', { class: 'sec-actions2' },
      h('button', { class: 'primary-btn', text: t('sec.save'), onclick: async () => {
        try { await importEncrypted(fileText, p1.value); }
        catch { return secMsg(t('sec.wrongFile'), true); }
        setStatus(t('sec.importedOk')); location.reload();
      } }),
      h('button', { class: 'ghost-btn', text: t('sec.cancel'), onclick: renderSecurity })));
  setTimeout(() => p1.focus(), 50);
}

// -------------------------------------------------- preflight checklist + print

function openPreflight() { renderPreflight(); $('preflight').hidden = false; }
function closePreflight() { $('preflight').hidden = true; }

/** One checklist line. state: true=ok ✓, false=bad ✗, 'warn'=⚠, 'info'=○ (advisory). */
function pfRow(label, state) {
  const mark = state === true ? '✓' : state === 'warn' ? '⚠' : state === 'info' ? '○' : '✗';
  const cls = state === true ? 'ok' : state === 'warn' ? 'warn' : state === 'info' ? 'info' : 'bad';
  return h('div', { class: 'pf-row ' + cls }, h('span', { class: 'pf-mark' }, mark), h('span', { text: label }));
}

function renderPreflight() {
  const body = $('preflightBody');
  $('preflightTitle').textContent = t('preflight.title');
  const p = profile();
  const r = readiness();
  const rows = [];
  const issues = r.blocking.length + r.invalid.length + r.duplicates.length + (r.noneChosen ? 1 : 0);
  rows.push(h('div', { class: 'pf-status ' + (r.ok ? 'ok' : 'bad'),
    text: r.ok ? t('preflight.ready', { n: r.count }) : t('preflight.issues', { n: issues }) }));

  const chosen = p.people.map((person, i) => ({ person, i })).filter((x) => x.person.include !== false);
  if (!chosen.length) rows.push(pfRow(t('ready.noneChosen'), false));

  for (const { person, i } of chosen) {
    rows.push(h('div', { class: 'pf-group', text: t('lbl.pilgrim', { n: i + 1 }) + (person.name ? ' · ' + person.name : '') }));
    const probs = validatePerson(person);
    for (const f of PERSON_FIELDS) {
      rows.push(pfRow(t('field.' + f.key), String(person[f.key] ?? '').trim().length > 0));
    }
    if (person.idNumber) rows.push(pfRow(t('preflight.idValid'), !probs.some((x) => x.key === 'idNumber')));
    if (/passport/i.test(String(person.idType || '')) && person.passportExpiry) {
      rows.push(pfRow(t('field.passportExpiry'), !probs.some((x) => x.key === 'passportExpiry')));
    }
    rows.push(pfRow(t('photo.label'), person.photo ? true : 'info'));
  }

  rows.push(h('div', { class: 'pf-group', text: t('preflight.overall') }));
  rows.push(pfRow(t('preflight.noDupes'), r.duplicates.length === 0));
  rows.push(pfRow(t('preflight.contactBlock'), r.advisory.length === 0 ? true : 'warn'));

  rows.push(h('div', { class: 'st-actions' },
    h('button', { class: 'primary-btn', text: t('preflight.print'), onclick: printSummary }),
    h('button', { class: 'ghost-btn', text: t('sec.cancel'), onclick: closePreflight })));
  body.replaceChildren(...rows);
}

/** Hand the summary to the print page via session storage (never to disk). */
async function printSummary() {
  const p = profile();
  const people = p.people.filter((x) => x.include !== false)
    .map((pr) => ({ name: pr.name, age: pr.age, gender: pr.gender, idType: pr.idType, idNumber: pr.idNumber, passportExpiry: pr.passportExpiry || '' }));
  const data = { profileName: p.name, contact: p.contact, people, anyExpiry: people.some((x) => x.passportExpiry) };
  try {
    await api.storage.session.set({ printData: data });
    await api.tabs.create({ url: api.runtime.getURL('src/popup/print.html') });
  } catch {
    setStatus(t('preflight.printFail'), 'error');
  }
}

// -------------------------------------------------- per-seva templates

/** Apply the remembered pilgrim selection for a flow (if one was saved). */
function applySevaSelection(flow) {
  const sel = state.store.settings.sevaSelection?.[flow];
  if (!Array.isArray(sel)) return; // no template for this seva → leave as-is
  profile().people.forEach((person, i) => { person.include = sel.includes(i); });
}

/** Remember the current selection as this flow's template. */
function saveSevaSelection(flow) {
  const sel = profile().people
    .map((person, i) => ({ person, i })).filter((x) => x.person.include !== false).map((x) => x.i);
  state.store.settings.sevaSelection = state.store.settings.sevaSelection || {};
  state.store.settings.sevaSelection[flow] = sel;
  markDirty();
  setStatus(t('seva.saved', { seva: FLOW_LABELS[flow] }));
}

// -------------------------------------------------- rate-us nudge (ranking)

/**
 * One-time, respectful "rate us" prompt — shown only after the extension has
 * actually been useful (>= 2 fills) and never again once acted on. Ratings are
 * the biggest lever on store ranking. Uses only a local fill count (a plain
 * number, never transmitted).
 */
// The rate nudge appears a few seconds AFTER the popup opens, not instantly —
// so it never lands on top of what the user came to do; it slides in once they
// have settled. If they close the popup first, it simply never shows this time.
const RATE_NUDGE_DELAY_MS = 5000;

async function maybeShowRateNudge() {
  if (state.store.settings.ratePrompted) return;
  let fills = 0;
  try { fills = (await api.storage.local.get('usage')).usage?.fills || 0; } catch { /* */ }
  if (fills < 2) return;

  setTimeout(() => {
    if (state.store.settings.ratePrompted) return; // dismissed elsewhere meanwhile
    $('rateMsg').textContent = t('rate.msg');
    $('rateNow').textContent = t('rate.now');
    $('rateLater').textContent = t('rate.later');
    $('rateBar').hidden = false;
    $('rateBar').classList.add('rate-in'); // gentle fade/slide in

    const dismiss = async () => { state.store.settings.ratePrompted = true; await saveNow(); $('rateBar').hidden = true; };
    $('rateNow').onclick = async () => {
      const isFF = (typeof IS_FIREFOX !== 'undefined' && IS_FIREFOX) || /firefox/i.test(navigator.userAgent);
      // The Chrome Web Store parses /detail/<slug>/<id>; without the slug segment
      // it reads the id AS the slug and 404s — so the slug must be included.
      const url = isFF
        ? 'https://addons.mozilla.org/en-US/firefox/addon/kollis-tirumala-booking-helper/reviews/'
        : 'https://chromewebstore.google.com/detail/kollis-tirumala-booking-helper/gbnefkodchpakicbhgkcgnfiaimcenkh/reviews';
      try { await api.tabs.create({ url }); } catch { window.open(url, '_blank'); }
      await dismiss();
    };
    $('rateLater').onclick = dismiss; // ask exactly once — no nagging
  }, RATE_NUDGE_DELAY_MS);
}

/**
 * "Did this page fill correctly?" — shown once per fill, only about a FRESH fill
 * (last ~30 min) so stale ones never nag. 👍 thanks and dismisses; 👎 opens the
 * field report so the user can send us the form's structure (no personal data),
 * which is how we learn which flows misbehave in the wild. Returns true if shown.
 */
async function maybeShowFillNudge() {
  if (!$('fillNudge')) return false; // not in this DOM (e.g. test harness)
  let last;
  try { last = (await api.storage.local.get('ttvLastFill')).ttvLastFill; } catch { return false; }
  if (!last || last.rated || !last.ts) return false;
  if (Date.now() - last.ts > 30 * 60 * 1000) return false; // only a just-happened fill

  const flowName = FLOW_LABELS[last.flow] || 'TTD';
  const missed = (last.total || 0) - (last.filled || 0);
  $('fillNudgeMsg').textContent = missed > 0
    ? t('nudge.fillMissed', { flow: flowName, n: missed })
    : t('nudge.fill', { flow: flowName });
  $('fillNudgeYes').textContent = t('nudge.yes');
  $('fillNudgeNo').textContent = t('nudge.no');
  $('fillNudge').hidden = false;
  $('fillNudge').classList.add('rate-in');

  const close = async () => {
    try { await api.storage.local.set({ ttvLastFill: { ...last, rated: true } }); } catch { /* */ }
    $('fillNudge').hidden = true;
  };
  $('fillNudgeYes').onclick = async () => { await close(); setStatus(t('nudge.thanks')); };
  $('fillNudgeNo').onclick = async () => { await close(); reportFields(); };
  return true;
}

// ---------------------------------------------------------------------- init

async function init() {
  // At-rest encryption gate: if the vault is locked, show ONLY the unlock
  // screen. Nothing below runs until the user unlocks (which reloads the popup).
  if (await isEncrypted() && !(await isUnlocked())) {
    await showUnlock();
    return;
  }

  state.store = await getStore();
  await saveStore(state.store); // persist any migration immediately
  await refreshMappings();
  await consumePendingPick();

  // Language must be set before the first render so every built string picks
  // it up. Static HTML strings are translated separately, once.
  setLang(state.store.settings.language || 'en');
  applyStaticI18n();
  renderLangSelect();
  $('langSelect').addEventListener('change', (e) => {
    state.store.settings.language = setLang(e.target.value);
    markDirty();
    applyStaticI18n();
    render();
  });

  if (state.store.settings.autoDetectFlow) {
    const [active] = await api.tabs.query({ active: true, currentWindow: true });
    const detected = flowFromUrl(active?.url || '');
    if (detected) state.flow = detected;
  }

  applyTheme(state.store.settings.theme);

  $('propagateAddress').checked = state.store.settings.propagateAddress;
  $('propagateAddress').addEventListener('change', (e) => {
    state.store.settings.propagateAddress = e.target.checked;
    markDirty();
  });

  $('autoContinue').checked = state.store.settings.autoContinue;
  $('autoContinue').addEventListener('change', (e) => {
    state.store.settings.autoContinue = e.target.checked;
    syncAssistToggle();
    markDirty();
  });

  // "Assist my whole booking" — one switch that drives the three sub-settings
  // (auto-fill-on-load + auto-continue + floating button). It never enables
  // anything that could touch payment; those flows have no such code.
  $('assistMode').checked = !!state.store.settings.assistMode;
  $('assistMode').addEventListener('change', (e) => {
    const on = e.target.checked;
    state.store.settings.assistMode = on;
    state.store.settings.autoFillOnLoad = on;
    state.store.settings.autoContinue = on ? true : state.store.settings.autoContinue;
    state.store.settings.floatingButton = on;
    // Reflect the change in the individual toggles without a full re-render.
    $('autoFillOnLoad').checked = state.store.settings.autoFillOnLoad;
    $('autoContinue').checked = state.store.settings.autoContinue;
    $('floatingButton').checked = state.store.settings.floatingButton;
    markDirty();
  });

  $('autoFillOnLoad').checked = state.store.settings.autoFillOnLoad;
  $('autoFillOnLoad').addEventListener('change', (e) => {
    state.store.settings.autoFillOnLoad = e.target.checked;
    syncAssistToggle();
    markDirty();
  });

  $('floatingButton').checked = state.store.settings.floatingButton;
  $('floatingButton').addEventListener('change', (e) => {
    state.store.settings.floatingButton = e.target.checked;
    syncAssistToggle();
    markDirty();
  });

  $('captchaFocus').checked = state.store.settings.captchaFocus !== false;
  $('captchaFocus').addEventListener('change', (e) => {
    state.store.settings.captchaFocus = e.target.checked;
    markDirty();
  });

  $('logoutWarn').checked = state.store.settings.logoutWarn !== false;
  $('logoutWarn').addEventListener('change', (e) => {
    state.store.settings.logoutWarn = e.target.checked;
    markDirty();
  });

  $('reactFill').checked = state.store.settings.reactFill !== false;
  $('reactFill').addEventListener('change', (e) => {
    state.store.settings.reactFill = e.target.checked;
    markDirty();
  });

  // Slot add-ons (opt-in, PAID). The master toggle reveals the amount inputs;
  // amounts are digits-only and validated, and are only written to settings
  // when valid so a malformed value can never reach the slot page.
  const slotAddOns = state.store.settings.slotAddOns
    || (state.store.settings.slotAddOns = { enabled: false, laddus: '', hundi: '' });
  const slotPanel = $('slotAddOnsPanel');
  const slotErr = $('slotAddOnsErr');
  const syncSlotPanel = () => { slotPanel.hidden = !$('slotAddOns').checked; };
  const validateSlotInputs = () => {
    const issues = validateSlotAddOns({ laddus: $('slotLaddus').value, hundi: $('slotHundi').value });
    if (issues.length) {
      slotErr.textContent = issues.map((i) => t('slot.' + i.code)).join(' ');
      slotErr.hidden = false;
    } else {
      slotErr.hidden = true;
    }
    return issues.length === 0;
  };
  $('slotAddOns').checked = !!slotAddOns.enabled;
  $('slotLaddus').value = slotAddOns.laddus || '';
  $('slotHundi').value = slotAddOns.hundi || '';
  syncSlotPanel();
  $('slotAddOns').addEventListener('change', (e) => {
    state.store.settings.slotAddOns = { ...state.store.settings.slotAddOns, enabled: e.target.checked };
    syncSlotPanel();
    markDirty();
  });
  const onSlotAmount = () => {
    // Keep only digits, and respect each field's live maxlength (laddus 2, hundi 7).
    $('slotLaddus').value = $('slotLaddus').value.replace(/\D/g, '').slice(0, 2);
    $('slotHundi').value = $('slotHundi').value.replace(/\D/g, '').slice(0, 7);
    if (validateSlotInputs()) {
      state.store.settings.slotAddOns = {
        ...state.store.settings.slotAddOns,
        laddus: $('slotLaddus').value,
        hundi: $('slotHundi').value,
      };
      markDirty();
    }
  };
  $('slotLaddus').addEventListener('input', onSlotAmount);
  $('slotHundi').addEventListener('input', onSlotAmount);

  $('reportField').addEventListener('click', reportFields);

  $('onboardGot').addEventListener('click', async () => {
    state.store.settings.onboarded = true;
    await saveNow();
    $('onboard').hidden = true;
  });

  // Re-open the first-run guide any time from the footer.
  $('howItWorks')?.addEventListener('click', () => showOnboarding());

  $('themeBtn').addEventListener('click', () => {
    const order = ['auto', 'light', 'dark'];
    const next = order[(order.indexOf(state.store.settings.theme) + 1) % order.length];
    state.store.settings.theme = next;
    applyTheme(next);
    markDirty();
  });

  $('fillBtn').addEventListener('click', fillPage);
  $('previewBtn').addEventListener('click', healthCheck);
  $('statsBtn').addEventListener('click', openStats);
  $('statsClose').addEventListener('click', closeStats);
  $('securityBtn').addEventListener('click', openSecurity);
  $('securityClose').addEventListener('click', () => { $('security').hidden = true; });
  $('preflightClose').addEventListener('click', closePreflight);
  applySevaSelection(state.flow); // restore this seva's remembered selection
  updateLockIcon();
  startISTClock();
  $('exportBtn').addEventListener('click', doExport);
  $('importBtn').addEventListener('click', () => $('importFile').click());
  $('importFile').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      await importAll(await file.text());
      state.store = await getStore();
      await refreshMappings();
      render();
      setStatus(`Imported ${state.store.profiles.length} profile(s).`);
    } catch (err) {
      setStatus(`Import failed: ${err.message}`, 'error');
    }
  });

  render();

  // B4 — first-run guide, shown until dismissed (or on the install welcome tab).
  if (!state.store.settings.onboarded || new URLSearchParams(location.search).has('welcome')) {
    showOnboarding();
  } else if (!(await maybeShowFillNudge())) {
    // Only one ask at a time: the fill nudge wins if a fresh fill is waiting,
    // otherwise fall back to the rate nudge.
    maybeShowRateNudge();
  }
}


function showOnboarding() {
  $('onboardTitle').textContent = t('onboard.title');
  $('onboardStep1').textContent = t('onboard.step1');
  $('onboardStep2').textContent = t('onboard.step2');
  $('onboardStep3').textContent = t('onboard.step3');
  $('onboardGot').textContent = t('onboard.got');
  $('onboard').hidden = false;
}

init();
