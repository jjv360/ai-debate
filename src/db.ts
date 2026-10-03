import PouchDB from 'pouchdb-browser'
import { DEFAULT_SETTINGS, type Debate, type Message, type Settings } from './types'

type Doc = Debate | Message | Settings | CacheDoc
interface CacheDoc { _id: string; _rev?: string; type: 'cache'; data: unknown; savedAt: number }

export const db = new PouchDB<Doc>('ai-debate')

// ---------- ids ----------
let lastTs = 0
/** Monotonic, sortable timestamp-ish id fragment */
export function seqId(): string {
  let ts = Date.now()
  if (ts <= lastTs) ts = lastTs + 1
  lastTs = ts
  return ts.toString(36).padStart(10, '0')
}
export function randomId(len = 6): string {
  return Math.random().toString(36).slice(2, 2 + len)
}

// ---------- generic upsert with conflict retry ----------
async function upsert<T extends Doc>(id: string, fn: (existing: T | undefined) => T): Promise<T> {
  for (let attempt = 0; attempt < 5; attempt++) {
    let existing: T | undefined
    try { existing = (await db.get(id)) as unknown as T } catch (e: any) { if (e.status !== 404) throw e }
    const next = fn(existing)
    next._id = id
    if (existing?._rev) next._rev = existing._rev
    try {
      const res = await db.put(next as any)
      return { ...next, _rev: res.rev }
    } catch (e: any) {
      if (e.status !== 409) throw e
    }
  }
  throw new Error('Could not save ' + id + ' (conflict)')
}

// ---------- settings ----------
export async function getSettings(): Promise<Settings> {
  try {
    const s = (await db.get('settings')) as Settings
    return { ...DEFAULT_SETTINGS, ...s }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}
export function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  return upsert<Settings>('settings', (s) => ({ ...DEFAULT_SETTINGS, ...s, ...patch, _id: 'settings' }))
}

// ---------- debates ----------
export async function listDebates(): Promise<Debate[]> {
  const res = await db.allDocs({ include_docs: true, startkey: 'debate:', endkey: 'debate:\ufff0' })
  return res.rows.map((r) => r.doc as Debate).sort((a, b) => b.createdAt - a.createdAt)
}
export async function getDebate(id: string): Promise<Debate | undefined> {
  try { return (await db.get(id)) as Debate } catch { return undefined }
}
export async function createDebate(d: Omit<Debate, '_id' | 'type' | 'createdAt' | 'updatedAt'>): Promise<Debate> {
  const now = Date.now()
  const doc: Debate = { ...d, _id: 'debate:' + seqId() + randomId(4), type: 'debate', createdAt: now, updatedAt: now }
  const res = await db.put(doc)
  return { ...doc, _rev: res.rev }
}
export function updateDebate(id: string, patch: Partial<Debate> | ((d: Debate) => Partial<Debate>)): Promise<Debate> {
  return upsert<Debate>(id, (d) => {
    if (!d) throw new Error('Debate not found')
    const p = typeof patch === 'function' ? patch(d) : patch
    return { ...d, ...p, updatedAt: Date.now() }
  })
}
export async function deleteDebate(id: string): Promise<void> {
  const msgs = await db.allDocs({ startkey: msgPrefix(id), endkey: msgPrefix(id) + '\ufff0' })
  const docs = msgs.rows.map((r) => ({ _id: r.id, _rev: r.value.rev, _deleted: true }))
  try {
    const d = await db.get(id)
    docs.push({ _id: d._id, _rev: d._rev, _deleted: true })
  } catch { /* already gone */ }
  if (docs.length) await db.bulkDocs(docs as any)
}

// ---------- messages ----------
const msgPrefix = (debateId: string) => 'msg:' + debateId + ':'

export async function listMessages(debateId: string): Promise<Message[]> {
  const res = await db.allDocs({ include_docs: true, startkey: msgPrefix(debateId), endkey: msgPrefix(debateId) + '\ufff0' })
  return res.rows.map((r) => r.doc as Message)
}
export async function addMessage(m: Omit<Message, '_id' | 'type' | 'createdAt'>): Promise<Message> {
  const doc: Message = { ...m, _id: msgPrefix(m.debateId) + seqId(), type: 'message', createdAt: Date.now() }
  const res = await db.put(doc)
  return { ...doc, _rev: res.rev }
}

// ---------- small cache (e.g. model list for offline use) ----------
export async function getCache<T>(key: string): Promise<{ data: T; savedAt: number } | undefined> {
  try {
    const d = (await db.get('cache:' + key)) as CacheDoc
    return { data: d.data as T, savedAt: d.savedAt }
  } catch { return undefined }
}
export function setCache(key: string, data: unknown): Promise<unknown> {
  return upsert<CacheDoc>('cache:' + key, () => ({ _id: 'cache:' + key, type: 'cache', data, savedAt: Date.now() }))
}

// ---------- change notifications ----------
type Listener = (doc: Doc & { _deleted?: boolean }) => void
const listeners = new Set<Listener>()
db.changes({ live: true, since: 'now', include_docs: true }).on('change', (c) => {
  const doc = (c.doc ?? { _id: c.id, _deleted: true }) as Doc & { _deleted?: boolean }
  if (c.deleted) doc._deleted = true
  listeners.forEach((l) => l(doc))
})
export function onDbChange(l: Listener): () => void {
  listeners.add(l)
  return () => { listeners.delete(l) }
}
