/**
 * Selectors captured from the live portal so the extension works out of the
 * box instead of requiring every field to be mapped by hand.
 *
 * Captured against ttdevasthanams.ap.gov.in. User mappings always win — a seed
 * is only consulted when no picked mapping exists for that key.
 *
 * VERIFIED means: observed on the live DOM. SED/SPAT were confirmed to persist
 * end-to-end; Arjitha was read from a live booking on 2026-xx.
 *
 * A caution on `id`: this site reuses it, and it differs BY FLOW.
 *   - SED / SPAT /pilgrim-details rows: `id` is the ROW INDEX (0-5), repeated
 *     across the five fields of that row. The `[name][id]` PAIR is unique,
 *     which the `nameId` strategy ("name@id") encodes.
 *   - Arjitha Seva rows: NO `id` attribute at all. Rows are matched purely by
 *     position with `nameNth` ("name::index").
 *
 * And the field NAMES themselves differ by flow. Arjitha is structurally the
 * same form (contact block + pilgrim rows, readOnly gender / ID-type
 * dropdowns) but every attribute name is different — pilgrimEmail vs emailId,
 * name vs fname, idType vs photoIdType, and so on. So seeds are per-flow.
 */

/**
 * Per-flow DOM attribute names. `rowHasId` picks the matching strategy:
 * true → prefer the unique name@id pair; false → positional name::index only.
 */
const FLOW_SELECTORS = {
  // Special Entry Darshan (Tirumala) and Ammavari SED share one selector set —
  // verified identical on both. Rows carry id = row index.
  sed: {
    contact: { email: 'emailId', city: 'city', state: 'state', country: 'country', pincode: 'pincode' },
    row: { name: 'fname', age: 'age', gender: 'gender', idType: 'photoIdType', idNumber: 'idProofNumber' },
    rowHasId: true,
  },
  spat: {
    contact: { email: 'emailId', city: 'city', state: 'state', country: 'country', pincode: 'pincode' },
    row: { name: 'fname', age: 'age', gender: 'gender', idType: 'photoIdType', idNumber: 'idProofNumber' },
    rowHasId: true,
  },
  // Tirumala/Tirupati Accommodation. VERIFIED live 2026-09-24 (Dec-2026 rooms):
  // /accommodation/pilgrim-details reuses the EXACT SED field set — same names,
  // same readOnly gender/photoIdType dropdowns, same disabled-until-type
  // idProofNumber, same contact block, no mobile field. Autofilled 15/15 live.
  acc: {
    contact: { email: 'emailId', city: 'city', state: 'state', country: 'country', pincode: 'pincode' },
    row: { name: 'fname', age: 'age', gender: 'gender', idType: 'photoIdType', idNumber: 'idProofNumber' },
    rowHasId: true,
  },
  // Arjitha Seva — different names throughout, and NO id on the rows.
  // Arjitha Seva — different names throughout, and NO id on the rows. VERIFIED
  // against a live 2026-09 Arjitha release: no Gothram field here (Gothram
  // belongs to the separate Srinivasa Divyanugraha Homam booking).
  'arjitha-seva': {
    contact: { email: 'pilgrimEmail', city: 'pilgrimCity', state: 'pilgrimState', country: 'pilgrimCountry', pincode: 'pilgrimPincode' },
    row: { name: 'name', age: 'age', gender: 'gender', idType: 'idType', idNumber: 'idNumber' },
    rowHasId: false,
    // Form-level Gothram (a SINGLE field, name="gothram"). Only Sri Srinivasa
    // Divyanugraha Homam renders it — regular Arjitha and Local-Temple sevas do
    // not. VERIFIED live 2026-09-25: Homam had `gothram` (once, before the
    // address block); Local-Temple seva (same arjitha-seva flow) did not. Seeded
    // by name, which is unique; on a seva without the field it simply does not
    // resolve and is skipped, so it never lands anywhere wrong.
    gothram: 'gothram',
  },
  // Virtual Seva — ttdevasthanams React portal, /virtual-seva/pilgrim-details.
  // VERIFIED live 2026-11-21 (Laksha Kumkumarchana, Sri Padmavathi Ammavari
  // Temple, 5-Dec-2026). The contact block and pilgrim rows are byte-identical
  // to Arjitha: pilgrim* contact names; rows name/age/gender/idType/idNumber
  // with NO id attribute (matched positionally); gender & idType are readOnly
  // custom dropdowns, exactly like the other ttdevasthanams flows. The ONE
  // difference from Arjitha: a form-level Gothram named `pilgrimGothram`
  // (Arjitha's is `gothram` and renders only on Homam) that is ALWAYS shown and
  // mandatory here. It sits in General Details, a SINGLE field per booking.
  'virtual-seva': {
    contact: { email: 'pilgrimEmail', city: 'pilgrimCity', state: 'pilgrimState', country: 'pilgrimCountry', pincode: 'pilgrimPincode' },
    row: { name: 'name', age: 'age', gender: 'gender', idType: 'idType', idNumber: 'idNumber' },
    rowHasId: false,
    gothram: 'pilgrimGothram',
  },
  // Angapradakshina — ttdevasthanams React portal, /apd/pilgrim-details
  // (flow=apd). VERIFIED live 2026-11-23 from the user's booking: the contact
  // block and pilgrim rows are byte-identical to Arjitha / Virtual Seva
  // (pilgrim* contact names; rows name/age/gender/idType/idNumber with NO id,
  // positional; gender & idType are readOnly custom dropdowns). UNLIKE Virtual
  // Seva there is NO Gothram field here, so none is seeded.
  apd: {
    contact: { email: 'pilgrimEmail', city: 'pilgrimCity', state: 'pilgrimState', country: 'pilgrimCountry', pincode: 'pilgrimPincode' },
    row: { name: 'name', age: 'age', gender: 'gender', idType: 'idType', idNumber: 'idNumber' },
    rowHasId: false,
  },
  // SRIVANI Trust Break Darshan, on the legacy AngularJS portal
  // (tirupatibalaji.ap.gov.in). VERIFIED from a live capture 2026-08-28.
  //
  // Unlike the others, each row's field NAME already carries the row number
  // (fName1, fName2, age1, age2, …), so every name is unique on its own — no
  // id-pair or positional matching needed. Gender and ID-proof are real
  // <select> elements here, not custom dropdowns. There is NO general-details
  // block on this page (like SPAT). Max 4 pilgrims per transaction.
  //
  // Deliberately excluded and never seeded: the page's `honeypot` bot-trap
  // input and its `captchaInput` — filling either would flag the booking.
  srivani: {
    contact: {},
    row: { name: 'fName', age: 'age', gender: 'gender', idType: 'proofS', idNumber: 'proofId' },
    rowNaming: 'suffixed', // name = base + (row+1): fName1, fName2, …
  },
};

// Substring label fallbacks. Deliberately generic so they match across flows
// whether the label reads "Enter email ID *" (SED) or "Email Address *"
// (Arjitha). Used only when the name selector misses.
const CONTACT_LABEL = {
  email: 'email', city: 'city', state: 'state', country: 'country', pincode: 'pincode',
};

/** Row fields in DOM order — the keys are stable across flows; attrs are not. */
const ROW_KEYS = ['name', 'age', 'gender', 'idType', 'idNumber'];

/**
 * Optional PAID add-ons on /slot-booking (additional laddus, hundi offering).
 * These are NOT part of any flow's pilgrim plan and are filled only when the
 * user has explicitly opted in AND entered a value — because both cost money.
 * See content.js maybeFillSlotAddOns and schema settings.slotAddOns.
 *
 * The inputs are bare React `type="tel"` fields with no name/id/label/
 * placeholder — their only handle is the floating caption text beside them, so
 * `nearText` is the primary strategy (labelContains kept as a backup in case a
 * future release wraps them in a real <label>). VERIFIED live 2026-09-24: two
 * tel inputs, "No. of Additional Laddus" (maxlength 2) then "Hundi Offerings".
 */
const SLOT_ADDON_SEEDS = {
  'addon.laddus': {
    strategies: [
      { kind: 'nearText', value: 'laddu' },
      { kind: 'labelContains', value: 'laddu' },
    ],
  },
  'addon.hundi': {
    strategies: [
      { kind: 'nearText', value: 'hundi' },
      { kind: 'labelContains', value: 'hundi' },
    ],
  },
};

/**
 * Srivari Seva volunteer profile (flow=srivari-seva).
 *
 * A single flat record on /srivari-seva/unified-profile, not pilgrim rows, so
 * it has its own plan builder rather than going through buildSeeds. Every field
 * key equals its DOM `name` and resolves by name (all unique on the live form),
 * except the ones below that have no usable unique name:
 *
 *   - gender             two radios — target the one whose value/label matches
 *   - fitnessMental /    two checkboxes that SHARE name="fitness" and
 *     fitnessPhysical    value="on"; only their labels tell them apart
 *   - photo / document   two <input type=file> with no name — positional
 *
 * Returns the same plan shape the engine's runPlan consumes:
 * [{ fieldKey, descriptor, value, type }]. A user mapping (state.mappings) for a
 * field always wins over the seed, exactly as on the darshan flows. Values that
 * are blank/false are dropped so nothing empty is ever pushed.
 */
// FLOWS is defined in schema.js (loaded first in both the popup and the content
// scripts). Guard for the Node unit tests, which require this file directly.
const FLOWS_SRIVARI = (typeof FLOWS !== 'undefined' && FLOWS.SRIVARI) || 'srivari-seva';

const VOLUNTEER_LABELS = {
  gender: { Male: 'male', Female: 'female' },
  fitnessMental: 'mentally fit',
  fitnessPhysical: 'physically fit',
};

function volunteerSeed(key, value) {
  // A structural, name-based descriptor for the ordinary fields (name === key).
  const byName = { strategies: [{ kind: 'name', value: key }] };

  if (key === 'gender') {
    const v = String(value || '');
    return {
      strategies: [
        // Prefer the exact radio by its value attribute (Male/Female), then its
        // visible label. querySelector with the case-insensitive attr flag.
        { kind: 'css', value: `input[name="gender"][value="${v}" i]` },
        { kind: 'label', value: (VOLUNTEER_LABELS.gender[v] || v).toLowerCase() },
      ],
    };
  }
  if (key === 'fitnessMental' || key === 'fitnessPhysical') {
    return { strategies: [{ kind: 'label', value: VOLUNTEER_LABELS[key] }] };
  }
  if (key === 'photo') {
    return { strategies: [{ kind: 'cssNth', value: 'input[type="file"]::0' }] };
  }
  if (key === 'document') {
    return { strategies: [{ kind: 'cssNth', value: 'input[type="file"]::1' }] };
  }
  return byName;
}

/**
 * The live `dob` field is an editable text input and TTD shows dates as
 * DD/MM/YYYY (e.g. "01/06/1990"), but our popup's <input type=date> stores ISO
 * (YYYY-MM-DD). Convert on the way out so the form receives the format it
 * expects. A value that is already DD/MM/YYYY (or anything unrecognised) is
 * passed through untouched.
 */
function volunteerDob(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : String(value || '');
}

/** Map a volunteer field's editor type to the engine's fill type. */
function volunteerFillType(type) {
  if (type === 'dropdown') return 'dropdown';
  if (type === 'file') return 'file';
  if (type === 'radio' || type === 'checkbox') return type; // engine reads el.type
  return 'text'; // text / email / date all fill as text
}

function buildVolunteerPlan(volunteer, userMappings) {
  const picks = (userMappings || {})[FLOWS_SRIVARI] || {};
  const plan = [];
  const fields = (typeof VOLUNTEER_FIELDS !== 'undefined') ? VOLUNTEER_FIELDS : [];

  for (const f of fields) {
    const raw = volunteer ? volunteer[f.key] : undefined;

    if (f.type === 'checkbox') {
      if (raw !== true) continue;                 // only tick when explicitly on
      const descriptor = picks[f.key] || volunteerSeed(f.key);
      plan.push({ fieldKey: f.key, descriptor, value: true, type: 'checkbox' });
      continue;
    }
    if (f.type === 'file') {
      if (!raw || !raw.dataUrl) continue;
      const descriptor = picks[f.key] || volunteerSeed(f.key);
      plan.push({ fieldKey: f.key, descriptor, value: raw, type: 'file' });
      continue;
    }
    let value = String(raw ?? '').trim();
    if (!value) continue;
    if (f.key === 'dob') value = volunteerDob(value); // ISO → DD/MM/YYYY for the live field

    const descriptor = picks[f.key] || volunteerSeed(f.key, value);
    if (f.type === 'radio') {
      // The descriptor already pinpoints the correct radio; ticking it is a
      // plain "check this" (value=true), which fillCheckable handles.
      plan.push({ fieldKey: f.key, descriptor, value: true, type: 'radio' });
    } else {
      plan.push({ fieldKey: f.key, descriptor, value, type: volunteerFillType(f.type) });
    }
  }
  return plan;
}

/**
 * Build the seed set for one flow, including a mapping per pilgrim row.
 * Unknown flows fall back to the SED selector set.
 */
function buildSeeds(flow, maxRows) {
  const sel = FLOW_SELECTORS[flow] || FLOW_SELECTORS.sed;
  const seeds = {};

  // Shared contact block (empty for flows without a general-details block).
  for (const key of Object.keys(sel.contact || {})) {
    seeds[`contact.${key}`] = {
      strategies: [
        { kind: 'name', value: sel.contact[key] },
        { kind: 'labelContains', value: CONTACT_LABEL[key] },
      ],
    };
  }

  // How this flow's rows are addressed:
  //   idPair    — name repeats, id = row index; the [name][id] pair is unique
  //   positional — name repeats, no id; match by position
  //   suffixed  — name already carries the row number (fName1, fName2, …), unique
  const naming = sel.rowNaming || (sel.rowHasId ? 'idPair' : 'positional');

  for (let row = 0; row < maxRows; row++) {
    for (const key of ROW_KEYS) {
      const attr = sel.row[key];
      let strategies;
      if (naming === 'suffixed') {
        strategies = [{ kind: 'name', value: `${attr}${row + 1}` }]; // already unique
      } else if (naming === 'idPair') {
        strategies = [
          { kind: 'nameId', value: `${attr}@${row}` },   // unique pair — preferred
          { kind: 'nameNth', value: `${attr}::${row}` }, // positional fallback
        ];
      } else {
        strategies = [{ kind: 'nameNth', value: `${attr}::${row}` }]; // no id — position only
      }
      seeds[`people.${row}.${key}`] = { strategies };
    }

    // Optional per-pilgrim photo upload (Arjitha Seva and some SED sevas ask
    // for it). The file input rarely has a stable name, so try a name guess
    // first, then fall back to the Nth file input on the page. A miss just
    // skips — the photo is never attached to the wrong row, and the user can
    // map the field by hand. Never required for a complete row.
    const photoAttr = sel.row.photo || 'photo';
    const photoStrategies = naming === 'suffixed'
      ? [{ kind: 'name', value: `${photoAttr}${row + 1}` }]
      : naming === 'idPair'
        ? [{ kind: 'nameId', value: `${photoAttr}@${row}` }, { kind: 'nameNth', value: `${photoAttr}::${row}` }]
        : [{ kind: 'nameNth', value: `${photoAttr}::${row}` }];
    photoStrategies.push({ kind: 'cssNth', value: `input[type="file"]::${row}` });
    seeds[`people.${row}.photo`] = { strategies: photoStrategies };

    // Legacy per-pilgrim Gothram (kept for any flow that declares a per-row
    // name). No live flow currently uses this — Homam's Gothram is form-level
    // (see below) — but leaving it costs nothing and never resolves without a
    // declared name.
    if (sel.row.gothram) {
      const g = sel.row.gothram;
      seeds[`people.${row}.gothram`] = {
        strategies: naming === 'suffixed'
          ? [{ kind: 'name', value: `${g}${row + 1}` }]
          : naming === 'idPair'
            ? [{ kind: 'nameId', value: `${g}@${row}` }, { kind: 'nameNth', value: `${g}::${row}` }]
            : [{ kind: 'nameNth', value: `${g}::${row}` }],
      };
    }
  }

  // Form-level Gothram: a SINGLE field per booking (Divyanugraha Homam only),
  // not per pilgrim. Seeded by its unique name; skipped on sevas without it.
  if (sel.gothram) {
    seeds['gothram'] = { strategies: [{ kind: 'name', value: sel.gothram }] };
  }
  return seeds;
}

/**
 * What "a complete pilgrim row" means on the live form, for the pre-Continue
 * check. `anchor` is counted to learn how many rows the page rendered — one
 * per ticket selected — and every attribute in `required` must be non-empty in
 * each of those rows. Per-flow because the name field differs (fname vs name).
 */
function rowCheckSpec(flow) {
  const sel = FLOW_SELECTORS[flow] || FLOW_SELECTORS.sed;
  return {
    anchor: sel.row.name,
    required: ROW_KEYS.map((k) => sel.row[k]),
  };
}

if (typeof module !== 'undefined') {
  module.exports = { FLOW_SELECTORS, ROW_KEYS, SLOT_ADDON_SEEDS, buildSeeds, rowCheckSpec, buildVolunteerPlan, volunteerSeed };
}
