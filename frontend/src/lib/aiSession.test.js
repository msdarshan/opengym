import { describe, it, expect } from 'vitest'
import { buildSessionPayload } from './aiSession.js'

const push = {
  id: 'push', name: 'Push', prog: 'double',
  ex: [
    { id: '0025', sets: 4, reps: 8, repsMin: 6 },     // barbell bench press
    { id: '0314', sets: 3, reps: 12, repsMin: 8 },    // dumbbell incline bench press (skipped)
    { id: '0334', sets: 4, reps: 15, repsMin: 12 }    // dumbbell lateral raise
  ]
}
const W = (id, d, start, entries) => ({ id, d, start, end: start + 50 * 60000, routineId: 'push', name: 'Push', bw: 72, entries })
const set = (w, r, extra = {}) => ({ w, r, done: true, ...extra })
const S = {
  unit: 'kg', effort: 'rir', targetW: 75, routines: [push], week: { 4: 'push' }, customEx: [],
  bodyweight: [{ d: '2026-11-01', w: 71.5 }, { d: '2026-11-20', w: 72 }],
  workouts: [
    W('old1', '2026-11-09', 1000, [{ id: '0025', sets: [set(17.5, 8), set(17.5, 7)] }]),
    W('old2', '2026-11-16', 2000, [{ id: '0025', sets: [set(20, 6), set(20, 6), { w: 20, r: 0, done: false }] }]),
    W('today', '2026-11-23', 3000, [
      { id: '0025', sets: [set(20, 8, { rir: 2 }), set(20, 8), set(20, 7), { w: 20, r: 8, done: false }] },
      { id: '0334', sets: [set(5, 12), set(5, 12), set(7.5, 8)] }
    ])
  ]
}

describe('AI coach session payload', () => {
  const p = buildSessionPayload(S, S.workouts[2], '  Should I add a set?  ')
  const bench = p.session.exercises[0]

  it('describes the session with real exercise names and only completed sets', () => {
    expect(p.unit).toBe('kg')
    expect(p.session).toMatchObject({ date: '2026-11-23', routine: 'Push', durationMin: 50, bodyweight: 72 })
    expect(bench).toMatchObject({ name: 'barbell bench press', bodyPart: 'chest' })
    expect(bench.sets).toEqual([{ weight: 20, reps: 8, rir: 2 }, { weight: 20, reps: 8 }, { weight: 20, reps: 7 }])
    expect(bench.unfinishedSets).toBe(1)
  })

  it('includes the plan, rep range and rule', () => {
    expect(bench.plan).toEqual({ sets: 4, rule: 'Double progression', repRange: '6-8' })
  })

  it('includes earlier sessions of the same exercise, newest first, never this one', () => {
    expect(bench.previousSessions.map(s => s.date)).toEqual(['2026-11-16', '2026-11-09'])
    expect(bench.previousSessions[0].sets).toEqual([{ weight: 20, reps: 6 }, { weight: 20, reps: 6 }])
  })

  it('carries the app\'s next target with a readable reason', () => {
    // Three sessions in a row short of the range → the double-progression rule deloads ~10 %.
    expect(bench.nextTarget).toMatchObject({ weight: 17.5, reps: 6 })
    expect(bench.nextTarget.reason).toBe('Stalled 3 sessions — deload to 17.5 kg.')
  })

  it('lists exercises skipped from the plan, the week and the weight trend', () => {
    expect(p.session.skippedFromPlan).toEqual(['dumbbell incline bench press'])
    expect(p.weeklyPlan.Thursday).toBe('Push')
    expect(p.weeklyPlan.Monday).toBe('Rest')
    expect(p.bodyweightTrend).toEqual([{ date: '2026-11-01', weight: 71.5 }, { date: '2026-11-20', weight: 72 }])
    expect(p.effortScale).toBe('rir')
  })

  it('passes the athlete\'s question trimmed, and nothing personal', () => {
    expect(p.athleteNote).toBe('Should I add a set?')
    const json = JSON.stringify(p)
    expect(json).not.toMatch(/gym_sheets|access|key|"id"/i)
    expect(buildSessionPayload(S, S.workouts[2]).athleteNote).toBeUndefined()
  })

  it('works for a workout whose routine was deleted', () => {
    const lone = { ...S.workouts[2], routineId: 'gone', entries: [{ id: '0025', target: { sets: 3, reps: 10 }, sets: [set(20, 10)] }] }
    const q = buildSessionPayload({ ...S, workouts: [...S.workouts.slice(0, 2), lone] }, lone)
    expect(q.session.exercises[0].plan.sets).toBe(3)
    expect(q.session.skippedFromPlan).toEqual([])
  })
})
