// Structural equivalent of the OpenCode ModelRef used by both the stable and
// V2 clients. Declared locally because the stable and beta SDK packages type
// the same field set under different module paths.
export interface ReviewModel {
  providerID: string
  id: string
  variant?: string
}

export type PermissionProtocol = "stable" | "v2"

export interface PermissionRequest {
  id: string
  sessionID: string
  action: string
  resources: string[]
  always: string[]
  source?: { type: "tool"; messageID: string; callID: string }
  protocol: PermissionProtocol
}

export type Decision =
  | { kind: "allow"; reasonCode: string; reason: string }
  | { kind: "allow_session"; reasonCode: string; reason: string }
  | { kind: "deny"; reasonCode: string; reason: string }

export interface QuestionFraming {
  question: string
  header?: string
  options: { label: string; description?: string }[]
  multiple?: boolean
  custom?: boolean
}

export type HumanInteraction =
  | { type: "message"; sessionID: string; text: string; createdAt?: number }
  | {
      type: "question_answer"
      sessionID: string
      callID: string
      completedAt: number
      questions: QuestionFraming[]
      answers: string[][]
    }

export interface ReviewInput {
  request: {
    action: string
    resources: string[]
    sessionPatterns: string[]
    toolInput?: unknown
  }
  context: {
    rootSessionID: string
    directory?: string
    userMessages: string[]
    humanInteractions: HumanInteraction[]
    delegationMessages: { sessionID: string; text: string }[]
    incomplete: boolean
    model?: ReviewModel
    historyRevisions?: { sessionID: string; revision: number }[]
  }
}

export interface SessionData {
  root(sessionID: string): string | Promise<string>
  get(sessionID: string): { id: string; parentID?: string } | undefined
  message: {
    list(sessionID: string): unknown[]
    get(sessionID: string, messageID: string): unknown
    source?(sessionID: string, messageID: string): Promise<unknown>
    sync(sessionID: string, sourceMessageID?: string): Promise<unknown>
    metadata?(sessionID: string, includeText?: boolean): { revision: number; incomplete: boolean; ambiguousTimes?: number[]; unknownTime?: boolean; hasQuestion?: boolean }
  }
  permission: {
    list(sessionID: string): PermissionRequest[] | undefined
    sync(sessionID: string): Promise<void>
  }
}

export interface RuntimeContext {
  options: Readonly<Record<string, unknown>>
  client: unknown
  data: {
    on(type: string, handler: (event: unknown) => void): () => void
    session: SessionData
    location?: {
      default(): { directory?: string; workspaceID?: string }
    }
  }
  location?: { directory?: string; workspaceID?: string }
  showToast?(input: {
    title?: string
    message: string
    variant?: "info" | "success" | "warning" | "error"
    duration?: number
  }): void
  resumeAfterDenial?(sessionID: string, reason: string): void
}

export interface ReviewerClient {
  prewarm?(): Promise<void>
  generate(input: {
    prompt: string
    model: ReviewModel
    parentSessionID: string
    location?: { directory?: string; workspaceID?: string }
    signal: AbortSignal
  }): Promise<unknown>
  reply(input: {
    sessionID: string
    requestID: string
    reply: "once" | "always" | "reject"
    message?: string
    protocol: PermissionProtocol
  }): Promise<"replied" | "not_found">
}
