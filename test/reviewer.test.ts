import { describe, expect, test } from "bun:test"
import { installReviewer } from "../src/reviewer.ts"
import type { PermissionRequest, ReviewerClient, RuntimeContext } from "../src/types.ts"

function harness(options: Record<string, unknown> = { model: "cloudflare-workers-ai/@cf/deepseek-ai/deepseek-v4-flash-0731" }) {
  const handlers = new Map<string, Set<(event: unknown) => void>>()
  const requests: PermissionRequest[] = []
  const replies: Parameters<ReviewerClient["reply"]>[0][] = []
  const toasts: string[] = []
  const resumptions: Array<{ sessionID: string; reason: string }> = []

  const context: RuntimeContext = {
    options,
    client: {},
    data: {
      on(type, handler) {
        const set = handlers.get(type) ?? new Set()
        set.add(handler)
        handlers.set(type, set)
        return () => set.delete(handler)
      },
      session: {
        root: () => "ses_root",
        get: (id) => ({ id, ...(id === "ses_root" ? {} : { parentID: "ses_root" }) }),
        message: {
          list: () => {
            const command = requests[0]?.resources[0] ?? "pnpm test"
            return [
              {
                id: "msg_user",
                type: "user",
                role: "user",
                time: { created: 1 },
                text: "Run the tests.",
                model: { providerID: "example", modelID: "main" },
              },
              {
                id: "msg_assistant",
                type: "assistant",
                time: { created: 2 },
                agent: "build",
                model: { providerID: "example", id: "main" },
                content: [
                  {
                    id: "call_1",
                    type: "tool",
                    name: "shell",
                    state: { status: "running", input: { command }, structured: {}, content: [] },
                    time: { created: 2 },
                  },
                ],
              },
            ] as never
          },
          get: (_sessionID, messageID) => {
            const command = requests[0]?.resources[0] ?? "pnpm test"
            return messageID === "msg_assistant"
              ? ({
                  id: "msg_assistant",
                  type: "assistant",
                  time: { created: 2 },
                  agent: "build",
                  model: { providerID: "example", id: "main" },
                  content: [
                    {
                      id: "call_1",
                      type: "tool",
                      name: "shell",
                      state: { status: "running", input: { command }, structured: {}, content: [] },
                      time: { created: 2 },
                    },
                  ],
                } as never)
              : undefined
          },
          sync: async () => {},
        },
        permission: {
          list: () => requests,
          sync: async () => {},
        },
      },
      location: { default: () => ({ directory: "/repo" }) },
    },
    showToast: (input) => toasts.push(input.title ?? input.message),
    resumeAfterDenial: (sessionID, reason) => resumptions.push({ sessionID, reason }),
  }

  const client: ReviewerClient = {
    generate: async () => ({
      decision: "deny",
      reasonCode: "missing_authorization",
      reason: "Authorization is missing; continue with a safer alternative.",
    }),
    async reply(input) {
      replies.push(input)
      const index = requests.findIndex((request) => request.id === input.requestID)
      if (index >= 0) requests.splice(index, 1)
      return "replied"
    },
  }

  const emit = (type: string, data: unknown) => {
    for (const handler of handlers.get(type) ?? []) handler({ type, data })
  }

  return { context, client, requests, replies, toasts, resumptions, emit }
}

function request(command: string, protocol: PermissionRequest["protocol"] = "v2", id = "per_1"): PermissionRequest {
  return {
    id,
    sessionID: "ses_root",
    action: "shell",
    resources: [command],
    always: [command],
    source: { type: "tool", messageID: "msg_assistant", callID: "call_1" },
    protocol,
  }
}

function toolRequest(action: string, resource: string): PermissionRequest {
  return {
    id: "per_1",
    sessionID: "ses_root",
    action,
    resources: [resource],
    always: [resource],
    source: { type: "tool", messageID: "msg_assistant", callID: "call_1" },
    protocol: "v2",
  }
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 10))
}

function fixtureRuntime(protocol: PermissionRequest["protocol"]) {
  const app = harness()
  const nativeGrants = new Set<string>()
  const events = { asked: 0, skipped: 0 }
  const key = (pending: PermissionRequest) => JSON.stringify([pending.sessionID, pending.action, pending.resources])
  const reply = app.client.reply
  app.client.reply = async (input) => {
    const pending = app.requests.find((item) => item.id === input.requestID)
    if (input.reply === "always" && pending) nativeGrants.add(key(pending))
    return reply(input)
  }
  return {
    ...app,
    events,
    async ask(pending: PermissionRequest) {
      if (nativeGrants.has(key(pending))) {
        events.skipped++
        return "always"
      }
      events.asked++
      app.requests.push(pending)
      if (protocol === "stable") {
        app.emit("permission.asked", {
          id: pending.id, sessionID: pending.sessionID, permission: pending.action,
          patterns: pending.resources, always: pending.always, tool: pending.source,
        })
      } else {
        app.emit("permission.v2.asked", pending)
      }
      await settle()
      return app.replies.find((item) => item.requestID === pending.id)?.reply
    },
  }
}

function questionMessage(protocol: "stable" | "v2", answer = "Skip tests", completed = 3, framing = "Should I skip tests?") {
  const state = {
    status: "completed",
    input: { questions: [{ question: framing, options: [{ label: answer }] }] },
    ...(protocol === "stable"
      ? { metadata: { answers: [[answer]] }, time: { start: 2, end: completed } }
      : { structured: { answers: [[answer]] } }),
  }
  return protocol === "stable"
    ? { info: { role: "assistant" }, parts: [{ type: "tool", tool: "question", callID: "question_1", state }] }
    : { type: "assistant", content: [{ type: "tool", name: "question", id: "question_1", state, time: { completed } }] }
}

describe("installReviewer", () => {
  describe.each(["stable", "v2"] as const)("%s native permission runtime", (protocol) => {
    test("fixture skips asked events after a native always grant", async () => {
      const app = fixtureRuntime(protocol)
      const first = request("git fetch origin", protocol, "per_first")
      app.requests.push(first)
      await app.client.reply({ sessionID: first.sessionID, requestID: first.id, reply: "always", protocol })

      expect(await app.ask(request("git fetch origin", protocol, "per_second"))).toBe("always")
      expect(app.events).toEqual({ asked: 0, skipped: 1 })
      expect(app.replies).toHaveLength(1)
    })

    test.each(["replied", "not_found"] as const)("checks a first native result of %s before reusing an approval", async (firstResult) => {
      const app = fixtureRuntime(protocol)
      const reply = app.client.reply
      const outcomes: string[] = []
      app.client.reply = async (input) => {
        const result = await reply(input)
        const outcome = input.requestID === "per_first" ? firstResult : result
        outcomes.push(outcome)
        return outcome
      }
      let calls = 0
      app.client.generate = async () => ++calls === 1
        ? { decision: "allow_session", reasonCode: "fixture_allow", reason: "Offline repeatable approval." }
        : { decision: "deny", reasonCode: "fixture_deny", reason: "Offline next-request denial." }
      const dispose = installReviewer(app.context, { client: app.client })
      try {
        await app.ask(request("git fetch origin", protocol, "per_first"))
        await app.ask(request("git fetch origin", protocol, "per_second"))
        expect(outcomes).toEqual([firstResult, "replied"])
        expect(calls).toBe(firstResult === "replied" ? 1 : 2)
        expect(app.replies.map((input) => input.reply)).toEqual(["once", firstResult === "replied" ? "once" : "reject"])
        expect(app.events).toEqual({ asked: 2, skipped: 0 })
        expect(app.replies.every((input) => input.protocol === protocol)).toBe(true)
        expect(app.requests).toEqual([])
      } finally { dispose() }
    })

    test.each([false, true])("scopes reusable approvals to the requesting session, same requester: %s", async (same) => {
      const app = fixtureRuntime(protocol)
      const list = app.context.data.session.message.list
      app.context.data.session.message.list = (id) => id === "ses_root" ? list(id) : list(id).slice(1)
      const inputs: unknown[] = []
      app.client.generate = async ({ prompt }) => {
        inputs.push(JSON.parse(prompt.slice(prompt.indexOf("\n") + 1)))
        return inputs.length === 1
          ? { decision: "allow_session", reasonCode: "fixture_allow", reason: "Offline approval for the requesting session." }
          : { decision: "deny", reasonCode: "fixture_deny", reason: "Offline denial in the other requesting session." }
      }
      const first = { ...request("git fetch origin", protocol, "per_first"), sessionID: "ses_a" }
      const second = { ...first, id: "per_second", sessionID: same ? "ses_a" : "ses_b" }
      const dispose = installReviewer(app.context, { client: app.client })
      try {
        await app.ask(first)
        await app.ask(second)
        expect(inputs).toHaveLength(same ? 1 : 2)
        expect(inputs.at(-1)).toEqual(inputs[0])
        expect(inputs[0]).toMatchObject({ request: { toolInput: { command: "git fetch origin" } },
          context: { rootSessionID: "ses_root", delegationMessages: [], incomplete: false } })
        expect(app.replies.map(({ sessionID, requestID, reply }) => [sessionID, requestID, reply])).toEqual([
          ["ses_a", "per_first", "once"], [second.sessionID, "per_second", same ? "once" : "reject"],
        ])
        expect(app.replies.every((reply) => reply.protocol === protocol)).toBe(true)
        expect(app.events).toEqual({ asked: 2, skipped: 0 })
        expect(app.requests).toEqual([])
      } finally { dispose() }
    })

    test.each(["unchanged", "changed scope", "prohibition", "incomplete", "question answer"])(
      "plugin-local reuse preserves asked events with %s context",
      async (scenario) => {
        const app = fixtureRuntime(protocol)
        const list = app.context.data.session.message.list
        let changed = false
        let text = "Fetch only a different remote."
        if (scenario === "prohibition") text = "Do not execute git fetch origin."
        if (scenario === "incomplete") text = "x".repeat(16_001)
        app.context.data.session.message.list = () => [
          ...list("ses_root"),
          ...(changed && scenario === "question answer" ? [questionMessage(protocol)] : []),
          ...(changed && ["changed scope", "prohibition", "incomplete"].includes(scenario) ? [{
            type: "user", time: { created: 4 }, text,
          }] : []),
        ]
        let calls = 0
        app.client.generate = async () => ++calls === 1
          ? { decision: "allow_session", reasonCode: "repeatable_fetch", reason: "Offline fixture approval." }
          : { decision: "deny", reasonCode: "changed_scope", reason: "The updated scope does not permit this fetch." }
        const dispose = installReviewer(app.context, { client: app.client })
        try {
          const first = await app.ask(request("git fetch origin", protocol, "per_first"))
          changed = true
          const second = await app.ask(request("git fetch origin", protocol, "per_second"))

          expect(app.events).toEqual({ asked: 2, skipped: 0 })
          expect([first, second]).toEqual(["once", scenario === "unchanged" ? "once" : "reject"])
          expect(calls).toBe(["changed scope", "question answer"].includes(scenario) ? 2 : 1)
          expect(app.replies.every((item) => item.reply !== "always")).toBe(true)
          expect(app.replies.every((item) => item.protocol === protocol)).toBe(true)
        } finally {
          dispose()
        }
      },
    )

    test.each([
      { framing: "Which previous restriction should I keep?", decision: "deny", reply: "reject" },
      { framing: "Which previous restriction should I remove?", decision: "allow", reply: "once" },
    ])("reviews a selected prohibition label with its framing: $framing", async ({ framing, decision, reply }) => {
      const app = fixtureRuntime(protocol)
      const list = app.context.data.session.message.list
      const answer = "Do not execute pnpm test."
      app.context.data.session.message.list = () => [...list("ses_root"), questionMessage(protocol, answer, 3, framing)]
      const prompts: string[] = []
      app.client.generate = async ({ prompt }) => {
        prompts.push(prompt)
        return { decision, reasonCode: "framed_selection", reason: "Offline fixture interprets the selected restriction in context." }
      }
      const dispose = installReviewer(app.context, { client: app.client })
      try {
        const result = await app.ask(request("pnpm test", protocol))
        expect(prompts).toHaveLength(1)
        const input = JSON.parse(prompts[0]!.slice(prompts[0]!.indexOf("\n") + 1))
        expect(input.context.humanInteractions.at(-1)).toMatchObject({
          type: "question_answer", questions: [{ question: framing, options: [{ label: answer }] }], answers: [[answer]],
        })
        expect(result).toBe(reply)
        expect(app.events).toEqual({ asked: 1, skipped: 0 })
      } finally {
        dispose()
      }
    })

    test.each([
      "ordinary allow", "disabled reuse", "broad pattern", "push", "credential read", "credential shell",
      "mutating command", "redirection", "composition", "different input",
    ])("requires another model decision for %s", async (scenario) => {
      const app = fixtureRuntime(protocol)
      if (scenario === "disabled reuse") app.context.options = { ...app.context.options, sessionApprovals: false }
      const command = scenario === "push" ? "git push origin feature"
        : scenario === "credential shell" ? "cat /repo/.env"
        : scenario === "mutating command" ? "touch output"
        : scenario === "redirection" ? "echo hello > output"
        : scenario === "composition" ? "git fetch origin && touch output" : "git fetch origin"
      let calls = 0
      app.client.generate = async () => ++calls === 1
        ? { decision: scenario === "ordinary allow" ? "allow" : "allow_session", reasonCode: "fixture_allow", reason: "Offline first approval." }
        : { decision: "deny", reasonCode: "fixture_deny", reason: "Offline second denial." }
      const dispose = installReviewer(app.context, { client: app.client })
      try {
        for (let index = 0; index < 2; index++) {
          const pending = scenario === "credential read" ? toolRequest("read", "/home/user/.ssh/id_ed25519")
            : request(index && scenario === "different input" ? "git fetch origin main" : command, protocol)
          pending.id = `per_${index}`
          pending.protocol = protocol
          pending.always = scenario === "broad pattern" ? ["*"] : scenario === "different input" ? ["git fetch origin*"] : [...pending.resources]
          await app.ask(pending)
        }
        expect(calls).toBe(2)
        expect(app.replies.map((reply) => reply.reply)).toEqual(["once", "reject"])
        expect(app.events).toEqual({ asked: 2, skipped: 0 })
      } finally {
        dispose()
      }
    })

    test("honors contextual denial for own diagnostics with complete question answers", async () => {
      const app = fixtureRuntime(protocol)
      const list = app.context.data.session.message.list
      app.context.data.session.message.list = () => [
        ...list("ses_root"), questionMessage(protocol, "Keep diagnostics private", 3, "May I read diagnostics?"),
      ]
      const prompts: string[] = []
      app.client.generate = async ({ prompt }) => {
        prompts.push(prompt)
        return { decision: "deny", reasonCode: "private_diagnostics", reason: "Offline question-context denial." }
      }
      const dispose = installReviewer(app.context, { client: app.client })
      try {
        const pending = toolRequest("external_directory", "/home/user/.local/state/opencode/auto-permissions/*")
        pending.protocol = protocol
        expect(await app.ask(pending)).toBe("reject")
        expect(prompts).toHaveLength(1)
        expect(JSON.parse(prompts[0]!.slice(prompts[0]!.indexOf("\n") + 1)).context).toMatchObject({
          incomplete: false,
          humanInteractions: expect.arrayContaining([{
            type: "question_answer", sessionID: "ses_root", callID: "question_1", completedAt: 3,
            questions: [{ question: "May I read diagnostics?", options: [{ label: "Keep diagnostics private" }] }],
            answers: [["Keep diagnostics private"]],
          }]),
        })
      } finally {
        dispose()
      }
    })

    test.each([
      { action: "shell", resource: "pnpm test", decision: "allow" },
      { action: "shell", resource: "pnpm test", decision: "deny" },
      { action: "external_directory", resource: "/home/user/.local/state/opencode/auto-permissions/*", decision: "allow" },
      { action: "external_directory", resource: "/home/user/.local/state/opencode/auto-permissions/*", decision: "deny" },
    ])("delegated $action honors contextual $decision", async ({ action, resource, decision }) => {
      const app = fixtureRuntime(protocol)
      const root = "Implement the change and finish the task."
      const scope = action === "shell" ? "Inspect only. Do not execute pnpm test."
        : "Inspect source only. Do not access /home/user/.local/state/opencode/auto-permissions/."
      app.context.data.session.message.list = (id) => [{
        type: "user", text: id === "ses_root" ? root : scope, time: { created: id === "ses_root" ? 1 : 2 },
      }]
      const contexts: unknown[] = []
      app.client.generate = async ({ prompt }) => {
        contexts.push(JSON.parse(prompt.slice(prompt.indexOf("\n") + 1)).context)
        return { decision, reasonCode: "delegated_scope", reason: "Offline scoped review." }
      }
      const dispose = installReviewer(app.context, { client: app.client })
      try {
        const pending = toolRequest(action, resource)
        pending.sessionID = "ses_child"
        pending.protocol = protocol
        if (action === "shell" && protocol === "stable") pending.action = "bash"
        const reply = await app.ask(pending)
        expect(contexts).toHaveLength(1)
        expect(contexts[0]).toMatchObject({
          userMessages: [root],
          humanInteractions: [{ type: "message", sessionID: "ses_root", text: root }],
          delegationMessages: [{ sessionID: "ses_child", text: scope }],
        })
        expect(reply).toBe(decision === "allow" ? "once" : "reject")
      } finally {
        dispose()
      }
    })

    test.each([false, true])("binds reuse to independent tool input, changed: %s", async (changed) => {
      const app = fixtureRuntime(protocol)
      const input = { command: "git fetch origin" }
      const tool = { type: "tool", callID: "call_1", id: "call_1", state: { input } }
      app.context.data.session.message.get = () => protocol === "stable"
        ? { info: { role: "assistant" }, parts: [tool] }
        : { type: "assistant", content: [tool] }
      const commands: string[] = []
      app.client.generate = async ({ prompt }) => {
        commands.push(JSON.parse(prompt.slice(prompt.indexOf("\n") + 1)).request.toolInput.command)
        return commands.length === 1
          ? { decision: "allow_session", reasonCode: "first_input", reason: "Offline approval of the original operation." }
          : { decision: "deny", reasonCode: "changed_input", reason: "Offline denial of the changed operation." }
      }
      const dispose = installReviewer(app.context, { client: app.client })
      try {
        await app.ask(request("git fetch origin", protocol, "per_first"))
        if (changed) input.command = "git fetch origin main"
        await app.ask(request("git fetch origin", protocol, "per_second"))
        expect(commands).toEqual(changed ? ["git fetch origin", "git fetch origin main"] : ["git fetch origin"])
        expect(app.replies.map((reply) => reply.reply)).toEqual(["once", changed ? "reject" : "once"])
        expect(app.events).toEqual({ asked: 2, skipped: 0 })
      } finally {
        dispose()
      }
    })

    test("rejects an in-place tool-input change during deferred review", async () => {
      const app = fixtureRuntime(protocol)
      const input = { command: "git fetch origin" }
      const tool = { type: "tool", callID: "call_1", id: "call_1", state: { input } }
      app.context.data.session.message.get = () => protocol === "stable"
        ? { info: { role: "assistant" }, parts: [tool] }
        : { type: "assistant", content: [tool] }
      let release!: () => void
      let prompt = ""
      const reasonCodes: string[] = []
      app.client.generate = async (request) => {
        prompt = request.prompt
        await new Promise<void>((resolve) => { release = resolve })
        return { decision: "allow_session", reasonCode: "old_operation", reason: "Offline approval of the old input." }
      }
      const dispose = installReviewer(app.context, {
        client: app.client, onDecision: (_request, decision) => { reasonCodes.push(decision.reasonCode) },
      })
      try {
        const running = app.ask(request("git fetch origin", protocol))
        await settle()
        expect(typeof release).toBe("function")
        expect(JSON.parse(prompt.slice(prompt.indexOf("\n") + 1)).request.toolInput).toEqual({ command: "git fetch origin" })
        input.command = "git fetch origin main"
        release()
        await running
        await settle()
        expect(app.replies.map((reply) => reply.reply)).toEqual(["reject"])
        expect(reasonCodes).toEqual(["changed_human_context"])
      } finally {
        dispose()
      }
    })

    test.each(["root prohibition", "question answer", "delegation"])("rejects an in-flight approval after changed %s", async (scenario) => {
      const app = fixtureRuntime(protocol)
      const list = app.context.data.session.message.list
      let changed = false
      app.context.data.session.message.list = (id) => {
        if (scenario === "delegation" && id === "ses_child") return [{ type: "user", text: changed ? "New scope" : "Old scope" }]
        return [...list("ses_root"), ...(changed && scenario === "root prohibition" ? [{
          type: "user", text: "Do not execute git fetch origin.", time: { created: 4 },
        }] : []), ...(changed && scenario === "question answer" ? [questionMessage(protocol)] : [])]
      }
      let release!: () => void
      app.client.generate = async () => {
        await new Promise<void>((resolve) => { release = resolve })
        return { decision: "allow_session", reasonCode: "old_approval", reason: "Offline approval of the old snapshot." }
      }
      const dispose = installReviewer(app.context, { client: app.client })
      try {
        const pending = request("git fetch origin", protocol)
        if (scenario === "delegation") pending.sessionID = "ses_child"
        const running = app.ask(pending)
        await settle()
        expect(typeof release).toBe("function")
        changed = true
        release()
        await running
        await settle()
        expect(app.replies.map((reply) => reply.reply)).toEqual(["reject"])
      } finally {
        dispose()
      }
    })
  })

  test.each(["stable", "v2"] as const)("%s question answers require model review even for routine commands", async (protocol) => {
    const app = harness()
    const list = app.context.data.session.message.list
    app.context.data.session.message.list = () => [...list("ses_root"), questionMessage(protocol)]
    const prompts: string[] = []
    app.client.generate = async ({ prompt }) => {
      prompts.push(prompt)
      return { decision: "deny", reasonCode: "skip_tests", reason: "The user selected skipping tests." }
    }
    const pending = request("pnpm test", protocol)
    app.requests.push(pending)
    const dispose = installReviewer(app.context, { client: app.client })
    try {
      app.emit("permission.v2.asked", pending)
      await settle()
      expect(prompts).toHaveLength(1)
      expect(prompts[0]).toContain('"answers":[["Skip tests"]]')
      expect(app.replies[0]?.reply).toBe("reject")
    } finally {
      dispose()
    }
  })

  test.each(["stable", "v2"] as const)("%s question context cannot use or create session approvals", async (protocol) => {
    const app = harness()
    const list = app.context.data.session.message.list
    let answered = false
    app.context.data.session.message.list = () => [...list("ses_root"), ...(answered ? [questionMessage(protocol)] : [])]
    let calls = 0
    app.client.generate = async () => {
      calls++
      return { decision: "allow_session", reasonCode: "fixture_allow", reason: "Offline fixture approval." }
    }
    const dispose = installReviewer(app.context, { client: app.client })
    try {
      for (let index = 0; index < 3; index++) {
        answered = index > 0
        const pending = request("git fetch origin", protocol, `per_${index}`)
        app.requests.push(pending)
        app.emit("permission.v2.asked", pending)
        await settle()
      }
      expect(calls).toBe(3)
      expect(app.replies.map((reply) => reply.reply)).toEqual(["once", "once", "once"])
    } finally {
      dispose()
    }
  })

  test.each(["prohibition", "oversized", "ambiguous chronology"])("cached approval cannot override %s", async (scenario) => {
    const app = harness()
    const list = app.context.data.session.message.list
    let changed = false
    app.context.data.session.message.list = () => {
      const messages = list("ses_root")
      if (!changed) return messages
      if (scenario === "ambiguous chronology") return [
        { type: "user", text: "Run the tests." }, questionMessage("v2"),
      ]
      return [
        ...messages,
        { type: "user", text: scenario === "prohibition" ? "Do not execute git fetch origin." : "x".repeat(16_001), time: { created: 4 } },
      ]
    }
    let calls = 0
    app.client.generate = async () => {
      calls++
      return { decision: "allow_session", reasonCode: "fixture_allow", reason: "Offline fixture approval." }
    }
    const dispose = installReviewer(app.context, { client: app.client })
    try {
      for (let index = 0; index < 2; index++) {
        changed = index > 0
        const pending = request("git fetch origin", "v2", `per_${index}`)
        app.requests.push(pending)
        app.emit("permission.v2.asked", pending)
        await settle()
      }
      expect(calls).toBe(1)
      expect(app.replies.map((reply) => reply.reply)).toEqual(["once", "reject"])
    } finally {
      dispose()
    }
  })

  test("changed human scope invalidates a narrow cached approval", async () => {
    const app = harness()
    let text = "Fetch origin."
    app.context.data.session.message.list = () => [{ type: "user", text, time: { created: 1 } }]
    let calls = 0
    app.client.generate = async () => {
      calls++
      return { decision: "allow_session", reasonCode: "fixture_allow", reason: "Offline fixture approval." }
    }
    const dispose = installReviewer(app.context, { client: app.client })
    try {
      for (let index = 0; index < 2; index++) {
        if (index) text = "Fetch a different target only."
        const pending = request("git fetch origin", "v2", `per_${index}`)
        app.requests.push(pending)
        app.emit("permission.v2.asked", pending)
        await settle()
      }
      expect(calls).toBe(2)
    } finally {
      dispose()
    }
  })

  test.each(["root message", "question answer", "delegation"])("does not coalesce reviews with different %s context", async (scenario) => {
    const app = harness()
    let version = 0
    app.context.data.session.message.list = (sessionID) => {
      if (scenario === "delegation" && sessionID === "ses_child") return [{ type: "user", text: `Scope ${version}` }]
      if (sessionID === "ses_child") return []
      return [
        { type: "user", text: scenario === "root message" ? `Request ${version}` : "Prepare configuration.", time: { created: 1 } },
        ...(scenario === "question answer" ? [questionMessage("v2", `Choice ${version}`)] : []),
      ]
    }
    const releases: Array<() => void> = []
    app.client.generate = async () => {
      await new Promise<void>((resolve) => releases.push(resolve))
      return { decision: "allow", reasonCode: "fixture_allow", reason: "Offline fixture approval." }
    }
    const dispose = installReviewer(app.context, { client: app.client })
    try {
      for (let index = 0; index < 2; index++) {
        version = index
        const pending = request("git push origin feature", "v2", `per_${index}`)
        if (scenario === "delegation") pending.sessionID = "ses_child"
        app.requests.push(pending)
        app.emit("permission.v2.asked", pending)
        await settle()
      }
      expect(releases).toHaveLength(2)
      for (const release of releases) release()
      await settle()
      expect(app.replies).toHaveLength(2)
    } finally {
      dispose()
    }
  })

  test("a prohibition beyond 4000 characters still rejects a routine command", async () => {
    const app = harness()
    app.context.data.session.message.list = () => [{ type: "user", text: `${"Context. ".repeat(600)}Do not execute pnpm test.` }]
    let calls = 0
    app.client.generate = async () => { calls++; return { decision: "allow", reasonCode: "fixture_allow", reason: "Offline fixture approval." } }
    const pending = request("pnpm test")
    app.requests.push(pending)
    const dispose = installReviewer(app.context, { client: app.client })
    try {
      app.emit("permission.v2.asked", pending)
      await settle()
      expect(calls).toBe(0)
      expect(app.replies[0]?.reply).toBe("reject")
    } finally {
      dispose()
    }
  })

  test("uses the requesting session model when no reviewer model is configured", async () => {
    const app = harness({})
    let model: Parameters<ReviewerClient["generate"]>[0]["model"] | undefined
    app.client.generate = async (input) => {
      model = input.model
      return { decision: "allow", reasonCode: "requested_action", reason: "The user requested this action." }
    }
    app.requests.push(request("git push origin feature"))
    const dispose = installReviewer(app.context, { client: app.client })

    app.emit("permission.v2.asked", app.requests[0])
    await settle()

    expect(model).toEqual({ providerID: "example", id: "main" })
    expect(app.replies).toHaveLength(1)
    dispose()
  })

  test.each(["provider error", "timeout", "invalid output"])("falls back to the session model after a reviewer %s", async (failure) => {
    const app = harness({ model: "reviewer/fast", variant: "reviewer-only", timeoutMs: 100 })
    const models: Parameters<ReviewerClient["generate"]>[0]["model"][] = []
    const signals: AbortSignal[] = []
    app.client.generate = async ({ model, signal }) => {
      models.push(model)
      signals.push(signal)
      if (model.providerID === "reviewer") {
        if (failure === "invalid output") return { decision: "allow" }
        if (failure === "timeout") {
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(new Error("Aborted")), { once: true })
          })
        }
        throw new Error("provider unavailable")
      }
      return { decision: "allow", reasonCode: "requested_action", reason: "The user requested this action." }
    }
    app.requests.push(request("git push origin feature"))
    const dispose = installReviewer(app.context, { client: app.client })
    try {
      app.emit("permission.v2.asked", app.requests[0])
      await new Promise((resolve) => setTimeout(resolve, failure === "timeout" ? 150 : 20))
      expect(models).toEqual([
        { providerID: "reviewer", id: "fast", variant: "reviewer-only" },
        { providerID: "example", id: "main" },
      ])
      expect(signals[1]).not.toBe(signals[0])
      expect(signals[1]?.aborted).toBe(false)
      expect(app.replies.map((reply) => reply.reply)).toEqual(["once"])
      expect(app.resumptions).toEqual([])
    } finally {
      dispose()
    }
  })

  test.each(["deny", "same model", "no configured model", "missing session model", "disposed"])("does not fall back for %s", async (scenario) => {
    const app = harness(scenario === "no configured model" ? {} : {
      model: scenario === "same model" ? "example/main" : "reviewer/fast",
    })
    if (scenario === "missing session model") app.context.data.session.message.list = () => []
    let calls = 0
    let fail!: () => void
    app.client.generate = async () => {
      calls++
      if (scenario === "deny") return { decision: "deny", reasonCode: "not_authorized", reason: "Not authorized." }
      if (scenario === "disposed") await new Promise<void>((_resolve, reject) => { fail = () => reject(new Error("cancelled")) })
      throw new Error("provider unavailable")
    }
    app.requests.push(request("git push origin feature"))
    const dispose = installReviewer(app.context, { client: app.client })
    try {
      app.emit("permission.v2.asked", app.requests[0])
      await settle()
      if (scenario === "disposed") {
        dispose()
        fail()
        await settle()
      }
      expect(calls).toBe(1)
      expect(app.replies.map((reply) => reply.reply)).toEqual(scenario === "disposed" ? [] : ["reject"])
    } finally {
      dispose()
    }
  })

  test("falls back even when the primary ignores its abort signal", async () => {
    const app = harness({ model: "reviewer/fast", timeoutMs: 100 })
    let calls = 0
    app.client.generate = async () => {
      if (++calls === 1) return await new Promise(() => {})
      return { decision: "allow", reasonCode: "requested_action", reason: "The user requested this action." }
    }
    app.requests.push(request("git push origin feature"))
    const dispose = installReviewer(app.context, { client: app.client })
    try {
      app.emit("permission.v2.asked", app.requests[0])
      await new Promise((resolve) => setTimeout(resolve, 150))
      expect(calls).toBe(2)
      expect(app.replies.map((reply) => reply.reply)).toEqual(["once"])
    } finally {
      dispose()
    }
  })

  test("truncates an over-long reviewer reason instead of failing the review", async () => {
    const app = harness({ model: "reviewer/fast" })
    app.client.generate = async () => ({
      decision: "allow",
      reasonCode: "requested_action",
      reason: "The requested action is reasonable. ".repeat(10),
    })
    app.requests.push(request("git push origin feature"))
    const dispose = installReviewer(app.context, { client: app.client })
    try {
      app.emit("permission.v2.asked", app.requests[0])
      await settle()
      expect(app.replies.map((reply) => reply.reply)).toEqual(["once"])
      expect(app.resumptions).toEqual([])
    } finally {
      dispose()
    }
  })

  test("silently approves a deterministic safe command once", async () => {
    const app = harness()
    app.requests.push(request("pnpm test"))
    const dispose = installReviewer(app.context, { client: app.client })

    app.emit("permission.v2.asked", app.requests[0])
    await settle()

    expect(app.replies).toEqual([
      { sessionID: "ses_root", requestID: "per_1", reply: "once", protocol: "v2" },
    ])
    expect(app.toasts).toEqual([])
    dispose()
  })

  test("reviews permission actions outside shell and external directory", async () => {
    const app = harness()
    app.client.generate = async () => ({ decision: "allow", reasonCode: "requested_read", reason: "Reads a project file." })
    app.requests.push(toolRequest("read", "src/index.ts"))
    const dispose = installReviewer(app.context, { client: app.client })

    app.emit("permission.v2.asked", app.requests[0])
    await settle()

    expect(app.replies).toEqual([
      { sessionID: "ses_root", requestID: "per_1", reply: "once", protocol: "v2" },
    ])
    dispose()
  })

  test("keeps a narrow repeatable approval plugin-local with a native once reply", async () => {
    const app = harness()
    app.client.generate = async () => ({
      decision: "allow_session",
      reasonCode: "repeatable_fetch",
      reason: "Fetching this remote is a repeatable low-risk operation.",
    })
    const pending = request("git fetch origin")
    pending.always = ["git fetch origin*"]
    app.requests.push(pending)
    const dispose = installReviewer(app.context, { client: app.client })

    app.emit("permission.v2.asked", app.requests[0])
    await settle()

    expect(app.replies).toEqual([
      { sessionID: "ses_root", requestID: "per_1", reply: "once", protocol: "v2" },
    ])
    dispose()
  })

  test("reuses an explicitly approved unchanged operation without another model call", async () => {
    const app = harness()
    let reviews = 0
    app.client.generate = async () => {
      reviews++
      return { decision: "allow_session", reasonCode: "approved_fetch", reason: "The fetch is approved." }
    }
    const first = request("git fetch origin", "v2", "per_1")
    first.always = ["git fetch origin*"]
    app.requests.push(first)
    const dispose = installReviewer(app.context, { client: app.client })

    app.emit("permission.v2.asked", first)
    await settle()
    const second = request("git fetch origin", "v2", "per_2")
    second.always = ["git fetch origin*"]
    app.requests.push(second)
    app.emit("permission.v2.asked", second)
    await settle()

    expect(reviews).toBe(1)
    expect(app.replies.map((reply) => reply.requestID)).toEqual(["per_1", "per_2"])
    dispose()
  })

  test("bounds reusable approval storage by evicting old operations", async () => {
    const app = fixtureRuntime("v2")
    let calls = 0
    app.client.generate = async () => {
      calls++
      return { decision: "allow_session", reasonCode: "fixture_allow", reason: "Offline repeatable fetch." }
    }
    const dispose = installReviewer(app.context, { client: app.client })
    try {
      for (let index = 0; index < 129; index++) {
        await app.ask(request(`git fetch origin branch${index}`, "v2", `per_${index}`))
      }
      await app.ask(request("git fetch origin branch0", "v2", "per_again"))
      expect(calls).toBe(130)
      expect(app.events).toEqual({ asked: 130, skipped: 0 })
    } finally {
      dispose()
    }
  })

  test("coalesces concurrent identical requests into one model review", async () => {
    const app = harness()
    let reviews = 0
    let release!: () => void
    app.client.generate = async () => {
      reviews++
      await new Promise<void>((resolve) => { release = resolve })
      return { decision: "allow", reasonCode: "approved_push", reason: "The push is approved." }
    }
    const first = request("git push origin main", "v2", "per_1")
    const second = request("git push origin main", "v2", "per_2")
    app.requests.push(first, second)
    const dispose = installReviewer(app.context, { client: app.client })

    app.emit("permission.v2.asked", first)
    app.emit("permission.v2.asked", second)
    for (let attempt = 0; attempt < 20 && !release; attempt++) await Promise.resolve()
    release()
    await settle()

    expect(reviews).toBe(1)
    expect(app.replies.map((reply) => reply.requestID).sort()).toEqual(["per_1", "per_2"])
    expect(app.replies.every((reply) => reply.reply === "once")).toBeTrue()
    dispose()
  })

  test.each([
    { command: "git push origin feature", always: ["git push origin feature"] },
    { command: "git fetch origin", always: ["*"] },
    { command: "git fetch origin", always: ["git *"] },
  ])("downgrades ineligible session approval for $command", async ({ command, always }) => {
    const app = harness()
    app.client.generate = async () => ({
      decision: "allow_session",
      reasonCode: "repeatable_action",
      reason: "Allow matching actions for this session.",
    })
    const pending = request(command)
    pending.always = [...always]
    app.requests.push(pending)
    const dispose = installReviewer(app.context, { client: app.client })

    app.emit("permission.v2.asked", app.requests[0])
    await settle()

    expect(app.replies[0]?.reply).toBe("once")
    dispose()
  })

  test("can disable session approvals", async () => {
    const app = harness({ model: "cloudflare-workers-ai/@cf/deepseek-ai/deepseek-v4-flash-0731", sessionApprovals: false })
    app.client.generate = async () => ({
      decision: "allow_session",
      reasonCode: "repeatable_fetch",
      reason: "Fetching this remote is a repeatable low-risk operation.",
    })
    const pending = request("git fetch origin")
    pending.always = ["git fetch origin*"]
    app.requests.push(pending)
    const dispose = installReviewer(app.context, { client: app.client })

    app.emit("permission.v2.asked", app.requests[0])
    await settle()

    expect(app.replies[0]?.reply).toBe("once")
    dispose()
  })

  test.each([
    { action: "read", resource: "/home/user/.ssh/id_ed25519" },
    { action: "shell", resource: "cat /repo/.env" },
  ])("keeps credential-sensitive $action approval one-time", async ({ action, resource }) => {
    const app = harness()
    app.client.generate = async () => ({
      decision: "allow_session",
      reasonCode: "repeatable_access",
      reason: "Allow matching access for this session.",
    })
    const pending = action === "shell" ? request(resource) : toolRequest(action, resource)
    pending.always = [resource]
    app.requests.push(pending)
    const dispose = installReviewer(app.context, { client: app.client })

    app.emit("permission.v2.asked", app.requests[0])
    await settle()

    expect(app.replies[0]?.reply).toBe("once")
    dispose()
  })

  test("automatically rejects a deterministic unsafe command with feedback", async () => {
    const app = harness()
    app.requests.push(request("sudo rm -rf /"))
    const dispose = installReviewer(app.context, { client: app.client })

    app.emit("permission.v2.asked", app.requests[0])
    await settle()

    expect(app.replies[0]).toMatchObject({ reply: "reject", message: expect.stringContaining("blocked") })
    expect(app.toasts).toEqual(["Blocked"])
    expect(app.resumptions).toEqual([
      {
        sessionID: "ses_root",
        reason: "Recursively deleting the filesystem root or home directory would cause catastrophic data loss; target only the specific generated directory instead.",
      },
    ])
    dispose()
  })

  test("resolves a deny verdict with helpful continuation", async () => {
    const app = harness()
    app.requests.push(request("git push origin feature"))
    const dispose = installReviewer(app.context, { client: app.client })

    app.emit("permission.v2.asked", app.requests[0])
    await settle()

    expect(app.replies[0]).toMatchObject({ reply: "reject", message: expect.stringContaining("safer alternative") })
    expect(app.requests).toHaveLength(0)
    expect(app.toasts).toEqual(["Blocked"])
    expect(app.resumptions).toEqual([
      { sessionID: "ses_root", reason: "Authorization is missing; continue with a safer alternative." },
    ])
    dispose()
  })

  test("rejects a timed-out review and resumes with safer guidance", async () => {
    const app = harness({ model: "cloudflare-workers-ai/@cf/deepseek-ai/deepseek-v4-flash-0731", timeoutMs: 100 })
    app.client.generate = ({ signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("Review timed out")), { once: true })
    })
    app.requests.push(request("git push origin feature"))
    const failures: unknown[] = []
    const dispose = installReviewer(app.context, {
      client: app.client,
      onFailure: (_request, error) => failures.push(error),
    })

    app.emit("permission.v2.asked", app.requests[0])
    await new Promise((resolve) => setTimeout(resolve, 250))

    expect(app.replies[0]).toMatchObject({ reply: "reject", message: expect.stringContaining("timed out") })
    expect(app.requests).toHaveLength(0)
    expect(app.toasts).toEqual(["Blocked"])
    expect(app.resumptions[0]?.reason).toContain("narrower or lower-risk step")
    expect(failures).toHaveLength(1)
    dispose()
  })

  test("rejects a provider failure and resumes with safer guidance", async () => {
    const app = harness()
    app.client.generate = async () => { throw new Error("provider unavailable") }
    app.requests.push(request("git push origin feature"))
    const dispose = installReviewer(app.context, { client: app.client })

    app.emit("permission.v2.asked", app.requests[0])
    await settle()

    expect(app.replies[0]).toMatchObject({ reply: "reject", message: expect.stringContaining("review failed") })
    expect(app.requests).toHaveLength(0)
    expect(app.resumptions[0]?.reason).toContain("narrower or lower-risk step")
    dispose()
  })

  test("reports an aborted generation as a timeout when its deadline expires", async () => {
    const app = harness({ model: "cloudflare-workers-ai/@cf/deepseek-ai/deepseek-v4-flash-0731", timeoutMs: 100 })
    app.client.generate = async ({ signal }) => {
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("Aborted")), { once: true })
      })
      throw new Error("unreachable")
    }
    app.requests.push(request("git push origin feature"))
    const dispose = installReviewer(app.context, { client: app.client })

    app.emit("permission.v2.asked", app.requests[0])
    await new Promise((resolve) => setTimeout(resolve, 250))

    expect(app.replies[0]?.message).toContain("review timed out")
    expect(app.resumptions[0]?.reason).toContain("timed out")
    dispose()
  })

  test("cancels a review when another actor replies first", async () => {
    const app = harness()
    app.requests.push(request("git push origin feature"))
    let release!: (value: string) => void
    app.client.generate = () => new Promise((resolve) => (release = resolve))
    const dispose = installReviewer(app.context, { client: app.client })

    app.emit("permission.v2.asked", app.requests[0])
    for (let attempt = 0; attempt < 20 && !release; attempt++) await Promise.resolve()
    expect(typeof release).toBe("function")
    app.requests.length = 0
    app.emit("permission.v2.replied", { sessionID: "ses_root", requestID: "per_1", reply: "reject" })
    release({ decision: "allow", reasonCode: "approved", reason: "Allowed." } as never)
    await settle()

    expect(app.replies).toEqual([])
    dispose()
  })

  test("shadow mode records but never replies", async () => {
    const app = harness({ model: "cloudflare-workers-ai/@cf/deepseek-ai/deepseek-v4-flash-0731", shadow: true })
    app.requests.push(request("pnpm test"))
    const decisions: string[] = []
    const dispose = installReviewer(app.context, {
      client: app.client,
      onDecision: (_request, decision) => decisions.push(decision.kind),
    })

    app.emit("permission.v2.asked", app.requests[0])
    await settle()

    expect(decisions).toEqual(["allow"])
    expect(app.replies).toEqual([])
    dispose()
  })

  test("auto-detects the stable permission event protocol", async () => {
    const app = harness()
    const stable = request("git status", "stable")
    app.requests.push(stable)
    const dispose = installReviewer(app.context, { client: app.client })

    app.emit("permission.asked", {
      id: stable.id,
      sessionID: stable.sessionID,
      permission: "bash",
      patterns: stable.resources,
      metadata: {},
      always: [],
      tool: { messageID: "msg_assistant", callID: "call_1" },
    })
    await settle()

    expect(app.replies).toEqual([
      { sessionID: "ses_root", requestID: "per_1", reply: "once", protocol: "stable" },
    ])
    dispose()
  })

  test("claims transitional permission.asked events for a V2-only owner", async () => {
    const app = harness()
    const pending = request("git status")
    app.requests.push(pending)
    const dispose = installReviewer(app.context, { client: app.client, protocols: ["v2"] })

    app.emit("permission.asked", {
      id: pending.id,
      sessionID: pending.sessionID,
      permission: "bash",
      patterns: pending.resources,
      metadata: {},
      always: [],
      tool: { messageID: "msg_assistant", callID: "call_1" },
    })
    await settle()

    expect(app.replies).toEqual([
      { sessionID: "ses_root", requestID: "per_1", reply: "once", protocol: "v2" },
    ])
    dispose()
  })
})
