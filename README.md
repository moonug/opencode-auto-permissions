# OpenCode Auto Permissions

[![release](https://img.shields.io/github/v/release/hueyexe/opencode-auto-permissions.svg)](https://github.com/hueyexe/opencode-auto-permissions/releases)
[![npm](https://img.shields.io/npm/v/opencode-auto-permissions.svg)](https://www.npmjs.com/package/opencode-auto-permissions)
[![tests](https://img.shields.io/badge/tests-440%20passing-brightgreen.svg)](./test)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue.svg)](./tsconfig.json)
[![OpenCode](https://img.shields.io/badge/OpenCode-stable%20%2B%20V2-blue.svg)](./docs/COMPATIBILITY_SPIKE.md)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

Automatic, context-aware permission review for OpenCode. Let routine work run normally, send riskier actions to a reviewer model, and keep coding agents moving while you are away.

The plugin supports stable and V2 OpenCode permission protocols automatically. Every approved request receives a native `once` reply; it never issues native `always` grants.

## Install

Install the published npm package globally with OpenCode's built-in plugin installer:

```bash
opencode plugin add opencode-auto-permissions
```

Older stable builds use `opencode plugin -g opencode-auto-permissions` instead.

That is the complete plugin installation. You do not need to clone this repository, install Bun, run `npm install`, choose a reviewer model, or edit plugin entries manually.

OpenCode downloads the package, detects its separate server and TUI targets, and registers `opencode-auto-permissions` in your global plugin configuration (`~/.config/opencode/opencode.json` on current builds; older V2 betas also added a TUI entry to `~/.config/opencode/cli.json`).

Quit and restart OpenCode after installation because configuration is loaded at startup. Auto Permissions automatically uses the model and variant selected by the session that requested the action. It also detects whether the server or TUI integration owns permission review, so only one reviewer handles each request.

## Configure Permissions

The recommended setup is not to set every permission to `ask`. Allow routine work in OpenCode, then use `ask` for operations where context matters. Only `ask` requests reach Auto Permissions. For example, add risk-based rules to `~/.config/opencode/opencode.json`:

```json
{
  "permission": {
    "bash": {
      "*": "allow",
      "rm *": "ask",
      "sudo *": "ask",
      "git push *": "ask",
      "git reset --hard*": "ask",
      "git clean -f*": "ask",
      "curl * | *sh*": "ask",
      "wget * | *sh*": "ask"
    },
    "external_directory": "ask",
    "webfetch": "allow",
    "websearch": "allow"
  }
}
```

OpenCode uses the last matching permission rule, so keep the broad `"*": "allow"` rule first and the narrower `ask` rules after it. Adapt the list to your environment: deployments, infrastructure commands, package publication, and production database tools are good candidates for contextual review.

To confirm installation, restart OpenCode and inspect both global files for the package entry. Actions resolved by `allow` or `deny` rules will not invoke the plugin; use an `ask` rule to exercise automatic review.

## Update

Update the package plugin to the latest published version:

```bash
opencode plugin update opencode-auto-permissions
```

If your configuration entry pins a version (for example `opencode-auto-permissions@0.2.10`), remove the pin or repoint it first; the updater treats a satisfied version pin as current. Older stable builds use `opencode plugin -g --force opencode-auto-permissions@latest` instead.

Restart OpenCode after updating. If you use an advanced options tuple, confirm that the server and TUI entries still contain the same options after the update.

## Uninstall

Remove `opencode-auto-permissions` with `opencode plugin remove opencode-auto-permissions`, or remove its entry from the plugin array in `~/.config/opencode/opencode.json` (and from `~/.config/opencode/cli.json` on older V2 betas), then restart OpenCode.

Remove only this package's entries; leave other plugins and configuration unchanged.

## How It Works

For each supported permission request, Auto Permissions combines deterministic safety rules with an isolated, one-step reviewer model:

- OpenCode handles `allow` and `deny` rules before the plugin; Auto Permissions reviews requests configured as `ask`.
- Matching explicit prohibitions in the latest direct human text and clearly catastrophic root/home deletion are rejected without model review. Question selections require their framing to determine whether a restriction is being retained or lifted; a selected label alone is not an unconditional prohibition.
- Contextual risks such as `sudo`, scoped deletion, force push, deployment, credential access, and external-directory access are judged against the user's request and target scope.
- External-directory boundaries are not treated as sensitive by default: ordinary project, tool, cache, log, state, temporary, and worktree paths are approved unless the target or operation presents a concrete hazard.
- Broad boundary globs such as `/tmp/*` are not treated as the requested scope when the tool input identifies a precise target; the reviewer evaluates the actual operation and latest user request.
- The reviewer is tuned for unattended agents: it defaults to approval when an action reasonably serves the task and uses `ask` only as a last resort.
- If a dedicated reviewer model times out, errors, or returns an invalid decision, the plugin tries the requesting session's model once, preserving that session model's variant. It does not retry the same provider/model, and a valid denial never triggers fallback. If no fallback is available or both attempts fail, the request is rejected automatically and the main agent receives guidance to continue with a narrower or lower-risk step.
- Reviewer sessions are hidden, have no tools, and deny all permissions.
- Bounded recent windows of complete human input are sent for review. Root human text is retained independently of question traffic, while root messages and validated completed built-in `question` answers also appear as chronological interactions with distinct provenance. Selected answers are human input; question wording and options are assistant framing, not independent authorization. Arbitrary tool output never supplies human approval.
- Task prompts from the requesting session and its non-root ancestors are included separately as delegation scope, not as newer human instructions. They cannot override root human boundaries. Question answers throughout the ancestry chain are ordered by completion time against root human message timestamps. Missing or cyclic ancestry, timestamps that prevent placement, or question-completion ties affecting retained-window membership or ordering cause rejection; historical ties wholly outside that window and ordered root text with equal timestamps do not poison a clean window. A completed question with malformed or unreconstructable structured answers makes context incomplete rather than silently disappearing.
- Delegation scope disables deterministic routine-command and own-diagnostics approvals, so a broad root task cannot silently bypass a narrower child assignment. The contextual reviewer can approve or deny within the actual task boundaries; delegation is not promoted to an unconditional human prohibition. Explicit root prohibitions, incomplete-context rejection, and catastrophic-delete checks remain deterministic.
- Each retained text interaction is preserved in full up to 16,000 characters. A question interaction's framing and answers together have the same bound (measured as JSON); delegation text is bounded too. The aggregate encoded human/delegation context has a 64,000-character budget. Oversized context is rejected as incomplete, never silently truncated. These bounds do not limit arbitrary request or tool-input size.
- The stable adapter bootstraps each session's in-memory human-context index once, paging backward in batches of 200 messages. This page size is not a session-length limit: older governing instructions and late-completing questions are collected too. Cold loading has a separate 30-second deadline and a 10,000-page limit; invalid or unproven pagination, cancellation, and exhausted budgets reject the request rather than authorize partial context.
- Warm permission checks and their pre-reply validation reuse that index without rescanning history. Delivered message changes mark affected IDs for authoritative point reads; failed or racing refreshes cannot reuse old authorization. Source input is revision-validated across collection even when another request has already refreshed the index. Unrelated assistant messages do not force reconstruction solely for matching creation timestamps. The cache retains compact user/question and routing metadata, not attachments, arbitrary assistant text or tool output, with at most 128 least-recently-used sessions and a 64 MiB retained-history budget per plugin runtime. At most 128 distinct cold loads may be pending; excess loads reject without cancelling admitted work. These limits do not bound total process memory or arbitrary tool input.
- Relevant deletions, ancestry changes, reset/reconnect events, and eviction invalidate cached history; the next check pays the cold cost again. A replacement that removes or retimes a retained interaction or routing boundary, or repairs historical integrity metadata, also requires reconstruction when the compact window cannot prove completeness. Undated text keeps authoritative history order; insertions whose placement cannot be proven also reconstruct instead of guessing a timestamp. Ordinary updates that preserve its boundaries still use point reads. Restart loses the index too. Local revisions validate delivered in-process changes, not arbitrary silent host event loss: the legacy hook supplies no server revision or replay cursor, and the index is not an atomic transaction.
- Context is collected again after review and before the native reply. Resolved ancestry is rechecked across awaited collection even if another request has rebuilt invalidated history. If the operation or authorization context changed while review was in flight, the previous decision cannot approve it. This is a fail-closed snapshot check, not an atomic runtime transaction.
- Plugin-authored denial continuations are excluded from that context so an earlier verdict cannot become a self-reinforcing human instruction.

The reviewer never receives authority to execute the requested action. It resolves each request by approving once or rejecting with an actionable reason, and may permit guarded plugin-local reuse for narrow matching requests with unchanged context. Reusable approvals are held in the plugin's memory and do not persist to later plugin instances or sessions.

Reviewer sessions are standalone and deleted after each decision or failure. Startup never deletes reviewer sessions because multiple OpenCode processes may be reviewing permissions concurrently; one process must not delete another process's active review.

Auto Permissions never asks the user to resolve a permission prompt. When the reviewer cannot safely approve, it denies and tells the coding agent why, what safer alternative to try, and to continue autonomously where possible.

Denial and failure continuations preserve the latest user prompt's agent, model, and variant, including attachment-only prompts. This routing metadata is retained separately from the latest model-bearing turn used for reviewer inheritance and fallback; filtered text and attachments do not become human authorization. A permission decision does not reset the primary agent's reasoning effort.

### Session Approvals

For repeatable low-risk operations, the reviewer may choose `allow_session`. Only that explicit decision can enter the plugin's in-memory cache; ordinary `allow` decisions remain one-time. A compact fingerprint binds reuse to the requesting session, exact action, resources, tool input, supplied session patterns, and review context. The cache holds at most 128 approvals and evicts the oldest when full; it does not retain conversation text in obsolete keys. Every approved request still receives `once`, never `always`, so later `ask` requests continue to reach context collection and deterministic policy before any plugin-local reuse. It never invents or broadens a permission pattern.

Static `allow` rules and pre-existing native grants remain runtime-owned and may prevent a request from reaching the plugin. Auto Permissions does not revoke grants made by another plugin, an earlier version, or a manual approval; it prevents its own new approvals from creating that bypass.

Code-side guardrails disable reuse when patterns are missing or broad, or when the action involves edits, external-directory boundaries, shell composition or redirection, arbitrary mutating commands, `sudo`, deletion, push, publish, deploy, credentials, destructive Git, or other non-repeatable effects. Completed question answers also require contextual review instead of routine-command or session-approval shortcuts; any approval stays one-time. Direct-text prohibitions, incomplete-context rejection, and catastrophic-delete checks still apply before the model. Eligible examples without question or delegation context include narrow reads/searches and commands such as a specific `git fetch` or test invocation with identical input. Set `sessionApprovals: false` to disable plugin-local reuse entirely.

When an action is rejected, Auto Permissions returns the reason to the main agent and asks it to continue with a safer alternative when possible. For example, it can target a generated subdirectory instead of a broad recursive delete, use `--force-with-lease` instead of an unrestricted force push, or inspect a deployment plan before applying it. A denial should redirect useful work rather than end the session.

## Choosing Rules

Use OpenCode's three permission outcomes deliberately:

| Rule | Use it for | Plugin behavior |
| --- | --- | --- |
| `allow` | Routine, expected work that should never wait | OpenCode runs it immediately; the reviewer is not called. |
| `ask` | Risk depends on user intent, target, or scope | Auto Permissions reviews context and replies once. |
| `deny` | Actions that must never run in your environment | OpenCode blocks it immediately; the reviewer cannot override it. |

For unattended multi-agent work, prefer `allow` for ordinary reads, edits, tests, builds, and source-control inspection. Prefer `ask` over `deny` for commands that can be legitimate in the right context. Reserve `deny` for firm organizational or personal boundaries.

Avoid an all-`ask` configuration unless you are evaluating the plugin in `shadow` mode. It adds model latency to every tool call and makes reviewer outages affect routine work.

## Configuration

The plugin tuple accepts these options:

| Option | Default | Description |
| --- | --- | --- |
| `model` | Requesting session model | Optional dedicated reviewer model in `provider/model` form. |
| `variant` | Selected model's default | Optional reviewer-only model variant. Use `"low"` when supported for faster decisions. |
| `sessionApprovals` | `true` | Enable guarded plugin-local reuse of explicit `allow_session` decisions with identical operations and context. Set `false` to disable reuse; native approvals are always `once`. |
| `timeoutMs` | `30000` | Per-model timeout from 100 to 30,000 milliseconds. A fallback gets its own budget, so two model attempts can take up to 60 seconds at the default (plus context/reply overhead). |
| `userMessageCount` | `8` | Window size from 1 to 20 for recent human interactions (root text and completed question answers); root text and delegation each have an independent window of the same size. |
| `shadow` | `false` | Evaluate and record decisions without replying to permission requests. |
| `runtime` | `"auto"` | Diagnostics override: `"auto"`, `"stable"`, or `"v2"`. Leave this on `"auto"` in normal use. |
| `debug` | `false` | Write the latest 100 privacy-minimized outcomes to a JSONL file. Use `true` for the default path or provide a file path. |

Start with `shadow: true` if you want to observe behavior before enabling automatic replies. Because options are an advanced manual configuration, edit both generated entries so the server and TUI receive identical settings.

No configuration tuple is required. To override the automatic session-model selection with a dedicated reviewer model, or to use other advanced options, replace the package string in both generated plugin entries with the same options tuple:

```json
[
  "opencode-auto-permissions",
  { "model": "cloudflare-workers-ai/@cf/deepseek-ai/deepseek-v4-flash-0731", "variant": "none" }
]
```

Keep the entries in `~/.config/opencode/opencode.json` and, on older V2 betas that use it, `~/.config/opencode/cli.json` synchronized. A fast, reliable model that follows JSON instructions works best; deep reasoning adds unnecessary latency for permission review. Restart OpenCode after changing either file.

With `debug: true`, diagnostics are written to `$XDG_STATE_HOME/opencode/auto-permissions/decisions.jsonl` (normally `~/.local/state/opencode/auto-permissions/decisions.jsonl`). Records include action type, timing, verdict, reason, reply result, and failure category. Commands, paths, tool inputs, and conversation text are not logged.

Access to Auto Permissions' recognized bounded diagnostics location is deterministically allowed only with complete human context, no completed question or delegation scope requiring interpretation, and no matching explicit human prohibition. Incomplete context is rejected; question-answer or delegation context goes through contextual review. Other diagnostic locations are not covered by this exception.

Reviewer sessions are standalone rather than children of the active coding session. This keeps reviewer model and variant state isolated from the main agent and its displayed reasoning level.

Concurrent requests share one model review only when their request and context agree, including human input and delegation. Once a narrow, non-sensitive operation receives explicit `allow_session`, an identical operation in the same requesting session with unchanged context can reuse the plugin-local approval without another model call. Each request is still collected and checked by deterministic policy first, and context is revalidated before replying. Changed human context makes the old approval ineligible; incomplete context is rejected before any cached approval. Destructive operations, pushes, publishing, deployments, credential access, broad wildcard patterns, and requests with question-answer context remain one-time decisions.

The plugin does not force a universal reasoning level because variant names differ by provider. Omitting `variant` uses the selected model's variant. Avoid high or maximum reasoning for permission review unless your policy requires unusually complex analysis.

## Compatibility

The compatibility baseline was acceptance-tested in the real TUI with:

- OpenCode stable `1.18.12`
- OpenCode V2 `0.0.0-beta-202608110357`

Newer V2 builds (September 2026 and later) renamed the permission event payloads (`permission.v2.asked` back to `permission.asked`, and the reusable-pattern field from `always` to `save`); the plugin accepts both shapes. The runtime protocol is detected automatically; stable permission events are handled by the server adapter and V2 events by the TUI adapter. See the [compatibility notes](docs/COMPATIBILITY_SPIKE.md) for implementation evidence and known protocol differences.

## Development

This section is only for contributors. Users installing through `opencode plugin` do not need Bun or a repository checkout.

Development requires [Bun](https://bun.sh/) and Node.js 22 or later:

```bash
bun install
bun run verify
```

`verify` runs strict TypeScript checks, the test suite, a production build, and package export smoke tests. Isolated runtime launchers are also available:

```bash
bun run test:stable
bun run test:v2
```

The launchers leave normal OpenCode configuration and session data untouched. See [Testing](docs/TESTING.md) for setup and acceptance scenarios.

Contributions go through pull requests with prefixed branches. See [Contributing](CONTRIBUTING.md).

## License

[MIT](LICENSE)
