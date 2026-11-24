// AI coach (Google Sheets build): turn one logged workout into the compact JSON the coach
// reads. Everything here is derived from the state — nothing personal beyond training data
// (no name, no access key) is included. The script forwards it to Gemini (apps-script/Code.gs).

import { EXIDX } from './exercises.js'
import { modeOf } from './history.js'
import { nextPrescription, policyFor, POLICY_NAME } from './progression.js'
import { DAYN } from './format.js'

const HISTORY_PER_EXERCISE = 3

const exInfo = (S, id) => {
  const ex = EXIDX[id] || (S.customEx || []).find(c => c.id === id)
  return { name: ex?.n || id, bodyPart: ex?.bp || '', equipment: ex?.eq || '' }
}

/** A logged set reduced to the fields that mean something for its kind. */
function setOut(s) {
  const o = {}
  if (s.w != null && s.w !== '') o.weight = +s.w
  if (s.r != null) o.reps = s.r
  if (s.sec != null) o.seconds = s.sec
  if (s.min != null) o.minutes = s.min
  if (s.speed != null) o.speed = s.speed
  if (s.rir != null) o.rir = s.rir
  if (s.rpe != null) o.rpe = s.rpe
  return o
}

/** "{0} kg more, back to {2} reps" → filled in from a progression `why` template. */
const fillWhy = why => {
  if (!Array.isArray(why) || !why.length) return ''
  const [tpl, ...args] = why
  return String(tpl).replace(/\{(\d+)\}/g, (_, i) => (args[+i] ?? ''))
}

function planOf(cfg, routine) {
  if (!cfg) return null
  const mode = modeOf(cfg)
  const rule = policyFor(cfg, routine, mode)
  const plan = { sets: cfg.sets, rule: POLICY_NAME[rule] || rule }
  if (mode === 'time') plan.seconds = cfg.sec
  else if (mode === 'cardio') { plan.minutes = cfg.min; plan.speed = cfg.speed }
  else if (rule === 'double') plan.repRange = `${cfg.repsMin || Math.max(1, (cfg.reps || 10) - 2)}-${cfg.reps}`
  else plan.reps = cfg.reps
  return plan
}

/**
 * Build the coach's input for workout `w` (which must already be in `S.workouts`).
 * `note` is an optional question from the athlete.
 */
export function buildSessionPayload(S, w, note = '') {
  const routine = (S.routines || []).find(r => r.id === w.routineId) || null
  const before = (S.workouts || []).filter(x => x.id !== w.id && (x.start || 0) < (w.start || 0))
    .sort((a, b) => (b.start || 0) - (a.start || 0))

  const exercises = (w.entries || []).map(e => {
    const cfg = (routine?.ex || []).find(c => c.id === e.id) || e.target || null
    const prev = []
    for (const x of before) {
      const pe = (x.entries || []).find(pe => pe.id === e.id)
      if (pe && pe.sets.some(s => s.done)) prev.push({ date: x.d, sets: pe.sets.filter(s => s.done).map(setOut) })
      if (prev.length >= HISTORY_PER_EXERCISE) break
    }
    let nextTarget = null
    if (cfg) {
      try {
        const p = nextPrescription(S, { ...cfg, id: e.id }, routine)
        if (p && p.kind !== 'off') {
          nextTarget = {}
          if (p.weight != null) nextTarget.weight = p.weight
          if (p.reps != null) nextTarget.reps = p.reps
          if (p.sec != null) nextTarget.seconds = p.sec
          const why = fillWhy(p.why); if (why) nextTarget.reason = why
        }
      } catch { /* no prescription for this one */ }
    }
    return {
      ...exInfo(S, e.id),
      plan: planOf(cfg, routine),
      sets: (e.sets || []).filter(s => s.done).map(setOut),
      ...(e.sets || []).some(s => !s.done) ? { unfinishedSets: (e.sets || []).filter(s => !s.done).length } : {},
      previousSessions: prev,
      ...(nextTarget ? { nextTarget } : {})
    }
  })

  const done = new Set((w.entries || []).map(e => e.id))
  const skipped = (routine?.ex || []).filter(c => !done.has(c.id)).map(c => exInfo(S, c.id).name)

  const week = {}
  for (let d = 1; d <= 7; d++) {
    const day = d % 7
    const r = (S.routines || []).find(x => x.id === S.week?.[day])
    week[DAYN[day]] = r ? r.name : 'Rest'
  }

  const bw = [...(S.bodyweight || [])].sort((a, b) => String(a.d).localeCompare(String(b.d))).slice(-6)
    .map(b => ({ date: b.d, weight: b.w }))

  return {
    unit: S.unit || 'kg',
    effortScale: S.effort && S.effort !== 'none' ? S.effort : null,
    session: {
      date: w.d,
      routine: w.name || routine?.name || '',
      durationMin: w.end && w.start ? Math.round((w.end - w.start) / 60000) : null,
      bodyweight: w.bw ?? null,
      exercises,
      skippedFromPlan: skipped
    },
    bodyweightTrend: bw,
    targetBodyweight: S.targetW ?? null,
    weeklyPlan: week,
    ...(note && note.trim() ? { athleteNote: note.trim().slice(0, 500) } : {})
  }
}
