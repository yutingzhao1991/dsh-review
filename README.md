# dsh-review

**English** | [中文](README.zh.md)

[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![dsh plugin](https://img.shields.io/badge/dsh-plugin-4c6ef5.svg)](https://github.com/deepseek-ai/deepseek-harness)
[![dependencies: none](https://img.shields.io/badge/dependencies-none-brightgreen.svg)](#install)

Code review as a tool, not a single vendor. Hand your diff to a CLI coding agent, or to a
subagent running a model from your DSH configuration — then read one merged report.

![Review status and per-round history between the conversation and the composer](docs/images/gui-en.png)

## What it gives you

- **Two kinds of reviewer, both real agents.** `codex` / `claude` / `gemini` / `opencode` /
  `cursor` / any CLI you template yourself, or a DSH subagent running a model from your DSH
  configuration.
- **Several reviewers, one report.** They run in parallel; each gets its own section, in the
  order they were selected.
- **Review modes.** Name a strength and a prompt once (`quick`, `balanced`, `deep`, …) and reuse
  it, instead of retyping review instructions every time.
- **Configured in the GUI, and saved for you.** Tick the reviewers you want; everything else
  stays collapsed under advanced settings. Edits are written about half a second after you stop
  typing — a status line at the top says where they stand, and a **Save now** button remains as a
  manual retry.
- **Review status, at a glance.** Once there is a conversation, a slim line between it and the
  composer says whether this session has reviewed, which round is running, how many rounds
  finished, and who reviewed. Expand it for each round's time, scope, and outcome. It stays
  hidden while the conversation is empty or when the current turn changed no files. The data is
  session-scoped and persists across reloads.
- **No keys, no endpoints.** Providers and credentials stay in your DSH config — this plugin
  only asks for what is already there.

## Install

Clone it somewhere permanent, then install it into a profile:

```sh
git clone git@github.com:yutingzhao1991/dsh-review.git ~/code/github/dsh-review
dsh plugin --profile web add ~/code/github/dsh-review     # web → your profile name
```

Or ask your agent to run `plugin_manager` → `install_bundle` with that absolute path.

Restart the host afterwards. Updating works the same way: `git pull`, then restart.

Requires **DSH 0.2.1 or newer**. The plugin declares this as `engines.dsh` in its manifest, so an
older host refuses to install or activate it instead of failing later inside a review.

## Use

```js
review()                                          // the reviewers you enabled, uncommitted changes
review({ reviewers: ["codex", "deep-dive"] })     // pick reviewers for this call
review({ mode: "deep" })                          // deep strength, several reviewers
review({ base: "main" })                          // working tree vs a branch
review({ commit: "abc1234" })                     // one commit
review({ instructions: "only concurrency and error handling" })
```

Reviewing takes minutes, so the call waits a little and then hands back a job id: read the
result with `job_output`, stop it with `job_kill`, or just wait — you are notified when it
settles.

Reviewers are opt-in: if nothing is enabled, a call with no `reviewers` fails and says so
rather than quietly running everything.

## Review status

A slim status line sits between the conversation and the composer, no panel required:

| State | What it shows |
| --- | --- |
| Nothing reviewed | `Review · Not reviewed yet` |
| Running | `Review · Round 2 in progress · 1m 05s` + the running reviewers |
| Finished | `Review · 3 round(s) reviewed` + reviewer chips |
| Last round failed/interrupted | `Review · Round 3 failed` / `Round 3 interrupted` |

Click the line for the last 30 finished rounds (plus any still running): round number, time,
scope (uncommitted changes / a base branch / a commit), reviewers, and outcome. The round count
is not limited by the retained history.

The data is a session projection: each `review` job writes once on registration and once on
settlement, and the value is checkpointed with the session. Switching sessions, reloading, or
restarting the host keeps the history. A round left running by a previous host process is shown
as `interrupted` instead of ticking forever.

**When it stays hidden:**

- The conversation is still empty — no messages and no first turn in flight.
- The current turn changed no files. This reuses the official
  [`@deepseek-ai/dsh-workspace-changes`](https://github.com/deepseek-ai/deepseek-harness) plugin:
  its `workspace/changes` event is normally only appended for a turn that actually changed files, so the
  status line does not run its own `git status`. It remains visible while a turn is in progress
  or a review is running, so triggering a review does not make it vanish.
- If the host does not mount `workspace-changes`, only the empty-conversation rule applies; a
  missing capability never hides the line. Subagent sessions are exempt from the no-change rule
  too, because the upstream plugin deliberately does not record them.
- It only looks at file changes made during the turn. Manual edits, or shell edits outside the
  upstream plugin's snapshot coverage, are not counted — that boundary belongs to
  `workspace-changes`, not to a second heuristic here.

## Reviewers

| Kind | What runs | Reads the code itself | Needs |
| --- | --- | --- | --- |
| `cli` | a coding agent you already trust | depends on the preset (codex reads the repo) | that CLI installed |
| `subagent` | a DSH child agent | yes, it has tools | a subagent service (default `spawn`) |

CLI presets: `codex`, `claude`, `gemini`, `opencode`, `cursor`, or `custom` with your own
command template.

**Where the CLI lives.** The plugin looks, in order, at: `executable` (a PATH name or a path) →
`~/.local/bin`, `~/.bun/bin`, `/opt/homebrew/bin`, `/usr/local/bin` → **the current profile's
dependencies** (`node_modules/.bin/<name>`, plus the package's own bin entry when the preset
declares one, e.g. `@openai/codex`'s `bin/codex.js`).

That last step is the recommended setup: install the CLI as a **direct dependency of the profile**
(`dsh plugin --profile <name> add <package>`). Do **not** keep pinning an absolute path in your
patch — that is the trap we hit locally: a dependency reinstall pruned
`node_modules/@openai/codex`, the pinned path silently went stale, and the tool description still
advertised the reviewer as usable while every call burned a full run. Absolute paths still work
(highest priority), but their lifetime is tied to the dependency graph.

When the configuration looks wrong, run the self-check instead of a real review:

```
review({ doctor: true })
```

It checks, per reviewer, whether the executable resolves, which candidate found it, whether
`--version` runs, whether the subagent provider is registered, and whether the host exposes the
`startActivation()` interface this plugin uses. It also reports whether the GUI config schema
resolved (`@deepseek-ai/schemastery`) and where it came from. It reviews nothing, starts no
reviewer, and does not need a git repository. Model connectivity for subagents is out of scope —
that would need a real request.

One thing worth knowing: a `subagent` inherits the parent session's model unless you set
`agentModel`, so it is **not** automatically a second opinion — name the model explicitly if you
want one.

Subagents get a 30-minute wall-clock ceiling by default (`timeoutMs` per reviewer; `hardTimeoutMs`
still caps the whole call). Recursion is bounded by the host's delegation-depth budget (default 1),
so a reviewer normally cannot start another subagent. Progress is reported while they run, so a
long review does not look stuck.

DSH 0.2.1 moved persona and tool restrictions out of the subagent start request: configure them in
an **Agent Preset** and select it with `agentPreset`. The old `persona` / `toolFilter` keys are
ignored with a migration warning instead of silently doing nothing.

There is deliberately no "send the diff to a bare model" kind: a reviewer that can open the
repository itself is worth more than one that only sees what it was handed.

```yaml
- id: review
  name: dsh-review
  config:
    agents:
      - preset: codex
        model: gpt-5.6-sol
      - preset: claude
    reviewers:
      - id: deep-dive
        kind: subagent
        provider: spawn             # subagent service, `spawn` by default
        agentProvider: bailian      # any provider from your DSH config
        agentModel: deepseek-v4.1-flash
```

A subagent's model comes from your DSH configuration (provider, key, context window), and the
GUI combines provider and model into one grouped picker — choosing an entry writes both
`agentProvider` and `agentModel`, and nothing is duplicated in this plugin.

`provider` is the **subagent service implementation** (default `spawn`), not the model provider.
The GUI hides it unless it is set to something other than `spawn`.

Add `agentPreset: <preset-id>` to run that reviewer under a specific Agent Preset. The preset owns
its persona and tool set; `spawn` supports an independent preset, while `fork` inherits the
parent's composition.

## Review modes

A mode bundles how hard to look, what to say, and who to use.

| Field | Meaning |
| --- | --- |
| `strength` | `light` / `standard` / `deep` — built-in review framing |
| `prompt` | extra instructions for this mode |
| `reviewers` | which reviewers this mode uses |
| `when` | `always` / `complex` / `never` — a review policy for the agent to follow |

```yaml
config:
  defaultMode: balanced
  modes:
    balanced:
      strength: standard
      reviewers: [ codex ]
    deep:
      strength: deep
      reviewers: [ codex, deep-dive ]
```

With no modes configured the plugin adds no constraints at all — you keep steering the agent
with your own prompt. `when` only takes effect if you also set `injectPolicy: true`, and it is
stated in the system prompt, not enforced as a gate.

## Configuration

Everything can be set in the GUI; these are the same knobs in YAML. Only the ones worth
knowing:

| Key | Default | Meaning |
| --- | --- | --- |
| `defaultReviewers` | none | reviewers used when a call omits `reviewers`; empty means none are enabled |
| `defaultMode` | none | mode applied when a call omits `mode` |
| `language` | `auto` | `zh` / `en` / `auto` report language (`auto` follows your instructions) |
| `injectPolicy` | `false` | state each mode's `when` rule in the system prompt |
| `agents` / `reviewers` | `[]` | define CLI and subagent reviewers (`agents` is the preset shorthand, `reviewers` the full form) |
| `modes` | `{}` | named review modes |
| `waitMs` | `0` | how long a call blocks before handing back a job id. `0` returns immediately (reviews take minutes, so waiting rarely pays) |
| `hardTimeoutMs` | `0` | wall-clock ceiling; `0` = no limit — you decide when to stop it |
| `maxResultChars` | `80000` | report cap; longer reports are truncated with a path to the full file |
| `maxDiffChars` | `160000` | diff cap for reviewers that receive the diff |

## Known limitations

- Reviews always run in the **session's working directory**; you cannot point them elsewhere.
- One call reviews one scope (uncommitted / a base branch / a commit), matching the underlying
  CLIs. `base` and `commit` are mutually exclusive. A range plus `instructions` works for
  subagents but not for the codex CLI (its range flag and PROMPT exclude each other): if every
  selected reviewer is such a CLI the call is rejected up front, otherwise the CLI ones are named
  in the report footnotes. To keep both the range and the focus, add a subagent reviewer; putting
  the focus in a mode's `prompt` does not help, since a mode prompt is skipped as well whenever a
  range is given (next bullet).
- A mode's prompt reaches codex only when no range is given (its CLI refuses both at once); the
  range is always honoured, and the report says when the prompt was skipped.
- codex only runs inside the directories it trusts (`~/.codex/config.toml`).
- An invalid `base`/`commit` fails before any reviewer starts, instead of running for minutes and
  reporting a batch that reviewed nothing.
- Report scaffolding (headings, footnotes, errors) is Chinese; `language` only controls the
  reviewers' own instructions.
- Truncated reports stay in `$TMPDIR/dsh-review-*/report.md`; other runs clean up after
  themselves.
- The reviewer list in the tool description is a **registration-time snapshot**: the host does not
  reload plugin code when the profile's dependencies change (measured: `patchReload: live` only
  reloads the patch layer), so the description can lag behind disk. Use
  `review({ doctor: true })` for the current truth. For the same reason, plugin code changes need
  a host restart.
- When a CLI's answer comes from stdout and stdout was truncated (past `collectMaxBytes`), the
  report footnote says the tail may be missing and gives the spill path. When no executable can be
  found, every candidate path and its failure reason is listed.

## Development

```sh
node selftest.mjs    # drives the plugin with a fake host: no DSH, no codex, no model calls
```

## License

[MIT](LICENSE)