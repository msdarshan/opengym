import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  validScriptUrl, workoutRows, weightRows, sheetsPing, sheetsLoad, sheetsSave,
  sheetsConfig, saveSheetsConfig, clearSheetsConfig
} from './sheets.js'

// Plain-Node test run: give the module the localStorage it expects.
const store = new Map()
globalThis.localStorage = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: k => store.delete(k)
}

const URL_OK = 'https://script.google.com/macros/s/AKfycbx_abc-123/exec'
const cfg = { url: URL_OK, key: 'a-long-access-key-123', name: 'Me' }

describe('validScriptUrl', () => {
  it('accepts a deployed web app URL', () => {
    expect(validScriptUrl(URL_OK)).toBe(true)
    expect(validScriptUrl('  ' + URL_OK + '  ')).toBe(true)
  })
  it('rejects editor links, dev links and other sites', () => {
    expect(validScriptUrl('https://script.google.com/home/projects/abc/edit')).toBe(false)
    expect(validScriptUrl('https://script.google.com/macros/s/abc/dev')).toBe(false)
    expect(validScriptUrl('https://evil.example/macros/s/abc/exec')).toBe(false)
    expect(validScriptUrl('')).toBe(false)
  })
})

describe('config', () => {
  beforeEach(() => store.clear())
  it('round-trips and requires url + key', () => {
    expect(sheetsConfig()).toBe(null)
    saveSheetsConfig(cfg)
    expect(sheetsConfig()).toEqual(cfg)
    saveSheetsConfig({ url: URL_OK })
    expect(sheetsConfig()).toBe(null)
    clearSheetsConfig()
    expect(sheetsConfig()).toBe(null)
  })
})

describe('readable tables', () => {
  const S = {
    unit: 'kg',
    customEx: [{ id: 'c1', n: 'My sled push', bp: 'legs' }],
    workouts: [
      {
        d: '2026-11-21', start: 2_000_000, end: 2_000_000 + 45 * 60000, name: 'Push', bw: 72.5,
        entries: [
          { id: '0025', sets: [{ w: 60, r: 8, done: true, rir: 2 }, { w: 60, r: 7, done: true }, { w: 60, r: 0, done: false }] },
          { id: 'c1', sets: [{ sec: 40, w: 20, done: true }] }
        ]
      },
      { d: '2026-11-20', start: 1_000_000, end: null, name: 'Run', entries: [{ id: 'x', sets: [{ min: 20, speed: 9, done: true }] }] }
    ],
    bodyweight: [{ d: '2026-11-21', w: 72.5 }, { d: '2026-11-19', w: 73 }]
  }

  it('writes one row per completed set, oldest workout first', () => {
    const rows = workoutRows(S)
    expect(rows[0][5]).toBe('Weight (kg)')
    expect(rows.length).toBe(1 + 4)               // header + 4 done sets
    expect(rows[1].slice(0, 3)).toEqual(['2026-11-20', 'Run', 'x'])   // unknown id falls back to the id
    expect(rows[1][8]).toBe(20)                   // minutes
    expect(rows[2].slice(0, 7)).toEqual(['2026-11-21', 'Push', 'barbell bench press', 'chest', 1, 60, 8])
    expect(rows[2][10]).toBe(2)                   // RIR
    expect(rows[2][13]).toBe(45)                  // duration
    expect(rows[3][4]).toBe(2)                    // set numbers skip nothing among done sets
    expect(rows[4].slice(2, 8)).toEqual(['My sled push', 'legs', 1, 20, '', 40])
  })

  it('sorts weigh-ins by date', () => {
    expect(weightRows(S)).toEqual([['Date', 'Body weight (kg)'], ['2026-11-19', 73], ['2026-11-21', 72.5]])
  })
})

describe('talking to the script', () => {
  let calls
  const respond = (body, { ok = true, status = 200, raw } = {}) => {
    globalThis.fetch = vi.fn(async (url, init) => {
      calls.push({ url, init, body: JSON.parse(init.body) })
      return { ok, status, text: async () => raw ?? JSON.stringify(body) }
    })
  }
  beforeEach(() => { calls = []; store.clear() })
  afterEach(() => { delete globalThis.fetch })

  it('sends the key in a text/plain POST body, never the URL', async () => {
    respond({ ok: true, sheet: 'openGym data' })
    await expect(sheetsPing(cfg)).resolves.toMatchObject({ sheet: 'openGym data' })
    expect(calls[0].url).toBe(URL_OK)
    expect(calls[0].init.method).toBe('POST')
    expect(calls[0].init.headers['Content-Type']).toMatch(/^text\/plain/)
    expect(calls[0].body).toEqual({ action: 'ping', key: cfg.key })
  })

  it('load returns null state for an empty Sheet', async () => {
    respond({ ok: true, state: null })
    await expect(sheetsLoad(cfg)).resolves.toEqual({ state: null })
  })

  it('save sends the state plus both tables', async () => {
    respond({ ok: true })
    const S = { unit: 'kg', workouts: [], bodyweight: [{ d: '2026-11-01', w: 70 }] }
    await sheetsSave(S, cfg)
    expect(calls[0].body.action).toBe('save')
    expect(calls[0].body.state).toEqual(S)
    expect(calls[0].body.workouts).toHaveLength(1)
    expect(calls[0].body.bodyweight).toHaveLength(2)
  })

  it('surfaces the script\'s error, e.g. a wrong key', async () => {
    respond({ ok: false, status: 401, error: 'Wrong access key' })
    await expect(sheetsLoad(cfg)).rejects.toMatchObject({ message: 'Wrong access key', status: 401 })
  })

  it('explains an HTML answer (deployed without "Anyone" access)', async () => {
    respond(null, { raw: '<!doctype html><title>Sign in</title>' })
    await expect(sheetsPing(cfg)).rejects.toThrow(/Who has access: Anyone/)
  })

  it('reports a network failure as status 0', async () => {
    globalThis.fetch = vi.fn(async () => { throw new TypeError('Failed to fetch') })
    await expect(sheetsSave({}, cfg)).rejects.toMatchObject({ status: 0 })
  })

  it('retries an empty answer and a failed request, then succeeds', async () => {
    let n = 0
    globalThis.fetch = vi.fn(async () => {
      n++
      if (n === 1) throw new TypeError('Failed to fetch')
      if (n === 2) return { ok: true, status: 200, text: async () => '' }
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, state: null }) }
    })
    await expect(sheetsLoad(cfg)).resolves.toEqual({ state: null })
    expect(n).toBe(3)
  })

  it('gives up after repeated empty answers with a clear error', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, text: async () => '' }))
    await expect(sheetsLoad(cfg)).rejects.toMatchObject({ status: 0, message: expect.stringMatching(/didn’t answer/) })
    expect(globalThis.fetch).toHaveBeenCalledTimes(3)
  })

  it('aborts a request that hangs', async () => {
    vi.useFakeTimers()
    globalThis.fetch = vi.fn((url, init) => new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    }))
    const p = sheetsLoad(cfg)
    const check = expect(p).rejects.toMatchObject({ status: 0 })
    await vi.advanceTimersByTimeAsync(30000 * 3 + 10)
    await check
    expect(globalThis.fetch).toHaveBeenCalledTimes(3)
    vi.useRealTimers()
  })

  it('explains a missing Apps Script permission instead of a generic web-page error', async () => {
    respond(null, { raw: '<html>Exception: You do not have permission to call UrlFetchApp.fetch. Required permissions: ...</html>' })
    await expect(sheetsPing(cfg)).rejects.toThrow(/run authorizeCoach/)
  })

  it('refuses to run without a saved connection', async () => {
    await expect(sheetsLoad()).rejects.toMatchObject({ status: 401 })
  })
})
