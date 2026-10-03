/**
 * Prompting logic for the overview agent (planner / moderator / judge) and the debate participants.
 * Pure functions over a transcript - no storage dependencies, so it can be tested outside the browser.
 */
import { chat, type ChatMessage, type ModelInfo } from './openrouter'

export interface TranscriptEntry {
  /** 'user' | 'moderator' | 'system' (technical notices, e.g. a participant failing to respond) | participant id */
  author: string
  authorName: string
  content: string
  round: number
}

export interface PlannedParticipant {
  name: string
  model: string
  stance: string
}

export interface Plan {
  title: string
  points: string[]
  participants: PlannedParticipant[]
  opening?: string
}

export interface Verdict {
  status: 'continue' | 'consensus' | 'settled'
  reason: string
  note?: string
  conclusion?: string
}

export const PASS_TOKEN = '[PASS]'

export const PARTICIPANT_COLORS = ['#7c8cff', '#3ddc97', '#ffb454', '#ff6b8b', '#4cc9f0', '#c77dff', '#f9e15d', '#ff8c42']

// ---------- helpers ----------
export function extractJson<T>(text: string): T {
  const cleaned = text.replace(/```(?:json)?/gi, '')
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('Model did not return JSON: ' + text.slice(0, 200))
  return JSON.parse(cleaned.slice(start, end + 1)) as T
}

function label(e: TranscriptEntry): string {
  if (e.author === 'user') return 'User (the human host)'
  if (e.author === 'moderator') return 'Moderator'
  if (e.author === 'system') return 'System notice'
  return e.authorName
}

function transcriptText(entries: TranscriptEntry[]): string {
  if (!entries.length) return '(no messages yet)'
  let round = -1
  const out: string[] = []
  for (const e of entries) {
    if (e.round !== round) {
      round = e.round
      out.push(`--- Round ${round} ---`)
    }
    out.push(`[${label(e)}]: ${e.content}`)
  }
  return out.join('\n\n')
}

// ---------- planning ----------
export async function planDebate(args: {
  apiKey: string
  model: string
  topic: string
  models: ModelInfo[]
  signal?: AbortSignal
}): Promise<{ plan: Plan; cost: number }> {
  const aliases = args.models.filter((m) => m.id.startsWith('~')).map((m) => m.id)
  const others = args.models.filter((m) => !m.id.startsWith('~')).map((m) => m.id)

  const system = `You are the organiser and moderator of a group-chat debate between AI agents. The user describes a topic or question. You design the debate.

Decide:
1. A short title for the debate (max 6 words).
2. The key points that need to be argued to settle the question (2-5 short items).
3. The participants and the LLM each one uses. There are two cases:

   a) The user does NOT name particular models. Create 2-5 participants, all using "${args.model}". Give each a short, memorable first name and a distinct starting stance so the debate covers the important viewpoints. Since they share a model, assigned sides are what creates a real debate. If the topic has two clear sides, two or three participants is usually enough.

   b) The user names particular models or vendors (e.g. "I'd like Opus and GPT to discuss this", "ChatGPT", "Gemini", "Grok"). Create exactly one participant per requested model. Pick the matching model ID from the lists below, preferring the "~...-latest" aliases, which always point to the newest version of that model family. Do NOT assign them sides or stances: the user wants to see how the different models think, so each must form its own view. Set "stance" to an empty string, unless the user explicitly asked a model to take a specific position. A name that reflects the model is a good idea (e.g. "Sol" for GPT Sol, "Opus" for Claude Opus).

   Only use exact model IDs from the lists.

"Latest" aliases (preferred):
${aliases.join('\n') || '(none available)'}

All other model IDs:
${others.join(', ') || '(list unavailable - use ' + args.model + ')'}

Respond with ONLY a JSON object, no other text:
{"title": string, "points": string[], "participants": [{"name": string, "model": string, "stance": string}], "opening": string}
"opening" is a 1-2 sentence welcome message you, as moderator, post in the chat to kick things off (framing the question and naming the participants). In case b) do not suggest which side anyone will take; invite each participant to share their own view.`

  const res = await chat({
    apiKey: args.apiKey,
    model: args.model,
    signal: args.signal,
    maxTokens: 4000,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: args.topic },
    ],
  })
  const plan = extractJson<Plan>(res.content)

  // Validate
  const valid = new Set(args.models.map((m) => m.id))
  const seen = new Set<string>()
  plan.participants = (plan.participants || []).slice(0, 6).map((p, i) => {
    let name = String(p.name || `Agent ${i + 1}`).trim().slice(0, 24)
    while (seen.has(name.toLowerCase())) name += ' ' + (i + 1)
    seen.add(name.toLowerCase())
    const model = valid.size === 0 || valid.has(p.model) ? p.model || args.model : args.model
    return { name, model, stance: String(p.stance || '') }
  })
  if (plan.participants.length < 2) throw new Error('The overview agent did not create enough participants.')
  plan.title = String(plan.title || 'Debate').slice(0, 80)
  plan.points = Array.isArray(plan.points) ? plan.points.map(String) : []
  return { plan, cost: res.cost }
}

// ---------- participant turn ----------
export function buildParticipantMessages(args: {
  topic: string
  points: string[]
  me: { id: string; name: string; stance: string }
  others: { name: string; stance: string }[]
  transcript: TranscriptEntry[]
  round: number
  /** Whether this participant has web search / fetch tools available */
  webAccess?: boolean
}): ChatMessage[] {
  const { me } = args
  const system = `You are ${me.name}, one of the participants in a group chat where AI agents debate a question and try to reach a conclusion everyone can agree on, or at least settle for.

The question / topic from the human host:
"""
${args.topic}
"""
${args.points.length ? '\nKey points to resolve:\n' + args.points.map((p) => '- ' + p).join('\n') + '\n' : ''}
${me.stance
    ? 'Your starting stance: ' + me.stance
    : "You have not been assigned a side. Give your own honest view, based on your own reasoning. The host wants to see how different AI models think about this, so don't just mirror what the others say."}

Other participants:
${args.others.map((o) => `- ${o.name}: ${o.stance || '(no assigned side, giving their own view)'}`).join('\n')}

There is also a Moderator who may step in, and the human host ("User") who may chime in at any time. When the User says something, take it seriously and respond to it.
"System notice" messages are posted by the app when a participant could not respond due to a technical problem (e.g. a network or API error). That participant isn't ignoring anyone; don't wait for their reply, and you may briefly acknowledge their absence if relevant.

How to behave:
- This is a chat, not an essay. Keep messages short and conversational: usually 1-3 short paragraphs. Markdown is OK, but avoid big headings.
- Engage directly with what others said, by name. Concede good points, challenge weak ones, propose compromises.
- Argue in good faith. Hold your position when you have good reasons, but genuinely update when persuaded. The goal is the best answer, not winning.
- Don't repeat points that have already been made. If you agree with where things are going, say so briefly.
- Messages appear as "[Name]: text". Do NOT prefix your own reply with your name.${args.webAccess ? `
- You have web search and web fetch tools. Use them when current facts, data or sources would strengthen or check a claim (yours or someone else's), but don't search for things you already know well. Cite sources briefly as markdown links.` : ''}
- If you have nothing useful to add right now (e.g. you are waiting for someone else to respond, or you already agree), reply with exactly ${PASS_TOKEN} and nothing else to stay silent this round.`

  const messages: ChatMessage[] = [{ role: 'system', content: system }]
  let pending: string[] = []
  const flush = () => {
    if (pending.length) messages.push({ role: 'user', content: pending.join('\n\n') })
    pending = []
  }
  for (const e of args.transcript) {
    if (e.author === me.id) {
      flush()
      messages.push({ role: 'assistant', content: e.content })
    } else {
      pending.push(`[${label(e)}]: ${e.content}`)
    }
  }
  const hint =
    args.round === 1 && !args.transcript.some((e) => e.author === me.id)
      ? `(Round 1: everyone posts their opening position at the same time. State yours.)`
      : `(Round ${args.round}: the messages above are new since you last spoke. Reply, or answer ${PASS_TOKEN} to stay silent.)`
  pending.push(hint)
  flush()
  return messages
}

/** Cleans up a participant's raw reply. Returns null if they passed. */
export function cleanReply(raw: string, name: string): string | null {
  let text = raw.trim()
  if (!text || text.toUpperCase().startsWith(PASS_TOKEN) || text.toUpperCase() === 'PASS') return null
  // Strip an accidental "[Name]:" / "Name:" prefix
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  text = text.replace(new RegExp(`^\\s*(\\*\\*)?\\[?${esc}\\]?(\\*\\*)?\\s*:\\s*`, 'i'), '')
  // Trailing pass token after content is just noise
  text = text.replace(/\s*\[PASS\]\s*$/i, '').trim()
  return text || null
}

/** True while a streaming reply could still turn out to be a pass, so the UI can hide it */
export function mightBePass(partial: string): boolean {
  const t = partial.trim().toUpperCase()
  return t.length === 0 || PASS_TOKEN.startsWith(t) || t.startsWith(PASS_TOKEN)
}

// ---------- judging ----------
export async function judgeRound(args: {
  apiKey: string
  model: string
  topic: string
  points: string[]
  participants: { name: string; model: string; stance: string }[]
  transcript: TranscriptEntry[]
  round: number
  maxRounds: number
  everyonePassed: boolean
  forceEnd: boolean
  signal?: AbortSignal
}): Promise<{ verdict: Verdict; cost: number }> {
  const system = `You are the moderator of a group-chat debate between AI agents. After each round you review the conversation and decide whether it should continue.

Topic from the human host:
"""
${args.topic}
"""
${args.points.length ? 'Key points: \n' + args.points.map((p) => '- ' + p).join('\n') : ''}

Participants:
${args.participants.map((p) => `- ${p.name} (${p.model}): ${p.stance || 'no assigned side, giving their own view'}`).join('\n')}

Decide one status:
- "continue": real disagreement remains and progress is still being made, or someone has an unanswered question/point, or the User recently said something that hasn't been fully addressed.
- "consensus": all participants now explicitly agree on an answer.
- "settled": they don't fully agree but have converged on a position everyone can live with, or they are clearly just repeating themselves.
Do not end the debate before every participant has responded to the others' arguments at least once. "System notice" messages report participants that failed to respond because of a technical error (network, API key, credits, etc.); don't hold the debate open waiting on a participant who keeps failing, and mention their absence in the conclusion if it matters. Rounds so far: ${args.round} of a maximum ${args.maxRounds}.

You may optionally include a short "note" (1-2 sentences) that will be posted in the chat as the Moderator, to steer the debate: e.g. highlight an unresolved point, ask someone to respond to a specific argument, or push them towards a compromise when going in circles. Leave it empty most of the time; only intervene when it genuinely helps. Never include a note when ending.

If ending ("consensus" or "settled"), write a "conclusion" for the User in markdown: open with the final answer in bold, then a short summary of the reasoning, noting any remaining caveats or reservations each participant had. Keep it concise.

Respond with ONLY a JSON object:
{"status": "continue" | "consensus" | "settled", "reason": string, "note": string, "conclusion": string}`

  let instruction = `Here is the conversation so far:\n\n${transcriptText(args.transcript)}\n\n`
  if (args.everyonePassed) instruction += 'Note: every participant passed (stayed silent) in the latest round.\n'
  if (args.forceEnd)
    instruction += `The maximum number of rounds has been reached. You MUST end now with "consensus" or "settled" and write the conclusion, summarising the best answer they reached (or the closest thing to it).\n`
  instruction += 'Give your decision as JSON.'

  const res = await chat({
    apiKey: args.apiKey,
    model: args.model,
    signal: args.signal,
    maxTokens: 4000,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: instruction },
    ],
  })
  const v = extractJson<Verdict>(res.content)
  let status: Verdict['status'] = v.status === 'consensus' || v.status === 'settled' ? v.status : 'continue'
  if (args.forceEnd && status === 'continue') status = 'settled'
  return {
    verdict: {
      status,
      reason: String(v.reason || ''),
      note: v.note ? String(v.note).trim() : undefined,
      conclusion: v.conclusion ? String(v.conclusion).trim() : undefined,
    },
    cost: res.cost,
  }
}
