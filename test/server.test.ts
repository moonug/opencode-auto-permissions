import { describe, expect, test } from "bun:test"
import server from "../src/server.ts"
import { REVIEWER_SYSTEM_PROMPT } from "../src/agent.ts"

function pluginInput() {
  return {
    directory: "/repo",
    client: {
      global: { health: async () => ({ data: { healthy: true, version: "1.18.12" } }) },
      v2: {},
      permission: {
        list: async () => ({ data: [] }),
        reply: async () => ({ data: true }),
      },
      session: {
        get: async () => ({ data: { id: "ses_root" } }),
        messages: async () => ({ data: [] }),
        create: async () => ({ data: { id: "ses_review" } }),
        prompt: async () => ({
          data: { info: { structured: { decision: "deny", reasonCode: "test", reason: "Test." } } },
        }),
        delete: async () => ({ data: true }),
      },
      app: {
        agents: async () => ({ data: [] }),
        skills: async () => ({ data: [] }),
      },
      tui: { showToast: async () => ({ data: true }) },
    },
  } as never
}

describe("server plugin", () => {
  test("observes a legacy mutation synchronously while final source collection is suspended", async () => {
    const input: any = pluginInput()
    let human = { info: { id: "human", role: "user", time: { created: 1 } }, parts: [{ type: "text", text: "Run local tests." }] }
    const source = { info: { id: "source", role: "assistant", time: { created: 2 } },
      parts: [{ type: "tool", tool: "bash", callID: "call", state: { input: { command: "pnpm test" } } }] }
    const request = { id: "p", sessionID: "ses_root", permission: "bash", patterns: ["pnpm test"], always: [],
      tool: { messageID: "source", callID: "call" } }
    let release!: (value: unknown) => void
    let sourceStarted!: () => void
    const started = new Promise<void>((resolve) => { sourceStarted = resolve })
    let replied!: () => void
    const done = new Promise<void>((resolve) => { replied = resolve })
    const replies: string[] = []
    input.client.session.messages = async () => ({ data: [human, source] })
    input.client.session.message = () => { sourceStarted(); return new Promise((resolve) => { release = resolve }) }
    input.client.permission.list = async () => ({ data: [request] })
    input.client.permission.reply = async ({ reply }: any) => { replies.push(reply); replied(); return { data: true } }
    const hooks = await server.server(input, { model: "fixture/reviewer", runtime: "stable" })
    try {
      await hooks.event?.({ event: { type: "permission.asked", properties: request } })
      await started
      human = { ...human, parts: [{ type: "text", text: "Do not execute pnpm test." }] }
      let observed = false
      const mutation = hooks.event?.({ event: { type: "message.part.updated", properties: {
        get part() { observed = true; return { sessionID: "ses_root", messageID: "human", type: "text" } },
      } } })
      // Do not await the hook: the host can resume the active collector immediately.
      expect(observed).toBe(true)
      release({ data: source })
      await done
      await mutation
      expect(replies).toEqual(["reject"])
    } finally {
      release?.({ data: source })
      await hooks.dispose?.()
    }
  })

  test("observes delivered changes once through the legacy hook before subsequent permissions", async () => {
    let current = { info: { id: "human", role: "user", time: { created: 1 } }, parts: [{ type: "text", text: "Run local tests." }] }
    let full = 0
    let points = 0
    const replies: string[] = []
    const pending: any[] = []
    let completed!: () => void
    const input: any = pluginInput()
    input.client.session.messages = async () => { full++; return { data: [current] } }
    input.client.session.message = async () => { points++; return { data: current } }
    input.client.permission.list = async () => ({ data: pending })
    input.client.permission.reply = async ({ reply }: any) => { replies.push(reply); completed(); return { data: true } }
    const hooks = await server.server(input, { model: "fixture/reviewer", runtime: "stable" })
    try {
      for (let index = 0; index < 2; index++) {
        const request = { id: `p_${index}`, sessionID: "ses_root", permission: "bash", patterns: ["pnpm test"], always: [] }
        pending.push(request)
        const done = new Promise<void>((resolve) => { completed = resolve })
        await hooks.event?.({ event: { type: "permission.asked", properties: request } })
        await done
        if (index === 0) {
          current = { ...current, parts: [{ type: "text", text: "Do not execute pnpm test." }] }
          const mutation = hooks.event?.({ event: { type: "message.part.updated", properties: { part: { sessionID: "ses_root", messageID: "human", type: "text" } } } })
          await mutation
        }
      }
      expect(replies).toEqual(["once", "reject"])
      expect(full).toBe(1)
      expect(points).toBe(1)
    } finally { await hooks.dispose?.() }
  })

  test("prioritizes exact tool input and the latest human request", () => {
    expect(REVIEWER_SYSTEM_PROMPT).toContain("Judge the actual operation from toolInput")
    expect(REVIEWER_SYSTEM_PROMPT).toContain("Give the latest human request the greatest weight")
    expect(REVIEWER_SYSTEM_PROMPT).toContain("Treat direct continuation phrases")
    expect(REVIEWER_SYSTEM_PROMPT).toContain("later explicit human authorization")
    expect(REVIEWER_SYSTEM_PROMPT).toContain("do not treat the boundary glob as the intended scope")
  })

  test("registers the hidden reviewer agent through the beta config hook", async () => {
    const factory = server.server
    const hooks = await factory(pluginInput(), { model: "cloudflare-workers-ai/@cf/deepseek-ai/deepseek-v4-flash-0731" })
    const config: any = {}

    await hooks.config?.(config)

    expect(config.agent["auto-permissions-reviewer"]).toMatchObject({
      model: "cloudflare-workers-ai/@cf/deepseek-ai/deepseek-v4-flash-0731",
      mode: "subagent",
      hidden: true,
      steps: 1,
      tools: { "*": false },
      permission: { "*": "deny" },
    })
  })

  test("strips ambient context only for the hidden reviewer request", async () => {
    const hooks = await server.server(pluginInput(), { model: "cloudflare-workers-ai/@cf/deepseek-ai/deepseek-v4-flash-0731" })
    const reviewerSystem = ["large global prompt", "skills", "mcp"]
    const regularSystem = ["regular prompt"]

    await hooks["chat.message"]?.(
      {
        sessionID: "ses_review",
        agent: "auto-permissions-reviewer",
        model: { providerID: "cloudflare-workers-ai", modelID: "@cf/deepseek-ai/deepseek-v4-flash-0731" },
      },
      {} as never,
    )
    await hooks["experimental.chat.system.transform"]?.(
      { sessionID: "ses_review", model: {} as never },
      { system: reviewerSystem },
    )
    const retrySystem = ["large global prompt again"]
    await hooks["experimental.chat.system.transform"]?.(
      { sessionID: "ses_review", model: {} as never },
      { system: retrySystem },
    )
    await hooks["experimental.chat.system.transform"]?.(
      { sessionID: "ses_regular", model: {} as never },
      { system: regularSystem },
    )

    expect(reviewerSystem).toEqual([REVIEWER_SYSTEM_PROMPT])
    expect(retrySystem).toEqual(reviewerSystem)
    expect(regularSystem).toEqual(["regular prompt"])
    await hooks.dispose?.()
  })
})
