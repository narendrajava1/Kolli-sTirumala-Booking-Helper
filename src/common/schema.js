/**
 * Canonical shape of everything the extension stores, plus the field catalogue
 * each booking flow can fill.
 *
 * Modelled on the live portal (ttdevasthanams.ap.gov.in), a Next.js app with a
 * shared booking pipeline:
 *
 *   /<service>/instructions → /slot-booking → /pilgrim-details
 *                           → /review-details → /receipt
 *
 * Every service passes ?flow=<id>&flowIdentifier=<id>, and /pilgrim-details is
 * a SINGLE page shared by all of them — which is why pilgrim rows are stored
 * once per profile rather than once per flow.
 *
 * Storage is a list of PROFILES. A profile is one saved travelling party:
 * a name ("Family", "Parents"), a shared contact block, and its own pilgrims.
 * A "field key" is a dotted path into the ACTIVE profile.
 */

/**
 * Accommodation (flow=acc) is deliberately absent.
 *
 * It is not the same shape as a darshan booking: it reserves rooms against an
 * existing darshan/seva ticket, with its own rules ("single person / unmarried
 * couple / minors not allowed"), so its form almost certainly asks for
 * check-in dates and room types rather than six pilgrim rows. Its selectors
 * were never captured, and shipping an untested tab invites trusting a fill
 * that may quietly do the wrong thing.
 *
 * Re-add it by restoring `ACC: 'acc'` here plus its label and param entry,
 * once the real form has been inspected.
 */
/**
 * Declaration order IS tab order, and the first entry is the default flow the
 * popup opens on. Special Entry Darshan (Tirumala) leads because it is the
 * primary booking; Ammavari follows.
 *
 * A page URL still wins over the default — opening the popup on an Ammavari
 * page selects Ammavari, so the priority never fights what you are looking at.
 */
const FLOWS = {
  SED: 'sed',                 // Special Entry Darshan — Tirumala  (default)
  SPAT: 'spat',               // Special Entry Darshan — Sri Padmavathi Ammavari Temple
  ARJITHA: 'arjitha-seva',    // Arjitha Seva — Srivari Temple (Pushpayagam, etc.)
  VSEVA: 'virtual-seva',      // Virtual Seva — remote participation, prasadam by post (Srivari/Ammavari)
  APD: 'apd',                 // Angapradakshina — Srivari Temple (no Gothram field)
  SRIVANI: 'srivani',         // SRIVANI Trust Break Darshan (legacy tirupatibalaji portal)
  ACC: 'acc',                 // Tirumala/Tirupati Accommodation (rooms)
  SRIVARI: 'srivari-seva',    // Srivari Seva — save-able VOLUNTEER profile (unified-profile)
};

const FLOW_LABELS = {
  [FLOWS.SED]: 'Special Entry Darshan',
  [FLOWS.SPAT]: 'Ammavari SED',
  [FLOWS.ARJITHA]: 'Arjitha Seva',
  [FLOWS.VSEVA]: 'Virtual Seva',
  [FLOWS.APD]: 'Angapradakshina',
  [FLOWS.SRIVANI]: 'SRIVANI',
  [FLOWS.ACC]: 'Accommodation',
  [FLOWS.SRIVARI]: 'Srivari Seva',
};

/**
 * Query-param value → flow. Read from `flow` or `flowIdentifier`. Arjitha uses
 * flowIdentifier=arjitha-seva and the path /arjitha-seva/pilgrim-details.
 */
const FLOW_BY_PARAM = {
  sed: FLOWS.SED,
  spat: FLOWS.SPAT,
  'arjitha-seva': FLOWS.ARJITHA,
  'virtual-seva': FLOWS.VSEVA,
  apd: FLOWS.APD,
  srivani: FLOWS.SRIVANI,
  acc: FLOWS.ACC,
  'srivari-seva': FLOWS.SRIVARI,
};

/** The flow the popup opens on when the current page does not indicate one. */
const DEFAULT_FLOW = FLOWS.SED;

/**
 * Max pilgrims per booking. 6 is VERIFIED for SPAT — the live "Number of
 * Tickets" dropdown offers up to 6 and the form renders exactly 6 rows.
 */
const MAX_PILGRIMS = 6;

/**
 * Per-flow ceiling on pilgrims in one transaction. Most darshan flows allow 6;
 * SRIVANI Break Darshan allows only 4 ("A maximum of four (4) pilgrims are
 * allowed per transaction", stated on its own form). The popup uses this to cap
 * the "+ Add pilgrim" button per tab so a party the form would reject can't be
 * built. Falls back to MAX_PILGRIMS for any flow not listed.
 */
const MAX_PILGRIMS_BY_FLOW = {
  sed: 6,
  spat: 6,
  'arjitha-seva': 6,
  srivani: 4,
};
const flowMaxPilgrims = (flow) => MAX_PILGRIMS_BY_FLOW[flow] || MAX_PILGRIMS;

/**
 * Per-field fill delay for a flow. Most portals keep the user's configured gap
 * so dependent fields (state → district) settle between writes. SRIVANI has no
 * such cascade and its quota goes in SECONDS, so it fills with a minimal gap.
 */
function fillDelayForFlow(flow, base) {
  const d = Number.isFinite(base) ? base : 60;
  // SRIVANI's quota goes in seconds, so it fills as fast as possible and leans
  // on the background finisher for anything that loads late.
  if (flow === 'srivani') return Math.min(d, 20);
  // The ttdevasthanams portal (SED, Ammavari SED, Arjitha, Accommodation,
  // Srivari Seva) fills through its own readOnly dropdown widgets, which already
  // wait for their option lists to render (dependent lists like state → district
  // are polled for, not timed), so the between-field pause only needs to let
  // React settle. A smaller cap keeps the fill snappy without racing anything.
  return Math.min(d, 40);
}

/**
 * Per-pilgrim fields on /pilgrim-details. Names and option strings are
 * VERIFIED against the live form.
 *
 * `idType` sits before `idNumber` deliberately: the portal silently truncates
 * the ID number's last character if it is typed while the ID type is blank.
 * The engine also enforces this by filling dropdowns first.
 */
const PERSON_FIELDS = [
  { key: 'name', label: 'Full name', type: 'text', maxLength: 80 },
  { key: 'age', label: 'Age', type: 'number', maxLength: 3 },
  // readOnly custom dropdowns on the live page — not <select>, not text.
  { key: 'gender', label: 'Gender', type: 'dropdown', options: ['Female', 'Male', 'Transgender'] },
  // The live TTD forms (SED, Arjitha, SRIVANI, Accommodation) offer only
  // Aadhaar Card and Passport — there is NO PAN option, so it is not listed
  // (a stored "PAN Card" could never match the form's dropdown).
  { key: 'idType', label: 'Photo ID proof', type: 'dropdown', options: ['Aadhaar Card', 'Passport'] },
  // 18 chars covers Aadhaar (12), most passports and PAN (10); the live field's
  // own maxlength still applies when filling.
  { key: 'idNumber', label: 'Photo ID number', type: 'text', maxLength: 18 },
];

/**
 * Verhoeff checksum — the algorithm UIDAI uses for Aadhaar's 12th (check) digit.
 *
 * A number can be a full 12 digits and still be a typo; Verhoeff catches every
 * single-digit error and every adjacent transposition, which is exactly how
 * people mistype an Aadhaar. The `d` table is the dihedral group D5 Cayley
 * table; `p` is generated from its canonical first permutation so there is no
 * chance of a mis-transcribed row silently rejecting valid numbers.
 */
const _VD = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6], [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8], [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2], [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4], [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const _VP1 = [1, 5, 7, 6, 2, 8, 3, 0, 9, 4];
const _VP = [[0, 1, 2, 3, 4, 5, 6, 7, 8, 9]];
for (let _i = 1; _i < 8; _i++) _VP[_i] = _VP[_i - 1].map((x) => _VP1[x]);
const _VINV = [0, 4, 3, 2, 1, 5, 6, 7, 8, 9];

/** True if the whole number (check digit included) passes the Verhoeff check. */
function verhoeffValid(numStr) {
  const rev = String(numStr).replace(/\D/g, '').split('').reverse();
  if (!rev.length) return false;
  let c = 0;
  for (let i = 0; i < rev.length; i++) c = _VD[c][_VP[i % 8][Number(rev[i])]];
  return c === 0;
}

/** The Verhoeff check digit for a base number — used only to test the above. */
function verhoeffGenerate(numStr) {
  const rev = String(numStr).replace(/\D/g, '').split('').reverse();
  let c = 0;
  for (let i = 0; i < rev.length; i++) c = _VD[c][_VP[(i + 1) % 8][Number(rev[i])]];
  return _VINV[c];
}

/**
 * Format checks for a pilgrim's fields, BEYOND "is it blank".
 *
 * readiness() already reports empty required fields. This is the second layer:
 * a value that is present but malformed — a short Aadhaar, a non-numeric age.
 * Catching these in the popup (or during the queue) means fixing them while
 * there is still time, not discovering a rejected ID at the temple gate.
 *
 * The ID check is TYPE-AWARE on purpose: Aadhaar is exactly 12 digits, but a
 * passport is alphanumeric and a different length, so a single hardcoded
 * "12 digits" rule would wrongly flag every foreign devotee. Only fields that
 * are filled in are checked here — emptiness is readiness()'s job, not this.
 *
 * Returns [{ key, code, params, label, problem }]. `code` keys the localized
 * message (problem.age / problem.aadhaar / problem.passport); `problem` is the
 * English text, kept as a fallback and for tests. Empty array means clean.
 */
function validatePerson(person) {
  const problems = [];

  const ageRaw = String(person.age ?? '').trim();
  if (ageRaw) {
    const n = Number(ageRaw);
    if (!/^\d{1,3}$/.test(ageRaw) || !Number.isInteger(n) || n < 1 || n > 120) {
      problems.push({
        key: 'age', code: 'age', params: {}, label: 'Age',
        problem: 'must be a whole number between 1 and 120',
      });
    }
  }

  const idType = String(person.idType ?? '').trim();
  const idNumber = String(person.idNumber ?? '').trim();
  if (idNumber && idType) {
    if (/aadhaar/i.test(idType)) {
      const digits = (idNumber.match(/\d/g) || []).length;
      // Aadhaar is 12 digits; users often type it grouped ("9999 9999 9999").
      if (!/^[\d\s]+$/.test(idNumber) || digits !== 12) {
        problems.push({
          key: 'idNumber', code: 'aadhaar', params: { digits }, label: 'Aadhaar number',
          problem: `must be 12 digits (has ${digits})`,
        });
      } else if (!verhoeffValid(idNumber)) {
        // 12 digits but the check digit does not match — a typo, not a real ID.
        problems.push({
          key: 'idNumber', code: 'aadhaarChecksum', params: {}, label: 'Aadhaar number',
          problem: 'looks invalid (checksum failed) — check for a typo',
        });
      }
    } else if (/passport/i.test(idType)) {
      const compact = idNumber.replace(/\s/g, '').toUpperCase();
      // Passports vary by country (India: 1 letter + 7 digits; US/UK: up to 9
      // digits). Stay permissive — never reject a valid foreign passport — but
      // catch clear typos: wrong length or a stray non-alphanumeric character.
      if (!/^[A-Z0-9]{5,15}$/.test(compact)) {
        problems.push({
          key: 'idNumber', code: 'passport', params: {}, label: 'Passport number',
          problem: 'should be 5–15 letters and digits',
        });
      }
    } else if (/pan/i.test(idType)) {
      // PAN is a fixed format: five letters, four digits, one letter (ABCDE1234F).
      const compact = idNumber.replace(/\s/g, '').toUpperCase();
      if (!/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(compact)) {
        problems.push({
          key: 'idNumber', code: 'pan', params: {}, label: 'PAN number',
          problem: 'should look like ABCDE1234F',
        });
      }
    }
  }

  // Passport expiry (optional, only meaningful for a passport). A date input
  // gives an ISO 'YYYY-MM-DD' string, so a plain string compare against today
  // is correct and timezone-safe. An expired passport is refused at the counter,
  // so catching it here saves a wasted booking.
  const exp = String(person.passportExpiry ?? '').trim();
  if (exp && /passport/i.test(idType)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(exp)) {
      problems.push({
        key: 'passportExpiry', code: 'passportExpiryBad', params: {}, label: 'Passport expiry',
        problem: 'is not a valid date',
      });
    } else if (exp < new Date().toISOString().slice(0, 10)) {
      problems.push({
        key: 'passportExpiry', code: 'passportExpired', params: {}, label: 'Passport expiry',
        problem: 'has expired — renew before booking',
      });
    }
  }

  return problems;
}

/**
 * Find pilgrims in one profile who share the same photo-ID number.
 *
 * TTD allows a given ID number ONCE per booking — enter the same Aadhaar for
 * two people (an easy copy-paste slip, especially with six rows) and the
 * booking is rejected at submit, after the slot is already gone. Catching it in
 * the popup, or during the queue, turns a lost slot into a two-second fix.
 *
 * Comparison ignores spacing and case ("9999 9999 9999" == "999999999999").
 * Returns [{ id, pilgrims: [0-based indices] }] for each number used twice or
 * more; empty when every ID is distinct.
 */
function findDuplicateIds(people) {
  const seen = new Map(); // normalized id → [indices]
  (people || []).forEach((person, i) => {
    const raw = String(person.idNumber ?? '').trim();
    if (!raw) return;
    const key = raw.replace(/\s+/g, '').toUpperCase();
    if (!seen.has(key)) seen.set(key, []);
    seen.get(key).push(i);
  });
  const dups = [];
  for (const [id, idxs] of seen) {
    if (idxs.length > 1) dups.push({ id, pilgrims: idxs });
  }
  return dups;
}

/**
 * The "General Details" block on /pilgrim-details. VERIFIED on the SED flow.
 * SPAT does not render this block; the same seeds simply find nothing there,
 * which is why an Ammavari fill reports fewer fields than a Tirumala one.
 */
const CONTACT_FIELDS = [
  { key: 'email', label: 'Email ID', type: 'email' },
  { key: 'mobile', label: 'Mobile', type: 'tel' },
  { key: 'city', label: 'City', type: 'text' },
  { key: 'state', label: 'State', type: 'text' },
  { key: 'country', label: 'Country', type: 'text' },
  { key: 'pincode', label: 'PIN code', type: 'text' },
];

/**
 * The date, slot and ticket count on /slot-booking are never autofilled — they
 * are decisions, not stored data.
 *
 * The two optional PAID add-ons on that page (additional laddus, hundi
 * offering) are OFF by default and filled only when the user explicitly opts in
 * via settings.slotAddOns AND enters a value — because both cost real money
 * (laddus ₹50 each, hundi a donation). Even then the extension only sets the
 * value; it never continues past the slot page, so the total is always seen
 * before paying. See settings.slotAddOns and content.js maybeFillSlotAddOns.
 */

/**
 * There is deliberately NO separate passport block. The live form handles
 * foreign devotees through the ordinary Photo ID Proof dropdown — pick
 * "Passport" and the passport number goes in the normal ID number field.
 * VERIFIED: photoIdType = "Passport" → idProofNumber = "Z1234567" persisted.
 */

const uid = () =>
  (globalThis.crypto?.randomUUID?.() || `p${Date.now()}${Math.floor(Math.random() * 1e6)}`);

function emptyPerson() {
  return Object.fromEntries(PERSON_FIELDS.map((f) => [f.key, '']));
}

function emptyProfile(name = 'Default') {
  return {
    id: uid(),
    name,
    // Optional single family Gothram, filled only on sevas that render it
    // (Sri Srinivasa Divyanugraha Homam). One per profile, NOT per pilgrim —
    // the live form has a single form-level `gothram` field. Never required.
    gothram: '',
    contact: Object.fromEntries(CONTACT_FIELDS.map((f) => [f.key, ''])),
    people: [emptyPerson()],
  };
}

/**
 * Srivari Seva VOLUNTEER profile (flow=srivari-seva).
 *
 * A completely different shape from a darshan booking: TTD's
 * /srivari-seva/unified-profile is ONE save-able record for the logged-in
 * sevak (not six pilgrim rows), stored server-side on the account. So the
 * extension keeps a SINGLE volunteer object per install (store.volunteer),
 * separate from the pilgrim profiles, and fills that form once.
 *
 * Every key below EQUALS the field's DOM `name` on the live form (verified
 * 2026-09-28), which is what the seeds resolve on — except the three that have
 * no usable unique name and are handled specially by buildVolunteerPlan:
 *   - gender   → radios, value="Male"/"Female"
 *   - fitnessMental / fitnessPhysical → two checkboxes sharing name="fitness"
 *     and value="on", told apart only by their labels
 *   - photo / document → two <input type=file> with no name (positional)
 *
 * Deliberately NOT filled (present on the form but auto/locked): `mobileNo`
 * (locked from the OTP login) and `age` (auto-derived from Date of Birth).
 * `state`/`district` auto-populate from the pincode, so they are best-effort.
 */
const VOLUNTEER_SECTIONS = [
  {
    title: 'identity',
    fields: [
      // Same as the darshan flows — Aadhaar Card / Passport only (no PAN).
      { key: 'idType', type: 'dropdown', options: ['Aadhaar Card', 'Passport'] },
      // 14 (not 12) so a grouped Aadhaar can be SHOWN as "9999 9999 9999" in the
      // popup; only the 12 digits are ever stored and filled.
      { key: 'idNumber', type: 'text', maxLength: 14 },
      { key: 'sevakName', type: 'text', maxLength: 60 },
      { key: 'fatherOrSpouseName', type: 'text', maxLength: 60 },
      { key: 'dob', type: 'date' },
      { key: 'email', type: 'email' },
      { key: 'bloodGroup', type: 'dropdown', options: ['A+', 'A-', 'B+', 'B-', 'O+', 'O-', 'AB+', 'AB-'] },
      { key: 'gender', type: 'radio', options: ['Male', 'Female'] },
      { key: 'fitnessMental', type: 'checkbox' },
      { key: 'fitnessPhysical', type: 'checkbox' },
    ],
  },
  {
    title: 'professional',
    fields: [
      { key: 'qualification', type: 'text', maxLength: 60, optional: true },
      { key: 'profession', type: 'text', maxLength: 60, optional: true },
      { key: 'areaOfInterest', type: 'text', maxLength: 60, optional: true },
      { key: 'employeeId', type: 'text', maxLength: 40, optional: true },
      { key: 'designation', type: 'text', maxLength: 60, optional: true },
      { key: 'specialisation', type: 'text', maxLength: 60, optional: true },
      { key: 'placeOfWork', type: 'text', maxLength: 80, optional: true },
    ],
  },
  {
    title: 'address',
    fields: [
      { key: 'country', type: 'dropdown', options: ['India'] },
      { key: 'pincode', type: 'text', maxLength: 6 },
      { key: 'mandal', type: 'text', maxLength: 40, optional: true },
      { key: 'city', type: 'text', maxLength: 40 },
      { key: 'street', type: 'text', maxLength: 60 },
      { key: 'doorNo', type: 'text', maxLength: 30 },
    ],
  },
  {
    title: 'uploads',
    fields: [
      { key: 'photo', type: 'file', optional: true },
      { key: 'document', type: 'file', optional: true },
    ],
  },
];

/** Flat list of every volunteer field, in DOM/section order. */
const VOLUNTEER_FIELDS = VOLUNTEER_SECTIONS.flatMap((s) => s.fields);

/**
 * The volunteer fields that MUST be present for the profile to be usable.
 * Deliberately narrower than the form's own required (*) set — the user's own
 * saved profile persisted with several professional/optional fields blank, so
 * blocking on those would nag without cause. state/district are excluded
 * because the portal auto-fills them from the pincode.
 */
const VOLUNTEER_REQUIRED = [
  'idType', 'idNumber', 'sevakName', 'dob', 'gender', 'email',
  'bloodGroup', 'country', 'pincode', 'city', 'street', 'doorNo',
];

function emptyVolunteer() {
  const v = { id: uid() };
  for (const f of VOLUNTEER_FIELDS) {
    v[f.key] = f.type === 'checkbox' ? false : f.type === 'file' ? null : '';
  }
  return v;
}

/**
 * Srivari Seva stores a LIST of Sevaks (volunteer profiles), not just one:
 * a Group Leader adds up to 15 members, each with the same unified-profile
 * fields, and fills the same Add-Sevak form once per member. TTD's own limit is
 * "15 sevaks or group members including the group leader".
 */
const MAX_VOLUNTEERS = 15;

/** The Sevak currently being edited/filled. */
function activeVolunteer(store) {
  const list = store.volunteers || [];
  return list.find((v) => v.id === store.activeVolunteerId) || list[0];
}

/** Add a blank Sevak (up to MAX_VOLUNTEERS) and make it active. Returns it. */
function addVolunteer(store) {
  if (!Array.isArray(store.volunteers)) store.volunteers = [];
  if (store.volunteers.length >= MAX_VOLUNTEERS) return activeVolunteer(store);
  const v = emptyVolunteer();
  store.volunteers.push(v);
  store.activeVolunteerId = v.id;
  return v;
}

/** Remove a Sevak (never the last one); keep a valid active selection. */
function removeVolunteer(store, id) {
  if (!Array.isArray(store.volunteers) || store.volunteers.length <= 1) return;
  const i = store.volunteers.findIndex((v) => v.id === id);
  if (i === -1) return;
  store.volunteers.splice(i, 1);
  if (!store.volunteers.some((v) => v.id === store.activeVolunteerId)) {
    store.activeVolunteerId = store.volunteers[Math.min(i, store.volunteers.length - 1)].id;
  }
}

/**
 * Bring a stored volunteers list (or a legacy single `volunteer`) up to shape:
 * an array of records, each with all fields and a stable id, and a valid
 * activeVolunteerId. Mutates and returns the store.
 */
function ensureVolunteers(store) {
  let list = store.volunteers;
  if (!Array.isArray(list) || !list.length) {
    // Migrate the earlier single `volunteer` object, if any.
    list = [{ ...emptyVolunteer(), ...(store.volunteer || {}) }];
  }
  store.volunteers = list.map((v) => ({ ...emptyVolunteer(), ...(v || {}) }));
  delete store.volunteer;
  if (!store.volunteers.some((v) => v.id === store.activeVolunteerId)) {
    store.activeVolunteerId = store.volunteers[0].id;
  }
  return store;
}

/**
 * Readiness of the single volunteer profile. Returns { ok, missing, advisory }.
 * `missing` are blank REQUIRED fields; `advisory` are blank optional ones worth
 * a gentle mention. Also does the light format checks the darshan side does
 * (email shape, pincode 6 digits, Aadhaar/PAN/Passport ID).
 */
function validateVolunteer(v = {}) {
  const val = (k) => String(v[k] ?? '').trim();
  const missing = VOLUNTEER_REQUIRED.filter((k) => !val(k));

  const problems = [];
  const email = val('email');
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    problems.push({ key: 'email', code: 'emailBad' });
  }
  const pin = val('pincode');
  if (pin && !/^\d{6}$/.test(pin)) {
    problems.push({ key: 'pincode', code: 'pincodeBad' });
  }
  // Reuse the pilgrim ID checks (Aadhaar/PAN/Passport) — same rules apply.
  const idProblem = validatePerson({ idType: val('idType'), idNumber: val('idNumber') })
    .find((p) => p.key === 'idNumber');
  if (idProblem) problems.push({ key: 'idNumber', code: idProblem.code, params: idProblem.params });

  const advisory = VOLUNTEER_FIELDS
    .filter((f) => f.optional && f.type !== 'file' && f.type !== 'checkbox' && !val(f.key))
    .map((f) => f.key);

  return { ok: missing.length === 0 && problems.length === 0, missing, problems, advisory };
}

/**
 * Profiles a fresh install starts with. These are just starting points — the
 * popup can rename, add, duplicate and delete them freely. Each holds its own
 * contact block and up to MAX_PILGRIMS pilgrims.
 */
const DEFAULT_PROFILE_NAMES = ['Family', 'Relatives', 'Friends / Others'];

function defaultStore() {
  const profiles = DEFAULT_PROFILE_NAMES.map((n) => emptyProfile(n));
  const volunteers = [emptyVolunteer()];
  return {
    version: 3,
    activeProfileId: profiles[0].id,
    profiles,
    // Srivari Seva Sevaks (volunteer profiles) — up to MAX_VOLUNTEERS for a
    // Group Leader. See VOLUNTEER_SECTIONS / flow=srivari-seva.
    volunteers,
    activeVolunteerId: volunteers[0].id,
    settings: {
      theme: 'auto',
      language: 'en',           // popup + on-page banners: 'en' | 'te' | 'hi'
      propagateAddress: true,   // blank per-pilgrim contact falls back to shared
      autoDetectFlow: true,     // switch tab to match ?flow= on the active page
      // Click "Continue" after a successful fill, advancing to the review
      // page. Refuses when any rendered pilgrim row is incomplete. Only ever
      // clicks Continue — never Pay Now.
      autoContinue: true,
      // Fill the pilgrim page automatically the moment it loads, WITHOUT the
      // user opening the popup. Off by default and strictly opt-in: it only
      // ever runs the same plan the manual button runs, only on a real
      // pilgrim-details form (never the queue, never a payment page), only when
      // the active profile is Ready, and it never touches Pay Now.
      autoFillOnLoad: false,
      // Draw a small "Fill" button on the TTD page itself (opt-in), so a fill
      // is possible without opening the popup. Never shown on payment pages.
      floatingButton: false,
      // Cleared once the first-run guide has been dismissed.
      onboarded: false,
      // "Assist my whole booking" — a single convenience switch. When ON it
      // enables auto-fill-on-load + auto-continue + the floating button together
      // (it still NEVER touches Pay Now). Off by default; the three individual
      // settings remain available for fine control.
      assistMode: false,
      // v1.4, both opt-in and OFF by default so nothing new appears or changes
      // until the user turns them on. Both are strictly local / read-only.
      bookingLog: false,      // keep a private on-device log of booking outcomes
      pageCountdown: false,   // show a small release countdown chip on the page
      releaseAlert: true,     // beep + flash the tab when the countdown hits zero
      draftProtection: true,  // warn before accidentally closing a filled form
      captchaFocus: true,     // scroll to + focus the captcha box when it appears
      logoutWarn: true,       // passive banner if you appear logged out of TTD (no network)
      ratePrompted: false,    // shown the one-time "rate us" nudge yet?
      // v1.15 — on the ttdevasthanams portal (which rejects synthetic input),
      // fill by driving TTD's own React onChange from the page's MAIN world
      // (Chrome only; no debugger). ON by default; whatever React can't fill
      // (custom dropdowns) falls back to the Paste Helper. Turn OFF to use pure
      // paste-assist if a TTD update ever makes the React fill misbehave.
      reactFill: true,
      // v1.7 — optional PAID add-ons on /slot-booking. OFF by default and
      // strictly opt-in because both cost real money: laddus are ₹50 each and
      // hundi is a donation. When enabled AND a value is set, the extension
      // fills that value into the add-on field on the slot page — but it NEVER
      // auto-continues past it, so the amounts are always seen before paying.
      slotAddOns: { enabled: false, laddus: '', hundi: '' },
      // Srivari Seva slot-booking helpers (flow=srivari-seva /slot-booking).
      // Date, location and the declaration are the user's decisions, so these
      // are conservative: location is only pre-selected when the user has named
      // one; the green-date highlight is READ-ONLY (never clicks a date); and
      // the declaration auto-tick is OPT-IN and OFF by default (it is the user's
      // legal declaration) and NEVER clicks Continue/Book.
      srivariSlot: {
        location: '',              // preferred "Seva Name" — '' means don't touch it
        highlightAvailable: true,  // outline the Available (green) dates — read-only
        autoDeclaration: false,    // tick "I hereby declare…" (opt-in; never continues)
      },
      // NOTE: no auto-pick-date. TTD assigns/blocks Srivari Seva dates and
      // availability shifts, so which date to book is deliberately left to the
      // user; the extension only HIGHLIGHTS the available ones (read-only).
      fillDelayMs: 60,
    },
  };
}

/**
 * Bring a stored blob up to the current shape.
 *
 * v1/v2 kept a single implicit profile with pilgrims keyed by flow
 * ({ spat: [...], sed: [...] }). Since /pilgrim-details is shared across
 * flows, that split was redundant — collapse it into one pilgrim list, taking
 * whichever flow the user had actually filled in.
 */
/**
 * PAN Card was previously an ID-type option but no live TTD form offers it, so
 * a pilgrim (or the volunteer) saved as "PAN Card" could never match the form's
 * dropdown. Clear it to blank so the readiness check flags it and the user
 * re-picks Aadhaar/Passport, rather than silently failing to fill.
 */
function dropUnsupportedPanIdType(store) {
  const isPan = (v) => /pan/i.test(String(v || ''));
  for (const p of store.profiles || []) {
    for (const person of p.people || []) {
      if (isPan(person.idType)) person.idType = '';
    }
  }
  for (const v of store.volunteers || []) {
    if (isPan(v.idType)) v.idType = '';
  }
}

function migrateStore(stored) {
  if (!stored) return defaultStore();
  if (stored.version >= 3 && Array.isArray(stored.profiles)) {
    const base = defaultStore();
    const store = { ...base, ...stored, settings: { ...base.settings, ...(stored.settings || {}) } };
    // slotAddOns is a nested object, so a shallow settings merge could carry a
    // partial one from an older/edited blob. Backfill any missing keys.
    store.settings.slotAddOns = { enabled: false, laddus: '', hundi: '', ...(store.settings.slotAddOns || {}) };
    store.settings.srivariSlot = { location: '', highlightAvailable: true, autoDeclaration: false, ...(store.settings.srivariSlot || {}) };
    delete store.settings.srivariSlot.autoPickDate; // dropped feature — never carry it forward
    // Backfill the volunteer profile (added after v3) without dropping any keys
    // a user already saved.
    // Reconcile Sevaks: prefer the user's stored list, else migrate a legacy
    // single `volunteer` — the base-store spread injected a default list that
    // must not shadow either.
    if (Array.isArray(stored.volunteers) && stored.volunteers.length) store.volunteers = stored.volunteers;
    else if (stored.volunteer) store.volunteers = [stored.volunteer];
    ensureVolunteers(store); // backfill fields/ids, drop legacy `volunteer`, fix activeVolunteerId
    if (!store.profiles.length) store.profiles = defaultStore().profiles;
    dropUnsupportedPanIdType(store); // PAN is no longer offered — clear stale PAN picks
    ensureStarterProfiles(store);
    if (!store.profiles.some((p) => p.id === store.activeProfileId)) {
      store.activeProfileId = store.profiles[0].id;
    }
    return store;
  }

  // --- legacy (v1/v2) ---
  const byFlow = stored.people && !Array.isArray(stored.people) ? stored.people : {};
  const filledCount = (list) =>
    (list || []).filter((p) => Object.values(p || {}).some((v) => v !== '' && v != null)).length;
  const best = Object.values(byFlow).reduce(
    (winner, list) => (filledCount(list) > filledCount(winner) ? list : winner),
    []
  );

  // Whatever they already had becomes the first starter profile, so no
  // previously-entered pilgrim is lost on upgrade.
  const profile = {
    ...emptyProfile(DEFAULT_PROFILE_NAMES[0]),
    contact: { ...emptyProfile().contact, ...(stored.contact || {}) },
    people: (best && best.length ? best : [emptyPerson()]).slice(0, MAX_PILGRIMS),
  };

  const base = defaultStore();
  const store = {
    version: 3,
    activeProfileId: profile.id,
    profiles: [profile],
    volunteers: stored.volunteer ? [stored.volunteer] : (stored.volunteers || undefined),
    activeVolunteerId: stored.activeVolunteerId,
    settings: { ...base.settings, ...(stored.settings || {}) },
  };
  ensureVolunteers(store);
  ensureStarterProfiles(store);
  return store;
}

/**
 * Top up a store with any missing starter profiles.
 *
 * Only ever ADDS — an existing profile is never renamed or touched, so a user
 * who deleted "Relatives" on purpose gets it back only if they also had no
 * other profiles of their own. The guard is the untouched-single-profile case:
 * a lone profile still carrying a default name means the user has not yet
 * organised anything, so filling in the rest is helpful rather than intrusive.
 */
function ensureStarterProfiles(store) {
  const lone = store.profiles.length === 1;
  const looksUntouched = lone &&
    (store.profiles[0].name === 'Default' || DEFAULT_PROFILE_NAMES.includes(store.profiles[0].name));
  if (!looksUntouched) return;

  if (store.profiles[0].name === 'Default') store.profiles[0].name = DEFAULT_PROFILE_NAMES[0];
  const have = new Set(store.profiles.map((p) => p.name));
  for (const name of DEFAULT_PROFILE_NAMES) {
    if (!have.has(name)) store.profiles.push(emptyProfile(name));
  }
}

function activeProfile(store) {
  return store.profiles.find((p) => p.id === store.activeProfileId) || store.profiles[0];
}

/** Every flow presents the same editor: contact block + pilgrim rows. */
const FLOW_FIELDS = {
  [FLOWS.SED]: { person: PERSON_FIELDS, shared: CONTACT_FIELDS },
  [FLOWS.SPAT]: { person: PERSON_FIELDS, shared: CONTACT_FIELDS },
  [FLOWS.ARJITHA]: { person: PERSON_FIELDS, shared: CONTACT_FIELDS },
  [FLOWS.VSEVA]: { person: PERSON_FIELDS, shared: CONTACT_FIELDS },
  [FLOWS.APD]: { person: PERSON_FIELDS, shared: CONTACT_FIELDS },
  [FLOWS.SRIVANI]: { person: PERSON_FIELDS, shared: CONTACT_FIELDS },
  [FLOWS.ACC]: { person: PERSON_FIELDS, shared: CONTACT_FIELDS },
};

/**
 * Validate the optional slot add-on values. Empty is always fine (the field is
 * simply not filled). A set value must be a sane, whole, non-negative number —
 * laddus 0–99 (the field's live maxlength is 2), hundi any whole rupee amount.
 * Returns [] when clean, else a list of { field, code }.
 */
function validateSlotAddOns(addOns) {
  const issues = [];
  const laddus = String(addOns?.laddus ?? '').trim();
  const hundi = String(addOns?.hundi ?? '').trim();
  if (laddus !== '') {
    const n = Number(laddus);
    if (!/^\d{1,2}$/.test(laddus) || !Number.isInteger(n) || n < 0 || n > 99) {
      issues.push({ field: 'laddus', code: 'laddusBad' });
    }
  }
  if (hundi !== '') {
    const n = Number(hundi);
    if (!/^\d{1,7}$/.test(hundi) || !Number.isInteger(n) || n < 0) {
      issues.push({ field: 'hundi', code: 'hundiBad' });
    }
  }
  return issues;
}

/** Parse the portal's flow identifier out of a tab URL. */
function flowFromUrl(url) {
  try {
    const u = new URL(url);
    const param = u.searchParams.get('flow') || u.searchParams.get('flowIdentifier');
    if (param && FLOW_BY_PARAM[param]) return FLOW_BY_PARAM[param];
    // /srivari-seva/ must be tested before the generic SRIVANI check below —
    // the two names are close, and this path is the volunteer profile, not the
    // legacy SRIVANI break-darshan flow.
    if (/^\/srivari-seva\b/.test(u.pathname)) return FLOWS.SRIVARI;
    if (/^\/arjitha-seva\b/.test(u.pathname)) return FLOWS.ARJITHA;
    if (/^\/sed\b/.test(u.pathname)) return FLOWS.SED;
    if (/^\/spat\b/.test(u.pathname)) return FLOWS.SPAT;
    if (/^\/accommodation\b/.test(u.pathname)) return FLOWS.ACC;
    // SRIVANI Break Darshan lives on the legacy AngularJS portal as a hash
    // route, e.g. tirupatibalaji.ap.gov.in/#/edonationConfirmCurrentSrivani.
    if (/srivani/i.test(u.hash) || /srivani/i.test(u.pathname)) return FLOWS.SRIVANI;
  } catch { /* not a URL we can parse */ }
  return null;
}

if (typeof module !== 'undefined') {
  module.exports = {
    FLOWS, FLOW_LABELS, FLOW_BY_PARAM, DEFAULT_FLOW, MAX_PILGRIMS, FLOW_FIELDS,
    MAX_PILGRIMS_BY_FLOW, flowMaxPilgrims, fillDelayForFlow,
    PERSON_FIELDS, CONTACT_FIELDS, DEFAULT_PROFILE_NAMES,
    VOLUNTEER_SECTIONS, VOLUNTEER_FIELDS, VOLUNTEER_REQUIRED, MAX_VOLUNTEERS,
    emptyVolunteer, validateVolunteer, activeVolunteer, addVolunteer, removeVolunteer, ensureVolunteers,
    defaultStore, migrateStore, activeProfile, emptyProfile, emptyPerson,
    ensureStarterProfiles, flowFromUrl, uid, validatePerson, validateSlotAddOns,
    findDuplicateIds, verhoeffValid, verhoeffGenerate,
  };
}
