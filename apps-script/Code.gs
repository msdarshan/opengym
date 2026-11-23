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

  const ss = SHEET_ID ? SpreadsheetApp.openById(SHEET_ID) : SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) return reply({ ok: false, status: 500, error: 'No spreadsheet — set SHEET_ID in the Apps Script code' });
  switch (req.action) {
    case 'ping':
      return reply({ ok: true, sheet: ss.getName() });
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
