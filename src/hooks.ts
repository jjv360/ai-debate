import { useEffect, useState, useSyncExternalStore } from 'react'
import { getSettings, listDebates, listMessages, onDbChange } from './db'
import { engineVersion, subscribeEngine } from './engine'
import { DEFAULT_SETTINGS, type Debate, type Message, type Settings } from './types'

export function useDebates(): Debate[] | null {
  const [list, setList] = useState<Debate[] | null>(null)
  useEffect(() => {
    let alive = true
    const load = () => listDebates().then((l) => alive && setList(l))
    load()
    const off = onDbChange((d) => { if (d._id.startsWith('debate:')) load() })
    return () => { alive = false; off() }
  }, [])
  return list
}

export function useMessages(debateId: string | null): Message[] {
  const [msgs, setMsgs] = useState<Message[]>([])
  useEffect(() => {
    setMsgs([])
    if (!debateId) return
    let alive = true
    const load = () => listMessages(debateId).then((l) => alive && setMsgs(l))
    load()
    const off = onDbChange((d) => { if (d._id.startsWith('msg:' + debateId + ':')) load() })
    return () => { alive = false; off() }
  }, [debateId])
  return msgs
}

export function useSettings(): Settings & { loaded: boolean } {
  const [s, setS] = useState<Settings & { loaded: boolean }>({ ...DEFAULT_SETTINGS, loaded: false })
  useEffect(() => {
    const load = () => getSettings().then((v) => setS({ ...v, loaded: true }))
    load()
    return onDbChange((d) => { if (d._id === 'settings') load() })
  }, [])
  return s
}

export function useEngine(): number {
  return useSyncExternalStore(subscribeEngine, engineVersion)
}

export function useOnline(): boolean {
  const [online, setOnline] = useState(navigator.onLine)
  useEffect(() => {
    const on = () => setOnline(true)
    const off = () => setOnline(false)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off) }
  }, [])
  return online
}

/** Selected debate id, kept in the URL hash (#/d/<id>) */
export function useHashRoute(): [string | null, (id: string | null) => void] {
  const read = () => {
    const m = location.hash.match(/^#\/d\/(.+)$/)
    return m ? decodeURIComponent(m[1]) : null
  }
  const [id, setId] = useState<string | null>(read)
  useEffect(() => {
    const h = () => setId(read())
    window.addEventListener('hashchange', h)
    return () => window.removeEventListener('hashchange', h)
  }, [])
  const nav = (next: string | null) => {
    location.hash = next ? '#/d/' + encodeURIComponent(next) : '#/'
  }
  return [id, nav]
}
