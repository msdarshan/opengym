// Google Sheets storage build (VITE_STORAGE=sheets) — for hosting openGym as static files
// (e.g. GitHub Pages) with no Node backend.
//
// Your data lives in a Google Sheet in your own Drive. A small Google Apps Script bound to
// that Sheet (apps-script/Code.gs) is deployed as a web app and plays the part of the
// server's /api/data: the app sends it the whole state on every save and reads it back on
// load, exactly as it does with the real backend — so the sync rules in useStore.js
// (timestamps, the dirty flag, "newest wins") are unchanged.
//
// There are no passkeys here: the script checks an access key you choose, stored on each
// device once. Anyone with both the script URL and the key can read and change the data,
// so keep them private.
//
// Besides the raw state, every save also sends two readable tables — one row per logged
// set, one row per weigh-in — which the script writes to the "Workouts" and "Body weight"
// tabs so you can look at your history in Sheets.

import { EXIDX } from './exercises.js'

export const SHEETS = import.meta.env.VITE_STORAGE === 'sheets'

const CFG_KEY = 'gym_sheets'

/** The saved connection for this device, or null. */
export function sheetsConfig() {
  try {
    const c = JSON.parse(localStorage.getItem(CFG_KEY))
    return c && c.url && c.key ? c : null
  } catch { return null }
}
export const saveSheetsConfig = c => localStorage.setItem(CFG_KEY, JSON.stringify(c))
export const clearSheetsConfig = () => localStorage.removeItem(CFG_KEY)

/** The stand-in "user" the rest of the app sees while connected. */
export const sheetsUser = c => ({ id: 'sheets', name: (c && c.name) || 'Me', sheets: true })

/** A deployed Apps Script web app URL ends in /exec. */
export const validScriptUrl = u =>
  /^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec\/?$/.test((u || '').trim())

// Apps Script web apps answer a POST with a redirect to script.googleusercontent.com; fetch
// follows it. text/plain keeps this a "simple" request, so no CORS preflight is needed —
// Apps Script cannot answer one. The key travels in the body, never in the URL.
// Google occasionally leaves a request hanging for minutes or answers with an empty body.
// Each attempt gets a time limit, and a hung or empty answer is tried again, so one bad
// request can't stall syncing until the app is restarted.
export const TIMEOUT_MS = 30000
const ATTEMPTS = 3

async function call(cfg, body, { timeoutMs = TIMEOUT_MS, attempts = ATTEMPTS } = {}) {
  let r, text = ''
  for (let i = 0; i < attempts; i++) {
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null
    const tm = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null
    try {
      r = await fetch(cfg.url.trim(), {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ ...body, key: cfg.key }),
        redirect: 'follow',
        ...(ctl ? { signal: ctl.signal } : {})
      })
      text = await r.text()
    } catch (e) {
      r = null; text = ''
    } finally {
      if (tm) clearTimeout(tm)
    }
    if (r && (text || !r.ok)) break
  }
  if (!r) {
    const err = new Error('Could not reach your Google Sheet — check your connection')
    err.status = 0
    throw err
  }
  if (r.ok && !text) {
    const err = new Error('Google Sheets didn’t answer — your data is kept and will be saved on the next try')
    err.status = 0
    throw err
  }
  let data
  try { data = JSON.parse(text) } catch {
    const err = new Error(r.ok
      ? 'Google answered with a web page instead of data — redeploy the script with "Who has access: Anyone"'
      : 'Google Sheets error (HTTP ' + r.status + ')')
    err.status = r.status
    throw err
  }
  if (!data.ok) {
    const err = new Error(data.error || 'Google Sheets request failed')
    err.status = data.status || 400
    throw err
  }
  return data
}

/** Check a URL + key pair before saving it. Resolves to { sheet } (the spreadsheet's name). */
export const sheetsPing = cfg => call(cfg, { action: 'ping' })

/** Same contract as GET /api/data: resolves to { state } (null when the Sheet is empty). */
export async function sheetsLoad(cfg = sheetsConfig()) {
  if (!cfg) { const e = new Error('Not connected to Google Sheets'); e.status = 401; throw e }
  const d = await call(cfg, { action: 'load' })
  return { state: d.state || null }
}

/**
 * AI coach: send one session's data to the script, which asks Gemini (apps-script/Code.gs).
 * Resolves to { text, model, truncated }. One attempt only — a retried request could be
 * answered twice and use up the free quota — with a longer limit, since the model thinks.
 */
export async function sheetsAnalyze(payload, cfg = sheetsConfig()) {
  if (!cfg) { const e = new Error('Not connected to Google Sheets'); e.status = 401; throw e }
  const d = await call(cfg, { action: 'analyze', payload }, { timeoutMs: 120000, attempts: 1 })
  return { text: d.text || '', model: d.model || '', truncated: !!d.truncated }
}

/** Same contract as PUT /api/data, plus the readable tables. */
export async function sheetsSave(state, cfg = sheetsConfig()) {
  if (!cfg) { const e = new Error('Not connected to Google Sheets'); e.status = 401; throw e }
  await call(cfg, { action: 'save', state, workouts: workoutRows(state), bodyweight: weightRows(state) })
}

const exName = (S, id) =>
  EXIDX[id]?.n || (S.customEx || []).find(c => c.id === id)?.n || id
const exPart = (S, id) =>
  EXIDX[id]?.bp || (S.customEx || []).find(c => c.id === id)?.bp || ''
const num = v => (v == null || v === '' || Number.isNaN(+v) ? '' : +v)

/** One row per completed set, oldest first, with a header row. */
export function workoutRows(S) {
  const unit = S.unit || 'kg'
  const rows = [['Date', 'Workout', 'Exercise', 'Body part', 'Set', `Weight (${unit})`, 'Reps',
    'Seconds', 'Minutes', 'Speed (km/h)', 'RIR', 'RPE', 'Body weight', 'Duration (min)']]
  const ws = [...(S.workouts || [])].sort((a, b) => (a.start || 0) - (b.start || 0))
  for (const w of ws) {
    const dur = w.end && w.start ? Math.round((w.end - w.start) / 60000) : ''
    for (const e of w.entries || []) {
      // A logged set carries only the fields its kind uses (w/r, sec, or min/speed), so
      // writing whatever is present puts each kind in its own columns.
      let n = 0
      for (const s of e.sets || []) {
        if (!s.done) continue
        n++
        rows.push([
          w.d || '', w.name || '', exName(S, e.id), exPart(S, e.id), n,
          num(s.w), num(s.r), num(s.sec), num(s.min), num(s.speed),
          num(s.rir), num(s.rpe), num(w.bw), dur
        ])
      }
    }
  }
  return rows
}

/** One row per weigh-in, oldest first, with a header row. */
export function weightRows(S) {
  const unit = S.unit || 'kg'
  const rows = [['Date', `Body weight (${unit})`]]
  const bw = [...(S.bodyweight || [])].sort((a, b) => String(a.d).localeCompare(String(b.d)))
  for (const b of bw) rows.push([b.d || '', num(b.w)])
  return rows
}
