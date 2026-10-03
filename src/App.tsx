import { useEffect, useState } from 'react'
import { addMessage, createDebate, deleteDebate, getDebate, getSettings, saveSettings } from './db'
import { forgetRunner, getModels, recoverInterrupted, startDebate } from './engine'
import { useDebates, useHashRoute, useOnline, useSettings } from './hooks'
import { completePkce } from './openrouter'
import type { Debate } from './types'
import { Sidebar } from './components/Sidebar'
import { ChatView } from './components/ChatView'
import { NewDebate } from './components/NewDebate'
import { SettingsModal } from './components/SettingsModal'

export function App() {
  const debates = useDebates()
  const settings = useSettings()
  const online = useOnline()
  const [selectedId, select] = useHashRoute()
  const [settingsOpen, setSettingsOpen] = useState<{ reason?: string } | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [toast, setToast] = useState('')

  // Startup: finish OpenRouter login if we're returning from it, recover interrupted debates, warm model cache
  useEffect(() => {
    recoverInterrupted()
    completePkce()
      .then(async (key) => {
        if (!key) return
        await saveSettings({ apiKey: key })
        setToast('Connected to OpenRouter')
      })
      .catch((e) => {
        setSettingsOpen({ reason: 'OpenRouter login failed: ' + e.message })
      })
    if (navigator.onLine) getModels().catch(() => {})
  }, [])

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(''), 3500)
    return () => clearTimeout(t)
  }, [toast])

  const selected = debates?.find((d) => d._id === selectedId) ?? null
  // Unknown id in URL (e.g. deleted) -> go to new debate
  useEffect(() => {
    if (!debates || !selectedId || selected) return
    let alive = true
    getDebate(selectedId).then((d) => { if (alive && !d) select(null) })
    return () => { alive = false }
  }, [debates, selectedId, selected])

  const needKey = () => setSettingsOpen({ reason: 'Connect your OpenRouter account to start debating. The app needs it to talk to the AI models.' })

  const start = async (topic: string): Promise<boolean> => {
    const s = await getSettings()
    if (!s.apiKey) { needKey(); return false }
    const d = await createDebate({
      title: topic.length > 60 ? topic.slice(0, 57) + '…' : topic,
      topic,
      status: 'planning',
      overviewModel: s.overviewModel,
      participants: [],
      points: [],
      round: 0,
      maxRounds: s.maxRounds,
      cost: 0,
    })
    await addMessage({ debateId: d._id, author: 'user', authorName: 'You', content: topic, round: 0 })
    select(d._id)
    void startDebate(d._id)
    return true
  }

  const remove = async (d: Debate) => {
    if (!confirm(`Delete "${d.title}"? This can't be undone.`)) return
    forgetRunner(d._id)
    if (d._id === selectedId) select(null)
    await deleteDebate(d._id)
  }

  return (
    <div className={'app' + (sidebarOpen ? ' sidebar-open' : '')}>
      <Sidebar
        debates={debates}
        selectedId={selectedId}
        online={online}
        onSelect={(id) => { select(id); setSidebarOpen(false) }}
        onDelete={remove}
        onSettings={() => { setSettingsOpen({}); setSidebarOpen(false) }}
      />
      <div className="sidebar-scrim" onClick={() => setSidebarOpen(false)} />
      <main className="main">
        {selected ? (
          <ChatView
            key={selected._id}
            debate={selected}
            online={online}
            hasKey={!!settings.apiKey}
            onNeedKey={needKey}
            onMenu={() => setSidebarOpen(true)}
          />
        ) : (
          <>
            <button className="icon-btn menu-btn floating" onClick={() => setSidebarOpen(true)} aria-label="Debates">☰</button>
            <NewDebate online={online} onStart={start} />
          </>
        )}
      </main>
      {settingsOpen && <SettingsModal reason={settingsOpen.reason} onClose={() => setSettingsOpen(null)} />}
      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}
