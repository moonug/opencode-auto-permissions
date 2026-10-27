import { expect, spyOn, test } from "bun:test"
import { collectReviewInput } from "../src/context.ts"
import { createStableRuntime } from "../src/stable.ts"
import { createStableHistory } from "../src/stable-history.ts"
import { installReviewer } from "../src/reviewer.ts"
import { applyDeterministicPolicy } from "../src/policy.ts"

const user = (id: string, time: number, text = id) => ({ info: { id, role: "user", time: { created: time } }, parts: [{ type: "text", text }] })
const question = (id: string, created: number, end: number) => ({
  info: { id, role: "assistant", time: { created } }, parts: [{ type: "tool", tool: "question", callID: id,
    state: { status: "completed", time: { end }, input: { questions: [{ question: "Scope?", options: [{ label: "Keep" }, { label: "Do not deploy" }], multiple: true, custom: true }] },
      metadata: { answers: [["Keep", "Do not deploy", "Custom constraint"]] }, output: "Untrusted output" } }],
})

test("retains independent text and completion windows with exact full terminal pages", async () => {
  const messages = [question("old_question", 0, 1_000), user("governing", 1),
    ...Array.from({ length: 198 }, (_, index) => ({ info: { id: `a_${index}`, role: "assistant", time: { created: index + 2 } }, parts: [] }))]
  const history = createStableHistory({ session: { messages: async () => ({ data: messages, response: new Response(null) }) } }, "/fixture")
  await history.sync("s")
  const retained = history.list("s")
  expect(retained).toContainEqual(user("governing", 1))
  expect(JSON.stringify(retained)).toContain("Custom constraint")
  expect(JSON.stringify(retained)).not.toContain("Untrusted output")
  expect(history.metadata("s").incomplete).toBe(false)
  history.dispose()
})

test.each(["invalid", "failed", "repeated", "empty", "unproven"])("rejects %s pagination without publishing partial history", async (kind) => {
  const history = createStableHistory({ session: { messages: async () => {
    if (kind === "invalid") return { data: {} }
    if (kind === "failed") return { error: "fixture failure" }
    if (kind === "empty") return { data: [], response: new Response(null, { headers: { "X-Next-Cursor": "older" } }) }
    if (kind === "unproven") return { data: Array.from({ length: 200 }, (_, index) => user(String(index), index)) }
    return { data: [user("same", 1)], response: new Response(null, { headers: { "X-Next-Cursor": "same" } }) }
  } } }, "/fixture")
  await expect(history.sync("s")).rejects.toThrow()
  expect(history.list("s")).toEqual([])
  history.dispose()
})

test("shares concurrent bootstrap and cancels a pending load on disposal", async () => {
  let resolve!: (value: any) => void
  let calls = 0
  const history = createStableHistory({ session: { messages: () => { calls++; return new Promise((done) => { resolve = done }) } } }, "/fixture")
  const first = history.sync("s")
  const second = history.sync("s")
  resolve({ data: [user("human", 1)] })
  await Promise.all([first, second])
  expect(calls).toBe(1)
  const cancelled = history.sync("other")
  history.dispose()
  await expect(cancelled).rejects.toThrow("cancelled")
})

test.each(["release", "dispose"])("bounds distinct pending cold loads at 128 before %s", async (mode) => {
  // A synchronous admission-loop regression must not block the parent test runner.
  const child = Bun.spawn([process.execPath, "--eval", `
    import { strict as assert } from "node:assert"
    import { createStableHistory } from ${JSON.stringify(new URL("../src/stable-history.ts", import.meta.url).href)}
    const releases = new Map()
    let calls = 0
    let aborted = 0
    const history = createStableHistory({ session: { messages: ({ path, signal }) => {
      calls++
      signal.addEventListener("abort", () => { aborted++ }, { once: true })
      return new Promise((resolve) => releases.set(path.id, () => resolve({ data: [{
        info: { id: path.id, role: "user", time: { created: 0 } }, parts: [{ type: "text", text: "Prepare the candidate." }],
      }] })))
    } } }, "/fixture")
    try {
      const loads = Array.from({ length: 128 }, (_, index) => history.sync("s_" + index)
        .then(() => "complete", (error) => error.message))
      assert.equal(calls, 128)
      assert.equal(releases.size, 128)
      await assert.rejects(history.sync("overflow"), /Stable history concurrent load budget exceeded/)
      assert.equal(calls, 128)
      assert.equal(aborted, 0)
      for (const id of releases.keys()) assert.deepEqual(history.list(id), [])
      if (${JSON.stringify(mode)} === "dispose") history.dispose()
      for (const release of releases.values()) release()
      const outcomes = await Promise.all(loads)
      assert.deepEqual(outcomes, Array(128).fill(${JSON.stringify(mode)} === "dispose" ? "Stable history load cancelled" : "complete"))
      if (${JSON.stringify(mode)} === "release") {
        for (const id of releases.keys()) {
          assert.equal(history.list(id).length, 1)
          assert.equal(history.metadata(id).incomplete, false)
        }
        await history.sync("s_0")
        assert.equal(calls, 128)
      } else {
        assert.equal(aborted, 128)
        for (const id of releases.keys()) assert.deepEqual(history.list(id), [])
        await assert.rejects(history.sync("s_0"), /Stable history disposed/)
      }
      console.info(${JSON.stringify(mode + ":128 admitted; 129 rejected; 128 settled")})
    } finally {
      history.dispose()
      for (const release of releases.values()) release()
    }
  `], { stdout: "pipe", stderr: "pipe" })
  let timedOut = false
  const watchdog = setTimeout(() => { timedOut = true; child.kill("SIGKILL") }, 5_000)
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    expect(timedOut).toBe(false)
    expect(stderr).toBe("")
    expect(code).toBe(0)
    expect(stdout).toBe(`${mode}:128 admitted; 129 rejected; 128 settled\n`)
  } finally { clearTimeout(watchdog); child.kill("SIGKILL") }
}, 10_000)

for (const mode of ["cold", "refresh", "source"] as const) {
  for (const same of [false, true]) {
    test.each(["session.deleted", "message.removed", "message.part.removed", "unknown message"])(`${mode} read isolates targeted %s (same session: ${same})`, async (type) => {
      let release!: (value: any) => void
      let blocked = false
      const history = createStableHistory({ session: {
        messages: async ({ path }: any) => blocked && mode === "cold" && path.id === "a"
          ? new Promise((resolve) => { release = resolve }) : { data: [user("human", 1)] },
        message: async () => new Promise((resolve) => { release = resolve }),
      } }, "/fixture")
      try {
        await history.sync("b")
        if (mode !== "cold") await history.sync("a")
        if (mode === "refresh") history.observe({ type: "message.updated", properties: { info: { id: "human", sessionID: "a" } } })
        blocked = true
        const pending = (mode === "source" ? history.source("a", "human") : history.sync("a"))
          .then(() => "complete", () => "cancelled")
        history.observe({ type: type === "unknown message" ? "message.updated" : type, properties: { sessionID: same ? "a" : "b" } })
        release(mode === "cold" ? { data: [user("human", 1)] } : { data: user("human", 1) })
        expect(await pending).toBe(same ? "cancelled" : "complete")
        expect(history.metadata(same ? "b" : "a").incomplete).toBe(false)
      } finally { history.dispose() }
    })
  }
}

test("bounds retained windows and evicts least-recently-used sessions", async () => {
  let calls = 0
  const history = createStableHistory({ session: { messages: async () => { calls++; return { data: Array.from({ length: 100 }, (_, index) => user(String(index), index)) } } } }, "/fixture")
  await history.sync("first")
  expect(history.list("first")).toHaveLength(20)
  for (let index = 0; index < 128; index++) await history.sync(String(index))
  expect(history.list("first")).toEqual([])
  await history.sync("first")
  expect(calls).toBe(130)
  history.dispose()
})

test("a warm touch promotes a cached session before capacity eviction", async () => {
  let calls = 0
  const history = createStableHistory({ session: { messages: async () => { calls++; return { data: [user("human", 1)] } } } }, "/fixture")
  try {
    for (let index = 0; index < 128; index++) await history.sync(`s_${index}`)
    await history.sync("s_0")
    await history.sync("new")
    expect(history.list("s_0")).toHaveLength(1)
    expect(history.list("s_1")).toEqual([])
    await history.sync("s_0")
    expect(calls).toBe(129)
  } finally { history.dispose() }
})

test("evicts retained projections at the 64 MiB budget before the session-count limit", async () => {
  const messages = [...Array.from({ length: 20 }, (_, index) => user(`u_${index}`, index, "u".repeat(15_000))),
    ...Array.from({ length: 20 }, (_, index) => {
      const message = question(`q_${index}`, index + 20, index + 20)
      message.parts[0]!.state.input.questions[0]!.question = "q".repeat(15_000)
      return message
    })]
  let calls = 0
  const history = createStableHistory({ session: { messages: async () => { calls++; return { data: messages } } } }, "/fixture")
  try {
    for (let index = 0; index < 70; index++) await history.sync(`s_${index}`)
    expect(history.list("s_0")).toEqual([])
    expect(history.metadata("s_0").incomplete).toBe(true)
    expect(history.list("s_69").length).toBeGreaterThan(0)
    await history.sync("s_0")
    expect(calls).toBe(71)
  } finally { history.dispose() }
})

test("bounds retained bytes across unfinished concurrent cold loads", async () => {
  const messages = [...Array.from({ length: 20 }, (_, index) => user(`u_${index}`, index + 100, "u".repeat(15_000))),
    ...Array.from({ length: 20 }, (_, index) => {
      const message = question(`q_${index}`, index + 120, index + 120)
      message.parts[0]!.state.input.questions[0]!.question = "q".repeat(15_000)
      return message
    })]
  const ids = Array.from({ length: 64 }, (_, index) => `s_${index}`)
  const releases = new Map<string, (value: any) => void>()
  const failures: string[] = []
  let reached = 0
  let ready!: () => void
  const projected = new Promise<void>((resolve) => { ready = resolve })
  const progress = () => { if (++reached === ids.length) ready() }
  let calls = 0
  const history = createStableHistory({ session: { messages: async ({ path, query }: any) => {
    calls++
    if (query.before) return new Promise((resolve) => { releases.set(path.id, resolve); progress() })
    return { data: messages, response: new Response(null, { headers: { "X-Next-Cursor": "older" } }) }
  } } }, "/fixture")
  const loads = ids.map((id) => history.sync(id).then(() => "complete", (error) => {
    failures.push(String(error))
    if (!releases.has(id)) progress()
    return "rejected"
  }))
  const terminal = { data: [user("older", 0)] }
  let watchdog: ReturnType<typeof setTimeout> | undefined
  try {
    const expired = new Promise<never>((_resolve, reject) => {
      watchdog = setTimeout(() => reject(new Error("Concurrent projection budget watchdog")), 5_000)
    })
    await Promise.race([projected, expired])
    expect(failures.length).toBeGreaterThan(0)
    expect(failures.every((error) => error === "Error: Stable history retention budget exceeded")).toBe(true)
    expect(releases.size).toBeGreaterThan(0)
    expect(releases.size + failures.length).toBe(ids.length)
    expect(ids.every((id) => history.list(id).length === 0 && history.metadata(id).incomplete)).toBe(true)
    for (const release of releases.values()) release(terminal)
    const outcomes = await Promise.race([Promise.all(loads), expired])
    expect(outcomes.filter((outcome) => outcome === "complete")).toHaveLength(releases.size)
    expect([...releases.keys()].every((id) => !history.metadata(id).incomplete)).toBe(true)
    expect(calls).toBe(ids.length + releases.size)
  } finally {
    clearTimeout(watchdog)
    history.dispose()
    for (const release of releases.values()) release(terminal)
    await Promise.all(loads)
  }
}, 10_000)

test.each(["duplicate identity", "backward order", "overlapping order"])("rejects malformed pagination: %s", async (kind) => {
  let calls = 0
  const history = createStableHistory({ session: { messages: async () => {
    calls++
    const data = kind === "backward order" ? [user("new", 2), user("old", 1)]
      : calls === 1 ? [user("first", 2)] : [user(kind === "duplicate identity" ? "first" : "next", 3)]
    return { data, response: new Response(null, { headers: calls === 1 ? { "X-Next-Cursor": "opaque+/=" } : {} }) }
  } } }, "/fixture")
  try { await expect(history.sync("s")).rejects.toThrow(); expect(history.list("s")).toEqual([]) }
  finally { history.dispose() }
})

test.each([false, true])("preserves intermediate ancestry and historical unknown timestamps across sessions: %s", async (unknown) => {
  const messages: Record<string, any[]> = {
    root: [user("old", 0), ...Array.from({ length: 30 }, (_, index) => user(`u_${index}`, index + 1, "Do not deploy")),
      { ...user("synthetic", 99, "Untrusted approval"), synthetic: true }],
    middle: [user("delegate_middle", 35, "Inspect only"), question("question_middle", 36, 100)],
    child: [user("delegate_child", 40, "Prepare a candidate")],
  }
  if (unknown) delete messages.root![0].info.time
  const runtime = createStableRuntime({ session: {
    get: async ({ path }: any) => ({ data: { id: path.id, ...(path.id === "root" ? {} : { parentID: path.id === "child" ? "middle" : "root" }) } }),
    messages: async ({ path }: any) => ({ data: messages[path.id] }),
  } }, {}, "/fixture")
  try {
    const input = await collectReviewInput(runtime.context, { id: "p", sessionID: "child", action: "bash", resources: ["inspect"], always: [], protocol: "stable" }, 8)
    expect(input.context.userMessages).toEqual(Array(8).fill("Do not deploy"))
    expect(input.context.delegationMessages).toEqual([{ sessionID: "middle", text: "Inspect only" }, { sessionID: "child", text: "Prepare a candidate" }])
    expect(input.context.humanInteractions.at(-1)).toMatchObject({ type: "question_answer", sessionID: "middle", answers: [["Keep", "Do not deploy", "Custom constraint"]] })
    expect(input.context.incomplete).toBe(unknown)
    expect(JSON.stringify(input)).not.toContain("Untrusted approval")
  } finally { runtime.dispose() }
})

test.each(["untimed", "question-tied"])("does not treat %s child delegation as ambiguous human chronology", async (kind) => {
  const delegation = user("delegate", 4, "Inspect only")
  if (kind === "untimed") delete (delegation.info as Record<string, unknown>).time
  const messages: Record<string, any[]> = {
    root: [user("human", 1, "Do not deploy")],
    child: [question("child_question", 2, 4), delegation],
  }
  const runtime = createStableRuntime({ session: {
    get: async ({ path }: any) => ({ data: { id: path.id, ...(path.id === "child" ? { parentID: "root" } : {}) } }),
    messages: async ({ path }: any) => ({ data: messages[path.id] }),
  } }, {}, "/fixture")
  const request = { id: "p", sessionID: "child", action: "bash", resources: ["inspect"], always: [], protocol: "stable" as const }
  try {
    const indexed = await collectReviewInput(runtime.context, request, 8)
    const generic = await collectReviewInput({ ...runtime.context, data: { ...runtime.context.data, session: {
      ...runtime.context.data.session, message: { sync: async () => {}, list: (id) => messages[id]!, get: () => undefined },
    } } }, request, 8)
    delete indexed.context.historyRevisions
    expect(indexed).toEqual(generic)
    expect(indexed.context.incomplete).toBe(false)
    expect(indexed.context.delegationMessages).toEqual([{ sessionID: "child", text: "Inspect only" }])
  } finally { runtime.dispose() }
})

test.each(["canonical", "historical ties", "unknown time", "malformed question"])("matches generic collector safeguards: %s", async (kind) => {
  const messages: any[] = [question("old_q", 0, 1), user("old", 1),
    ...Array.from({ length: 40 }, (_, index) => user(`u_${index}`, index + 2)), question("recent_q", 42, 50)]
  if (kind === "canonical") messages[0].parts[0].state.time.end = 1.5
  if (kind === "unknown time") delete messages[1].info.time
  if (kind === "malformed question") messages[0].parts[0].state.metadata.answers = []
  const runtime = createStableRuntime({ session: { get: async () => ({ data: { id: "s" } }), messages: async () => ({ data: messages }) } }, {}, "/fixture")
  const request = { id: "p", sessionID: "s", action: "bash", resources: ["inspect"], always: [], protocol: "stable" as const }
  try {
    const indexed = await collectReviewInput(runtime.context, request, 8)
    const generic = await collectReviewInput({ ...runtime.context, data: { ...runtime.context.data, session: {
      ...runtime.context.data.session, message: { sync: async () => {}, list: () => messages, get: () => undefined },
    } } }, request, 8)
    delete indexed.context.historyRevisions
    expect(indexed).toEqual(generic)
  } finally { runtime.dispose() }
})

test.each(["ignored text", "retimed text", "demoted question", "retimed question"])("reconstructs a pruned window after %s", async (kind) => {
  const text = kind.endsWith("text")
  const messages: any[] = text
    ? Array.from({ length: 21 }, (_, index) => user(`u_${index}`, index + 1, index === 0 ? "Do not deploy" : "Prepare only"))
    : [user("root", 0), ...Array.from({ length: 21 }, (_, index) => question(`q_${index}`, index + 1, index + 100))]
  const target = `${text ? "u" : "q"}_20`
  let full = 0
  let points = 0
  const runtime = createStableRuntime({ session: {
    get: async () => ({ data: { id: "s" } }),
    messages: async () => { full++; return { data: messages } },
    message: async ({ path }: any) => { points++; return { data: messages.find((message) => message.info.id === path.messageID) } },
  } }, {}, "/fixture")
  const request = { id: "p", sessionID: "s", action: "bash", resources: ["inspect"], always: [], protocol: "stable" as const }
  try {
    await collectReviewInput(runtime.context, request, 20)
    const changed = messages.find((message) => message.info.id === target)
    if (kind === "ignored text") changed.parts[0].ignored = true
    if (kind === "retimed text") changed.info.time.created = 0
    if (kind === "demoted question") changed.parts[0].state.status = "error"
    if (kind === "retimed question") changed.parts[0].state.time.end = 90
    messages.sort((left, right) => left.info.time.created - right.info.time.created)
    runtime.observe({ type: "message.part.updated", properties: { part: { sessionID: "s", messageID: target, type: "tool" } } })
    const indexed = await collectReviewInput(runtime.context, request, 20)
    const generic = await collectReviewInput({ ...runtime.context, data: { ...runtime.context.data, session: {
      ...runtime.context.data.session, message: { sync: async () => {}, list: () => messages, get: () => undefined },
    } } }, request, 20)
    delete indexed.context.historyRevisions
    expect(indexed).toEqual(generic)
    expect(indexed.context.incomplete).toBe(false)
    expect(full).toBe(2)
    expect(points).toBe(1)
    await collectReviewInput(runtime.context, request, 20)
    expect(full).toBe(2)
  } finally { runtime.dispose() }
})

test("retains a per-message question tie straddling the twenty-interaction boundary", async () => {
  const message = question("assistant", 0, 1)
  message.parts = Array.from({ length: 21 }, (_, index) => question(`call_${index}`, 0, index < 2 ? 1 : index).parts[0]!)
  const messages = [user("human", 0), message]
  const runtime = createStableRuntime({ session: {
    get: async () => ({ data: { id: "s" } }), messages: async () => ({ data: messages }),
  } }, {}, "/fixture")
  try {
    const input = await collectReviewInput(runtime.context, { id: "p", sessionID: "s", action: "bash", resources: ["inspect"], always: [], protocol: "stable" }, 20)
    expect(input.context.humanInteractions).toHaveLength(20)
    expect(input.context.incomplete).toBe(true)
  } finally { runtime.dispose() }
})

test.each(["malformed answers", "unknown root time", "invalid assistant time", "resolved question tie"])("recovers after authoritative repair of %s", async (kind) => {
  const messages: any[] = [user("human", 0), question("first", 1, 5), question("second", 2, 6)]
  const target = kind === "unknown root time" ? "human" : "second"
  if (kind === "malformed answers") messages[2].parts[0].state.metadata.answers = []
  if (kind === "unknown root time") delete messages[0].info.time
  if (kind === "invalid assistant time") messages[2].info.time.created = NaN
  if (kind === "resolved question tie") messages[2].parts[0].state.time.end = 5
  let full = 0
  const runtime = createStableRuntime({ session: {
    get: async () => ({ data: { id: "s" } }), messages: async () => { full++; return { data: messages } },
    message: async ({ path }: any) => ({ data: messages.find((message) => message.info.id === path.messageID) }),
  } }, {}, "/fixture")
  const request = { id: "p", sessionID: "s", action: "bash", resources: ["inspect"], always: [], protocol: "stable" as const }
  try {
    expect((await collectReviewInput(runtime.context, request, 8)).context.incomplete).toBe(true)
    messages[0] = user("human", 0)
    messages[2] = question("second", 2, 6)
    runtime.observe({ type: "message.updated", properties: { info: { id: target, sessionID: "s" } } })
    const repaired = await collectReviewInput(runtime.context, request, 8)
    expect(repaired.context.incomplete).toBe(false)
    expect(repaired.context.humanInteractions.map((item) => item.type === "message" ? item.createdAt : item.completedAt)).toEqual([0, 5, 6])
    expect(full).toBe(2)
  } finally { runtime.dispose() }
})

test.each(["historical tie", "untimed delegation", "historical malformed question"])("safe edits avoid rescans with unrelated %s", async (kind) => {
  const messages: Record<string, any[]> = {
    root: [user("human", 1, "Inspect only"), ...Array.from({ length: 12 }, (_, index) => question(`q_${index}`, index + 2, index < 2 ? 20 : index + 20)), user("newest", 100)],
    child: [user("delegate", 101, "Prepare only")],
  }
  if (kind === "untimed delegation") {
    messages.root = [user("human", 1, "Inspect only")]
    delete messages.child![0].info.time
    messages.child!.unshift(user("dated_delegate", 100, "Prepare only"))
  }
  if (kind === "historical malformed question") messages.root![1].parts[0].state.metadata.answers = []
  let pages = 0
  let points = 0
  const runtime = createStableRuntime({ session: {
    get: async ({ path }: any) => ({ data: { id: path.id, ...(path.id === "child" ? { parentID: "root" } : {}) } }),
    messages: async ({ path }: any) => { pages++; return { data: messages[path.id] } },
    message: async ({ path }: any) => { points++; return { data: messages[path.id]!.find((message) => message.info.id === path.messageID) } },
  } }, {}, "/fixture")
  const request = { id: "p", sessionID: "child", action: "edit", resources: ["candidate.ts"], always: [], protocol: "stable" as const }
  try {
    await collectReviewInput(runtime.context, request, 8)
    for (let index = 0; index < 3; index++) {
      const sessionID = kind === "untimed delegation" ? "child" : "root"
      const current = messages[sessionID]!.at(-1)!
      current.parts[0].text = `Prepare candidate ${index} only`
      runtime.observe({ type: "message.updated", properties: { info: { id: current.info.id, sessionID } } })
      const indexed = await collectReviewInput(runtime.context, request, 8)
      const generic = await collectReviewInput({ ...runtime.context, data: { ...runtime.context.data, session: {
        ...runtime.context.data.session, message: { sync: async () => {}, list: (id) => messages[id]!, get: () => undefined },
      } } }, request, 8)
      delete indexed.context.historyRevisions
      expect(indexed).toEqual(generic)
      expect(pages).toBe(2)
    }
    expect(points).toBe(3)
  } finally { runtime.dispose() }
})

test("refreshes delivered human mutations by authoritative point reads without rescanning", async () => {
  let current = user("human", 1, "Prepare only")
  let full = 0
  let points = 0
  const runtime = createStableRuntime({ session: {
    get: async () => ({ data: { id: "s" } }),
    messages: async () => { full++; return { data: [current] } },
    message: async () => { points++; return { data: current } },
  } }, {}, "/fixture")
  const request = { id: "p", sessionID: "s", action: "bash", resources: ["inspect"], always: [], protocol: "stable" as const }
  try {
    const first = await collectReviewInput(runtime.context, request, 8)
    current = user("human", 1, "Do not deploy")
    runtime.emit({ type: "message.part.updated", properties: { part: { sessionID: "s", messageID: "human", type: "text", text: "stale callback text" } } })
    const second = await collectReviewInput(runtime.context, request, 8)
    expect(second.context.userMessages).toEqual(["Do not deploy"])
    expect(second.context.historyRevisions).not.toEqual(first.context.historyRevisions)
    expect(full).toBe(1)
    expect(points).toBe(1)
  } finally { runtime.dispose() }
})

test.each(["retained edit", "new equal-time message"])("preserves authoritative equal-time order after %s", async (kind) => {
  const messages = [user("Z", 1, "Run local tests."), user("a", 1, "Do not execute pnpm test.")]
  let full = 0
  const runtime = createStableRuntime({ session: {
    get: async () => ({ data: { id: "s" } }), messages: async () => { full++; return { data: messages } },
    message: async ({ path }: any) => ({ data: messages.find((message) => message.info.id === path.messageID) }),
  } }, {}, "/fixture")
  const request = { id: "p", sessionID: "s", action: "bash", resources: ["pnpm test"], always: [], protocol: "stable" as const }
  try {
    await collectReviewInput(runtime.context, request, 8)
    if (kind === "new equal-time message") messages.splice(1, 0, user("B", 1, "Run local tests."))
    else messages[0] = user("Z", 1, "Run local tests again.")
    runtime.observe({ type: "message.updated", properties: { info: { id: kind === "retained edit" ? "Z" : "B", sessionID: "s" } } })
    const indexed = await collectReviewInput(runtime.context, request, 8)
    const generic = await collectReviewInput({ ...runtime.context, data: { ...runtime.context.data, session: {
      ...runtime.context.data.session, message: { sync: async () => {}, list: () => messages, get: () => undefined },
    } } }, request, 8)
    delete indexed.context.historyRevisions
    expect(indexed).toEqual(generic)
    expect(applyDeterministicPolicy(indexed)?.kind).toBe("deny")
    expect(full).toBe(kind === "retained edit" ? 1 : 2)
  } finally { runtime.dispose() }
})

test("uses exact transient source input from bootstrap, then awaits authoritative lookup", async () => {
  let points = 0
  const source = { info: { id: "tool", role: "assistant", time: { created: 2 } }, parts: [{ type: "tool", callID: "call", tool: "bash", state: { input: { command: "exact input", nested: [1, 2] }, output: "Do not promote output" } }] }
  const runtime = createStableRuntime({ session: {
    get: async () => ({ data: { id: "s" } }), messages: async () => ({ data: [user("human", 1), source] }),
    message: async () => { points++; return { data: source } },
  } }, {}, "/fixture")
  const request = { id: "p", sessionID: "s", action: "bash", resources: ["inspect"], always: [], protocol: "stable" as const,
    source: { type: "tool" as const, messageID: "tool", callID: "call" } }
  try {
    const first = await collectReviewInput(runtime.context, request, 8)
    expect(first.request.toolInput).toEqual(source.parts[0]!.state.input)
    expect(points).toBe(0)
    const second = await collectReviewInput(runtime.context, request, 8)
    expect(second.request.toolInput).toEqual(first.request.toolInput)
    expect(points).toBe(1)
    expect(JSON.stringify(runtime.context.data.session.message.list("s"))).not.toContain("exact input")
    expect(JSON.stringify(second)).not.toContain("Do not promote output")
  } finally { runtime.dispose() }
})

test.each([["missing", 1], ["invalid", 1], ["missing", 8], ["invalid", 8]] as const)("preserves an existing prohibition with %s time after a safe warm edit (count %i)", async (kind, count) => {
  const messages: any[] = [user("dated", 1, "Run local tests."), user("untimed", 2, "Do not execute pnpm test.")]
  if (kind === "missing") delete messages[1].info.time
  else messages[1].info.time.created = "invalid"
  let pages = 0
  let points = 0
  const pending = { id: "p", sessionID: "s", permission: "bash", patterns: ["pnpm test"], always: [] }
  const runtime = createStableRuntime({ session: {
    get: async () => ({ data: { id: "s" } }), messages: async () => { pages++; return { data: messages } },
    message: async ({ path }: any) => { points++; return { data: messages.find((message) => message.info.id === path.messageID) } },
  }, permission: { list: async () => ({ data: [pending] }) } }, { userMessageCount: count }, "/fixture")
  const request = { id: "p", sessionID: "s", action: "bash", resources: ["pnpm test"], always: [], protocol: "stable" as const }
  try {
    expect(applyDeterministicPolicy(await collectReviewInput(runtime.context, request, count))?.kind).toBe("deny")
    messages[0] = user("dated", 1, "Run local tests again.")
    runtime.observe({ type: "message.updated", properties: { info: { id: "dated", sessionID: "s" } } })
    const indexed = await collectReviewInput(runtime.context, request, count)
    const generic = await collectReviewInput({ ...runtime.context, data: { ...runtime.context.data, session: {
      ...runtime.context.data.session, message: { sync: async () => {}, list: () => messages, get: () => undefined },
    } } }, request, count)
    delete indexed.context.historyRevisions
    expect(indexed).toEqual(generic)
    expect(indexed.context.incomplete).toBe(false)
    expect(applyDeterministicPolicy(indexed)?.reasonCode).toBe("explicit_user_prohibition")
    let finished!: () => void
    const done = new Promise<void>((resolve) => { finished = resolve })
    const replies: string[] = []
    let modelCalls = 0
    const stop = installReviewer(runtime.context, { client: {
      generate: async () => { modelCalls++; return { decision: "allow", reasonCode: "fixture", reason: "Offline decision." } },
      reply: async ({ reply }) => { replies.push(reply); finished(); return "replied" },
    } })
    try {
      runtime.emit({ type: "permission.asked", properties: pending })
      await done
      expect(replies).toEqual(["reject"])
      expect(modelCalls).toBe(0)
    } finally { stop() }
    expect(pages).toBe(1)
    expect(points).toBe(1)
  } finally { runtime.dispose() }
})

for (const position of [0, 1]) {
  test.each(["missing", "invalid"])(`reconstructs authoritative insertion of %s-time text at position ${position}`, async (kind) => {
    const messages: any[] = [user("dated", 1, "Run local tests.")]
    let pages = 0
    let points = 0
    const runtime = createStableRuntime({ session: {
      get: async () => ({ data: { id: "s" } }), messages: async () => { pages++; return { data: messages } },
      message: async ({ path }: any) => { points++; return { data: messages.find((message) => message.info.id === path.messageID) } },
    } }, {}, "/fixture")
    const request = { id: "p", sessionID: "s", action: "bash", resources: ["pnpm test"], always: [], protocol: "stable" as const }
    try {
      await collectReviewInput(runtime.context, request, 1)
      const inserted: any = user("inserted", 2, "Do not execute pnpm test.")
      if (kind === "missing") delete inserted.info.time
      else inserted.info.time.created = "invalid"
      messages.splice(position, 0, inserted)
      runtime.observe({ type: "message.updated", properties: { info: { id: "inserted", sessionID: "s" } } })
      const indexed = await collectReviewInput(runtime.context, request, 1)
      const generic = await collectReviewInput({ ...runtime.context, data: { ...runtime.context.data, session: {
        ...runtime.context.data.session, message: { sync: async () => {}, list: () => messages, get: () => undefined },
      } } }, request, 1)
      delete indexed.context.historyRevisions
      expect(indexed).toEqual(generic)
      expect(indexed.context.incomplete).toBe(false)
      expect(applyDeterministicPolicy(indexed)?.kind).toBe(position === 0 ? "allow" : "deny")
      await collectReviewInput(runtime.context, request, 1)
      expect(pages).toBe(2)
      expect(points).toBe(1)
    } finally { runtime.dispose() }
  })
}

test.each(["root", "child"])("reconstructs new dated text among undated %s text", async (sessionID) => {
  const messages: Record<string, any[]> = {
    root: [user("root_human", 0, "Prepare the candidate")],
    child: [],
  }
  messages[sessionID] = [user("dated", 1, "Run local tests."), user("untimed", 3, "Do not execute pnpm test.")]
  delete messages[sessionID]![1].info.time
  let pages = 0
  const runtime = createStableRuntime({ session: {
    get: async ({ path }: any) => ({ data: { id: path.id, ...(path.id === "child" ? { parentID: "root" } : {}) } }),
    messages: async ({ path }: any) => { pages++; return { data: messages[path.id] } },
    message: async ({ path }: any) => ({ data: messages[path.id]!.find((message) => message.info.id === path.messageID) }),
  } }, {}, "/fixture")
  const request = { id: "p", sessionID, action: "bash", resources: ["pnpm test"], always: [], protocol: "stable" as const }
  try {
    await collectReviewInput(runtime.context, request, 1)
    messages[sessionID]!.splice(1, 0, user("inserted", 2, "Run local tests again."))
    runtime.observe({ type: "message.updated", properties: { info: { id: "inserted", sessionID } } })
    const indexed = await collectReviewInput(runtime.context, request, 1)
    const generic = await collectReviewInput({ ...runtime.context, data: { ...runtime.context.data, session: {
      ...runtime.context.data.session, message: { sync: async () => {}, list: (id) => messages[id]!, get: () => undefined },
    } } }, request, 1)
    delete indexed.context.historyRevisions
    expect(indexed).toEqual(generic)
    expect(indexed.context.incomplete).toBe(false)
    if (sessionID === "root") expect(applyDeterministicPolicy(indexed)?.kind).toBe("deny")
    else expect(indexed.context.delegationMessages).toEqual([{ sessionID: "child", text: "Do not execute pnpm test." }])
    expect(pages).toBe(sessionID === "root" ? 2 : 3)
  } finally { runtime.dispose() }
})

test("cold-load mutations use authoritative refresh rather than callback payload ordering", async () => {
  let current = user("human", 1, "Original instruction")
  let points = 0
  const runtime = createStableRuntime({ session: {
    get: async () => ({ data: { id: "s" } }),
    messages: async () => {
      const captured = current
      current = user("human", 1, "Do not deploy")
      runtime.observe({ type: "message.updated", data: { info: { id: "human", sessionID: "s", role: "user" } } })
      return { data: [captured] }
    },
    message: async () => { points++; return { data: current } },
  } }, {}, "/fixture")
  try {
    const input = await collectReviewInput(runtime.context, { id: "p", sessionID: "s", action: "bash", resources: ["deploy"], always: [], protocol: "stable" }, 8)
    expect(input.context.userMessages).toEqual(["Do not deploy"])
    expect(input.context.incomplete).toBe(false)
    expect(points).toBe(1)
  } finally { runtime.dispose() }
})

test("does not reuse source input from a page that raced a delivered source mutation", async () => {
  const source = (command: string) => ({ info: { id: "tool", role: "assistant", time: { created: 2 } },
    parts: [{ type: "tool", callID: "call", state: { input: { command } } }] })
  let points = 0
  const runtime = createStableRuntime({ session: {
    get: async () => ({ data: { id: "s" } }),
    messages: async () => {
      runtime.observe({ type: "message.part.updated", properties: { part: { sessionID: "s", messageID: "tool", type: "tool" } } })
      return { data: [user("human", 1), source("old input")] }
    },
    message: async () => { points++; return { data: source("new input") } },
  } }, {}, "/fixture")
  try {
    const input = await collectReviewInput(runtime.context, { id: "p", sessionID: "s", action: "bash", resources: ["inspect"], always: [], protocol: "stable",
      source: { type: "tool", messageID: "tool", callID: "call" } }, 8)
    expect(input.request.toolInput).toEqual({ command: "new input" })
    expect(points).toBe(2)
  } finally { runtime.dispose() }
})

test.each(["message.removed", "message.part.removed", "session.updated", "session.deleted", "server.connected", "session.reset"])("rebootstraps after %s without approving an incomplete window", async (type) => {
  let messages = [user("older", 1), user("newer", 2)]
  let calls = 0
  const history = createStableHistory({ session: { messages: async () => { calls++; return { data: messages } } } }, "/fixture")
  try {
    await history.sync("s")
    const revision = history.metadata("s").revision
    messages = [user("older", 1)]
    history.observe({ type, properties: { sessionID: "s", messageID: "newer" } })
    expect(history.metadata("s").incomplete).toBe(true)
    await history.sync("s")
    expect(history.list("s")).toEqual(messages)
    expect(history.metadata("s").revision).not.toBe(revision)
    expect(calls).toBe(2)
  } finally { history.dispose() }
})

test.each(["failed", "racing"])("rejects %s authoritative refresh without using prior context", async (kind) => {
  const history = createStableHistory({ session: {
    messages: async () => ({ data: [user("human", 1)] }),
    message: async () => {
      if (kind === "racing") history.observe({ type: "message.part.updated", data: { sessionID: "s", messageID: "human" } })
      return kind === "failed" ? { error: "unavailable" } : { data: user("human", 1, "new") }
    },
  } }, "/fixture")
  try {
    await history.sync("s")
    history.observe({ type: "message.part.updated", data: { sessionID: "s", messageID: "human" } })
    await expect(history.sync("s")).rejects.toThrow()
    expect(history.metadata("s").incomplete).toBe(true)
    expect(history.list("s")).toEqual([])
  } finally { history.dispose() }
})

test("enforces the cold-load deadline even if the transport ignores cancellation", async () => {
  const original = globalThis.setTimeout
  let deadline = 0
  const timer = spyOn(globalThis, "setTimeout").mockImplementationOnce(((callback: () => void, milliseconds: number) => {
    deadline = milliseconds
    return original(callback, 0)
  }) as typeof setTimeout)
  const history = createStableHistory({ session: { messages: () => new Promise(() => {}) } }, "/fixture")
  try {
    await expect(history.sync("s")).rejects.toThrow("cancelled")
    expect(deadline).toBe(30_000)
  } finally { timer.mockRestore(); history.dispose() }
})

test.each(["source", "refresh"])("rejects after the final authoritative %s deadline even if the transport ignores cancellation", async (phase) => {
  const original = globalThis.setTimeout
  let timer: { mockRestore(): void } | undefined
  let watchdog: ReturnType<typeof setTimeout> | undefined
  let pointSignal: AbortSignal | undefined
  let pointID: string | undefined
  const deadlines: number[] = []
  const source = { info: { id: "tool", role: "assistant", time: { created: 2 } }, parts: [
    { type: "tool", tool: "edit", callID: "call", state: { input: { patch: "fixture-change" } } },
  ] }
  const permission = { id: "p", sessionID: "s", permission: "edit", patterns: ["candidate.ts"], always: [],
    ...(phase === "source" ? { tool: { messageID: "tool", callID: "call" } } : {}) }
  let pages = 0
  let points = 0
  let models = 0
  const replies: string[] = []
  const failures: unknown[] = []
  let finished!: () => void
  const done = new Promise<void>((resolve) => { finished = resolve })
  const runtime = createStableRuntime({ session: {
    get: async () => ({ data: { id: "s" } }), messages: async () => { pages++; return { data: [user("human", 1, "Prepare the candidate."), source] } },
    message: ({ path, signal }: { path: { messageID: string }; signal: AbortSignal }) => { points++; pointID = path.messageID; pointSignal = signal; return new Promise(() => {}) },
  }, permission: { list: async () => ({ data: [permission] }) } }, { model: "fixture/reviewer" }, "/fixture")
  const stop = installReviewer(runtime.context, { client: {
    generate: async () => {
      models++
      expect(points).toBe(0)
      if (phase === "refresh") runtime.observe({ type: "message.updated", properties: { info: { id: "human", sessionID: "s" } } })
      timer = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, milliseconds: number) => {
        deadlines.push(milliseconds)
        return original(callback, 0)
      }) as typeof setTimeout)
      return { decision: "allow", reasonCode: "fixture", reason: "Offline decision." }
    },
    reply: async ({ reply }) => { replies.push(reply); finished(); return "replied" },
  }, onFailure: (_request, error) => { failures.push(error) } })
  try {
    // Keep the failure watchdog independent of the accelerated history deadlines.
    const expired = new Promise<never>((_resolve, reject) => {
      watchdog = original(() => reject(new Error(`Authoritative ${phase} deadline watchdog`)), 2_000)
    })
    runtime.emit({ type: "permission.asked", properties: permission })
    await Promise.race([done, expired])
    expect(deadlines).toEqual(phase === "source" ? [30_000, 30_000] : [30_000])
    expect(pointSignal?.aborted).toBe(true)
    expect(pointID).toBe(phase === "source" ? "tool" : "human")
    expect(replies).toEqual(["reject"])
    expect(failures.map(String)).toEqual(["Error: Stable history load cancelled"])
    expect(models).toBe(1)
    expect(pages).toBe(1)
    expect(points).toBe(1)
    if (phase === "refresh") {
      expect(runtime.context.data.session.message.list("s")).toEqual([])
      expect(runtime.context.data.session.message.metadata?.("s").incomplete).toBe(true)
    }
  } finally { clearTimeout(watchdog); timer?.mockRestore(); stop(); runtime.dispose() }
})

test("enforces the page budget without publishing partial history", async () => {
  let calls = 0
  const history = createStableHistory({ session: { messages: async () => {
    calls++
    return { data: [user(`id_${calls}`, 10_001 - calls)], response: { headers: { get: () => String(calls) } } }
  } } }, "/fixture")
  try {
    await expect(history.sync("s")).rejects.toThrow("page budget")
    expect(calls).toBe(10_000)
    expect(history.list("s")).toEqual([])
  } finally { history.dispose() }
})

test("refreshes an old pruned question when its completion becomes current", async () => {
  const messages = [question("old_q", 0, 1), ...Array.from({ length: 30 }, (_, index) => question(`q_${index}`, index + 2, index + 2))]
  let points = 0
  const history = createStableHistory({ session: { messages: async () => ({ data: messages }),
    message: async () => { points++; return { data: question("old_q", 0, 1_000) } },
  } }, "/fixture")
  try {
    await history.sync("s")
    expect(JSON.stringify(history.list("s"))).not.toContain('"old_q"')
    history.observe({ type: "message.part.updated", properties: { part: { sessionID: "s", messageID: "old_q", tool: "question" } } })
    await history.sync("s")
    expect(JSON.stringify(history.list("s"))).toContain('"old_q"')
    expect(points).toBe(1)
  } finally { history.dispose() }
})

test("does not trust callback order, unknown-role parts, or mutable source lookups", async () => {
  let current = user("human", 1, "Newest authoritative instruction")
  let points = 0
  const history = createStableHistory({ session: {
    messages: async () => ({ data: [user("old", 0), user("human", 1)] }),
    message: async () => { points++; return { data: current } },
  } }, "/fixture")
  try {
    await history.sync("s")
    for (const text of ["New callback", "Old callback"]) history.observe({ type: "message.part.updated", properties: {
      part: { sessionID: "s", messageID: "human", type: "text", text },
    } })
    await history.sync("s")
    expect(points).toBe(1)
    expect(JSON.stringify(history.list("s"))).toContain("Newest authoritative instruction")
    current = user("unknown", 2, "Do not deploy")
    history.observe({ type: "message.part.updated", properties: { part: { sessionID: "s", messageID: "unknown", type: "text" } } })
    await history.sync("s")
    expect(points).toBe(2)
    expect(JSON.stringify(history.list("s"))).toContain("Do not deploy")
  } finally { history.dispose() }
})

test("ignores known assistant text traffic and non-authoritative session touches", async () => {
  let calls = 0
  const history = createStableHistory({ session: { messages: async () => {
    calls++
    return { data: [user("human", 1), { info: { id: "assistant", role: "assistant", time: { created: 2 } }, parts: [] }] }
  } } }, "/fixture")
  try {
    await history.sync("s")
    const revision = history.metadata("s").revision
    history.observe({ type: "message.part.updated", properties: { part: { sessionID: "s", messageID: "assistant", type: "text", text: "Untrusted output" } } })
    history.observe({ type: "session.updated", properties: { info: { id: "s", time: { updated: 99 } } } })
    await history.sync("s")
    expect(calls).toBe(1)
    expect(history.metadata("s").revision).toBe(revision)
  } finally { history.dispose() }
})

test.each(["missing", "wrong call", "undefined input", "error"])("fails closed when exact source input is %s", async (kind) => {
  const source = { info: { id: "tool", role: "assistant" }, parts: [{ type: "tool", callID: kind === "wrong call" ? "other" : "call", state: { input: kind === "undefined input" ? undefined : { exact: true } } }] }
  const runtime = createStableRuntime({ session: { get: async () => ({ data: { id: "s" } }), messages: async () => ({ data: [user("human", 1)] }),
    message: async () => kind === "error" ? { error: "unavailable" } : { data: kind === "missing" ? undefined : source },
  } }, {}, "/fixture")
  try {
    await expect(collectReviewInput(runtime.context, { id: "p", sessionID: "s", action: "bash", resources: ["inspect"], always: [], protocol: "stable",
      source: { type: "tool", messageID: "tool", callID: "call" } }, 8)).rejects.toThrow()
  } finally { runtime.dispose() }
})

test("marks context incomplete if a delivered human mutation arrives during awaited source lookup", async () => {
  const source = { info: { id: "tool", role: "assistant" }, parts: [{ type: "tool", callID: "call", state: { input: { exact: true } } }] }
  const runtime = createStableRuntime({ session: { get: async () => ({ data: { id: "s" } }), messages: async () => ({ data: [user("human", 1)] }),
    message: async () => {
      runtime.observe({ type: "message.part.updated", properties: { part: { sessionID: "s", messageID: "human", type: "text" } } })
      return { data: source }
    },
  } }, {}, "/fixture")
  try {
    const input = await collectReviewInput(runtime.context, { id: "p", sessionID: "s", action: "bash", resources: ["inspect"], always: [], protocol: "stable",
      source: { type: "tool", messageID: "tool", callID: "call" } }, 8)
    expect(input.context.incomplete).toBe(true)
  } finally { runtime.dispose() }
})

test("rejects ancestry changes during session lookup", async () => {
  const runtime = createStableRuntime({ session: { get: async () => {
    runtime.observe({ type: "session.updated", properties: { info: { id: "s", parentID: "new_parent" } } })
    return { data: { id: "s" } }
  }, messages: async () => ({ data: [] }) } }, {}, "/fixture")
  try {
    await expect(collectReviewInput(runtime.context, { id: "p", sessionID: "s", action: "bash", resources: ["inspect"], always: [], protocol: "stable" }, 8)).rejects.toThrow("session changed")
  } finally { runtime.dispose() }
})

test("repeated ordinary session touches do not invalidate warm authorization history", async () => {
  let calls = 0
  const runtime = createStableRuntime({ session: { get: async () => ({ data: { id: "s" } }), messages: async () => { calls++; return { data: [user("human", 1)] } } } }, {}, "/fixture")
  const request = { id: "p", sessionID: "s", action: "bash", resources: ["inspect"], always: [], protocol: "stable" as const }
  try {
    const first = await collectReviewInput(runtime.context, request, 8)
    for (let index = 0; index < 5; index++) runtime.observe({ type: "session.updated", properties: { info: { id: "s", time: { updated: index } } } })
    const second = await collectReviewInput(runtime.context, request, 8)
    expect(second).toEqual(first)
    expect(calls).toBe(1)
  } finally { runtime.dispose() }
})

test.each(["direct", "session.status", "unrelated deletion", "unrelated creation"])("invalidates ancestry changes during final source lookup after %s", async (preceding) => {
  let parent = "old_root"
  const source = { info: { id: "tool", role: "assistant" }, parts: [{ type: "tool", callID: "call", state: { input: { exact: true } } }] }
  const runtime = createStableRuntime({ session: {
    get: async ({ path }: any) => ({ data: { id: path.id, ...(path.id === "child" ? { parentID: parent } : {}) } }),
    messages: async ({ path }: any) => ({ data: path.id === "child" ? [source] : [user("human", 1)] }),
    message: async () => {
      if (preceding === "session.status") runtime.observe({ type: "session.status", properties: { sessionID: "child", status: { type: "busy" } } })
      if (preceding === "unrelated deletion") runtime.observe({ type: "session.deleted", properties: { info: { id: "other" } } })
      if (preceding === "unrelated creation") runtime.observe({ type: "session.created", properties: { info: { id: "other" } } })
      parent = "new_root"
      runtime.observe({ type: "session.updated", properties: { info: { id: "child", parentID: parent } } })
      return { data: source }
    },
  } }, {}, "/fixture")
  const request = { id: "p", sessionID: "child", action: "bash", resources: ["inspect"], always: [], protocol: "stable" as const,
    source: { type: "tool" as const, messageID: "tool", callID: "call" } }
  try {
    expect((await collectReviewInput(runtime.context, request, 8)).context.rootSessionID).toBe("old_root")
    await expect(collectReviewInput(runtime.context, request, 8)).rejects.toThrow()
    const { source: _source, ...withoutSource } = request
    expect((await collectReviewInput(runtime.context, withoutSource, 8)).context.rootSessionID).toBe("new_root")
  } finally { runtime.dispose() }
})

test.each(["session.status", "session.deleted", "session.created"])("%s preserves unrelated cached ancestry and warm pages", async (type) => {
  let gets = 0
  let pages = 0
  const runtime = createStableRuntime({ session: {
    get: async ({ path }: any) => { gets++; return { data: { id: path.id, ...(path.id === "child" ? { parentID: "root" } : {}) } } },
    messages: async () => { pages++; return { data: [user("human", 1)] } },
  } }, {}, "/fixture")
  const request = { id: "p", sessionID: "child", action: "edit", resources: ["candidate.ts"], always: [], protocol: "stable" as const }
  try {
    const first = await collectReviewInput(runtime.context, request, 8)
    runtime.observe({ type, properties: type === "session.status" ? { sessionID: "child" } : { info: { id: "other" } } })
    expect(await collectReviewInput(runtime.context, request, 8)).toEqual(first)
    expect(gets).toBe(2)
    expect(pages).toBe(2)
  } finally { runtime.dispose() }
})

test.each(["server.connected", "message.removed", "message.part.updated"])("rejects unstable cold loads on %s", async (type) => {
  const history = createStableHistory({ session: { messages: async () => {
    history.observe({ type, properties: { sessionID: "s" } })
    return { data: [user("human", 1)] }
  } } }, "/fixture")
  try {
    await expect(history.sync("s")).rejects.toThrow()
    expect(history.metadata("s").incomplete).toBe(true)
    expect(history.list("s")).toEqual([])
  } finally { history.dispose() }
})

test("rejects a deferred model authorization after delivered history changes", async () => {
  let current = user("human", 1, "Prepare the local candidate")
  let full = 0
  let points = 0
  let finishModel!: (value: unknown) => void
  let modelStarted!: () => void
  const started = new Promise<void>((resolve) => { modelStarted = resolve })
  let replied!: () => void
  const done = new Promise<void>((resolve) => { replied = resolve })
  const pending = { id: "p", sessionID: "s", permission: "edit", patterns: ["candidate.ts"], always: [] }
  const runtime = createStableRuntime({ session: { get: async () => ({ data: { id: "s" } }),
    messages: async () => { full++; return { data: [current] } }, message: async () => { points++; return { data: current } },
  }, permission: { list: async () => ({ data: [pending] }) } }, { model: "fixture/reviewer" }, "/fixture")
  const replies: string[] = []
  const stop = installReviewer(runtime.context, { client: {
    generate: () => { modelStarted(); return new Promise((resolve) => { finishModel = resolve }) },
    reply: async ({ reply }) => { replies.push(reply); replied(); return "replied" },
  } })
  try {
    runtime.emit({ type: "permission.asked", properties: pending })
    await started
    current = user("human", 1, "Do not edit the candidate")
    runtime.emit({ type: "message.part.updated", properties: { part: { sessionID: "s", messageID: "human", type: "text" } } })
    finishModel({ decision: "allow_session", reasonCode: "fixture", reason: "Offline decision." })
    await done
    expect(replies).toEqual(["reject"])
    expect(full).toBe(1)
    expect(points).toBe(1)
  } finally { stop(); runtime.dispose() }
})

test.each(["unrelated tool", "human", "source", "failed refresh"])("pending authorization validates semantic input after %s traffic", async (kind) => {
  let human = user("human", 1, "Fetch the remote references")
  let command = "git fetch origin"
  const source = () => ({ info: { id: "source", role: "assistant", time: { created: 2 } },
    parts: [{ type: "tool", tool: "bash", callID: "call", state: { input: { command } } }] })
  const unrelated = { info: { id: "other", role: "assistant", time: { created: 3 } },
    parts: [{ type: "tool", tool: "read", callID: "other", state: { input: { path: "notes.txt" } } }] }
  let pages = 0
  let points = 0
  let modelCalls = 0
  let finish!: (value: unknown) => void
  let start!: () => void
  const started = new Promise<void>((resolve) => { start = resolve })
  let replied!: () => void
  let done = new Promise<void>((resolve) => { replied = resolve })
  const pending: any[] = []
  const runtime = createStableRuntime({ session: {
    get: async () => ({ data: { id: "s" } }),
    messages: async () => { pages++; return { data: [human, source(), unrelated] } },
    message: async ({ path }: any) => {
      points++
      if (kind === "failed refresh" && path.messageID === "other") return { error: "fixture unavailable" }
      return { data: path.messageID === "human" ? human : path.messageID === "source" ? source() : unrelated }
    },
  }, permission: { list: async () => ({ data: pending }) } }, { model: "fixture/reviewer" }, "/fixture")
  const replies: string[] = []
  const stop = installReviewer(runtime.context, { client: {
    generate: () => { modelCalls++; start(); return new Promise((resolve) => { finish = resolve }) },
    reply: async ({ reply }) => { replies.push(reply); replied(); return "replied" },
  } })
  const request = { id: "p", sessionID: "s", permission: "bash", patterns: ["git fetch origin"], always: ["git fetch origin"],
    tool: { messageID: "source", callID: "call" } }
  try {
    pending.push(request)
    runtime.emit({ type: "permission.asked", properties: request })
    await started
    if (kind === "human") human = user("human", 1, "Do not execute git fetch origin")
    if (kind === "source") command = "git fetch another-remote"
    const messageID = kind === "human" ? "human" : kind === "source" ? "source" : "other"
    runtime.observe({ type: "message.part.updated", properties: { part: { sessionID: "s", messageID, type: "tool" } } })
    finish({ decision: "allow_session", reasonCode: "fixture", reason: "Offline decision." })
    await done
    expect(replies).toEqual([kind === "unrelated tool" ? "once" : "reject"])
    if (kind === "unrelated tool") {
      runtime.observe({ type: "message.updated", properties: { info: { id: "other", sessionID: "s" } } })
      done = new Promise<void>((resolve) => { replied = resolve })
      const next = { ...request, id: "p_next" }
      pending.push(next)
      runtime.emit({ type: "permission.asked", properties: next })
      await Promise.race([done, new Promise((_, reject) => setTimeout(() => reject(new Error("session reuse stalled")), 500))])
      expect(replies).toEqual(["once", "once"])
      expect(modelCalls).toBe(1)
    }
    expect(pages).toBe(1)
    expect(points).toBeGreaterThan(0)
  } finally { stop(); runtime.dispose() }
})

test("rejects a raced source response even after another permission drains dirty history", async () => {
  let command = "git fetch origin"
  const source = () => ({ info: { id: "source", role: "assistant", time: { created: 2 } },
    parts: [{ type: "tool", tool: "bash", callID: "call", state: { input: { command } } }] })
  let pages = 0
  let points = 0
  let release!: (value: any) => void
  let suspended!: () => void
  const waiting = new Promise<void>((resolve) => { suspended = resolve })
  let finishedA!: () => void
  let finishedB!: () => void
  const doneA = new Promise<void>((resolve) => { finishedA = resolve })
  const doneB = new Promise<void>((resolve) => { finishedB = resolve })
  const pending: any[] = []
  const runtime = createStableRuntime({ session: {
    get: async () => ({ data: { id: "s" } }),
    messages: async () => { pages++; return { data: [user("human", 1, "Fetch the references"), source()] } },
    message: async () => {
      const data = source()
      if (++points === 2) {
        suspended()
        return new Promise((resolve) => { release = resolve })
      }
      return { data }
    },
  }, permission: { list: async () => ({ data: pending }) } }, { model: "fixture/reviewer" }, "/fixture")
  const replies = new Map<string, string>()
  const stop = installReviewer(runtime.context, { client: {
    generate: async () => ({ decision: "allow", reasonCode: "fixture", reason: "Offline decision." }),
    reply: async ({ requestID, reply }) => {
      replies.set(requestID, reply)
      if (requestID === "a") finishedA()
      if (requestID === "b") finishedB()
      return "replied"
    },
  } })
  try {
    await runtime.context.data.session.message.sync("s")
    const original = source()
    const first = { id: "a", sessionID: "s", permission: "bash", patterns: [command], always: [],
      tool: { messageID: "source", callID: "call" } }
    pending.push(first)
    runtime.emit({ type: "permission.asked", properties: first })
    await waiting
    command = "git fetch other-remote"
    runtime.observe({ type: "message.part.updated", properties: { part: { sessionID: "s", messageID: "source", type: "tool" } } })
    const second = { id: "b", sessionID: "s", permission: "edit", patterns: ["notes.txt"], always: [] }
    pending.push(second)
    runtime.emit({ type: "permission.asked", properties: second })
    await doneB
    expect(runtime.context.data.session.message.metadata!("s").incomplete).toBe(false)
    release({ data: original })
    await doneA
    expect(replies.get("a")).toBe("reject")
    expect(replies.get("b")).toBe("once")
    expect(pages).toBe(1)
    expect(points).toBe(3)
  } finally { stop(); runtime.dispose() }
})

test("revalidates transient cold source input after another collector refreshes the session", async () => {
  let command = "git fetch origin"
  const source = () => ({ info: { id: "source", role: "assistant", time: { created: 2 } },
    parts: [{ type: "tool", tool: "bash", callID: "call", state: { input: { command } } }] })
  let release!: (value: any) => void
  let started!: () => void
  const waiting = new Promise<void>((resolve) => { started = resolve })
  let pages = 0
  let points = 0
  const runtime = createStableRuntime({ session: {
    get: async ({ path }: any) => ({ data: { id: path.id, ...(path.id === "child" ? { parentID: "root" } : {}) } }),
    messages: async ({ path }: any) => {
      pages++
      if (path.id === "root") {
        started()
        return new Promise((resolve) => { release = resolve })
      }
      return { data: [source()] }
    },
    message: async () => { points++; return { data: source() } },
  } }, {}, "/fixture")
  try {
    const pending = collectReviewInput(runtime.context, { id: "p", sessionID: "child", action: "bash", resources: [command], always: [], protocol: "stable",
      source: { type: "tool", messageID: "source", callID: "call" } }, 8)
    await waiting
    await runtime.context.data.session.message.sync("child")
    command = "git fetch other-remote"
    runtime.observe({ type: "message.part.updated", properties: { part: { sessionID: "child", messageID: "source", type: "tool" } } })
    await runtime.context.data.session.message.sync("child")
    release({ data: [user("human", 1)] })
    const input = await pending
    expect(input.request.toolInput).toEqual({ command })
    expect(input.context.incomplete).toBe(false)
    expect(pages).toBe(2)
    expect(points).toBe(2)
  } finally { runtime.dispose() }
})

test("keeps a source collection incomplete when a concurrent collector hides its delivered mutation", async () => {
  let command = "git fetch origin"
  const source = () => ({ info: { id: "source", role: "assistant", time: { created: 2 } },
    parts: [{ type: "tool", tool: "bash", callID: "call", state: { input: { command } } }] })
  const runtime = createStableRuntime({ session: {
    get: async () => ({ data: { id: "s" } }), messages: async () => ({ data: [user("human", 1), source()] }),
    message: async () => ({ data: source() }),
  } }, {}, "/fixture")
  try {
    await runtime.context.data.session.message.sync("s")
    const read = runtime.context.data.session.message.source!
    runtime.context.data.session.message.source = async (...args) => {
      const captured = await read(...args)
      command = "git fetch other-remote"
      runtime.observe({ type: "message.part.updated", properties: { part: { sessionID: "s", messageID: "source", type: "tool" } } })
      await runtime.context.data.session.message.sync("s")
      return captured
    }
    const input = await collectReviewInput(runtime.context, { id: "p", sessionID: "s", action: "bash", resources: ["git fetch origin"], always: [], protocol: "stable",
      source: { type: "tool", messageID: "source", callID: "call" } }, 8)
    expect(input.context.incomplete).toBe(true)
    expect(applyDeterministicPolicy(input)?.kind).toBe("deny")
  } finally { runtime.dispose() }
})

test.each(["answers", "framing"])("refreshes retained question %s in place and rejects its prior deferred approval", async (kind) => {
  let current: any = question("answered", 2, 3)
  let pages = 0
  let points = 0
  let started!: () => void
  const waiting = new Promise<void>((resolve) => { started = resolve })
  let release!: (value: unknown) => void
  let finished!: () => void
  let done = new Promise<void>((resolve) => { finished = resolve })
  const pending: any[] = []
  const runtime = createStableRuntime({ session: {
    get: async () => ({ data: { id: "s" } }),
    messages: async () => { pages++; return { data: [user("human", 1, "Prepare the candidate"), current] } },
    message: async () => { points++; return { data: current } },
  }, permission: { list: async () => ({ data: pending }) } }, { model: "fixture/reviewer" }, "/fixture")
  const contexts: any[] = []
  const replies: string[] = []
  const stop = installReviewer(runtime.context, { client: {
    generate: async ({ prompt }) => {
      contexts.push(JSON.parse(prompt.slice(prompt.indexOf("\n") + 1)).context)
      if (contexts.length === 1) {
        started()
        return new Promise((resolve) => { release = resolve })
      }
      return { decision: "deny", reasonCode: "fixture", reason: "Offline decision." }
    },
    reply: async ({ reply }) => { replies.push(reply); finished(); return "replied" },
  } })
  const request = { id: "p", sessionID: "s", action: "edit", resources: ["candidate.ts"], always: [], protocol: "stable" as const }
  const permission = { id: "p", sessionID: "s", permission: "edit", patterns: ["candidate.ts"], always: [] }
  try {
    pending.push(permission)
    runtime.emit({ type: "permission.asked", properties: permission })
    await waiting
    current = structuredClone(current)
    if (kind === "answers") current.parts[0].state.metadata.answers = [["Keep"]]
    else {
      current.parts[0].state.input.questions[0].question = "Which local files may be changed?"
      current.parts[0].state.input.questions[0].header = "Narrow scope"
      current.parts[0].state.input.questions[0].options[0].description = "Inspect only without modifying files."
    }
    runtime.observe({ type: kind === "answers" ? "message.part.updated" : "message.updated", properties: {
      sessionID: "s", messageID: "answered", part: { sessionID: "s", messageID: "answered", type: "tool", tool: "question" },
    } })
    const expected = { type: "question_answer" as const, sessionID: "s", callID: "answered", completedAt: 3,
      questions: current.parts[0].state.input.questions, answers: current.parts[0].state.metadata.answers }
    const updated = await collectReviewInput(runtime.context, request, 8)
    expect(updated.context.humanInteractions.at(-1)).toEqual(expected)
    expect(updated.context.incomplete).toBe(false)
    expect(contexts[0].humanInteractions.at(-1)).not.toEqual(expected)
    release({ decision: "allow_session", reasonCode: "fixture", reason: "Offline old approval." })
    await done
    expect(replies).toEqual(["reject"])
    done = new Promise<void>((resolve) => { finished = resolve })
    const next = { ...permission, id: "p_next" }
    pending.push(next)
    runtime.emit({ type: "permission.asked", properties: next })
    await done
    expect(contexts).toHaveLength(2)
    expect(contexts[1].humanInteractions.at(-1)).toEqual(expected)
    expect(replies).toEqual(["reject", "reject"])
    expect(pages).toBe(1)
    expect(points).toBe(1)
  } finally { stop(); runtime.dispose() }
})

test.each(["new root", "new intermediate"])("rejects repaired %s ancestry during another permission's old-root refresh", async (kind) => {
  let parent = "old_root"
  let hold = false
  let pages = 0
  let points = 0
  let releaseRoot!: (value: any) => void
  let suspended!: () => void
  const blocked = new Promise<void>((resolve) => { suspended = resolve })
  let started!: () => void
  const waiting = new Promise<void>((resolve) => { started = resolve })
  let releaseModel!: (value: unknown) => void
  let finishedA!: () => void
  let finishedB!: () => void
  const doneA = new Promise<void>((resolve) => { finishedA = resolve })
  const doneB = new Promise<void>((resolve) => { finishedB = resolve })
  const source = { info: { id: "source", role: "assistant", time: { created: 3 } },
    parts: [{ type: "tool", tool: "bash", callID: "call", state: { input: { command: "git fetch origin" } } }] }
  const messages: Record<string, any[]> = {
    old_root: [user("old_human", 1, "Prepare the candidate")],
    new_root: [user("new_human", 1, "Do not execute git fetch origin")],
    middle: [user("narrow_scope", 2, "Inspect only; do not fetch references")],
    child: [user("delegate", 2, "Fetch the references"), source],
  }
  const pending: any[] = []
  const runtime = createStableRuntime({ session: {
    get: async ({ path }: any) => ({ data: { id: path.id,
      ...(path.id === "child" ? { parentID: parent } : path.id === "middle" ? { parentID: "old_root" } : {}) } }),
    messages: async ({ path }: any) => { pages++; return { data: messages[path.id] } },
    message: async ({ path }: any) => {
      points++
      if (path.id === "old_root" && hold) {
        hold = false
        suspended()
        return new Promise((resolve) => { releaseRoot = resolve })
      }
      return { data: messages[path.id]!.find((message) => message.info.id === path.messageID) }
    },
  }, permission: { list: async () => ({ data: pending }) } }, { model: "fixture/reviewer" }, "/fixture")
  const contexts: any[] = []
  const replies = new Map<string, string>()
  const stop = installReviewer(runtime.context, { client: {
    generate: async ({ prompt }) => {
      contexts.push(JSON.parse(prompt.slice(prompt.indexOf("\n") + 1)).context)
      if (contexts.length === 1) {
        started()
        return new Promise((resolve) => { releaseModel = resolve })
      }
      return { decision: "allow", reasonCode: "fixture", reason: "Offline decision." }
    },
    reply: async ({ requestID, reply }) => {
      replies.set(requestID, reply)
      if (requestID === "a") finishedA()
      if (requestID === "b") finishedB()
      return "replied"
    },
  } })
  try {
    await collectReviewInput(runtime.context, { id: "warm", sessionID: "child", action: "bash", resources: ["git fetch origin"], always: [], protocol: "stable",
      source: { type: "tool", messageID: "source", callID: "call" } }, 8)
    const first = { id: "a", sessionID: "child", permission: "bash", patterns: ["git fetch origin"], always: [],
      tool: { messageID: "source", callID: "call" } }
    pending.push(first)
    runtime.emit({ type: "permission.asked", properties: first })
    await waiting
    hold = true
    runtime.observe({ type: "message.updated", properties: { info: { id: "old_human", sessionID: "old_root" } } })
    releaseModel({ decision: "allow", reasonCode: "fixture", reason: "Offline old approval." })
    await blocked
    await runtime.context.data.session.message.sync("child")
    parent = kind === "new root" ? "new_root" : "middle"
    runtime.observe({ type: "session.updated", properties: { info: { id: "child", parentID: parent } } })
    const second = { id: "b", sessionID: "child", permission: "read", patterns: ["notes.txt"], always: [] }
    pending.push(second)
    runtime.emit({ type: "permission.asked", properties: second })
    await doneB
    expect(runtime.context.data.session.message.metadata!("child").incomplete).toBe(false)
    expect(runtime.context.data.session.get("child")?.parentID).toBe(parent)
    releaseRoot({ data: messages.old_root![0] })
    await doneA
    expect(replies.get("a")).toBe("reject")
    expect(replies.get("b")).toBe("once")
    expect(contexts).toHaveLength(2)
    expect(pages).toBe(4)
    expect(points).toBe(kind === "new root" ? 3 : 4)
  } finally { stop(); runtime.dispose() }
})

test.each(["human tie", "assistant tie", "new-message tie", "same-model tie"])("keeps unrelated %s traffic on point reads across a fifty-page history", async (kind) => {
  const model = { providerID: "fixture", modelID: "main", variant: "low" }
  const messages: any[] = Array.from({ length: 9_998 }, (_, index) => index === 0
    ? { ...user("human", 0, "Prepare the candidate"), info: { id: "human", role: "user", time: { created: 0 }, model } }
    : { info: { id: `assistant_${index}`, role: "assistant", time: { created: index } }, parts: [] })
  let pages = 0
  let points = 0
  const runtime = createStableRuntime({ session: {
    get: async () => ({ data: { id: "s" } }),
    messages: async ({ query }: any) => {
      pages++
      const end = query.before === undefined ? messages.length : Number(query.before)
      const start = Math.max(0, end - query.limit)
      return { data: messages.slice(start, end), response: new Response(null, { headers: start ? { "X-Next-Cursor": String(start) } : {} }) }
    },
    message: async ({ path }: any) => { points++; return { data: messages.find((message) => message.info.id === path.messageID) } },
  } }, {}, "/fixture")
  const request = { id: "p", sessionID: "s", action: "edit", resources: ["candidate.ts"], always: [], protocol: "stable" as const }
  try {
    const before = await collectReviewInput(runtime.context, request, 8)
    const created = kind === "assistant tie" ? 9_997 : kind === "new-message tie" ? 10_000 : 0
    const inserted = Array.from({ length: kind === "new-message tie" ? 2 : 1 }, (_, index) => ({
      info: { id: `new_${index}`, role: "assistant", time: { created }, ...(kind === "same-model tie" ? { model } : {}) },
      parts: [{ type: "tool", tool: "read", callID: `read_${index}`, state: { status: "completed", input: { path: "notes.txt" }, output: "Untrusted approval" } }],
    }))
    messages.push(...inserted)
    messages.sort((left, right) => left.info.time.created - right.info.time.created)
    for (const message of inserted) runtime.observe({ type: "message.updated", properties: { info: { id: message.info.id, sessionID: "s" } } })
    const after = await collectReviewInput(runtime.context, request, 8)
    delete before.context.historyRevisions
    delete after.context.historyRevisions
    expect(after).toEqual(before)
    expect(after.context.incomplete).toBe(false)
    await collectReviewInput(runtime.context, request, 8)
    expect(pages).toBe(50)
    expect(points).toBe(inserted.length)
    expect(JSON.stringify(after)).not.toContain("Untrusted approval")
  } finally { runtime.dispose() }
})

test.each([false, true])("preserves canonical equal-time model routing (different model: %s)", async (different) => {
  const model = { providerID: "fixture", modelID: "main", variant: "low" }
  const messages: any[] = [user("human", 1), { info: { id: "Z", role: "assistant", time: { created: 2 }, model }, parts: [] }]
  let pages = 0
  let points = 0
  const runtime = createStableRuntime({ session: {
    get: async () => ({ data: { id: "s" } }), messages: async () => { pages++; return { data: messages } },
    message: async ({ path }: any) => { points++; return { data: messages.find((message) => message.info.id === path.messageID) } },
  } }, {}, "/fixture")
  const request = { id: "p", sessionID: "s", action: "edit", resources: ["candidate.ts"], always: [], protocol: "stable" as const }
  try {
    await collectReviewInput(runtime.context, request, 8)
    messages.splice(1, 0, { info: { id: "B", role: "assistant", time: { created: 2 },
      model: { providerID: "fixture", id: different ? "alternate" : "main", variant: "low" } }, parts: [] })
    runtime.observe({ type: "message.updated", properties: { info: { id: "B", sessionID: "s" } } })
    const indexed = await collectReviewInput(runtime.context, request, 8)
    const generic = await collectReviewInput({ ...runtime.context, data: { ...runtime.context.data, session: {
      ...runtime.context.data.session, message: { sync: async () => {}, list: () => messages, get: () => undefined },
    } } }, request, 8)
    delete indexed.context.historyRevisions
    expect(indexed).toEqual(generic)
    expect(indexed.context.model).toEqual({ providerID: "fixture", id: "main", variant: "low" })
    expect(pages).toBe(different ? 2 : 1)
    expect(points).toBe(1)
  } finally { runtime.dispose() }
})

test("retains a cross-page question tie at the pruned boundary through warm checks and native replies", async () => {
  const messages = [question("older", 0, 1_000), question("newer", 1, 1_000),
    ...Array.from({ length: 19 }, (_, index) => question(`later_${index}`, index + 2, index + 1_001)),
    ...Array.from({ length: 180 }, (_, index) => ({ info: { id: `filler_${index}`, role: "assistant", time: { created: index + 21 } }, parts: [] }))]
  let pages = 0
  let points = 0
  const permission = { id: "p", sessionID: "s", permission: "read", patterns: ["notes.txt"], always: [] }
  const runtime = createStableRuntime({ session: {
    get: async () => ({ data: { id: "s" } }),
    messages: async ({ query }: any) => {
      pages++
      const end = query.before === undefined ? messages.length : Number(query.before)
      const start = Math.max(0, end - query.limit)
      return { data: messages.slice(start, end), response: new Response(null, { headers: start ? { "X-Next-Cursor": String(start) } : {} }) }
    },
    message: async () => { points++; throw new Error("Unexpected point lookup") },
  }, permission: { list: async () => ({ data: [permission] }) } }, { model: "fixture/reviewer", userMessageCount: 20 }, "/fixture")
  const request = { id: "p", sessionID: "s", action: "read", resources: ["notes.txt"], always: [], protocol: "stable" as const }
  try {
    const indexed = await collectReviewInput(runtime.context, request, 20)
    const generic = await collectReviewInput({ ...runtime.context, data: { ...runtime.context.data, session: {
      ...runtime.context.data.session, message: { sync: async () => {}, list: () => messages, get: () => undefined },
    } } }, request, 20)
    delete indexed.context.historyRevisions
    expect(indexed).toEqual(generic)
    expect(indexed.context.humanInteractions).toHaveLength(20)
    expect(indexed.context.incomplete).toBe(true)
    let finished!: () => void
    const done = new Promise<void>((resolve) => { finished = resolve })
    let modelCalls = 0
    const replies: string[] = []
    const stop = installReviewer(runtime.context, { client: {
      generate: async () => { modelCalls++; return { decision: "allow", reasonCode: "fixture", reason: "Offline decision." } },
      reply: async ({ reply }) => { replies.push(reply); finished(); return "replied" },
    } })
    try {
      runtime.emit({ type: "permission.asked", properties: permission })
      await done
      expect(replies).toEqual(["reject"])
      expect(modelCalls).toBe(0)
    } finally { stop() }
    expect((await collectReviewInput(runtime.context, request, 20)).context.incomplete).toBe(true)
    expect(pages).toBe(2)
    expect(points).toBe(0)
  } finally { runtime.dispose() }
})

for (const fallback of [false, true]) {
  test.each(["removed", "retimed", "updated"])(`preserves the reviewer model after %s routing (fallback: ${fallback})`, async (kind) => {
    const messages: any[] = [user("human", 0),
      { info: { id: "predecessor", role: "assistant", time: { created: 1 }, model: { providerID: "fixture", modelID: "older", variant: "low" } }, parts: [] },
      { info: { id: "latest", role: "assistant", time: { created: 2 }, model: { providerID: "fixture", modelID: "latest", variant: "high" } }, parts: [] }]
    let pages = 0
    let points = 0
    const permission = { id: "p", sessionID: "s", permission: "edit", patterns: ["candidate.ts"], always: [] }
    const runtime = createStableRuntime({ session: {
      get: async () => ({ data: { id: "s" } }), messages: async () => { pages++; return { data: messages } },
      message: async ({ path }: any) => { points++; return { data: messages.find((message) => message.info.id === path.messageID) } },
    }, permission: { list: async () => ({ data: [permission] }) } }, fallback ? { model: "fixture/dedicated" } : {}, "/fixture")
    const request = { id: "p", sessionID: "s", action: "edit", resources: ["candidate.ts"], always: [], protocol: "stable" as const }
    try {
      await collectReviewInput(runtime.context, request, 8)
      expect(JSON.stringify(runtime.context.data.session.message.list("s"))).not.toContain('"predecessor"')
      const latest = messages.find((message) => message.info.id === "latest")
      if (kind === "removed") delete latest.info.model
      if (kind === "retimed") latest.info.time.created = 0.5
      if (kind === "updated") latest.info.model = { providerID: "fixture", modelID: "updated", variant: "medium" }
      messages.sort((left, right) => left.info.time.created - right.info.time.created)
      runtime.observe({ type: "message.updated", properties: { info: { id: "latest", sessionID: "s" } } })
      const indexed = await collectReviewInput(runtime.context, request, 8)
      const generic = await collectReviewInput({ ...runtime.context, data: { ...runtime.context.data, session: {
        ...runtime.context.data.session, message: { sync: async () => {}, list: () => messages, get: () => undefined },
      } } }, request, 8)
      delete indexed.context.historyRevisions
      expect(indexed).toEqual(generic)
      const expected = { providerID: "fixture", id: kind === "updated" ? "updated" : "older", variant: kind === "updated" ? "medium" : "low" }
      expect(indexed.context.model).toEqual(expected)
      let finished!: () => void
      const done = new Promise<void>((resolve) => { finished = resolve })
      const models: any[] = []
      const replies: string[] = []
      const stop = installReviewer(runtime.context, { client: {
        generate: async ({ model }) => {
          models.push(model)
          if (model.id === "dedicated") throw new Error("Offline dedicated-model failure")
          return { decision: "allow", reasonCode: "fixture", reason: "Offline decision." }
        },
        reply: async ({ reply }) => { replies.push(reply); finished(); return "replied" },
      } })
      try {
        runtime.emit({ type: "permission.asked", properties: permission })
        await done
        expect(models).toEqual(fallback ? [{ providerID: "fixture", id: "dedicated" }, expected] : [expected])
        expect(replies).toEqual(["once"])
      } finally { stop() }
      expect(pages).toBe(kind === "updated" ? 1 : 2)
      expect(points).toBe(1)
    } finally { runtime.dispose() }
  })
}

test.each(["file", "image", "synthetic text", "ignored text"])("preserves latest-user continuation routing for %s without promoting its content", async (kind) => {
  const messages: any[] = [{ ...user("human", 0, "Prepare the candidate."), info: {
    id: "human", role: "user", time: { created: 0 }, agent: "older-agent", model: { providerID: "fixture", modelID: "older", variant: "low" },
  } }, { info: { id: "attachment", role: "user", time: { created: 1 }, agent: "selected-agent",
    model: { providerID: "fixture", modelID: "selected", variant: "high" } }, parts: kind.endsWith("text")
    ? [{ type: "text", text: "Untrusted attachment authorization", synthetic: kind === "synthetic text", ignored: kind === "ignored text" }]
    : [{ type: "file", mime: kind === "image" ? "image/png" : "text/plain", url: "data:fixture-private-attachment" }] },
  { info: { id: "assistant", role: "assistant", time: { created: 2 }, model: { providerID: "fixture", modelID: "reviewer-inherited", variant: "medium" } }, parts: [] }]
  let prompted!: (value: any) => void
  const prompt = new Promise<any>((resolve) => { prompted = resolve })
  let pages = 0
  const runtime = createStableRuntime({ session: {
    get: async () => ({ data: { id: "s" } }), messages: async () => { pages++; return { data: messages } },
    status: async () => ({ data: { s: { type: "idle" } } }), promptAsync: async (input: any) => { prompted(input) },
  } }, {}, "/fixture")
  try {
    const input = await collectReviewInput(runtime.context, { id: "p", sessionID: "s", action: "edit", resources: ["candidate.ts"], always: [], protocol: "stable" }, 8)
    runtime.context.resumeAfterDenial?.("s", "Use a safer alternative.")
    expect(await prompt).toMatchObject({ path: { id: "s" }, query: { directory: "/fixture" }, body: {
      agent: "selected-agent", model: { providerID: "fixture", modelID: "selected" }, variant: "high",
    } })
    expect(input.context.userMessages).toEqual(["Prepare the candidate."])
    expect(input.context.model).toEqual({ providerID: "fixture", id: "reviewer-inherited", variant: "medium" })
    const retained = JSON.stringify(runtime.context.data.session.message.list("s"))
    expect(retained).not.toContain("fixture-private-attachment")
    expect(retained).not.toContain("Untrusted attachment authorization")
    expect(pages).toBe(1)
  } finally { runtime.dispose() }
})

test.each(["demoted", "retimed", "updated"])("preserves the latest-user routing boundary after %s metadata", async (kind) => {
  const inherited = { providerID: "fixture", modelID: "inherited", variant: "medium" }
  const messages: any[] = [user("human", 0, "Prepare the candidate."),
    { info: { id: "predecessor", role: "user", time: { created: 1 }, agent: "previous-agent", model: { providerID: "fixture", modelID: "previous", variant: "low" } }, parts: [] },
    { info: { id: "latest", role: "user", time: { created: 2 }, agent: "latest-agent" }, parts: [] },
    { info: { id: "assistant", role: "assistant", time: { created: 3 }, model: inherited }, parts: [] }]
  let prompted!: (value: any) => void
  const prompt = new Promise<any>((resolve) => { prompted = resolve })
  let pages = 0
  let points = 0
  const runtime = createStableRuntime({ session: {
    get: async () => ({ data: { id: "s" } }), messages: async () => { pages++; return { data: messages } },
    message: async ({ path }: any) => { points++; return { data: messages.find((message) => message.info.id === path.messageID) } },
    status: async () => ({ data: { s: { type: "idle" } } }), promptAsync: async (input: any) => { prompted(input) },
  } }, {}, "/fixture")
  const request = { id: "p", sessionID: "s", action: "edit", resources: ["candidate.ts"], always: [], protocol: "stable" as const }
  try {
    await collectReviewInput(runtime.context, request, 8)
    expect(JSON.stringify(runtime.context.data.session.message.list("s"))).not.toContain('"predecessor"')
    const latest = messages.find((message) => message.info.id === "latest")
    if (kind === "demoted") latest.info.role = "assistant"
    if (kind === "retimed") latest.info.time.created = 0.5
    if (kind === "updated") latest.info.agent = "updated-agent"
    messages.sort((left, right) => left.info.time.created - right.info.time.created)
    runtime.observe({ type: "message.updated", properties: { info: { id: "latest", sessionID: "s" } } })
    const input = await collectReviewInput(runtime.context, request, 8)
    runtime.context.resumeAfterDenial?.("s", "Use a safer alternative.")
    const { parts, ...routing } = (await prompt).body
    expect(routing).toEqual(kind === "updated" ? { agent: "updated-agent" } : {
      agent: "previous-agent", model: { providerID: "fixture", modelID: "previous" }, variant: "low",
    })
    expect(input.context.model).toEqual({ providerID: "fixture", id: "inherited", variant: "medium" })
    expect(input.context.userMessages).toEqual(["Prepare the candidate."])
    expect(pages).toBe(kind === "updated" ? 1 : 2)
    expect(points).toBe(1)
  } finally { runtime.dispose() }
})

test.each(["equal time", "unknown time", "promoted equal time", "promoted unknown time"])("reconstructs unproven non-text user placement with %s", async (kind) => {
  const messages: any[] = [user("human", 0, "Prepare the candidate."),
    { info: { id: "latest", role: "user", time: { created: 2 }, agent: "latest-agent" }, parts: [] },
    { info: { id: "assistant", role: "assistant", time: { created: 3 }, model: { providerID: "fixture", modelID: "inherited" } }, parts: [] }]
  const promoted = kind.startsWith("promoted")
  if (promoted) messages.push({ info: { id: "inserted", role: "assistant", time: { created: 4 } }, parts: [] })
  let prompted!: (value: any) => void
  const prompt = new Promise<any>((resolve) => { prompted = resolve })
  let pages = 0
  let points = 0
  const runtime = createStableRuntime({ session: {
    get: async () => ({ data: { id: "s" } }), messages: async () => { pages++; return { data: messages } },
    message: async ({ path }: any) => { points++; return { data: messages.find((message) => message.info.id === path.messageID) } },
    status: async () => ({ data: { s: { type: "idle" } } }), promptAsync: async (input: any) => { prompted(input) },
  } }, {}, "/fixture")
  const request = { id: "p", sessionID: "s", action: "edit", resources: ["candidate.ts"], always: [], protocol: "stable" as const }
  try {
    await collectReviewInput(runtime.context, request, 8)
    if (promoted) messages.pop()
    messages.splice(1, 0, { info: { id: "inserted", role: "user", time: { created: kind.endsWith("equal time") ? 2 : undefined }, agent: "earlier-agent" }, parts: [] })
    runtime.observe({ type: "message.updated", properties: { info: { id: "inserted", sessionID: "s" } } })
    const input = await collectReviewInput(runtime.context, request, 8)
    runtime.context.resumeAfterDenial?.("s", "Use a safer alternative.")
    const { parts, ...routing } = (await prompt).body
    expect(routing).toEqual({ agent: "latest-agent" })
    expect(input.context.incomplete).toBe(false)
    expect(input.context.userMessages).toEqual(["Prepare the candidate."])
    expect(input.context.model).toEqual({ providerID: "fixture", id: "inherited" })
    expect(pages).toBe(2)
    expect(points).toBe(1)
  } finally { runtime.dispose() }
})

test("bootstraps 10,000 messages once and retains older governing human text", async () => {
  const messages = Array.from({ length: 10_000 }, (_, index) => ({
    info: { id: `msg_${index}`, role: index === 0 ? "user" : "assistant", time: { created: index } },
    parts: [{ type: "text", text: index === 0 ? "Do not deploy." : "Untrusted output" }],
  }))
  let calls = 0
  const pending: any[] = []
  const runtime = createStableRuntime({ session: {
    get: async () => ({ data: { id: "ses_root" } }),
    messages: async ({ query }: any) => {
      calls++
      const end = query.before === undefined ? messages.length : Number(query.before)
      const start = Math.max(0, end - query.limit)
      return { data: messages.slice(start, end), response: new Response(null, {
        headers: start ? { "X-Next-Cursor": String(start) } : {},
      }) }
    },
  }, permission: { list: async () => ({ data: pending }) } }, { model: "fixture/reviewer" }, "/fixture")
  const request = { id: "per_1", sessionID: "ses_root", action: "bash", resources: ["deploy"], always: [], protocol: "stable" as const }
  try {
    for (let index = 0; index < 4; index++) {
      const input = await collectReviewInput(runtime.context, request, 8)
      expect(input.context.userMessages).toEqual(["Do not deploy."])
      expect(input.context.incomplete).toBe(false)
    }
    expect(calls).toBe(50)
    expect(JSON.stringify(runtime.context.data.session.message.list("ses_root"))).not.toContain("Untrusted output")
    let finished!: () => void
    let modelCalls = 0
    const replies: string[] = []
    const stop = installReviewer(runtime.context, { client: {
      generate: async () => { modelCalls++; return { decision: "allow", reasonCode: "fixture", reason: "Offline decision." } },
      reply: async ({ reply }) => { replies.push(reply); finished(); return "replied" },
    } })
    try {
      for (let index = 0; index < 3; index++) {
        const permission = { id: `p_${index}`, sessionID: "ses_root", permission: "edit", patterns: ["candidate.ts"], always: [] }
        pending.push(permission)
        const done = new Promise<void>((resolve) => { finished = resolve })
        runtime.emit({ type: "permission.asked", properties: permission })
        await done
      }
      expect(modelCalls).toBe(3)
      expect(replies).toEqual(["once", "once", "once"])
      expect(calls).toBe(50)
    } finally { stop() }
  } finally { runtime.dispose() }
})
