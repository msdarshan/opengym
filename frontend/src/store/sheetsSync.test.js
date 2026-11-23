// End-to-end check of the Google Sheets sync with two "devices" sharing one Sheet.
// Each device is a fresh copy of the real store module with its own localStorage; the
// Sheet is an in-memory stand-in for the Apps Script web app.
import { describe, it, expect, beforeEach, vi } from 'vitest'

const URL = 'https://script.google.com/macros/s/AKfyTEST/exec'
const KEY = 'test-access-key-123456'
let sheet

const storage = () => {
  const m = new Map()
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), _m: m }
}

globalThis.document = globalThis.document || { addEventListener() {}, visibilityState: 'visible' }
globalThis.fetch = async (url, init) => {
  const b = JSON.parse(init.body)
  const send = o => ({ ok: true, status: 200, text: async () => JSON.stringify(o) })
  if (b.key !== KEY) return send({ ok: false, status: 401, error: 'Wrong access key' })
  if (b.action === 'ping') return send({ ok: true, sheet: 'test' })
  if (b.action === 'load') return send({ ok: true, state: sheet ? JSON.parse(sheet) : null })
  if (b.action === 'save') { sheet = JSON.stringify(b.state); return send({ ok: true }) }
  return send({ ok: false, error: 'bad' })
}

// Each device: its own localStorage + its own module instance of the store.
async function device() {
  const ls = storage()
  globalThis.localStorage = ls
  vi.resetModules()
  vi.stubEnv('VITE_STORAGE', 'sheets')
  const { useStore } = await import('./useStore.js')
  const on = async fn => { globalThis.localStorage = ls; return fn(useStore.getState()) }
  return { on, ls, store: useStore }
}
const names = S => (S.workouts || []).map(w => w.name)
const upperEx = S => S.routines.find(r => r.name === 'Upper').ex.map(e => e.id)
const stored = () => JSON.parse(sheet)

beforeEach(() => {
  sheet = JSON.stringify({
    unit: 'kg', routines: [{ id: 'up', name: 'Upper', ex: [{ id: '0047', sets: 4, reps: 8 }] }],
    week: { 1: 'up' }, workouts: [], bodyweight: [], exWeights: {}, customEx: [], dayPlan: {}, active: null, _ts: 1
  })
})

describe('Google Sheets sync between two devices', () => {
  it('a stale device editing a routine does not erase a workout logged elsewhere (the incident)', async () => {
    const phone = await device()
    await phone.on(s => s.connectSheets({ url: URL, key: KEY, name: 'Me' }))
    const mac = await device()
    await mac.on(s => s.connectSheets({ url: URL, key: KEY, name: 'Me' }))

    // Phone logs and finishes a workout; it reaches the Sheet.
    await phone.on(async s => { s.update(S => { S.workouts.push({ id: 'w1', d: '2026-11-23', start: 10, end: 20, name: 'Monday upper', entries: [] }) }, false); await s.pushState() })
    expect(names(stored())).toEqual(['Monday upper'])

    // The Mac tab never reloaded. Adding the lateral raise there used to save its old copy.
    await mac.on(async s => { s.update(S => { S.routines[0].ex.push({ id: '0334', sets: 3, reps: 15 }) }, false); await s.pushState() })
    expect(names(stored())).toEqual(['Monday upper'])          // workout survived
    expect(upperEx(stored())).toEqual(['0047', '0334'])        // and so did the edit
    expect(names(mac.store.getState().S)).toEqual(['Monday upper'])   // the Mac got the workout too

    // Phone reopens: it keeps its workout and picks up the routine edit.
    await phone.on(s => s.pullState())
    expect(names(phone.store.getState().S)).toEqual(['Monday upper'])
    expect(upperEx(phone.store.getState().S)).toEqual(['0047', '0334'])
  })

  it('workouts logged on both devices before either syncs are both kept', async () => {
    const a = await device(); await a.on(s => s.connectSheets({ url: URL, key: KEY }))
    const b = await device(); await b.on(s => s.connectSheets({ url: URL, key: KEY }))
    await a.on(s => s.update(S => { S.workouts.push({ id: 'A', start: 1, name: 'A', entries: [] }) }, false))
    await b.on(s => s.update(S => { S.workouts.push({ id: 'B', start: 2, name: 'B', entries: [] }) }, false))
    await a.on(s => s.pushState())
    await b.on(s => s.pushState())
    expect(names(stored())).toEqual(['A', 'B'])
    await a.on(s => s.pullState())
    expect(names(a.store.getState().S)).toEqual(['A', 'B'])
  })

  it('a deletion on one device propagates instead of being undone by the other', async () => {
    sheet = JSON.stringify({ ...JSON.parse(sheet), workouts: [{ id: 'old', start: 1, name: 'old', entries: [] }] })
    const a = await device(); await a.on(s => s.connectSheets({ url: URL, key: KEY }))
    const b = await device(); await b.on(s => s.connectSheets({ url: URL, key: KEY }))
    await a.on(async s => { s.update(S => { S.workouts = [] }, false); await s.pushState() })
    await b.on(async s => { s.update(S => { S.unit = 'lb' }, false); await s.pushState() })
    expect(names(stored())).toEqual([])
    expect(stored().unit).toBe('lb')
  })

  it('connecting keeps a workout logged on this device before it was connected', async () => {
    const phone = await device()
    // Logged without a connection ("Continue without syncing", or not connected yet).
    await phone.on(s => { s.setGuest(true); s.update(S => { S.workouts.push({ id: 'gym', start: 50, name: 'Logged offline', entries: [] }) }, false) })
    const how = await phone.on(s => s.connectSheets({ url: URL, key: KEY, name: 'Me' }))
    expect(how).toBe('merged')
    expect(names(phone.store.getState().S)).toEqual(['Logged offline'])   // still on the phone
    expect(names(stored())).toEqual(['Logged offline'])                    // and now in the Sheet
    expect(upperEx(stored())).toEqual(['0047'])                            // the Sheet's plan kept
  })

  it('a fresh device with nothing logged simply loads the Sheet', async () => {
    const d = await device()
    expect(await d.on(s => s.connectSheets({ url: URL, key: KEY }))).toBe('pulled')
    expect(upperEx(d.store.getState().S)).toEqual(['0047'])
  })

  it('the sync light follows connect → change → save → failure', async () => {
    const d = await device()
    await d.on(s => s.connectSheets({ url: URL, key: KEY }))
    expect(d.store.getState().sync.state).toBe('ok')
    expect(d.store.getState().sync.at).toBeGreaterThan(0)

    await d.on(s => s.update(S => { S.unit = 'lb' }))           // a real change schedules a save
    expect(d.store.getState().sync.state).toBe('pending')

    await d.on(s => s.pushState())
    expect(d.store.getState().sync.state).toBe('ok')
    expect(stored().unit).toBe('lb')

    const realFetch = globalThis.fetch
    globalThis.fetch = async () => { throw new TypeError('Failed to fetch') }
    try {
      await d.on(s => { s.update(S => { S.unit = 'kg' }, false); return s.pushState() })
      expect(d.store.getState().sync.state).toBe('error')
      expect(d.store.getState().sync.error).toMatch(/reach your Google Sheet/)
      expect(d.ls.getItem('gym_dirty')).toBe('1')
    } finally { globalThis.fetch = realFetch }

    await d.on(s => s.pushState())                               // back online: retry succeeds
    expect(d.store.getState().sync.state).toBe('ok')
    expect(stored().unit).toBe('kg')
  })

  it('a device on the old version (no merge history) merges a restored Sheet back in', async () => {
    const phone = await device()
    await phone.on(s => s.connectSheets({ url: URL, key: KEY }))
    phone.ls.removeItem('gym_sheets_base')                     // as if synced by the old code
    // The Sheet is restored from version history with the lost workout.
    sheet = JSON.stringify({ ...JSON.parse(sheet), workouts: [{ id: 'lost', start: 5, name: 'restored', entries: [] }], _ts: 0 })
    await phone.on(s => s.pullState())
    expect(names(phone.store.getState().S)).toEqual(['restored'])
    expect(names(stored())).toEqual(['restored'])
  })
})
