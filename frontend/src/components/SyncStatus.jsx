// Google Sheets build: a small light showing whether this device's data is saved in the Sheet.
//
//   green  Synced · 2 min ago          blue (pulsing)  Syncing…
//   orange Not saved yet               red             Offline / Not synced
//
// Tapping it saves now. Renders nothing outside the Sheets build or when not connected.
import { useEffect, useState } from 'react'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { SHEETS } from '../lib/sheets.js'
import { t } from '../lib/i18n.js'

const COLOR = { ok: 'var(--green)', syncing: 'var(--blue)', pending: 'var(--orange)', offline: 'var(--red)', error: 'var(--red)' }

export function ago(at, now = Date.now()) {
  if (!at) return ''
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 45) return t('just now')
  const m = Math.round(s / 60)
  if (m < 60) return t('{0} min ago', m)
  const h = Math.round(m / 60)
  if (h < 24) return t('{0} h ago', h)
  return new Date(at).toLocaleDateString()
}

/** Short label + longer explanation for a sync state. */
export function syncText(sync, now) {
  switch (sync.state) {
    case 'ok': return [t('Synced'), sync.at ? t('Saved to Google Sheets {0}', ago(sync.at, now)) : t('Saved to Google Sheets')]
    case 'syncing': return [t('Syncing…'), t('Talking to Google Sheets…')]
    case 'offline': return [t('Offline'), t('No connection — changes are kept on this device and saved when you’re back online')]
    case 'error': return [t('Not synced'), (sync.error || t('Google Sheets didn’t take the last save')) + ' · ' + t('tap to retry')]
    default: return [t('Not saved yet'), t('A change here is waiting to be saved to Google Sheets')]
  }
}

function useTick(ms) {
  const [, setN] = useState(0)
  useEffect(() => { const iv = setInterval(() => setN(n => n + 1), ms); return () => clearInterval(iv) }, [ms])
}

/** Compact pill for headers. `full` shows the longer explanation instead of the short label. */
export default function SyncStatus({ full = false }) {
  const user = useStore(s => s.user)
  const sync = useStore(s => s.sync)
  const pushState = useStore(s => s.pushState)
  useTick(30000)
  if (!SHEETS || !user || !sync) return null
  const [label, detail] = syncText(sync)
  const color = COLOR[sync.state] || COLOR.pending
  const retry = async () => {
    await pushState()
    const s = useStore.getState().sync
    useUI.getState().toast(s.state === 'ok' ? t('Saved to Google Sheets') : syncText(s)[1])
  }
  return (
    <button type="button" className={'syncpill' + (full ? ' full' : '')} onClick={retry}
      title={detail} aria-label={t('Sync status: {0}. Tap to save now.', detail)} data-state={sync.state}>
      <span className={'syncdot' + (sync.state === 'syncing' ? ' busy' : '')} style={{ '--sync': color }} aria-hidden="true" />
      <span className="synclabel">{full ? detail : label}</span>
    </button>
  )
}
