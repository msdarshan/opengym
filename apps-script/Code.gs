/**
 * openGym — Google Sheets storage.
 *
 * Paste this whole file into Extensions → Apps Script of a Google Sheet, set ACCESS_KEY
 * below, then Deploy → New deployment → Web app (Execute as: Me, Who has access: Anyone).
 * Step-by-step guide: apps-script/README.md in the openGym repository.
 *
 * The app sends its whole state on every save, exactly like the openGym server's
 * PUT /api/data. It is stored as JSON split across rows of a hidden "_opengym_data" tab
 * (one cell holds at most 50,000 characters). Do not edit that tab by hand.
 * The "Workouts" and "Body weight" tabs are rewritten on every save for you to read —
 * edits there are overwritten and never flow back into the app.
 */

// Choose a long random key (20+ characters) and enter the same key in the app.
// Anyone with this key and the web app URL can read and change your gym data.
const ACCESS_KEY = 'PASTE_YOUR_ACCESS_KEY_HERE';

// Leave empty when the script was created from the Sheet (Extensions → Apps Script).
// For a standalone project (script.new), put the spreadsheet's ID here — the long part of
// its URL between /d/ and /edit.
const SHEET_ID = '';

const DATA_SHEET = '_opengym_data';
const CHUNK = 40000;            // characters per cell, under Sheets' 50,000 limit
const MAX_STATE = 20 * 1000 * 1000;

function doPost(e) {
  let req;
  try {
    req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return reply({ ok: false, status: 400, error: 'Bad request' });
  }
  if (!ACCESS_KEY || ACCESS_KEY === 'PASTE_YOUR_ACCESS_KEY_HERE' || ACCESS_KEY.length < 12) {
    return reply({ ok: false, status: 500, error: 'Set ACCESS_KEY in the Apps Script code (12+ characters), then deploy a new version' });
  }
  if (typeof req.key !== 'string' || !safeEqual(req.key, ACCESS_KEY)) {
    return reply({ ok: false, status: 401, error: 'Wrong access key' });
  }

  // The AI coach needs no spreadsheet access.
  if (req.action === 'analyze') return reply(analyze(req.payload));

  const ss = SHEET_ID ? SpreadsheetApp.openById(SHEET_ID) : SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) return reply({ ok: false, status: 500, error: 'No spreadsheet — set SHEET_ID in the Apps Script code' });
  switch (req.action) {
    case 'ping':
      return reply({ ok: true, sheet: ss.getName(), ai: !!geminiKey() });
    case 'load':
      return reply({ ok: true, state: readState(ss) });
    case 'save': {
      if (!req.state || typeof req.state !== 'object') {
        return reply({ ok: false, status: 400, error: 'Missing state' });
      }
      const lock = LockService.getScriptLock();
      if (!lock.tryLock(25000)) return reply({ ok: false, status: 503, error: 'Busy — try again' });
      try {
        writeState(ss, req.state);
        if (Array.isArray(req.workouts)) writeTable(ss, 'Workouts', req.workouts);
        if (Array.isArray(req.bodyweight)) writeTable(ss, 'Body weight', req.bodyweight);
      } finally {
        lock.releaseLock();
      }
      return reply({ ok: true });
    }
    default:
      return reply({ ok: false, status: 400, error: 'Unknown action' });
  }
}

// Opening the URL in a browser just confirms the deployment works; no data over GET.
function doGet() {
  return reply({ ok: true, app: 'openGym storage', hint: 'The openGym app talks to this URL with POST requests.' });
}

function reply(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

function dataSheet(ss) {
  let sh = ss.getSheetByName(DATA_SHEET);
  if (!sh) {
    sh = ss.insertSheet(DATA_SHEET);
    sh.hideSheet();
  }
  return sh;
}

function readState(ss) {
  const sh = ss.getSheetByName(DATA_SHEET);
  if (!sh || sh.getLastRow() < 1) return null;
  const vals = sh.getRange(1, 1, sh.getLastRow(), 1).getValues();
  // Each chunk is stored with a leading "j" so Sheets never reads it as a number or formula.
  const json = vals.map(function (r) { return String(r[0] || '').slice(1); }).join('');
  if (!json) return null;
  try { return JSON.parse(json); } catch (err) { return null; }
}

function writeState(ss, state) {
  const json = JSON.stringify(state);
  if (json.length > MAX_STATE) throw new Error('State too large');
  const rows = [];
  for (let i = 0; i < json.length; i += CHUNK) rows.push(['j' + json.slice(i, i + CHUNK)]);
  const sh = dataSheet(ss);
  sh.clearContents();
  if (rows.length) {
    if (sh.getMaxRows() < rows.length) sh.insertRowsAfter(sh.getMaxRows(), rows.length - sh.getMaxRows());
    const range = sh.getRange(1, 1, rows.length, 1);
    range.setNumberFormat('@');
    range.setValues(rows);
  }
}

function writeTable(ss, name, rows) {
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  sh.clearContents();
  if (!rows.length) return;
  const width = rows[0].length;
  const clean = rows.map(function (r) {
    const out = [];
    for (let i = 0; i < width; i++) {
      const v = r[i];
      // Text that starts with = + - @ would be read as a formula; prefix it so it stays text.
      out.push(typeof v === 'string' && /^[=+\-@]/.test(v) ? "'" + v : (v == null ? '' : v));
    }
    return out;
  });
  if (sh.getMaxRows() < clean.length) sh.insertRowsAfter(sh.getMaxRows(), clean.length - sh.getMaxRows());
  if (sh.getMaxColumns() < width) sh.insertColumnsAfter(sh.getMaxColumns(), width - sh.getMaxColumns());
  sh.getRange(1, 1, clean.length, width).setValues(clean);
  sh.getRange(1, 1, 1, width).setFontWeight('bold');
  sh.setFrozenRows(1);
}

/* ------------------------------------------------------------------------------------------
 * AI coach — post-session feedback from Google Gemini (free tier).
 *
 * Setup: get a free API key at https://aistudio.google.com/apikey, then in this Apps Script
 * project open Project Settings (gear) → Script properties → Add property:
 *   GEMINI_API_KEY = <your key>
 * Optional: GEMINI_MODEL to pin a model instead of the list below.
 * The key stays in your Google account; the app never sees it.
 *
 * Note: on Gemini's free tier, Google may use what you send to improve its products.
 * The app sends only the session's training data (exercises, sets, weights, reps, effort,
 * body weight, your note) — never your name, access key or other accounts' data.
 * ---------------------------------------------------------------------------------------- */

// Tried in order: the first that exists on the free tier answers. Gemini model names change
// often — if all of these are gone, set GEMINI_MODEL in Script properties.
const GEMINI_MODELS = ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite'];
const MAX_PAYLOAD = 60000;  // characters of session data sent to the model

const COACH_PROMPT = [
  'You are an experienced, encouraging strength and hypertrophy coach reviewing ONE gym session',
  'that the athlete just logged in the openGym app. You receive the session as JSON: the',
  'exercises done with every set (weight, reps, optional RIR/RPE effort), the plan targets and',
  'progression rule for each exercise, the previous sessions of the same exercises, the target',
  'the app will prescribe next time (`nextTarget`, with its reason), skipped exercises, recent',
  'body weight, the weekly plan, and optionally a question from the athlete (`athleteNote`).',
  '',
  'Write a short, specific review (about 150-250 words) in Markdown with these sections:',
  '## How it went — 2-3 sentences; name real numbers and compare with previous sessions.',
  '## Next session — 2-4 bullets with concrete weights/reps per exercise. Agree with the',
  '   app\'s nextTarget unless the data clearly says otherwise, and then say why.',
  '## Watch out — only if the data shows something (e.g. big rep drop-offs, sets far below',
  '   the rep range, warm-up sets logged as work sets, skipped exercises, very short rests',
  '   implied by duration). Otherwise leave this section out.',
  'If there is an athleteNote, answer it in a final ## Your question section.',
  '',
  'Rules: use the athlete\'s unit (`unit`). Dumbbell weights are per dumbbell. Be direct and',
  'practical, no generic filler, no emojis. Never give medical diagnoses; if pain or injury is',
  'mentioned, suggest stopping that movement and seeing a professional. If the data is too thin',
  'for a recommendation, say what to log next time instead of guessing.'
].join('\n');

function geminiKey() {
  return PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY') || '';
}

function analyze(payload) {
  const key = geminiKey();
  if (!key) {
    return { ok: false, status: 503, error: 'The AI coach isn’t set up yet — add GEMINI_API_KEY under Apps Script → Project Settings → Script properties' };
  }
  if (!payload || typeof payload !== 'object') return { ok: false, status: 400, error: 'Missing session data' };
  const text = JSON.stringify(payload);
  if (text.length > MAX_PAYLOAD) return { ok: false, status: 413, error: 'Session data too large to analyze' };

  const pinned = PropertiesService.getScriptProperties().getProperty('GEMINI_MODEL');
  const models = pinned ? [pinned] : GEMINI_MODELS;
  let busy = null;
  for (let i = 0; i < models.length; i++) {
    let res = callGemini(key, models[i], text, true);
    if (res.retryWithoutThinking) res = callGemini(key, models[i], text, false);
    if (res.notFound) continue;                       // model retired → try the next one
    if (res.overloaded) { busy = res; continue; }     // free tier busy → try the next one
    return res;
  }
  if (busy) return { ok: false, status: 503, error: 'Gemini is very busy right now (free tier) — try again in a few minutes' };
  return { ok: false, status: 404, error: 'None of the Gemini models are available — set GEMINI_MODEL in Script properties' };
}

function callGemini(key, model, text, withThinking) {
  const body = {
    systemInstruction: { parts: [{ text: COACH_PROMPT }] },
    contents: [{ role: 'user', parts: [{ text: 'My session (JSON):\n' + text }] }],
    generationConfig: { maxOutputTokens: 8192 }
  };
  if (withThinking) body.generationConfig.thinkingConfig = { thinkingLevel: 'LOW' };

  const r = UrlFetchApp.fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent',
    { method: 'post', contentType: 'application/json', headers: { 'x-goog-api-key': key },
      payload: JSON.stringify(body), muteHttpExceptions: true });
  const code = r.getResponseCode();
  let d = {};
  try { d = JSON.parse(r.getContentText()); } catch (err) { /* not JSON */ }
  const msg = (d.error && d.error.message) || '';

  if (code === 404) return { notFound: true };
  // "This model is currently experiencing high demand" (503) or a server error: another model
  // on the list may well be free.
  if (code === 503 || code === 500 || code === 502 || code === 504) return { overloaded: true, status: code };
  if (code === 400 && withThinking && /thinking/i.test(msg)) return { retryWithoutThinking: true };
  if (code === 429) return { ok: false, status: 429, error: 'The free Gemini limit is used up for now — try again in a few minutes' };
  if (code === 401 || code === 403) return { ok: false, status: code, error: 'Gemini rejected the API key — check GEMINI_API_KEY in Script properties' };
  if (code !== 200) return { ok: false, status: code, error: 'Gemini error ' + code + (msg ? ': ' + msg : '') };

  if (d.promptFeedback && d.promptFeedback.blockReason) {
    return { ok: false, status: 422, error: 'Gemini declined this request (' + d.promptFeedback.blockReason + ')' };
  }
  const c = (d.candidates || [])[0];
  const parts = (c && c.content && c.content.parts) || [];
  const out = parts.filter(function (p) { return p.text && !p.thought; }).map(function (p) { return p.text; }).join('').trim();
  if (!out) return { ok: false, status: 502, error: 'Gemini returned no text' + (c && c.finishReason ? ' (' + c.finishReason + ')' : '') };
  return { ok: true, text: out, model: model, truncated: !!(c && c.finishReason === 'MAX_TOKENS') };
}

// Run this once from the editor (choose it in the function list, click Run) to grant the
// "Connect to an external service" permission the AI coach needs. It also checks the key:
// the log shows whether Gemini accepted it.
function authorizeCoach() {
  const r = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=50',
    { headers: { 'x-goog-api-key': geminiKey() }, muteHttpExceptions: true });
  const code = r.getResponseCode();
  if (code !== 200) { Logger.log('Gemini answered HTTP ' + code + ' — check GEMINI_API_KEY in Script properties'); return; }
  const names = (JSON.parse(r.getContentText()).models || []).map(function (m) { return String(m.name).replace('models/', ''); });
  const usable = GEMINI_MODELS.filter(function (m) { return names.indexOf(m) !== -1; });
  Logger.log('Gemini key works. Coach will use: ' + (usable[0] || 'none of ' + GEMINI_MODELS.join(', ') + ' — set GEMINI_MODEL'));
}
