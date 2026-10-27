import type { HumanInteraction, PermissionRequest, QuestionFraming, ReviewInput, ReviewModel, RuntimeContext } from "./types.ts"

const MAX_INTERACTION_CHARS = 16_000
const MAX_CONTEXT_CHARS = 64_000
export const AUTO_PERMISSIONS_MESSAGE_PREFIX = "[Auto Permissions] The requested action was blocked:"

export function normalizeAskedEvent(event: unknown): PermissionRequest | null {
  if (!isRecord(event)) return null
  const data = payload(event)
  if (
    event.type === "permission.v2.asked" ||
    (event.type === "permission.asked" && validRequest(data, "action", "resources"))
  ) {
    if (!validRequest(data, "action", "resources")) return null
    return {
      id: data.id,
      sessionID: data.sessionID,
      action: data.action,
      resources: [...data.resources],
      // Newer V2 runtimes renamed the reusable-pattern field to "save";
      // older betas and stable events still use "always".
      always: stringArray(data.always ?? data.save),
      ...(normalizeTool(data.source) ? { source: normalizeTool(data.source)! } : {}),
      protocol: "v2",
    }
  }

  if (event.type !== "permission.asked" && event.type !== "permission.updated") return null
  if (!data || typeof data.id !== "string" || typeof data.sessionID !== "string") return null
  const action = typeof data.permission === "string" ? data.permission : data.type
  const rawResources = data.patterns ?? data.pattern
  const resources = Array.isArray(rawResources) ? rawResources : typeof rawResources === "string" ? [rawResources] : []
  if (typeof action !== "string" || resources.length === 0 || !resources.every((item) => typeof item === "string"))
    return null
  const tool = normalizeTool(data.tool)
    ? normalizeTool(data.tool)!
    : typeof data.messageID === "string" && typeof data.callID === "string"
      ? { type: "tool" as const, messageID: data.messageID, callID: data.callID }
      : undefined
  return {
    id: data.id,
    sessionID: data.sessionID,
    action,
    resources,
    always: stringArray(data.always),
    ...(tool ? { source: tool } : {}),
    protocol: "stable",
  }
}

export function normalizeRepliedEvent(event: unknown): { sessionID: string; requestID: string } | null {
  if (!isRecord(event) || !["permission.v2.replied", "permission.replied"].includes(String(event.type))) return null
  const data = payload(event)
  const requestID = data?.requestID ?? data?.permissionID
  if (!isRecord(data) || typeof data.sessionID !== "string" || typeof requestID !== "string") return null
  return { sessionID: data.sessionID, requestID }
}

export async function collectReviewInput(
  context: RuntimeContext,
  request: PermissionRequest,
  userMessageCount: number,
): Promise<ReviewInput> {
  const rootSessionID = await context.data.session.root(request.sessionID)
  const chain = [request.sessionID]
  let incomplete = false
  while (chain.at(-1) !== rootSessionID && chain.length < 64) {
    const parent = context.data.session.get(chain.at(-1)!)?.parentID
    if (!parent || chain.includes(parent)) break
    chain.push(parent)
  }
  const root = context.data.session.get(rootSessionID)
  if (chain.at(-1) !== rootSessionID || !root || root.parentID) incomplete = true
  const sessions = [rootSessionID, ...chain.reverse().filter((id) => id !== rootSessionID)]
  const parents = sessions.map((id) => context.data.session.get(id)?.parentID)
  const synced = await Promise.all(sessions.map((id) => context.data.session.message.sync(id,
    id === request.sessionID ? request.source?.messageID : undefined)))
  // Another collector can drain dirty state while this source read is suspended.
  const sourceRevision = context.data.session.message.metadata?.(request.sessionID).revision
  const toolInput = request.source?.type === "tool"
    ? await findToolInput(context, request.sessionID, request.source.messageID, request.source.callID,
      synced[sessions.indexOf(request.sessionID)])
    : undefined
  incomplete ||= sourceRevision !== context.data.session.message.metadata?.(request.sessionID).revision
  incomplete ||= sessions.some((id, index) => {
    const current = context.data.session.get(id)
    return !current || current.parentID !== parents[index]
  })

  const rootMessages = context.data.session.message.list(rootSessionID)
  const sessionMessages = request.sessionID === rootSessionID
    ? []
    : context.data.session.message.list(request.sessionID)
  const collected = sessions.map((id) => humanInteractions(context.data.session.message.list(id), id, id === rootSessionID))
  incomplete ||= collected.some((item) => item.incomplete)
  incomplete ||= sessions.some((id) => context.data.session.message.metadata?.(id).incomplete)
  const interactions = collected.flatMap((item) => item.interactions)
  incomplete ||= context.data.session.message.metadata?.(rootSessionID).unknownTime === true
    && (interactions.some((item) => item.type === "question_answer")
      || sessions.some((id) => context.data.session.message.metadata?.(id).hasQuestion))
  const times = interactions.map((item) => item.type === "message" ? item.createdAt : item.completedAt)
  const allTimed = times.every((time) => time !== undefined)
  // Message order alone cannot place a tool's completion among human inputs.
  incomplete ||= interactions.some((item) => item.type === "question_answer") && !allTimed
  if (allTimed) {
    interactions.sort((left, right) =>
      (left.type === "message" ? left.createdAt! : left.completedAt)
      - (right.type === "message" ? right.createdAt! : right.completedAt))
  }
  const recentInteractions = interactions.slice(-userMessageCount).filter((item) => {
    const time = item.type === "message" ? item.createdAt : item.completedAt
    if (time !== undefined && sessions.some((id) => context.data.session.message.metadata?.(id, id === rootSessionID).ambiguousTimes?.includes(time))) incomplete = true
    if (time !== undefined && times.indexOf(time) !== times.lastIndexOf(time)
      && interactions.some((other) => other.type === "question_answer" && other.completedAt === time)) incomplete = true
    const text = item.type === "message" ? item.text : JSON.stringify({ questions: item.questions, answers: item.answers })
    if (text.length <= MAX_INTERACTION_CHARS) return true
    incomplete = true
    return false
  })
  const delegationMessages = sessions.filter((id) => id !== rootSessionID).flatMap((id) =>
    context.data.session.message.list(id).flatMap((message) => {
      const text = userText(message)
      return text === undefined ? [] : [{ sessionID: id, text }]
    })).slice(-userMessageCount).filter((item) => {
    if (item.text.length <= MAX_INTERACTION_CHARS) return true
    incomplete = true
    return false
  })
  const userMessages = rootMessages.flatMap((message) => {
    const text = userText(message)
    return text === undefined ? [] : [text]
  }).slice(-userMessageCount).filter((text) => {
    if (text.length <= MAX_INTERACTION_CHARS) return true
    incomplete = true
    return false
  })
  const currentDirectory = directory(context)
  const model = latestUserModel(sessionMessages) ?? latestUserModel(rootMessages)

  const input: ReviewInput = {
    request: {
      action: request.action,
      resources: [...request.resources],
      sessionPatterns: [...request.always],
      ...(request.source?.type === "tool" ? { toolInput } : {}),
    },
    context: {
      rootSessionID,
      ...(currentDirectory ? { directory: currentDirectory } : {}),
      userMessages,
      humanInteractions: recentInteractions,
      delegationMessages,
      incomplete,
      ...(context.data.session.message.metadata ? {
        historyRevisions: sessions.map((id) => ({ sessionID: id, revision: context.data.session.message.metadata!(id).revision })),
      } : {}),
      ...(model ? { model } : {}),
    },
  }
  if (JSON.stringify(input.context).length > MAX_CONTEXT_CHARS) {
    input.context.userMessages = []
    input.context.humanInteractions = []
    input.context.delegationMessages = []
    input.context.incomplete = true
  }
  if (sessions.some((id) => context.data.session.message.metadata?.(id).incomplete)) input.context.incomplete = true
  return input
}

export function humanInteractions(messages: unknown[], sessionID: string, includeText: boolean) {
  let incomplete = false
  const interactions = messages.flatMap((message): HumanInteraction[] => {
    if (!isRecord(message) || message.synthetic === true || message.ignored === true) return []
    const info = isRecord(message.info) ? message.info : message
    if (info.synthetic === true || info.ignored === true) return []
    const text = includeText ? userText(message) : undefined
    if (text !== undefined) {
      const createdAt = info.time?.created
      return [{ type: "message", sessionID, text, ...(validTime(createdAt) ? { createdAt } : {}) }]
    }
    const stable = isRecord(message.info)
    if ((stable ? info.role : message.type) !== "assistant") return []
    const parts = stable ? message.parts : message.content
    if (!Array.isArray(parts)) return []
    return parts.flatMap((part) => {
      if (!isRecord(part) || part.type !== "tool" || part.synthetic === true || part.ignored === true
        || (stable ? part.tool : part.name) !== "question" || !isRecord(part.state)
        || part.state.status !== "completed") return []
      const state = part.state
      const answers = stable ? state.metadata?.answers : state.structured?.answers
      const rawQuestions = state.input?.questions
      const completedAt = stable ? state.time?.end : part.time?.completed
      const startedAt = stable ? state.time?.start : part.time?.created
      const messageCreatedAt = info.time?.created
      const callID = part.callID ?? part.id
      if (typeof callID !== "string" || !callID || !validTime(completedAt)
        || (startedAt !== undefined && (!validTime(startedAt) || completedAt < startedAt))
        || (messageCreatedAt !== undefined && (!validTime(messageCreatedAt) || completedAt < messageCreatedAt))
        || !Array.isArray(rawQuestions) || rawQuestions.length === 0
        || !Array.isArray(answers) || answers.length !== rawQuestions.length
        || !answers.every((answer) => Array.isArray(answer) && answer.every((value) => typeof value === "string"))) {
        incomplete = true
        return []
      }
      const questions = rawQuestions.map(questionFraming)
      if (questions.some((question) => question === undefined) || answers.some((answer, index) => {
        const question = questions[index]!
        return (question.multiple !== true && answer.length > 1) || new Set(answer).size !== answer.length
          || (question.custom === false && answer.some((value) => !question.options.some((option) => option.label === value)))
      })) {
        incomplete = true
        return []
      }
      return [{
        type: "question_answer" as const, sessionID, callID, completedAt,
        questions: questions as QuestionFraming[], answers: answers.map((answer) => [...answer]),
      }]
    })
  })
  return { interactions, incomplete }
}

function questionFraming(value: unknown): QuestionFraming | undefined {
  if (!isRecord(value) || typeof value.question !== "string" || !value.question
    || (value.header !== undefined && typeof value.header !== "string")
    || (value.multiple !== undefined && typeof value.multiple !== "boolean")
    || (value.custom !== undefined && typeof value.custom !== "boolean")
    || !Array.isArray(value.options)
    || !value.options.every((option) => isRecord(option) && typeof option.label === "string"
      && (option.description === undefined || typeof option.description === "string"))) return undefined
  return {
    question: value.question,
    ...(value.header !== undefined ? { header: value.header } : {}),
    options: value.options.map((option) => ({
      label: option.label,
      ...(option.description !== undefined ? { description: option.description } : {}),
    })),
    ...(value.multiple !== undefined ? { multiple: value.multiple } : {}),
    ...(value.custom !== undefined ? { custom: value.custom } : {}),
  }
}

function validTime(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
}

function latestUserModel(messages: unknown[]): ReviewModel | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (!isRecord(message)) continue
    const model = messageModel(message)
    if (model) return model
  }
  return undefined
}

function messageModel(message: Record<string, any>): ReviewModel | undefined {
  // Newer V2 runtimes expose messages as flat records and user prompts carry no
  // model there, so the most recent assistant turn is the closest routing
  // signal for the reviewer.
  const info = isRecord(message.info) ? message.info : message
  const role = info.role ?? message.type
  if (role !== "user" && role !== "assistant") return undefined
  const raw = isRecord(info.model) ? info.model : undefined
  if (!raw) return undefined
  const providerID = raw.providerID
  const id = raw.modelID ?? raw.id
  if (typeof providerID !== "string" || typeof id !== "string") return undefined
  const variant = typeof raw.variant === "string" ? raw.variant : undefined
  return { providerID, id, ...(variant ? { variant } : {}) }
}

export async function isRequestPending(context: RuntimeContext, request: PermissionRequest): Promise<boolean> {
  await context.data.session.permission.sync(request.sessionID)
  return context.data.session.permission.list(request.sessionID)?.some((item) => item.id === request.id) ?? false
}

async function findToolInput(
  context: RuntimeContext,
  sessionID: string,
  messageID: string,
  callID: string,
  loadedSource?: unknown,
): Promise<unknown> {
  const metadata = context.data.session.message.metadata?.(sessionID)
  const cachedSource = isRecord(loadedSource) && metadata && !metadata.incomplete && loadedSource.revision === metadata.revision
    ? loadedSource.message : undefined
  const message = context.data.session.message.source && isRecord(cachedSource) && cachedSource.info?.id === messageID ? cachedSource : context.data.session.message.source
    ? await context.data.session.message.source(sessionID, messageID)
    : context.data.session.message.get(sessionID, messageID)
  if (context.data.session.message.source && !isRecord(message)) throw new Error("Stable source lookup failed")
  if (!isRecord(message)) return undefined

  if (message.type === "assistant" && Array.isArray(message.content)) {
    const tool = message.content.find(
      (item) => isRecord(item) && item.type === "tool" && (item.id === callID || item.callID === callID),
    )
    if (isRecord(tool) && isRecord(tool.state) && (!context.data.session.message.source || tool.state.input !== undefined)) return tool.state.input
  }

  if (isRecord(message.info) && message.info.role === "assistant" && Array.isArray(message.parts)) {
    const tool = message.parts.find(
      (part) => isRecord(part) && part.type === "tool" && (part.callID === callID || part.id === callID),
    )
    if (isRecord(tool) && isRecord(tool.state) && (!context.data.session.message.source || tool.state.input !== undefined)) return tool.state.input
  }
  if (context.data.session.message.source) throw new Error("Stable source tool input unavailable")
  return undefined
}

function directory(context: RuntimeContext): string | undefined {
  return context.location?.directory ?? context.data.location?.default().directory
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function payload(event: Record<string, any>): Record<string, any> | null {
  return isRecord(event.data) ? event.data : isRecord(event.properties) ? event.properties : null
}

function validRequest(
  data: Record<string, any> | null,
  actionKey: "action" | "permission",
  resourcesKey: "resources" | "patterns",
): data is Record<string, any> & { id: string; sessionID: string } {
  return Boolean(
    data &&
      typeof data.id === "string" &&
      typeof data.sessionID === "string" &&
      typeof data[actionKey] === "string" &&
      Array.isArray(data[resourcesKey]) &&
      data[resourcesKey].every((item: unknown) => typeof item === "string"),
  )
}

function normalizeTool(value: unknown): { type: "tool"; messageID: string; callID: string } | undefined {
  if (!isRecord(value) || (value.type !== undefined && value.type !== "tool") || typeof value.messageID !== "string") {
    return undefined
  }
  const callID = typeof value.callID === "string" ? value.callID : value.id
  return typeof callID === "string" ? { type: "tool", messageID: value.messageID, callID } : undefined
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

export function userText(message: unknown): string | undefined {
  if (!isRecord(message) || message.synthetic === true || message.ignored === true) return undefined
  if (isRecord(message.info) && (message.info.synthetic === true || message.info.ignored === true)) return undefined
  if (message.type === "user" && typeof message.text === "string") {
    return isPluginContinuation(message.text) ? undefined : message.text
  }
  if (!isRecord(message.info) || message.info.role !== "user" || !Array.isArray(message.parts)) return undefined
  const text = message.parts
    .filter(
      (part) =>
        isRecord(part) &&
        part.type === "text" &&
        typeof part.text === "string" &&
        part.synthetic !== true &&
        part.ignored !== true,
    )
    .map((part) => part.text)
    .join("\n")
  return text && !isPluginContinuation(text) ? text : undefined
}

function isPluginContinuation(text: string): boolean {
  return text.trimStart().startsWith(AUTO_PERMISSIONS_MESSAGE_PREFIX)
}
