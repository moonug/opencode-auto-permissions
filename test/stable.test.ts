import { describe, expect, test } from "bun:test"
import { installReviewer } from "../src/reviewer.ts"
import { createStableRuntime, protocolForVersion } from "../src/stable.ts"

function client() {
  const prompts: unknown[] = []
  let statusChecks = 0
  const sessions = new Map([
    ["ses_child", { id: "ses_child", parentID: "ses_root" }],
    ["ses_root", { id: "ses_root" }],
  ])
  const pending = [
    {
      id: "per_1",
      sessionID: "ses_child",
      permission: "bash",
      patterns: ["git status"],
      metadata: {},
      always: [],
      tool: { messageID: "msg_assistant", callID: "call_1" },
    },
  ]
  return {
    global: { health: async () => ({ data: { healthy: true, version: "1.18.12" } }) },
    v2: {},
    session: {
      get: async ({ path }: { path: { id: string } }) => ({ data: sessions.get(path.id) }),
      messages: async ({ path }: { path: { id: string } }) => ({
        data: [
          {
            info: {
              id: "msg_user",
              role: "user",
              agent: "build",
              model: { providerID: "cloudflare-workers-ai", modelID: "@cf/deepseek-ai/deepseek-v4-flash-0731", variant: "max" },
            },
            parts: [{ type: "text", text: "Inspect the repository." }],
          },
          {
            info: { id: "msg_assistant", role: "assistant" },
            parts: [{ type: "tool", callID: "call_1", state: { input: { command: "git status" } } }],
          },
        ],
      }),
      promptAsync: async (input: unknown) => {
        prompts.push(input)
        return { data: undefined }
      },
      status: async () => ({
        data: statusChecks++ === 0 ? { ses_child: { type: "busy" } } : { ses_child: { type: "idle" } },
      }),
    },
    permission: {
      list: async () => ({ data: pending }),
      reply: async () => ({ data: true }),
    },
    tui: { showToast: async () => ({ data: true }) },
    prompts,
  }
}

describe("createStableRuntime", () => {
  test.each([
    { name: "truncated prohibition", instruction: "Do not execute pnpm test.", count: 200, expectedReply: "reject" },
    { name: "full page", instruction: "Run the tests.", count: 199, expectedReply: "reject" },
    { name: "complete bounded page", instruction: "Run the tests.", count: 198, expectedReply: "once" },
    { name: "invalid page", instruction: "Run the tests.", count: 0, expectedReply: "reject" },
  ])("checks bounded message-source completeness: $name", async ({ name, instruction, count, expectedReply }) => {
    const injected = client()
    const messages = [
      { info: { id: "msg_human", role: "user" }, parts: [{ type: "text", text: instruction }] },
      ...Array.from({ length: count }, (_, index) => ({
        info: { id: `msg_assistant_${index}`, role: "assistant" }, parts: [{ type: "text", text: "Inspecting source." }],
      })),
    ]
    const pending = { id: "per_history", sessionID: "ses_root", permission: "bash", patterns: ["pnpm test"], always: [] }
    const runtime = createStableRuntime({
      ...injected,
      session: {
        ...injected.session,
        messages: async ({ query }: { query: { limit: number } }) => ({
          data: name === "invalid page" ? {} : messages.slice(-query.limit),
        }),
      },
      permission: { list: async () => ({ data: [pending] }) },
    }, { model: "fixture/reviewer" }, "/repo")
    const replies: string[] = []
    const failures: unknown[] = []
    let calls = 0
    let complete!: () => void
    const completed = new Promise<void>((resolve) => { complete = resolve })
    const dispose = installReviewer(runtime.context, {
      client: {
        generate: async () => {
          calls++
          return { decision: "allow", reasonCode: "fixture_only", reason: "Offline fixture approval." }
        },
        reply: async ({ reply }) => {
          replies.push(reply)
          complete()
          return "replied"
        },
      },
      onFailure: (_request, error) => { failures.push(error) },
    })
    try {
      runtime.emit({ type: "permission.asked", properties: pending })
      await completed
      expect(replies).toEqual([expectedReply])
      expect(calls).toBe(0)
      expect(failures).toHaveLength(expectedReply === "once" ? 0 : 1)
    } finally {
      dispose()
      runtime.dispose()
    }
  })

  test("detects stable and V2 runtime versions", () => {
    expect(protocolForVersion("1.18.12")).toBe("stable")
    expect(protocolForVersion("0.0.0-beta-202608040144")).toBe("v2")
    expect(protocolForVersion("2.0.0")).toBe("v2")
    expect(protocolForVersion(undefined)).toBeUndefined()
  })

  test("does not permanently classify an unavailable version", async () => {
    const runtime = createStableRuntime(
      { ...client(), global: {} },
      { model: "cloudflare-workers-ai/@cf/deepseek-ai/deepseek-v4-flash-0731" },
      "/repo",
    )

    expect(await runtime.version()).toBeUndefined()
    runtime.dispose()
  })

  test("resumes the session with safe continuation guidance after a denial", async () => {
    const injected = client()
    const runtime = createStableRuntime(injected, { model: "cloudflare-workers-ai/@cf/deepseek-ai/deepseek-v4-flash-0731" }, "/repo")
    await runtime.context.data.session.message.sync("ses_child")

    runtime.context.resumeAfterDenial?.("ses_child", "The user explicitly prohibited this action.")
    await new Promise((resolve) => setTimeout(resolve, 150))

    expect(injected.prompts).toEqual([
      {
        path: { id: "ses_child" },
        query: { directory: "/repo" },
        body: {
          agent: "build",
          model: { providerID: "cloudflare-workers-ai", modelID: "@cf/deepseek-ai/deepseek-v4-flash-0731" },
          variant: "max",
          parts: [{
            type: "text",
            text: expect.stringContaining("Continue the task using a safer alternative"),
          }],
        },
      },
    ])
    runtime.dispose()
  })

  test("normalizes legacy permission.updated events and resolves root context", async () => {
    const runtime = createStableRuntime(client(), { model: "cloudflare-workers-ai/@cf/deepseek-ai/deepseek-v4-flash-0731" }, "/repo")
    const seen: unknown[] = []
    runtime.context.data.on("permission.asked", (event) => seen.push(event))

    runtime.emit({
      type: "permission.updated",
      properties: {
        id: "per_1",
        type: "bash",
        pattern: "git status",
        sessionID: "ses_child",
        messageID: "msg_assistant",
        callID: "call_1",
        title: "Run command",
        metadata: {},
      },
    })

    expect(seen).toHaveLength(1)
    expect(await runtime.context.data.session.root("ses_child")).toBe("ses_root")
    await runtime.context.data.session.message.sync("ses_root")
    expect(runtime.context.data.session.message.list("ses_root")).toHaveLength(2)
    await runtime.context.data.session.permission.sync("ses_child")
    expect(runtime.context.data.session.permission.list("ses_child")).toMatchObject([
      { id: "per_1", action: "bash", resources: ["git status"], always: [], protocol: "stable" },
    ])
    runtime.dispose()
  })

  test("normalizes stable permission replies", () => {
    const runtime = createStableRuntime(client(), { model: "cloudflare-workers-ai/@cf/deepseek-ai/deepseek-v4-flash-0731" }, "/repo")
    const seen: unknown[] = []
    runtime.context.data.on("permission.replied", (event) => seen.push(event))

    runtime.emit({
      type: "permission.replied",
      properties: { sessionID: "ses_child", permissionID: "per_1", response: "once" },
    })

    expect(seen).toHaveLength(1)
    runtime.dispose()
  })
})
