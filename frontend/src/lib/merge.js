// Three-way merge of two copies of the app state.
//
// Why: the app syncs its WHOLE state as one document. Saving a copy that was loaded before
// another device's change silently throws that change away — a tab left open on a laptop
// can erase a workout just logged on the phone. A merge against the last version both sides
// agreed on (`base`) tells "you never had it" apart from "you deleted it", so:
//
//   · something only one side changed  → that side's version wins
//   · something both sides changed     → combined where that is meaningful (lists by id,
//                                         best weights), otherwise this device ("local") wins
//   · something one side deleted       → stays deleted, unless the other side edited it
//
// `base` may be null (a device that has never synced under these rules). Then nothing can
// be told apart from a deletion, so lists are unioned — keeping an extra item beats
// losing a logged workout.

const sortKeys = v => {
  if (Array.isArray(v)) return v.map(sortKeys)
  if (v && typeof v === 'object') {
    const o = {}
    for (const k of Object.keys(v).sort()) if (v[k] !== undefined) o[k] = sortKeys(v[k])
    return o
  }
  return v
}
/** Order-independent JSON, for comparing two values structurally. */
export const stable = v => JSON.stringify(sortKeys(v === undefined ? null : v))
const same = (a, b) => stable(a) === stable(b)

// Fields that are bookkeeping, not data.
const IGNORED = new Set(['_ts'])
export const sameState = (a, b) => {
  const strip = s => { if (!s) return s; const o = { ...s }; IGNORED.forEach(k => delete o[k]); return o }
  return same(strip(a), strip(b))
}

// Lists of records merged item by item, by key.
const KEYED = {
  workouts: w => w && w.id,
  routines: r => r && r.id,
  customEx: c => c && c.id,
  bodyweight: b => b && b.d     // one weigh-in per day
}
// Maps merged entry by entry.
const MAPS = new Set(['week', 'dayPlan', 'exWeights'])

function pick3(b, l, r, both) {
  if (same(l, b)) return r
  if (same(r, b)) return l
  return both ? both(l, r) : l
}

function mergeList(base, local, remote, keyOf, onBoth) {
  const idx = list => {
    const m = new Map()
    ;(Array.isArray(list) ? list : []).forEach(x => { const k = keyOf(x); if (k != null) m.set(k, x) })
    return m
  }
  const B = base == null ? null : idx(base)
  const L = idx(local), R = idx(remote)
  const out = new Map()
  // Local order first (it is what this device is looking at), then anything new from remote.
  const keys = [...L.keys(), ...[...R.keys()].filter(k => !L.has(k))]
  for (const k of keys) {
    const l = L.get(k), r = R.get(k), b = B ? B.get(k) : undefined
    if (l !== undefined && r !== undefined) { out.set(k, B ? pick3(b, l, r, onBoth) : (onBoth ? onBoth(l, r) : l)); continue }
    if (!B) { out.set(k, l !== undefined ? l : r); continue }   // no base: union
    if (l !== undefined) {
      // Remote doesn't have it: new here (keep) or deleted there (drop, unless edited here).
      if (b === undefined || !same(l, b)) out.set(k, l)
    } else {
      // Local doesn't have it: new there (keep) or deleted here (drop, unless edited there).
      if (b === undefined || !same(r, b)) out.set(k, r)
    }
  }
  return [...out.values()]
}

function mergeMap(base, local, remote, onBoth) {
  const b = base || {}, l = local || {}, r = remote || {}
  const out = {}
  for (const k of new Set([...Object.keys(l), ...Object.keys(r)])) {
    const has = (o, key) => Object.prototype.hasOwnProperty.call(o, key)
    if (has(l, k) && has(r, k)) { out[k] = base ? pick3(b[k], l[k], r[k], onBoth) : (onBoth ? onBoth(l[k], r[k]) : l[k]); continue }
    const v = has(l, k) ? l[k] : r[k]
    if (!base || !has(b, k) || !same(v, b[k])) out[k] = v   // new, or edited after the other side deleted it
  }
  return out
}

// Two weigh-ins for the same day: the later entry wins.
const newerWeighIn = (l, r) => ((r && r.t) || 0) > ((l && l.t) || 0) ? r : l
// Best weight per exercise: keep the heavier.
const heavier = (l, r) => ((r && r.w) || 0) > ((l && l.w) || 0) ? r : l

/**
 * Merge `local` (this device) and `remote` (what's stored) against `base` (the last state
 * this device knows both agreed on). Returns a new state object.
 */
export function mergeStates(base, local, remote) {
  if (!remote) return local
  if (!local) return remote
  const out = {}
  const keys = new Set([...Object.keys(local), ...Object.keys(remote)])
  for (const k of keys) {
    if (IGNORED.has(k)) continue
    const b = base ? base[k] : undefined, l = local[k], r = remote[k]
    if (KEYED[k]) {
      const onBoth = k === 'bodyweight' ? newerWeighIn : undefined
      out[k] = mergeList(base ? b : null, l, r, KEYED[k], onBoth)
    } else if (MAPS.has(k)) {
      out[k] = mergeMap(base ? b : null, l, r, k === 'exWeights' ? heavier : undefined)
    } else if (k === 'active') {
      // A workout in progress belongs to the device running it. With none here, take the
      // stored one only if it changed since we last agreed (started on another device) —
      // not one this device has since finished or cancelled.
      if (l != null) out[k] = l
      else if (base && same(r, b)) out[k] = null
      else out[k] = r ?? null
    } else {
      out[k] = base ? pick3(b, l, r) : (l !== undefined ? l : r)
    }
  }
  if (Array.isArray(out.workouts)) out.workouts.sort((a, b) => (a.start || 0) - (b.start || 0))
  if (Array.isArray(out.bodyweight)) out.bodyweight.sort((a, b) => String(a.d).localeCompare(String(b.d)))
  // A workout finished elsewhere must not come back as "still in progress" here.
  if (out.active && out.active.id && (out.workouts || []).some(w => w.id === out.active.id)) out.active = null
  return out
}
