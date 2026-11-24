# Google Sheets storage for openGym

This lets openGym run as a plain static site (GitHub Pages) with your data saved in a
Google Sheet in your own Google Drive. A small Apps Script attached to the Sheet stands in
for the openGym server.

What you get: sync between your devices, data that survives clearing the browser, and
readable **Workouts** and **Body weight** tabs in the Sheet.
What you don't get (they need the Node server): passkey sign-in, multiple profiles,
invites/admin, push notifications and the AI Coach.

## 1. Create the Sheet and the script (about 5 minutes)

1. Go to <https://sheets.new> and name the spreadsheet, e.g. **openGym data**.
2. In the menu: **Extensions → Apps Script**.
3. Delete everything in the editor and paste the whole of [`Code.gs`](Code.gs).
4. On the line `const ACCESS_KEY = 'PASTE_YOUR_ACCESS_KEY_HERE';` replace the placeholder
   with a long random key (20+ characters, letters and numbers). Keep a copy — you type the
   same key into the app.
5. Click **Save** (the disk icon).

**Alternative:** if Extensions → Apps Script doesn't open (for example a browser that blocks
the new tab), create a standalone project at <https://script.new> instead, paste the same
code, and set `SHEET_ID` to the long ID in your Sheet's URL (between `/d/` and `/edit`).

## 2. Deploy it as a web app

1. Click **Deploy → New deployment**.
2. Click the gear next to *Select type* and choose **Web app**.
3. Set **Execute as: Me** and **Who has access: Anyone**.
   ("Anyone" only means the URL is reachable; every request still needs your access key.)
4. Click **Deploy**, then **Authorize access**, pick your Google account.
   Google warns that the app isn't verified because you wrote it yourself:
   click **Advanced → Go to (project name) (unsafe) → Allow**.
5. Copy the **Web app URL**. It looks like
   `https://script.google.com/macros/s/AKfy…/exec`.

## 3. Connect the app

Open your openGym site, paste the **Web app URL** and your **access key**, and tap
**Connect Google Sheet**. Do the same once on every device you use.

## 4. AI coach (optional, free)

The app can ask Google Gemini for feedback on a session ("Analyze this session" on the
workout summary and in History).

1. Get a free API key at <https://aistudio.google.com/apikey>.
2. In Apps Script: **Project Settings (gear) → Script properties → Add script property**:
   name `GEMINI_API_KEY`, value = your key → **Save script properties**.
3. In the editor, choose **`authorizeCoach`** in the function list and click **Run**, then
   approve **"Connect to an external service"**. The log should say *"Gemini key works"*.

The key stays in your Google account; the app never sees it. Only the session's training
data is sent (no name or access key). On Gemini's free tier Google may use what you send to
improve its products. If the first model on the list is busy or retired, the script tries
the next one; set a `GEMINI_MODEL` script property to pin one.

## Changing the script later

After editing `Code.gs` (for example to change the key), use **Deploy → Manage deployments →
✎ Edit → Version: New version → Deploy**. This keeps the same URL. Creating a *new*
deployment gives a new URL that you'd have to enter on every device again.

## Notes

- Keep the URL and key private. Anyone with both can read and change your gym data.
- Don't edit the hidden `_opengym_data` tab. The Workouts and Body weight tabs are
  rewritten on every save, so changes there are overwritten.
- Saves happen in the background a moment after each change and take 1–2 seconds.
  If you're offline, the app keeps your data and saves on the next change.
- Moving from an openGym server: export a backup there (Settings → Export), connect this
  version, then import the backup (Settings → Import).
