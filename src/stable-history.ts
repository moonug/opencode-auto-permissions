import { humanInteractions, userText } from "./context.ts"

const PAGE_SIZE = 200
const MAX_PAGES = 10_000
const DEADLINE_MS = 30_000
const MAX_SESSIONS = 128
const MAX_BYTES = 64 * 1024 * 1024
const WINDOW = 20

type Entry = {
  messages: any[]
  revision: number
  incomplete: boolean
  unknownTime: boolean
  hasQuestion: boolean
  bytes: number
  ambiguousTimes: number[]
  questionAmbiguousTimes: number[]
  anomalies: Map<string, { incomplete: boolean; unknownTime: boolean; ties: number[] }>
}

export function createStableHistory(client: any, directory: string) {
  const entries = new Map<string, Entry>()
  const loading = new Map<string, Promise<unknown>>()
  const building = new Map<string, Entry>()
  const controllers = new Map<AbortController, string>()
  const mutations = new Map<string, { revision: number; dirty: Set<string> }>()
  let revision = 0
  let disposed = false

  function observe(event: any) {
    if (disposed || !record(event)) return
    const data = event.properties ?? event.data
    if (["server.connected", "server.instance.disposed", "session.reset"].includes(event.type)) {
      revision++
      entries.clear()
      mutations.clear()
      for (const controller of controllers.keys()) controller.abort()
      return
    }
    if (!record(data)) return
    const sessionID = data.sessionID ?? data.info?.sessionID ?? data.part?.sessionID ?? data.info?.id
    if (typeof sessionID !== "string") return
    if (["session.deleted", "message.removed", "message.part.removed"].includes(event.type)
      || (event.type === "session.updated" && !record(data.info))) {
      revision++
      entries.delete(sessionID)
      mutations.delete(sessionID)
      for (const [controller, owner] of controllers) if (owner === sessionID) controller.abort()
      return
    }
    if (!["message.updated", "message.part.updated", "message.part.delta"].includes(event.type)) return
    const state = mutations.get(sessionID)
    if (!state) return
    const messageID = data.messageID ?? data.info?.id ?? data.part?.messageID
    if (typeof messageID !== "string") {
      entries.delete(sessionID)
      revision++
      mutations.delete(sessionID)
      for (const [controller, owner] of controllers) if (owner === sessionID) controller.abort()
      return
    }
    const known = entries.get(sessionID)?.messages.find((message) => message.info.id === messageID)
    if (known?.info.role === "assistant" && !known.parts.some((part: any) => part.tool === "question")
      && data.part && data.part.tool !== "question" && data.part.type !== "tool") return
    state.revision = ++revision
    if (state.dirty.size >= 10_000) {
      entries.delete(sessionID)
      mutations.delete(sessionID)
      for (const [controller, owner] of controllers) if (owner === sessionID) controller.abort()
      return
    }
    state.dirty.add(messageID)
  }

  async function refresh(sessionID: string, entry: Entry, signal: AbortSignal) {
    const state = mutations.get(sessionID)
    if (!state) throw new Error("Stable history invalidated")
    const observed = state.revision
    const refreshed: any[] = []
    for (const messageID of state.dirty) {
      const result: any = await abortable(client.session.message({ path: { id: sessionID, messageID },
        query: { directory }, signal }), signal)
      if (result?.error || result?.data?.info?.id !== messageID) throw new Error("Stable history refresh failed")
      refreshed.push(result.data)
    }
    if (mutations.get(sessionID) !== state || state.revision !== observed || disposed || signal.aborted) throw new Error("Stable history changed during refresh")
    if (refreshed.length) {
      // Reconstruct only when this replacement can retire integrity state or lose a boundary.
      if (refreshed.some((message) => {
        const anomaly = entry.anomalies.get(message.info.id)
        const human = humanInteractions([message], "", true)
        if (anomaly && (anomaly.ties.length || (anomaly.incomplete && !human.incomplete)
          || (anomaly.unknownTime && !human.interactions.some((item) => item.type === "message" && item.createdAt === undefined)))) return true
        const previous = entry.messages.find((item) => item.info.id === message.info.id)
        if (!previous) {
          const model = message.info.model
          const latestModel = entry.messages.findLast((item) => typeof item.info.model?.providerID === "string"
            && typeof (item.info.model.modelID ?? item.info.model.id) === "string")?.info.model
          const routingChanged = record(model) && typeof model.providerID === "string" && typeof (model.modelID ?? model.id) === "string"
            && (model.providerID !== latestModel?.providerID || (model.modelID ?? model.id) !== (latestModel?.modelID ?? latestModel?.id)
              || (typeof model.variant === "string" ? model.variant : undefined) !== latestModel?.variant)
          return (message.info.role === "user" || routingChanged)
            && ([...entry.messages, ...refreshed].some((other) => !validTime(other.info.time?.created))
              || [...entry.messages, ...refreshed].some((other) => other.info.id !== message.info.id
                 && (other.info.time?.created ?? 0) === (message.info.time?.created ?? 0)))
        }
        if (previous.info.role === "user" && message.info.role !== "user") return true
        if ((previous.info.role === "user" || message.info.role === "user")
          && previous.info.time?.created !== message.info.time?.created) return true
        if (typeof previous.info.model?.providerID === "string"
          && typeof (previous.info.model.modelID ?? previous.info.model.id) === "string"
          && (!record(message.info.model) || typeof message.info.model.providerID !== "string"
            || typeof (message.info.model.modelID ?? message.info.model.id) !== "string"
            || previous.info.time?.created !== message.info.time?.created)) return true
        const next = humanInteractions([message], "", true).interactions
        return humanInteractions([previous], "", true).interactions.some((item) => !next.some((replacement) =>
          item.type === "message" ? replacement.type === "message" && replacement.createdAt === item.createdAt
            : replacement.type === "question_answer" && replacement.callID === item.callID && replacement.completedAt === item.completedAt))
      })) return false
      project(entry, refreshed, false)
      state.dirty.clear()
    }
    entry.revision = observed
    return true
  }

  function project(entry: Entry, messages: any[], older: boolean) {
    const projected = messages.map((message) => {
      if (!record(message) || !record(message.info) || typeof message.info.id !== "string"
        || !["user", "assistant"].includes(message.info.role) || !Array.isArray(message.parts)) {
        throw new Error("Invalid stable history message")
      }
      const info = message.info
      const malformed = humanInteractions([message], "", true).incomplete
      entry.incomplete ||= malformed
      // Preserve malformed chronology evidence before normalizing timestamps.
      if (malformed) entry.anomalies.set(info.id, {
        ...(entry.anomalies.get(info.id) ?? { unknownTime: false, ties: [] }), incomplete: true,
      })
      const text = userText(message)
      const parts = text !== undefined
        ? [{ type: "text", text: text.length > 16_000 ? "x".repeat(16_001) : text }]
        : message.parts.filter((part: any) => record(part) && part.type === "tool" && part.tool === "question")
          .map((part: any) => ({ type: part.type, tool: part.tool, callID: part.callID, id: part.id,
            synthetic: part.synthetic, ignored: part.ignored, state: record(part.state) ? {
              status: part.state.status, input: { questions: part.state.input?.questions }, time: part.state.time,
              metadata: { answers: part.state.metadata?.answers },
            } : part.state }))
      return { info: { id: info.id, role: info.role, time: { created: validTime(info.time?.created) ? info.time.created : undefined },
        model: record(info.model) ? { providerID: textField(info.model.providerID), modelID: textField(info.model.modelID),
          id: textField(info.model.id), variant: textField(info.model.variant) } : undefined,
        agent: textField(info.agent), synthetic: info.synthetic === true ? true : undefined, ignored: info.ignored === true ? true : undefined },
        synthetic: message.synthetic === true ? true : undefined, ignored: message.ignored === true ? true : undefined, parts }
    })
    const human = humanInteractions(projected, "", true)
    entry.incomplete ||= human.incomplete
    entry.hasQuestion ||= human.interactions.some((item) => item.type === "question_answer")
    entry.unknownTime ||= human.interactions.some((item) => item.type === "message" && item.createdAt === undefined)
    const ambiguousTimes = new Set(entry.ambiguousTimes)
    const questionAmbiguousTimes = new Set(entry.questionAmbiguousTimes)
    const times = new Map<number, { total: number; questions: number }>()
    for (const item of human.interactions) {
      const time = item.type === "message" ? item.createdAt : item.completedAt
      if (time === undefined) continue
      const count = times.get(time) ?? { total: 0, questions: 0 }
      count.total++
      if (item.type === "question_answer") count.questions++
      times.set(time, count)
    }
    for (const [time, count] of times) {
      if (count.questions && count.total > 1) ambiguousTimes.add(time)
      if (count.questions > 1) questionAmbiguousTimes.add(time)
    }
    for (const message of projected) {
      const human = humanInteractions([message], "", true)
      const unknownTime = human.interactions.some((item) => item.type === "message" && item.createdAt === undefined)
      const ties = human.interactions.flatMap((item) => {
        const time = item.type === "message" ? item.createdAt : item.completedAt
        return time !== undefined && ambiguousTimes.has(time) ? [time] : []
      })
      if (human.incomplete || unknownTime || ties.length) entry.anomalies.set(message.info.id, {
        incomplete: human.incomplete || entry.anomalies.get(message.info.id)?.incomplete === true,
        unknownTime, ties: [...new Set(ties)],
      })
      if (message.info.role !== "assistant") continue
      message.parts = humanInteractions([message], "", false).interactions
        .filter((item) => item.type === "question_answer")
        .sort((left, right) => left.completedAt - right.completedAt).slice(-WINDOW).map((item) => {
          const oversized = JSON.stringify({ questions: item.questions, answers: item.answers }).length > 16_000
          return { type: "tool", tool: "question", callID: item.callID, state: {
            status: "completed", time: { end: item.completedAt },
            input: { questions: oversized ? [{ question: "x".repeat(16_001), options: [] }] : item.questions },
            metadata: { answers: oversized ? [[]] : item.answers },
          } } as any
        })
    }
    // Preserve authoritative positions when timestamps cannot establish order.
    const replacements = new Map(projected.map((message) => [message.info.id, message]))
    const combined = older ? [...projected, ...entry.messages] : [
      ...entry.messages.map((message) => replacements.get(message.info.id) ?? message),
      ...projected.filter((message) => !entry.messages.some((previous) => previous.info.id === message.info.id)),
    ]
    if (!older && combined.every((message) => validTime(message.info.time?.created)))
      combined.sort((left, right) => left.info.time.created - right.info.time.created)
    const texts = combined.filter((message) => userText(message) !== undefined).slice(-WINDOW)
    const questions = combined.flatMap((message) => humanInteractions([message], "", false).interactions
      .filter((item) => item.type === "question_answer").map((item) => ({ message, time: item.completedAt, callID: item.callID })))
      .sort((left, right) => left.time - right.time).slice(-WINDOW)
    const latestModel = combined.findLast((message) => typeof message.info.model?.providerID === "string"
      && typeof (message.info.model.modelID ?? message.info.model.id) === "string")
    const latestUser = combined.findLast((message) => message.info.role === "user")
    const selected = new Set([...texts, ...questions.map((item) => item.message), ...combined.slice(-1),
      ...(latestModel ? [latestModel] : []), ...(latestUser ? [latestUser] : [])])
    // Preserve ambiguity at the retained window boundary, even after pruning.
    const interactions = humanInteractions(combined, "", true).interactions
    for (const question of questions) {
      const tied = interactions.filter((item) => (item.type === "message" ? item.createdAt : item.completedAt) === question.time)
      if (tied.length > 1) ambiguousTimes.add(question.time)
      if (tied.filter((item) => item.type === "question_answer").length > 1) questionAmbiguousTimes.add(question.time)
    }
    const retained = combined.filter((message) => selected.has(message)).map((message) => message.info.role !== "assistant" ? message : {
      ...message, parts: message.parts.filter((part: any) => questions.some((question) => question.message === message
        && question.callID === part.callID && question.time === part.state?.time?.end)),
    })
    entry.ambiguousTimes = [...ambiguousTimes].filter((time) => questions.some((question) => question.time === time))
    entry.questionAmbiguousTimes = [...questionAmbiguousTimes].filter((time) => questions.some((question) => question.time === time))
    // Keep bounded provenance for anomalies even when their messages leave the compact window.
    for (const message of [...projected, ...combined]) {
      const human = humanInteractions([message], "", true)
      const previous = entry.anomalies.get(message.info.id)
      const incomplete = previous?.incomplete || human.incomplete
      const unknownTime = previous?.unknownTime || human.interactions.some((item) => item.type === "message" && item.createdAt === undefined)
      const ties = [...new Set([...(previous?.ties ?? []), ...human.interactions.flatMap((item) => {
        const time = item.type === "message" ? item.createdAt : item.completedAt
        return time !== undefined && ambiguousTimes.has(time) ? [time] : []
      })])]
      if (incomplete || unknownTime || ties.length) entry.anomalies.set(message.info.id, { incomplete, unknownTime, ties })
    }
    for (const [id, anomaly] of entry.anomalies) {
      anomaly.ties = anomaly.ties.filter((time) => entry.ambiguousTimes.includes(time))
      if (!anomaly.incomplete && !anomaly.unknownTime && !anomaly.ties.length) entry.anomalies.delete(id)
    }
    const bytes = JSON.stringify([retained, [...entry.anomalies], entry.ambiguousTimes, entry.questionAmbiguousTimes]).length * 2
    let otherBytes = [...entries.values(), ...building.values()].filter((other) => other !== entry)
      .reduce((sum, other) => sum + other.bytes, 0)
    for (const [id, cached] of entries) {
      if (bytes + otherBytes <= MAX_BYTES) break
      if (cached === entry) continue
      entries.delete(id)
      mutations.delete(id)
      otherBytes -= cached.bytes
    }
    if (bytes + otherBytes > MAX_BYTES) throw new Error("Stable history retention budget exceeded")
    entry.messages = retained
    entry.bytes = bytes
  }

  async function bootstrap(sessionID: string, sourceMessageID?: string) {
    const controller = new AbortController()
    controllers.set(controller, sessionID)
    const timer = setTimeout(() => controller.abort(), DEADLINE_MS)
    const state = { revision: ++revision, dirty: new Set<string>() }
    mutations.set(sessionID, state)
    const entry: Entry = { messages: [], revision: state.revision, incomplete: false, unknownTime: false, hasQuestion: false, bytes: 0, ambiguousTimes: [], questionAmbiguousTimes: [], anomalies: new Map() }
    building.set(sessionID, entry)
    const cursors = new Set<string>()
    const messageIDs = new Set<string>()
    let identityBytes = 0
    let cursorBytes = 0
    let source: { value: unknown; revision: number } | undefined
    let before: string | undefined
    let previousOldest: string | undefined
    let previousTime: number | undefined
    try {
      for (let page = 0; page < MAX_PAGES; page++) {
        const pageRevision = state.revision
        const result: any = await abortable(client.session.messages({ path: { id: sessionID },
          query: { directory, limit: PAGE_SIZE, ...(before !== undefined ? { before } : {}) },
          responseStyle: "fields", signal: controller.signal }), controller.signal)
        if (result?.error) throw new Error("Stable history page failed")
        const data = result?.data ?? result
        if (!Array.isArray(data) || data.length > PAGE_SIZE) throw new Error("Invalid stable history page")
        for (const message of data) {
          const id = message?.info?.id
          if (typeof id !== "string" || !id || messageIDs.has(id)) throw new Error("Stable history message identity did not progress")
          identityBytes += id.length * 2 + 64
          if (identityBytes + cursorBytes > MAX_BYTES) throw new Error("Stable history identity budget exceeded")
          messageIDs.add(id)
          if (id === sourceMessageID) source = { value: sourceProjection(message), revision: pageRevision }
        }
        for (let index = 1; index < data.length; index++) {
          const left = data[index - 1]?.info?.time?.created
          const right = data[index]?.info?.time?.created
          if (validTime(left) && validTime(right) && left > right) throw new Error("Stable history page order is invalid")
        }
        const newestTime = data.at(-1)?.info?.time?.created
        if (previousTime !== undefined && validTime(newestTime) && newestTime > previousTime)
          throw new Error("Stable history page order did not progress")
        previousTime = validTime(data[0]?.info?.time?.created) ? data[0].info.time.created : undefined
        const response = result?.response
        const next = response?.headers?.get("X-Next-Cursor")
        if (next !== undefined && next !== null && (typeof next !== "string" || !next || cursors.has(next)))
          throw new Error("Stable history cursor did not progress")
        cursorBytes += next ? next.length * 2 : 0
        if (identityBytes + cursorBytes > MAX_BYTES)
          throw new Error("Stable history identity budget exceeded")
        if (data.length === 0 && next) throw new Error("Empty continuing stable history page")
        const oldest = data[0]?.info?.id
        if (before !== undefined && (data.length === 0 || oldest === previousOldest)) throw new Error("Stable history page did not progress")
        previousOldest = oldest
        project(entry, data, true)
        if (!next) {
          if (data.length === PAGE_SIZE && !response?.headers) throw new Error("Stable history completion is unproven")
          if (disposed || controller.signal.aborted) throw new Error("Stable history load cancelled")
          if (!await refresh(sessionID, entry, controller.signal)) throw new Error("Stable history changed beyond the retained window")
          entries.set(sessionID, entry)
          building.delete(sessionID)
          enforceBudget()
          return source?.revision === state.revision ? { message: source.value, revision: source.revision } : undefined
        }
        cursors.add(next)
        before = next
      }
      throw new Error("Stable history page budget exceeded")
    } finally {
      clearTimeout(timer)
      controllers.delete(controller)
      building.delete(sessionID)
    }
  }

  function enforceBudget() {
    while (entries.size > MAX_SESSIONS || [...entries.values()].reduce((sum, value) => sum + value.bytes, 0) > MAX_BYTES) {
      const oldest = entries.keys().next().value!
      entries.delete(oldest)
      mutations.delete(oldest)
    }
  }

  return {
    async sync(sessionID: string, sourceMessageID?: string): Promise<unknown> {
      if (disposed) throw new Error("Stable history disposed")
      const entry = entries.get(sessionID)
      if (entry) {
        const controller = new AbortController()
        controllers.set(controller, sessionID)
        const timer = setTimeout(() => controller.abort(), DEADLINE_MS)
        let complete = false
        try {
          complete = await refresh(sessionID, entry, controller.signal)
        } catch (error) {
          entries.delete(sessionID)
          mutations.delete(sessionID)
          throw error
        } finally {
          clearTimeout(timer)
          controllers.delete(controller)
        }
        if (!mutations.has(sessionID) || entries.get(sessionID) !== entry) throw new Error("Stable history invalidated")
        entries.delete(sessionID)
        if (complete) {
          entries.set(sessionID, entry)
          enforceBudget()
          return
        }
        mutations.delete(sessionID)
      }
      let task = loading.get(sessionID)
      if (!task) {
        if (loading.size >= MAX_SESSIONS) throw new Error("Stable history concurrent load budget exceeded")
        while (entries.size + loading.size >= MAX_SESSIONS) {
          const oldest = entries.keys().next().value!
          entries.delete(oldest)
          mutations.delete(oldest)
        }
        task = bootstrap(sessionID, sourceMessageID).finally(() => {
          loading.delete(sessionID)
          if (!entries.has(sessionID)) mutations.delete(sessionID)
        })
        loading.set(sessionID, task)
      }
      return await task
    },
    observe,
    async source(sessionID: string, messageID: string): Promise<unknown> {
      const controller = new AbortController()
      controllers.set(controller, sessionID)
      const timer = setTimeout(() => controller.abort(), DEADLINE_MS)
      try {
        const result: any = await abortable(client.session.message({ path: { id: sessionID, messageID }, query: { directory }, signal: controller.signal }), controller.signal)
        if (result?.error || result?.data?.info?.id !== messageID) throw new Error("Stable source lookup failed")
        return sourceProjection(result.data)
      } finally {
        clearTimeout(timer)
        controllers.delete(controller)
      }
    },
    list: (sessionID: string): unknown[] => entries.get(sessionID)?.messages ?? [],
    metadata: (sessionID: string, includeText = true) => ({ revision: mutations.get(sessionID)?.revision ?? revision,
      incomplete: !entries.has(sessionID) || !mutations.has(sessionID) || entries.get(sessionID)!.incomplete || Boolean(mutations.get(sessionID)?.dirty.size),
      unknownTime: entries.get(sessionID)?.unknownTime ?? false,
      hasQuestion: entries.get(sessionID)?.hasQuestion ?? false,
      ambiguousTimes: (includeText ? entries.get(sessionID)?.ambiguousTimes : entries.get(sessionID)?.questionAmbiguousTimes) ?? [] }),
    dispose() {
      disposed = true
      for (const controller of controllers.keys()) controller.abort()
      entries.clear()
      mutations.clear()
      building.clear()
    },
  }
}

function sourceProjection(message: any): unknown {
  return { info: { id: message.info.id, role: message.info.role }, parts: Array.isArray(message.parts)
    ? message.parts.filter((part: any) => record(part) && part.type === "tool").map((part: any) => ({
      type: "tool", callID: part.callID, id: part.id, state: { input: part.state?.input },
    })) : [] }
}

function record(value: any): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function validTime(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
}

function textField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error("Stable history load cancelled"))
    signal.addEventListener("abort", abort, { once: true })
    if (signal.aborted) abort()
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort))
  })
}
