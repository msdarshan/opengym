// AI coach panel (Google Sheets build) — feedback on one workout, only when asked.
//
// Shown on the "Workout complete" summary and in a workout's detail sheet. Tapping the button
// sends the session (lib/aiSession.js) to the script, which asks Gemini. The answer is saved
// on the workout (`w.ai`), so it syncs to other devices and stays readable later.
import { useState } from 'react'
import { useStore } from '../store/useStore.js'
import { SHEETS, sheetsAnalyze } from '../lib/sheets.js'
import { buildSessionPayload } from '../lib/aiSession.js'
import { t } from '../lib/i18n.js'
import Icon from './Icon.jsx'
import { Button } from './ui.jsx'

/* ---- tiny Markdown subset: ## headings, - / 1. bullets, **bold**, paragraphs ----
   Rendered as React elements (never as HTML), so model output can't inject markup. */
function inline(text, key) {
  const out = []
  const re = /\*\*(.+?)\*\*/g
  let last = 0, m, i = 0
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index))
    out.push(<strong key={key + '-' + i++}>{m[1]}</strong>)
    last = m.index + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

export function MiniMarkdown({ text }) {
  const lines = String(text || '').replace(/\r/g, '').split('\n')
  const blocks = []
  let list = null, para = []
  const flushPara = () => { if (para.length) { blocks.push({ type: 'p', text: para.join(' ') }); para = [] } }
  const flushList = () => { if (list) { blocks.push(list); list = null } }
  for (const raw of lines) {
    const line = raw.trim()
    const h = line.match(/^#{1,4}\s+(.*)$/)
    const li = line.match(/^(?:[-*•]|\d+[.)])\s+(.*)$/)
    if (!line) { flushPara(); flushList(); continue }
    if (h) { flushPara(); flushList(); blocks.push({ type: 'h', text: h[1] }); continue }
    if (li) { flushPara(); (list = list || { type: 'ul', items: [] }).items.push(li[1]); continue }
    flushList(); para.push(line)
  }
  flushPara(); flushList()
  return <div className="aimd">
    {blocks.map((b, i) => b.type === 'h' ? <h4 key={i}>{inline(b.text, 'h' + i)}</h4>
      : b.type === 'ul' ? <ul key={i}>{b.items.map((it, j) => <li key={j}>{inline(it, i + '-' + j)}</li>)}</ul>
      : <p key={i}>{inline(b.text, 'p' + i)}</p>)}
  </div>
}

export default function AiCoach({ workoutId }) {
  const user = useStore(s => s.user)
  const w = useStore(s => (s.S.workouts || []).find(x => x.id === workoutId))
  const update = useStore(s => s.update)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [asking, setAsking] = useState(false)
  const [note, setNote] = useState('')
  if (!SHEETS || !user || !w) return null

  const run = async () => {
    setErr(''); setBusy(true)
    try {
      const S = useStore.getState().S
      const cur = (S.workouts || []).find(x => x.id === workoutId)
      const res = await sheetsAnalyze(buildSessionPayload(S, cur, note))
      if (!res.text) throw new Error(t('The coach sent back an empty answer — try again'))
      update(s => {
        const x = (s.workouts || []).find(x => x.id === workoutId)
        if (x) x.ai = { text: res.text, at: Date.now(), model: res.model, ...(note.trim() ? { note: note.trim().slice(0, 500) } : {}), ...(res.truncated ? { truncated: true } : {}) }
      })
      setNote(''); setAsking(false)
    } catch (e) {
      setErr(e.message || t('Could not reach the coach'))
    }
    setBusy(false)
  }

  const ai = w.ai
  return <div className="card aicoach" style={{ textAlign: 'left' }}>
    <div className="row between" style={{ marginBottom: ai ? 6 : 4, gap: 8 }}>
      <div className="row" style={{ gap: 8, alignItems: 'center' }}>
        <Icon name="sparkles" className="accent" />
        <div className="tt" style={{ fontWeight: 600 }}>{t('AI coach')}</div>
      </div>
      {ai && <div className="dim small">{new Date(ai.at).toLocaleDateString()}</div>}
    </div>

    {ai ? <>
      {ai.note && <div className="small muted" style={{ marginBottom: 6 }}>{t('You asked:')} “{ai.note}”</div>}
      <MiniMarkdown text={ai.text} />
      {ai.truncated && <div className="dim small">{t('(The answer was cut short.)')}</div>}
    </> : !busy && <div className="small muted" style={{ marginBottom: 10 }}>
      {t('Get feedback on this session and what to do next time.')}
    </div>}

    {busy && <div className="small muted row" style={{ gap: 8, margin: '8px 0' }}>
      <span className="syncdot busy" style={{ '--sync': 'var(--blue)' }} aria-hidden="true" />{t('The coach is looking at your session…')}
    </div>}
    {err && <div className="small" role="alert" style={{ color: 'var(--red)', margin: '8px 0' }}>{err}</div>}

    {!busy && <>
      {asking && <textarea className="input" rows={2} maxLength={500} value={note} onChange={e => setNote(e.target.value)}
        placeholder={t('Ask the coach something about this session (optional)')} style={{ marginBottom: 8, resize: 'vertical' }} />}
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <Button variant={ai ? 'tinted' : 'primary'} icon="sparkles" onClick={run}>{ai ? t('Ask again') : t('Analyze this session')}</Button>
        {!asking && <Button variant="ghost" onClick={() => setAsking(true)}>{t('Add a question')}</Button>}
      </div>
      <div className="dim small" style={{ marginTop: 8, lineHeight: 1.4 }}>
        {t('Uses Google Gemini through your own Google account. Only this session’s training data is sent.')}
      </div>
    </>}
  </div>
}
