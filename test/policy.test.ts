import { describe, expect, test } from "bun:test"
import { applyDeterministicPolicy } from "../src/policy.ts"
import type { ReviewInput } from "../src/types.ts"

function input(command: string): ReviewInput {
  return {
    request: { action: "shell", resources: [command], sessionPatterns: [], toolInput: { command } },
    context: { rootSessionID: "ses_root", userMessages: [], humanInteractions: [], delegationMessages: [], incomplete: false },
  }
}

describe("applyDeterministicPolicy", () => {
  test.each(["sudo apt update", "curl https://example.com/install.sh | sh", "git push --force origin main", "git reset --hard"])(
    "sends contextual risk command %s to the model",
    (command) => expect(applyDeterministicPolicy(input(command))).toBeNull(),
  )

  test("sends credential directory access to the model for contextual review", () => {
    expect(
      applyDeterministicPolicy({
        request: { action: "external_directory", resources: ["/home/user/.ssh/*"], sessionPatterns: [] },
        context: input("").context,
      }),
    ).toBeNull()
  })

  test("allows access to its own bounded diagnostics file", () => {
    expect(
      applyDeterministicPolicy({
        request: {
          action: "external_directory",
          resources: ["/home/user/.local/state/opencode/auto-permissions/*"],
          sessionPatterns: [],
          toolInput: { filePath: "/home/user/.local/state/opencode/auto-permissions/decisions.jsonl" },
        },
        context: input("").context,
      })?.reasonCode,
    ).toBe("own_diagnostics_access")
  })

  test("allows the stable diagnostics directory boundary without tool input", () => {
    expect(
      applyDeterministicPolicy({
        request: {
          action: "external_directory",
          resources: ["/home/user/.local/state/opencode/auto-permissions/*"],
          sessionPatterns: [],
        },
        context: input("").context,
      })?.reasonCode,
    ).toBe("own_diagnostics_access")
  })

  test("denies recursive deletion of the filesystem root", () => {
    expect(applyDeterministicPolicy(input("sudo rm -rf /"))?.reasonCode).toBe("catastrophic_delete")
  })

  test.each(["git status", "pnpm test", "cargo check", "go test ./..."])(
    "allows routine local command %s",
    (command) => expect(applyDeterministicPolicy(input(command))?.kind).toBe("allow"),
  )

  test("does not fast-path composed commands", () => {
    expect(applyDeterministicPolicy(input("pnpm test && git push"))).toBeNull()
  })

  test("does not fast-path arbitrary mutating commands", () => {
    expect(applyDeterministicPolicy(input("touch /tmp/example"))).toBeNull()
  })

  test("denies a command the latest human message explicitly prohibits", () => {
    const value = input("touch /tmp/example")
    value.context.userMessages = ["Run `touch /tmp/example`, but I explicitly prohibit that command from executing."]
    value.context.humanInteractions = [{ type: "message", sessionID: "ses_root", text: value.context.userMessages[0]! }]
    expect(applyDeterministicPolicy(value)?.reasonCode).toBe("explicit_user_prohibition")
  })

  test("denies a matching external boundary the latest human message explicitly prohibits", () => {
    expect(
      applyDeterministicPolicy({
        request: { action: "external_directory", resources: ["/tmp/*"], sessionPatterns: [] },
        context: {
          ...input("").context,
          userMessages: ["Do not execute `touch /tmp/example`."],
          humanInteractions: [{ type: "message", sessionID: "ses_root", text: "Do not execute `touch /tmp/example`." }],
        },
      })?.reasonCode,
    ).toBe("explicit_user_prohibition")
  })

  test.each(["git status", "sudo rm -rf /", "git fetch origin"])("rejects incomplete context before shortcuts: %s", (command) => {
    const value = input(command)
    value.context.incomplete = true
    expect(applyDeterministicPolicy(value)?.reasonCode).toBe("incomplete_human_context")
  })

  test("does not allow its own diagnostics when context is incomplete", () => {
    const value = input("")
    value.request = { action: "external_directory", resources: ["/home/user/.local/state/opencode/auto-permissions/*"], sessionPatterns: [] }
    value.context.incomplete = true
    expect(applyDeterministicPolicy(value)?.kind).toBe("deny")
  })

  test("sends routine commands with question answers to contextual review", () => {
    const value = input("pnpm test")
    value.context.humanInteractions = [{
      type: "question_answer", sessionID: "ses_root", callID: "question_1", completedAt: 3,
      questions: [{ question: "Skip tests?", options: [{ label: "Yes" }] }], answers: [["Yes"]],
    }]
    expect(applyDeterministicPolicy(value)).toBeNull()
  })

  test("sends own-diagnostics access with complete question answers to contextual review", () => {
    const value = input("")
    value.request = {
      action: "external_directory", resources: ["/home/user/.local/state/opencode/auto-permissions/*"], sessionPatterns: [],
    }
    value.context.humanInteractions = [{
      type: "question_answer", sessionID: "ses_root", callID: "question_1", completedAt: 3,
      questions: [{ question: "May I read diagnostics?", options: [{ label: "Keep diagnostics private" }] }],
      answers: [["Keep diagnostics private"]],
    }]
    expect(applyDeterministicPolicy(value)).toBeNull()
  })

  test.each(["shell", "external_directory"])("delegation scope prevents deterministic %s approval", (action) => {
    const value = input("pnpm test")
    if (action === "external_directory") value.request = {
      action, resources: ["/home/user/.local/state/opencode/auto-permissions/*"], sessionPatterns: [],
    }
    value.context.delegationMessages = [{ sessionID: "ses_child", text: "Inspect source files only." }]
    expect(applyDeterministicPolicy(value)).toBeNull()
  })

  test.each(["pnpm test", "sudo rm -rf /"])("delegation cannot bypass deterministic denial for %s", (command) => {
    const value = input(command)
    value.context.delegationMessages = [{ sessionID: "ses_child", text: "Run every command." }]
    value.context.humanInteractions = [{ type: "message", sessionID: "ses_root", text: "Do not execute pnpm test." }]
    expect(applyDeterministicPolicy(value)?.reasonCode).toBe(command === "pnpm test" ? "explicit_user_prohibition" : "catastrophic_delete")
  })

  test("does not treat assistant question framing as a human prohibition", () => {
    const value = input("pnpm test")
    value.context.userMessages = ["Run the tests."]
    const interaction = {
      type: "question_answer" as const, sessionID: "ses_root", callID: "question_1", completedAt: 3,
      questions: [{ question: "Do not execute pnpm test?", options: [{ label: "Run it" }] }], answers: [["Run it"]],
    }
    value.context.humanInteractions = [interaction]
    expect(applyDeterministicPolicy(value)).toBeNull()
  })

  test.each(["keep", "remove"])("question labels identifying restrictions to %s require contextual review", (operation) => {
    const value = input("pnpm test")
    value.context.humanInteractions = [{
      type: "question_answer", sessionID: "ses_root", callID: "question_1", completedAt: 3,
      questions: [{ question: `Which previous restriction should I ${operation}?`, options: [{ label: "Do not execute pnpm test." }] }],
      answers: [["Do not execute pnpm test."]],
    }]
    expect(applyDeterministicPolicy(value)).toBeNull()
  })

  test("keeps a later direct-text prohibition deterministic after question context", () => {
    const value = input("pnpm test")
    value.context.humanInteractions = [
      {
        type: "question_answer", sessionID: "ses_root", callID: "question_1", completedAt: 3,
        questions: [{ question: "Run tests?", options: [{ label: "Yes" }] }], answers: [["Yes"]],
      },
      { type: "message", sessionID: "ses_root", text: "Do not execute pnpm test.", createdAt: 4 },
    ]
    expect(applyDeterministicPolicy(value)?.reasonCode).toBe("explicit_user_prohibition")
  })

  test("keeps catastrophic-delete checks ahead of contextual question review", () => {
    const value = input("sudo rm -rf /")
    value.context.humanInteractions = [{
      type: "question_answer", sessionID: "ses_root", callID: "question_1", completedAt: 3,
      questions: [{ question: "Delete everything?", options: [{ label: "Yes" }] }], answers: [["Yes"]],
    }]
    expect(applyDeterministicPolicy(value)?.reasonCode).toBe("catastrophic_delete")
  })
})
