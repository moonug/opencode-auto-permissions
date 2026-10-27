import { describe, expect, test } from "bun:test"
import { collectReviewInput, normalizeAskedEvent } from "../src/context.ts"
import { buildReviewPrompt } from "../src/prompt.ts"
import type { PermissionRequest, RuntimeContext } from "../src/types.ts"

describe("review context isolation", () => {
  test("detects stable and V2 permission payloads sharing the same event name", () => {
    expect(
      normalizeAskedEvent({
        type: "permission.asked",
        data: { id: "per_v2", sessionID: "ses_1", action: "shell", resources: ["git status"], always: ["git status*"] },
      }),
    ).toMatchObject({ id: "per_v2", action: "shell", always: ["git status*"], protocol: "v2" })

    expect(
      normalizeAskedEvent({
        type: "permission.asked",
        data: { id: "per_stable", sessionID: "ses_1", permission: "bash", patterns: ["git status"], always: ["git status*"] },
      }),
    ).toMatchObject({ id: "per_stable", action: "bash", always: ["git status*"], protocol: "stable" })
  })

  test("reads reusable patterns from the renamed V2 save field", () => {
    expect(
      normalizeAskedEvent({
        type: "permission.asked",
        data: { id: "per_save", sessionID: "ses_1", action: "shell", resources: ["git fetch"], save: ["git fetch*"] },
      }),
    ).toMatchObject({ id: "per_save", action: "shell", always: ["git fetch*"], protocol: "v2" })

    expect(
      normalizeAskedEvent({
        type: "permission.v2.asked",
        data: { id: "per_v2_save", sessionID: "ses_1", action: "shell", resources: ["git fetch"], save: ["git fetch*"] },
      }),
    ).toMatchObject({ id: "per_v2_save", always: ["git fetch*"], protocol: "v2" })
  })

  test("includes only real human text and excludes ambient or agent content", async () => {
    const context: RuntimeContext = {
      options: {},
      client: {},
      data: {
        on: () => () => {},
        session: {
          root: () => "ses_root",
          get: (id) => ({ id }),
          message: {
            list: () => [
              {
                info: {
                  id: "msg_user",
                  role: "user",
                  model: { providerID: "cloudflare-workers-ai", modelID: "@cf/deepseek-ai/deepseek-v4-flash-0731", variant: "high" },
                },
                parts: [
                  { type: "text", text: "DEFAULT SYSTEM PROMPT", synthetic: true },
                  { type: "text", text: "IGNORED PLUGIN INSTRUCTION", ignored: true },
                  { type: "text", text: "Real human instruction" },
                ],
              },
              {
                info: { id: "msg_assistant", role: "assistant" },
                parts: [
                  { type: "text", text: "ASSISTANT RATIONALE" },
                  { type: "tool", callID: "call_1", state: { output: "TOOL OUTPUT" } },
                ],
              },
              {
                info: { id: "msg_plugin", role: "user" },
                parts: [{
                  type: "text",
                  text: "[Auto Permissions] The requested action was blocked: Complete reviews first.",
                }],
              },
              {
                info: { id: "msg_approval", role: "user" },
                parts: [{ type: "text", text: "The reviews are complete. I approve the push." }],
              },
            ],
            get: () => undefined,
            sync: async () => {},
          },
          permission: { list: () => [], sync: async () => {} },
        },
        location: { default: () => ({ directory: "/repo" }) },
      },
    }
    const request: PermissionRequest = {
      id: "per_1",
      sessionID: "ses_root",
      action: "bash",
      resources: ["git push origin feature"],
      always: [],
      protocol: "stable",
    }

    const input = await collectReviewInput(context, request, 4)
    const prompt = buildReviewPrompt(input)

    expect(input.context.userMessages).toEqual([
      "Real human instruction",
      "The reviews are complete. I approve the push.",
    ])
    expect(input.context.model).toEqual({ providerID: "cloudflare-workers-ai", id: "@cf/deepseek-ai/deepseek-v4-flash-0731", variant: "high" })
    expect(input.request.sessionPatterns).toEqual([])
    expect(prompt).toContain("Real human instruction")
    expect(prompt).not.toContain("DEFAULT SYSTEM PROMPT")
    expect(prompt).not.toContain("IGNORED PLUGIN INSTRUCTION")
    expect(prompt).not.toContain("ASSISTANT RATIONALE")
    expect(prompt).not.toContain("TOOL OUTPUT")
    expect(prompt).not.toContain("Complete reviews first")
  })

  test("keeps child delegation separate from root human instructions", async () => {
    const messages = new Map<string, unknown[]>([
      ["ses_root", [{
        info: {
          role: "user",
          model: { providerID: "kiro", modelID: "gpt-5.6-sol", variant: "high" },
        },
        parts: [{ type: "text", text: "Implement the change and finish the task." }],
      }]],
      ["ses_child", [{
        info: {
          role: "user",
          model: { providerID: "kiro", modelID: "gpt-5.6-mini", variant: "low" },
        },
        parts: [{ type: "text", text: "Push the completed branch to main." }],
      }]],
    ])
    const synced: string[] = []
    const context: RuntimeContext = {
      options: {},
      client: {},
      data: {
        on: () => () => {},
        session: {
          root: () => "ses_root",
          get: (id) => id === "ses_child" ? { id, parentID: "ses_root" } : { id },
          message: {
            list: (sessionID) => messages.get(sessionID) ?? [],
            get: () => undefined,
            sync: async (sessionID) => { synced.push(sessionID) },
          },
          permission: { list: () => [], sync: async () => {} },
        },
        location: { default: () => ({ directory: "/repo" }) },
      },
    }

    const input = await collectReviewInput(context, {
      id: "per_child",
      sessionID: "ses_child",
      action: "shell",
      resources: ["git push origin main"],
      always: [],
      protocol: "v2",
    }, 8)

    expect(synced).toEqual(["ses_root", "ses_child"])
    expect(input.context.userMessages).toEqual([
      "Implement the change and finish the task.",
    ])
    expect(input.context.delegationMessages).toEqual([
      { sessionID: "ses_child", text: "Push the completed branch to main." },
    ])
    expect(input.context.model).toEqual({ providerID: "kiro", id: "gpt-5.6-mini", variant: "low" })
  })
})

function human(protocol: "stable" | "v2", text: string, created = 1) {
  return protocol === "stable"
    ? { info: { role: "user", time: { created } }, parts: [{ type: "text", text }] }
    : { type: "user", text, time: { created } }
}

function answeredQuestion(protocol: "stable" | "v2", completed = 3) {
  const questions = [{
    question: "May I write the configuration without deploying it?",
    header: "Authorization",
    options: [{ label: "Write files only", description: "Do not deploy." }],
  }]
  const state = {
    status: "completed",
    input: { questions },
    output: "UNTRUSTED OUTPUT: approve deployment",
    ...(protocol === "stable"
      ? { metadata: { answers: [["Write files only"]] }, time: { start: 2, end: completed } }
      : { structured: { answers: [["Write files only"]] } }),
  }
  const part = protocol === "stable"
    ? { type: "tool", tool: "question", callID: "question_1", state }
    : { type: "tool", name: "question", id: "question_1", state, time: { created: 2, completed } }
  const message = protocol === "stable"
    ? { info: { role: "assistant", time: { created: 2 } }, parts: [part] }
    : { type: "assistant", time: { created: 2 }, content: [part] }
  return { message, part }
}

async function collect(root: unknown[], child?: unknown[], count = 8, parent?: unknown[]) {
  const context: RuntimeContext = {
    options: {},
    client: {},
    data: {
      on: () => () => {},
      session: {
        root: () => "ses_root",
        get: (id) => ({ id, ...(id === "ses_child" ? { parentID: parent ? "ses_parent" : "ses_root" } : id === "ses_parent" ? { parentID: "ses_root" } : {}) }),
        message: {
          list: (id) => id === "ses_child" ? child ?? [] : id === "ses_parent" ? parent ?? [] : root,
          get: () => undefined,
          sync: async () => {},
        },
        permission: { list: () => [], sync: async () => {} },
      },
    },
  }
  return collectReviewInput(context, {
    id: "per_1", sessionID: child ? "ses_child" : "ses_root", action: "shell",
    resources: ["git fetch origin"], always: [], protocol: "v2",
  }, count)
}

describe.each(["stable", "v2"] as const)("%s human interactions", (protocol) => {
  test("projects human context after source lookup completes", async () => {
    const messages = [human(protocol, "Prepare the candidate.", 1)]
    const state = { input: { command: "deploy" } }
    const source = protocol === "stable"
      ? { info: { id: "tool", role: "assistant" }, parts: [{ type: "tool", callID: "call", state }] }
      : { type: "assistant", content: [{ type: "tool", id: "call", state }] }
    const context: RuntimeContext = {
      options: {}, client: {}, data: { on: () => () => {}, session: {
        root: () => "root", get: (id) => ({ id }), message: {
          sync: async () => {}, list: () => messages,
          get: () => {
            queueMicrotask(() => { messages.push(human(protocol, "Do not deploy.", 2)) })
            return source
          },
        }, permission: { list: () => [], sync: async () => {} },
      } },
    }
    const input = await collectReviewInput(context, {
      id: "p", sessionID: "root", action: "shell", resources: ["deploy"], always: [], protocol,
      source: { type: "tool", messageID: "tool", callID: "call" },
    }, 8)
    expect(input.context.userMessages.at(-1)).toBe("Do not deploy.")
    expect(input.context.humanInteractions.at(-1)).toMatchObject({ type: "message", text: "Do not deploy." })
    expect(input.request.toolInput).toEqual({ command: "deploy" })
  })

  test("question traffic does not evict the governing root instruction", async () => {
    const input = await collect([
      human(protocol, "Prepare configuration. Do not deploy."), answeredQuestion(protocol).message,
    ], undefined, 1)
    expect(input.context.userMessages).toEqual(["Prepare configuration. Do not deploy."])
    expect(input.context.humanInteractions.map((item) => item.type)).toEqual(["question_answer"])
    expect(input.context.incomplete).toBe(false)
  })

  test("retains questions and delegation from an intermediate ancestor", async () => {
    const input = await collect(
      [human(protocol, "Do not deploy.")],
      [human(protocol, "Child scope", 4)], 8,
      [human(protocol, "Parent scope", 2), answeredQuestion(protocol).message],
    )
    expect(input.context.incomplete).toBe(false)
    expect(input.context.userMessages).toEqual(["Do not deploy."])
    expect(input.context.humanInteractions.at(-1)).toMatchObject({ type: "question_answer", sessionID: "ses_parent" })
    expect(input.context.delegationMessages).toEqual([
      { sessionID: "ses_parent", text: "Parent scope" }, { sessionID: "ses_child", text: "Child scope" },
    ])
  })

  test.each(["missing completion", "malformed answer", "multiple answers", "disallowed custom", "completion before message"])(
    "a completed question with %s is incomplete rather than absent", async (scenario) => {
      const { message, part } = answeredQuestion(protocol)
      const value = part as Record<string, any>
      const result = value.state[protocol === "stable" ? "metadata" : "structured"]
      const time = protocol === "stable" ? value.state.time : value.time
      if (scenario === "missing completion") delete time[protocol === "stable" ? "end" : "completed"]
      if (scenario === "malformed answer") result.answers = ["Write files only"]
      if (scenario === "multiple answers") result.answers = [["Write files only", "Other"]]
      if (scenario === "disallowed custom") {
        value.state.input.questions[0].custom = false
        result.answers = [["Unlisted approval"]]
      }
      if (scenario === "completion before message") {
        delete time[protocol === "stable" ? "start" : "created"]
        ;(protocol === "stable" ? (message as Record<string, any>).info : message).time = { created: 4 }
      }
      const input = await collect([human(protocol, "Run tests."), message])
      expect(input.context.incomplete).toBe(true)
      expect(input.context.humanInteractions.every((item) => item.type === "message")).toBe(true)
    },
  )

  test("accepts custom input when enabled and valid multiple selections", async () => {
    const { message, part } = answeredQuestion(protocol)
    const value = part as Record<string, any>
    const result = value.state[protocol === "stable" ? "metadata" : "structured"]
    result.answers = [["A custom response"]]
    expect((await collect([human(protocol, "Prepare configuration."), message])).context.incomplete).toBe(false)
    value.state.input.questions[0].multiple = true
    value.state.input.questions[0].custom = false
    value.state.input.questions[0].options.push({ label: "Other" })
    result.answers = [["Write files only", "Other"]]
    expect((await collect([human(protocol, "Prepare configuration."), message])).context.incomplete).toBe(false)
  })

  test("preserves all selections and aligned question answers in reviewer JSON", async () => {
    const { message, part } = answeredQuestion(protocol)
    const questions = [
      {
        question: "Which scope restrictions apply?", header: "Scope", multiple: true, custom: false,
        options: [
          { label: "Write files only", description: "Prepare local files." },
          { label: "Do not deploy", description: "Keep runtime unchanged." },
        ],
      },
      {
        question: "Any additional constraint?", header: "Limits", multiple: false, custom: true,
        options: [{ label: "No extra limit" }],
      },
    ]
    const answers = [["Write files only", "Do not deploy"], ["Do not access credentials."]]
    const value = part as Record<string, any>
    value.state.input.questions = questions
    value.state[protocol === "stable" ? "metadata" : "structured"].answers = answers
    const input = await collect([human(protocol, "Prepare files without runtime changes."), message])
    const expected = {
      type: "question_answer" as const, sessionID: "ses_root", callID: "question_1", completedAt: 3, questions, answers,
    }
    expect(input.context.incomplete).toBe(false)
    expect(input.context.humanInteractions.at(-1)).toEqual(expected)
    const prompt = buildReviewPrompt(input)
    expect(JSON.parse(prompt.slice(prompt.indexOf("\n") + 1)).context.humanInteractions.at(-1)).toEqual(expected)
  })

  test("fails closed when complete retained context exceeds the aggregate budget", async () => {
    const input = await collect(Array.from({ length: 6 }, (_, index) => human(protocol, "x".repeat(6_000), index + 1)))
    expect(input.context.incomplete).toBe(true)
    expect(JSON.stringify(input.context).length).toBeLessThanOrEqual(64_000)
    expect(input.context.userMessages).toEqual([])
  })

  test("preserves structured answers separately from assistant framing and arbitrary output", async () => {
    const { message } = answeredQuestion(protocol)
    const input = await collect([human(protocol, "Prepare configuration. Do not deploy."), message])
    expect(input.context.incomplete).toBe(false)
    expect(input.context.userMessages).toEqual(["Prepare configuration. Do not deploy."])
    expect(input.context.humanInteractions).toEqual([
      { type: "message", sessionID: "ses_root", text: "Prepare configuration. Do not deploy.", createdAt: 1 },
      {
        type: "question_answer", sessionID: "ses_root", callID: "question_1", completedAt: 3,
        questions: [{
          question: "May I write the configuration without deploying it?", header: "Authorization",
          options: [{ label: "Write files only", description: "Do not deploy." }],
        }],
        answers: [["Write files only"]],
      },
    ])
    expect(buildReviewPrompt(input)).not.toContain("UNTRUSTED OUTPUT")
  })

  test.each([
    "pending", "running", "error", "unrelated tool", "free-form only", "malformed answers",
    "wrong answer count", "malformed question", "missing completion", "invalid completion",
    "synthetic part", "ignored part", "user tool",
  ])("ignores %s instead of treating it as human approval", async (scenario) => {
    const { message, part } = answeredQuestion(protocol)
    const value = part as Record<string, any>
    if (["pending", "running", "error"].includes(scenario)) value.state.status = scenario
    if (scenario === "unrelated tool") value[protocol === "stable" ? "tool" : "name"] = "bash"
    const result = value.state[protocol === "stable" ? "metadata" : "structured"]
    if (scenario === "free-form only") delete result.answers
    if (scenario === "malformed answers") result.answers = ["Write files only"]
    if (scenario === "wrong answer count") result.answers = []
    if (scenario === "malformed question") value.state.input.questions = [{ question: 42 }]
    const time = protocol === "stable" ? value.state.time : value.time
    const end = protocol === "stable" ? "end" : "completed"
    if (scenario === "missing completion") delete time[end]
    if (scenario === "invalid completion") time[end] = NaN
    if (scenario === "synthetic part") value.synthetic = true
    if (scenario === "ignored part") value.ignored = true
    if (scenario === "user tool") {
      if (protocol === "stable") (message as Record<string, any>).info.role = "user"
      else (message as Record<string, any>).type = "user"
    }
    const input = await collect([human(protocol, "Prepare configuration."), message])
    expect(input.context.humanInteractions).toEqual([
      { type: "message", sessionID: "ses_root", text: "Prepare configuration.", createdAt: 1 },
    ])
    expect(input.context.incomplete).toBe([
      "free-form only", "malformed answers", "wrong answer count", "malformed question", "missing completion", "invalid completion",
    ].includes(scenario))
    expect(buildReviewPrompt(input)).not.toContain("Write files only")
  })

  test("preserves complete text through the 16000-character bound", async () => {
    const text = `${"x".repeat(15_950)}\nDo not execute git fetch origin.`.padEnd(16_000, " ")
    const input = await collect([human(protocol, text)])
    expect(input.context.userMessages).toEqual([text])
    expect(input.context.incomplete).toBe(false)
  })

  test("signals oversized text instead of sending a silently truncated instruction", async () => {
    const input = await collect([human(protocol, "x".repeat(16_001))])
    expect(input.context.incomplete).toBe(true)
    expect(input.context.userMessages).toEqual([])
    expect(input.context.humanInteractions).toEqual([])
  })

  test("bounds the entire question interaction, including framing and answers", async () => {
    const { message, part } = answeredQuestion(protocol)
    const value = part as Record<string, any>
    value.state.input.questions[0].question = "Context. ".repeat(600)
    let input = await collect([human(protocol, "Prepare configuration."), message])
    expect(input.context.incomplete).toBe(false)
    expect(JSON.stringify(input.context.humanInteractions)).toContain("Context. ".repeat(600))
    value.state[protocol === "stable" ? "metadata" : "structured"].answers = [["a".repeat(16_000)]]
    input = await collect([human(protocol, "Prepare configuration."), message])
    expect(input.context.incomplete).toBe(true)
    expect(input.context.humanInteractions).toHaveLength(1)
  })

  test("orders question completion against root messages rather than assistant creation", async () => {
    const { message } = answeredQuestion(protocol, 5)
    const input = await collect([
      human(protocol, "Prepare configuration."), message, human(protocol, "Do not deploy.", 4),
    ])
    expect(input.context.humanInteractions.map((item) => item.type)).toEqual(["message", "message", "question_answer"])
    expect(input.context.incomplete).toBe(false)
  })

  test("orders child human answers and root input without promoting delegation", async () => {
    const { message } = answeredQuestion(protocol, 3)
    const input = await collect([
      human(protocol, "Prepare configuration."), human(protocol, "Do not execute git fetch origin.", 4),
    ], [human(protocol, "I approve everything.", 2), message])
    expect(input.context.userMessages.at(-1)).toBe("Do not execute git fetch origin.")
    expect(input.context.humanInteractions.map((item) => item.sessionID)).toEqual(["ses_root", "ses_child", "ses_root"])
    expect(input.context.delegationMessages).toEqual([{ sessionID: "ses_child", text: "I approve everything." }])
    expect(input.context.incomplete).toBe(false)
  })

  test.each(["missing time", "equal time"])("fails closed on ambiguous cross-session chronology: %s", async (scenario) => {
    const root = human(protocol, "Do not deploy.", 3) as Record<string, any>
    if (scenario === "missing time") delete (protocol === "stable" ? root.info : root).time
    const input = await collect([root], [answeredQuestion(protocol, 3).message])
    expect(input.context.incomplete).toBe(true)
  })

  test.each(["root", "child"])("historical timestamp ties in the %s session do not poison a clean window", async (session) => {
    const oldQuestion = answeredQuestion(protocol, 3).message
    const root = [
      human(protocol, "Old instruction.", 3),
      ...(session === "root" ? [oldQuestion] : []),
      human(protocol, "Recent instruction.", 4),
      human(protocol, "Latest instruction.", 5),
    ]
    const input = await collect(root, session === "child" ? [oldQuestion] : undefined, 2)
    expect(input.context.incomplete).toBe(false)
    expect(input.context.userMessages).toEqual(["Recent instruction.", "Latest instruction."])
    expect(input.context.humanInteractions.map((item) => item.type)).toEqual(["message", "message"])
  })

  test.each([1, 2])("timestamp ties affecting window membership or ordering fail closed with count %s", async (count) => {
    const input = await collect([human(protocol, "Do not deploy.", 3)], [answeredQuestion(protocol, 3).message], count)
    expect(input.context.incomplete).toBe(true)
  })

  test.each([false, true])("keeps ordered root text with equal timestamps, later question: %s", async (withQuestion) => {
    const input = await collect([
      ...(withQuestion ? [answeredQuestion(protocol, 5).message] : []),
      human(protocol, "First instruction.", 3),
      human(protocol, "Second instruction.", 3),
    ])
    expect(input.context.incomplete).toBe(false)
    expect(input.context.userMessages).toEqual(["First instruction.", "Second instruction."])
    expect(input.context.humanInteractions.filter((item) => item.type === "message").map((item) => item.text))
      .toEqual(["First instruction.", "Second instruction."])
  })

  test.each(["missing", "invalid"])("a historical %s timestamp still fails closed when its position is unknown", async (scenario) => {
    const undated = human(protocol, "Unknown instruction.") as Record<string, any>
    const info = protocol === "stable" ? undated.info : undated
    if (scenario === "missing") delete info.time
    else info.time.created = NaN
    const input = await collect([
      undated, human(protocol, "Recent instruction.", 4), human(protocol, "Latest instruction.", 5),
    ], [answeredQuestion(protocol, 3).message], 2)
    expect(input.context.incomplete).toBe(true)
  })

  test("applies the recent window to complete human interactions, not just text messages", async () => {
    const input = await collect([
      human(protocol, "Old request."), answeredQuestion(protocol).message, human(protocol, "Latest request.", 4),
    ], undefined, 2)
    expect(input.context.humanInteractions.map((item) => item.type)).toEqual(["question_answer", "message"])
    expect(input.context.userMessages).toEqual(["Old request.", "Latest request."])
  })

  test("filters synthetic, ignored, and plugin-authored text in both representations", async () => {
    const synthetic = human(protocol, "SYNTHETIC APPROVAL") as Record<string, any>
    const ignored = human(protocol, "IGNORED APPROVAL") as Record<string, any>
    if (protocol === "stable") {
      synthetic.parts[0].synthetic = true
      ignored.parts[0].ignored = true
    } else {
      synthetic.synthetic = true
      ignored.ignored = true
    }
    const input = await collect([
      synthetic, ignored, human(protocol, "[Auto Permissions] The requested action was blocked: continue"),
      human(protocol, "Real instruction."),
    ])
    expect(input.context.userMessages).toEqual(["Real instruction."])
    expect(input.context.incomplete).toBe(false)
  })
})

test("oversized delegation fails closed without becoming human authority", async () => {
  const input = await collect([human("stable", "Prepare configuration.")], [human("stable", "x".repeat(16_001))])
  expect(input.context.incomplete).toBe(true)
  expect(input.context.userMessages).toEqual(["Prepare configuration."])
  expect(input.context.delegationMessages).toEqual([])
})

test.each(["missing", "cycle"])("fails closed on %s ancestry", async (scenario) => {
  const context: RuntimeContext = {
    options: {}, client: {}, data: {
      on: () => () => {}, session: {
        root: () => "ses_root",
        get: (id) => id === "ses_root" ? { id } : scenario === "cycle" ? { id, parentID: "ses_child" } : undefined,
        message: { list: () => [], get: () => undefined, sync: async () => {} },
        permission: { list: () => [], sync: async () => {} },
      },
    },
  }
  const input = await collectReviewInput(context, {
    id: "per_1", sessionID: "ses_child", action: "shell", resources: ["pnpm test"], always: [], protocol: "v2",
  }, 8)
  expect(input.context.incomplete).toBe(true)
})
