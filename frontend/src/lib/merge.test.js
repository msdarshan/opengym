import { describe, it, expect } from 'vitest'
import { mergeStates, sameState } from './merge.js'

const W = (id, start, extra = {}) => ({ id, d: '2026-11-23', start, end: start + 1, name: 'W' + id, entries: [], ...extra })
const R = (id, ex = []) => ({ id, name: 'R' + id, ex })
const base = {
  _ts: 1, unit: 'kg', restSec: 90,
  routines: [R('up', ['a', 'b'])], week: { 1: 'up' }, dayPlan: {},
  workouts: [W('w0', 100)], bodyweight: [{ d: '2026-11-01', w: 70, t: 1 }],
  exWeights: { a: { w: 50, d: '2026-11-01' } }, customEx: [], active: null
}
const clone = o => JSON.parse(JSON.stringify(o))

describe('the incident: stale tab edits a routine while the phone logged a workout', () => {
  it('keeps both the new workout and the routine edit', () => {
    const phone = clone(base); phone.workouts.push(W('w1', 200)); phone.exWeights.a = { w: 55, d: '2026-11-23' }
    const stale = clone(base); stale.routines[0].ex.push('lateral')
    // Phone saved first; the stale tab now saves against what it last saw (base).
    const merged = mergeStates(base, stale, phone)
    expect(merged.workouts.map(w => w.id)).toEqual(['w0', 'w1'])
    expect(merged.routines[0].ex).toEqual(['a', 'b', 'lateral'])
    expect(merged.exWeights.a.w).toBe(55)
  })
  it('a phone with no merge history (base null) unions workouts back in', () => {
    const lostOnPhone = clone(base); lostOnPhone.routines[0].ex.push('lateral')
    const restored = clone(base); restored.workouts.push(W('w1', 200))
    const merged = mergeStates(null, lostOnPhone, restored)
    expect(merged.workouts.map(w => w.id)).toEqual(['w0', 'w1'])
    expect(merged.routines[0].ex).toContain('lateral')   // local wins without a base
  })
})

describe('deletions', () => {
  it('a workout deleted here stays deleted', () => {
    const local = clone(base); local.workouts = []
    expect(mergeStates(base, local, clone(base)).workouts).toEqual([])
  })
  it('a workout deleted elsewhere stays deleted', () => {
    const remote = clone(base); remote.workouts = []
    expect(mergeStates(base, clone(base), remote).workouts).toEqual([])
  })
  it('deleted elsewhere but edited here: the edit survives', () => {
    const remote = clone(base); remote.workouts = []
    const local = clone(base); local.workouts[0].name = 'renamed'
    expect(mergeStates(base, local, remote).workouts.map(w => w.name)).toEqual(['renamed'])
  })
  it('a routine deleted on one device is not resurrected', () => {
    const local = clone(base); local.routines = []
    const remote = clone(base); remote.workouts.push(W('w2', 300))
    const m = mergeStates(base, local, remote)
    expect(m.routines).toEqual([])
    expect(m.workouts).toHaveLength(2)
  })
})

describe('both sides changed', () => {
  it('workouts from both devices are kept, oldest first', () => {
    const local = clone(base); local.workouts.push(W('L', 400))
    const remote = clone(base); remote.workouts.push(W('Rm', 300))
    expect(mergeStates(base, local, remote).workouts.map(w => w.id)).toEqual(['w0', 'Rm', 'L'])
  })
  it('settings: only-changed side wins, true conflict goes to this device', () => {
    const local = clone(base); local.restSec = 120
    const remote = clone(base); remote.unit = 'lb'
    const m = mergeStates(base, local, remote)
    expect([m.restSec, m.unit]).toEqual([120, 'lb'])
    const r2 = clone(base); r2.restSec = 60
    expect(mergeStates(base, local, r2).restSec).toBe(120)
  })
  it('week entries merge per day', () => {
    const local = clone(base); local.week[4] = 'up'
    const remote = clone(base); remote.week[6] = 'up'; delete remote.week[1]
    expect(mergeStates(base, local, remote).week).toEqual({ 4: 'up', 6: 'up' })
  })
  it('same-day weigh-ins keep the later one', () => {
    const local = clone(base); local.bodyweight.push({ d: '2026-11-23', w: 71, t: 10 })
    const remote = clone(base); remote.bodyweight.push({ d: '2026-11-23', w: 72, t: 20 })
    expect(mergeStates(base, local, remote).bodyweight.at(-1).w).toBe(72)
  })
  it('best weights keep the heavier', () => {
    const local = clone(base); local.exWeights.a = { w: 60, d: 'x' }
    const remote = clone(base); remote.exWeights.a = { w: 57.5, d: 'y' }
    expect(mergeStates(base, local, remote).exWeights.a.w).toBe(60)
  })
})

describe('workout in progress', () => {
  const act = { id: 'live', name: 'Upper', start: 500, entries: [] }
  it('stays on the device running it', () => {
    const local = clone(base); local.active = act
    expect(mergeStates(base, local, clone(base)).active).toEqual(act)
  })
  it('a workout this device finished does not come back from a stale copy', () => {
    const remote = clone(base); remote.active = act                     // saved mid-workout
    const local = clone(base); local.workouts.push(W('live', 500))      // then finished here
    const m = mergeStates({ ...clone(base), active: act }, local, remote)
    expect(m.active).toBe(null)
    expect(m.workouts.map(w => w.id)).toContain('live')
  })
  it('finished elsewhere: the in-progress copy is dropped', () => {
    const local = clone(base); local.active = act
    const remote = clone(base); remote.workouts.push(W('live', 500))
    expect(mergeStates(base, local, remote).active).toBe(null)
  })
})

describe('sameState', () => {
  it('ignores the timestamp and key order', () => {
    expect(sameState({ a: 1, b: { c: 2, d: 3 }, _ts: 5 }, { b: { d: 3, c: 2 }, a: 1, _ts: 9 })).toBe(true)
    expect(sameState({ a: 1 }, { a: 2 })).toBe(false)
  })
})
