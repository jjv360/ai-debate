/**
 * Orchestrates debates: planning, parallel participant rounds, judging and concluding.
 * Runs in memory (one runner per debate) and persists everything to PouchDB as it goes.
 */
import { judgeRound, planDebate, buildParticipantMessages, cleanReply, PARTICIPANT_COLORS, type TranscriptEntry } from './agents'
import { addMessage, getCache, getDebate, getSettings, listDebates, listMessages, randomId, setCache, updateDebate } from './db'
import { chat, fetchModels, OpenRouterError, supportsTools, WEB_TOOLS, type ModelInfo } from './openrouter'
import type { Debate, Message } from './types'

export type Phase = 'planning' | 'debating' | 'judging'

export interface RunnerState {
  phase: Phase
  /** participant id -> streamed text so far ('' = thinking) */
  drafts: Record<string, string>
}

interface Runner {
  abort: AbortController
  state: RunnerState
}

const runners = new Map<string, Runner>()
const listeners = new Set<() => void>()
let version = 0

function emit() {
  version++
  listeners.forEach((l) => l())
}
export function subscribeEngine(l: () => void): () => void {
  listeners.add(l)
  return () => { listeners.delete(l) }
}
export function engineVersion(): number {
  return version
}
export function getRunnerState(debateId: string): RunnerState | undefined {
  return runners.get(debateId)?.state
}
export function isRunning(debateId: string): boolean {
  return runners.has(debateId)
}

// ---------- models (cached for offline / speed) ----------
// v2: entries include supported_parameters (needed to know which models support tools)
const MODELS_CACHE = 'models-v2'
export async function getModels(force = false): Promise<ModelInfo[]> {
  const cached = await getCache<ModelInfo[]>(MODELS_CACHE)
  if (!force && cached && Date.now() - cached.savedAt < 6 * 3600_000) return cached.data
  try {
    const models = await fetchModels()
    await setCache(MODELS_CACHE, models)
    return models
  } catch (e) {
    if (cached) return cached.data
    throw e
  }
}

// ---------- startup ----------
/** Debates left "running" by a previous session (page closed mid-debate) become paused. */
export async function recoverInterrupted(): Promise<void> {
  for (const d of await listDebates()) {
    if ((d.status === 'running' || d.status === 'planning') && !runners.has(d._id)) {
      await updateDebate(d._id, { status: 'paused' })
    }
  }
}

// ---------- public actions ----------
export async function startDebate(debateId: string): Promise<void> {
  if (runners.has(debateId)) return
  const runner: Runner = { abort: new AbortController(), state: { phase: 'debating', drafts: {} } }
  runners.set(debateId, runner)
  emit()
  try {
    await run(debateId, runner)
  } catch (e: any) {
    if (!runner.abort.signal.aborted) {
      console.error(e)
      const msg = e?.message || String(e)
      await addMessage({ debateId, author: 'system', authorName: 'System', content: msg, round: (await getDebate(debateId))?.round ?? 0, kind: 'error' })
      await updateDebate(debateId, { status: 'error', error: msg })
    }
  } finally {
    runners.delete(debateId)
    emit()
  }
}

export async function stopDebate(debateId: string): Promise<void> {
  const r = runners.get(debateId)
  if (!r) return
  r.abort.abort()
  runners.delete(debateId)
  emit()
  await updateDebate(debateId, { status: 'paused' })
}

/** Called when the human types in the chat. Resumes the debate if it isn't running. */
export async function postUserMessage(debateId: string, content: string): Promise<void> {
  const d = await getDebate(debateId)
  if (!d) return
  await addMessage({ debateId, author: 'user', authorName: 'You', content, round: d.round })
  if (!runners.has(debateId) && d.participants.length) {
    const settings = await getSettings()
    // Give the debate a fresh round budget if it had used it up
    const maxRounds = d.round >= d.maxRounds ? d.round + settings.maxRounds : d.maxRounds
    await updateDebate(debateId, { status: 'running', maxRounds, outcome: undefined, error: undefined })
    void startDebate(debateId)
  }
}

export function forgetRunner(debateId: string) {
  const r = runners.get(debateId)
  if (r) {
    r.abort.abort()
    runners.delete(debateId)
    emit()
  }
}

// ---------- the loop ----------
/** Participant failure notices are shared with the agents; other system/app errors are not. */
function isParticipantNotice(m: Message): boolean {
  // Older notices predate the `about` field, so fall back to their wording
  return m.kind === 'error' && m.author === 'system' && (!!m.about || / failed to respond: /.test(m.content))
}

function toTranscript(msgs: Message[]): TranscriptEntry[] {
  return msgs
    .filter((m) => isParticipantNotice(m) || (m.kind !== 'error' && m.author !== 'system'))
    .map((m) => ({ author: m.author, authorName: m.authorName, content: m.content, round: m.round }))
}

/** Human-readable reason for a failed request */
function describeError(e: any): string {
  if (e instanceof OpenRouterError) {
    if (e.status === 401 || e.status === 402) return `OpenRouter key problem: ${e.message}`
    if (e.status === 403) return `OpenRouter refused the request (key limit, model restriction or moderation): ${e.message}`
    if (e.status === undefined) return e.message
    return `OpenRouter error ${e.status}: ${e.message}`
  }
  return e?.message || String(e)
}

/** Runs a moderator request; failures stop the debate (it can be resumed) with a clear message. */
async function asModerator<T>(model: string, signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    if (signal.aborted) throw e
    throw new Error(`The moderator (${model}) failed to respond, so the debate was stopped: ${describeError(e)}. Resume the debate to try again.`)
  }
}

async function addCost(debateId: string, cost: number) {
  if (cost > 0) await updateDebate(debateId, (d) => ({ cost: (d.cost || 0) + cost }))
}

async function run(debateId: string, runner: Runner) {
  const signal = runner.abort.signal
  const settings = await getSettings()
  if (!settings.apiKey) throw new Error('No OpenRouter API key set. Open Settings to connect your account.')
  const apiKey = settings.apiKey

  let debate = (await getDebate(debateId)) as Debate
  if (!debate) return

  // ----- planning -----
  if (!debate.participants.length) {
    runner.state.phase = 'planning'
    emit()
    await updateDebate(debateId, { status: 'planning' })
    let models: ModelInfo[] = []
    try { models = await getModels() } catch { /* plan without list */ }
    const { plan, cost } = await asModerator(debate.overviewModel, signal, () =>
      planDebate({ apiKey, model: debate.overviewModel, topic: debate.topic, models, signal }),
    )
    if (signal.aborted) return
    await addCost(debateId, cost)
    debate = await updateDebate(debateId, {
      title: plan.title,
      points: plan.points,
      status: 'running',
      participants: plan.participants.map((p, i) => ({
        id: 'p' + randomId(5),
        name: p.name,
        model: p.model,
        stance: p.stance,
        color: PARTICIPANT_COLORS[i % PARTICIPANT_COLORS.length],
      })),
    })
    if (plan.opening) {
      await addMessage({ debateId, author: 'moderator', authorName: 'Moderator', content: plan.opening, round: 0, model: debate.overviewModel })
    }
  } else {
    debate = await updateDebate(debateId, { status: 'running', error: undefined })
  }

  // ----- rounds -----
  // Models that can use web tools this session. If the model list is unavailable, tools are skipped.
  let toolModels: ModelInfo[] = []
  if (settings.webTools) {
    try { toolModels = await getModels() } catch { /* no web tools */ }
  }
  /** Models whose tool requests were rejected - retried without tools for the rest of the run */
  const toolsRejected = new Set<string>()

  for (;;) {
    if (signal.aborted) return
    debate = (await getDebate(debateId)) as Debate
    const round = debate.round + 1
    const transcript = toTranscript(await listMessages(debateId))

    runner.state.phase = 'debating'
    runner.state.drafts = Object.fromEntries(debate.participants.map((p) => [p.id, '']))
    emit()

    let posted = 0
    let failed = 0
    await Promise.all(
      debate.participants.map(async (p) => {
        try {
          const ask = (webAccess: boolean) => chat({
            apiKey,
            model: p.model,
            signal,
            maxTokens: 4000,
            tools: webAccess ? WEB_TOOLS : undefined,
            messages: buildParticipantMessages({
              topic: debate.topic,
              points: debate.points,
              me: p,
              others: debate.participants.filter((o) => o.id !== p.id),
              transcript,
              round,
              webAccess,
            }),
            onDelta: (text) => {
              if (!runners.has(debateId)) return
              runner.state.drafts = { ...runner.state.drafts, [p.id]: text }
              emit()
            },
          })
          const webAccess = settings.webTools && !toolsRejected.has(p.model) && supportsTools(toolModels, p.model)
          let res
          try {
            res = await ask(webAccess)
          } catch (e) {
            // e.g. "No endpoints found that support tool use" - fall back to a plain request
            if (!webAccess || signal.aborted || !(e instanceof OpenRouterError) || (e.status !== 400 && e.status !== 404)) throw e
            console.warn(`Web tools rejected for ${p.model}, retrying without:`, e.message)
            toolsRejected.add(p.model)
            res = await ask(false)
          }
          if (signal.aborted) return
          await addCost(debateId, res.cost)
          const reply = cleanReply(res.content, p.name)
          // Persist before removing the draft so the bubble doesn't flicker
          if (reply) {
            posted++
            await addMessage({ debateId, author: p.id, authorName: p.name, content: reply, round, model: res.model })
          }
        } catch (e: any) {
          if (signal.aborted) return
          // Participant failures don't stop the debate: the notice is shown in the chat and
          // shared with the other agents (and the moderator) so they know why this one is silent.
          failed++
          console.warn(`${p.name} (${p.model}) failed:`, e)
          await addMessage({
            debateId,
            author: 'system',
            authorName: 'System',
            content: `${p.name} (${p.model}) failed to respond: ${describeError(e)}`,
            round,
            kind: 'error',
            about: p.id,
          })
        } finally {
          const { [p.id]: _drop, ...rest } = runner.state.drafts
          runner.state.drafts = rest
          emit()
        }
      }),
    )
    if (signal.aborted) return
    // Nobody could respond (e.g. offline, or the key is invalid / out of credits): stop rather than loop
    if (failed > 0 && failed === debate.participants.length) {
      await updateDebate(debateId, { round })
      throw new Error('No participant was able to respond this round, so the debate was stopped. Check your connection and OpenRouter key, then resume the debate.')
    }

    debate = await updateDebate(debateId, { round })

    // ----- judge -----
    runner.state.phase = 'judging'
    emit()
    const forceEnd = round >= debate.maxRounds
    const all = await listMessages(debateId)
    const { verdict, cost } = await asModerator(debate.overviewModel, signal, () => judgeRound({
      apiKey,
      model: debate.overviewModel,
      topic: debate.topic,
      points: debate.points,
      participants: debate.participants,
      transcript: toTranscript(all),
      round,
      maxRounds: debate.maxRounds,
      everyonePassed: posted === 0,
      forceEnd,
      signal,
    }))
    if (signal.aborted) return
    await addCost(debateId, cost)

    // If the human spoke while we were judging, keep going so they get a response
    const userCount = (msgs: Message[]) => msgs.filter((m) => m.author === 'user').length
    const userSpokeLate = userCount(await listMessages(debateId)) > userCount(all)
    if (verdict.status !== 'continue' && !userSpokeLate) {
      await addMessage({
        debateId,
        author: 'moderator',
        authorName: 'Moderator',
        content: verdict.conclusion || verdict.reason,
        round,
        kind: 'conclusion',
        model: debate.overviewModel,
      })
      await updateDebate(debateId, {
        status: 'concluded',
        outcome: forceEnd && verdict.status !== 'consensus' ? 'round-limit' : verdict.status,
        conclusion: verdict.conclusion || verdict.reason,
      })
      return
    }
    if (verdict.status === 'continue' && verdict.note) {
      await addMessage({ debateId, author: 'moderator', authorName: 'Moderator', content: verdict.note, round, model: debate.overviewModel })
    }
    if (forceEnd && userSpokeLate) {
      await updateDebate(debateId, (d) => ({ maxRounds: d.maxRounds + settings.maxRounds }))
    }
  }
}
