---
description: "A general-purpose code-review tool for DSH agents: fan one review out to CLI agents (codex, claude, …), to other models called through DSH's own LLM service, and to read-only subagents — all driven by one config block."
kind: "plugin"
---

# dsh-review

**English** | [中文](README.zh.md)

[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![dsh plugin](https://img.shields.io/badge/dsh-plugin-4c6ef5.svg)](https://github.com/deepseek-ai/deepseek-harness)
[![dependencies: none](https://img.shields.io/badge/dependencies-none-brightgreen.svg)](#design-notes)
[![reviewers: cli · llm · subagent](https://img.shields.io/badge/reviewers-cli%20%C2%B7%20llm%20%C2%B7%20subagent-orange.svg)](#three-kinds-of-reviewer)

One tool — `review` — that hands your diff to whoever you trust to read it: a CLI coding
agent, a model reached through DSH's own provider stack, or a read-only DSH subagent. You
decide in config which reviewers exist, which models they use, and how hard they should
look. Zero runtime dependencies: only `node:` built-ins.

```mermaid
flowchart LR
    A["agent calls<br/>review({ mode, reviewers })"] --> B["collect changes<br/>(git, host-side)"]
    B --> C1["cli<br/>codex · claude · gemini · custom"]
    B --> C2["llm<br/>dsh ctx.llm → any provider"]
    B --> C3["subagent<br/>read-only DSH child"]
    C1 --> D["one merged report"]
    C2 --> D
    C3 --> D
    D --> E{"finished within<br/>waitMs?"}
    E -- yes --> F["returned inline"]
    E -- no --> G["job id → job_output"]
```

## Table of Contents

- [Why this exists](#why-this-exists)
- [Install](#install)
- [Quick start](#quick-start)
- [Three kinds of reviewer](#three-kinds-of-reviewer)
- [Review modes](#review-modes)
- [Configuration reference](#configuration-reference)
- [How one call runs](#how-one-call-runs)
- [Self-test](#self-test)
- [Design notes](#design-notes)
- [Known limitations](#known-limitations)
- [License](#license)

## Why this exists

`codex exec review` on its own is fine, but an agent running it through the `bash` tool hits
two walls:

1. **Sandbox** — codex reads and writes `~/.codex` (session logs, sqlite, PATH aliases). Under
   the DSH file sandbox that becomes `Operation not permitted` before the review even starts.
2. **Command approval** — `codex` is not on `run_command`'s auto-allow list, so every review
   stops for approval; with approval set to `never` it is simply refused.

This plugin spawns the process from the host side via `ctx.subprocess`, so neither applies.
The command line is assembled by the plugin, and the model can only choose *what to review*
and *which reviewer* — there is no room to inject extra flags.

The same argument generalizes: **any** review needs a reviewer that the calling agent cannot
easily reach. So instead of one hard-coded `codex_review`, this plugin exposes a reviewer
registry, and `review` picks from it.

Reviewing is read-only by design: no `--dangerously-bypass-approvals-and-sandbox`-style
switches are ever emitted, and codex keeps whatever sandbox and approval policy
`~/.codex/config.toml` gives it.

## Install

Clone it somewhere permanent (the profile **symlinks** to this directory — don't delete it,
don't copy it):

```sh
git clone git@github.com:yutingzhao1991/dsh-review.git ~/code/github/dsh-review
```

Then either:

- ask the agent to call `plugin_manager` → `install_bundle` with `target` set to the absolute
  clone path; or
- run `dsh plugin --profile web add ~/code/github/dsh-review` (`web` → your profile name;
  repeat per profile).

A freshly installed bundle takes effect immediately. **After editing `index.js` you must
restart the host process**: the loader uses a plain `import()`, same-path modules are cached
by ESM, and the profile's `hmr.root` is empty by default and does not watch this directory —
toggling the plugin row is not enough. Upgrades behave the same way: `git pull`, then restart.

## Quick start

```yaml
# ~/.dsh/profiles/<profile>/cordis.patch.yml
- id: review
  name: dsh-review
  config:
    agents:
      - preset: codex
        model: gpt-5.6-sol
    models:
      - provider: bainian
        model: qwen3.8-max
        label: Qwen3.8-Max
      - provider: bainian
        model: glm-5.3
    defaultMode: balanced
    modes:
      balanced:
        strength: standard
        reviewers: [ codex, qwen3.8-max ]
      deep:
        strength: deep
        reviewers: [ codex, qwen3.8-max, glm-5.3 ]
        synthesize: true        # merge the reports into one de-duplicated list
```

Then, from the agent:

```js
review()                                            // all enabled reviewers, uncommitted changes
review({ reviewers: ["codex"] })                    // just codex
review({ mode: "deep" })                            // deep strength + synthesis
review({ base: "main" })                            // working tree vs a branch
review({ commit: "abc1234" })                       // one commit
review({ instructions: "only concurrency and error handling" })
```

## Three kinds of reviewer

| Kind | How it runs | Reads the code itself? | Needs | Good for |
| --- | --- | --- | --- | --- |
| `cli` | host-side `ctx.subprocess`, argv from a template | depends on the preset (codex: yes) | the CLI installed | reusing an agent you already trust |
| `llm` | `ctx.llm.stream()` — DSH's own provider stack | no, the plugin feeds it a diff packet | a configured provider + model | a second opinion from a different model, cheaply |
| `subagent` | `ctx.subagents.start()` — a real DSH child agent | yes, it has tools | a subagent provider | a reviewer that can open files, grep, and run read-only commands |

### `cli` presets

| Preset | Executable | argv shape | Captures |
| --- | --- | --- | --- |
| `codex` | `codex` | `exec review {range} --ephemeral -m <model> --output-last-message <file> [-- <prompt>]` | report file |
| `claude` | `claude` | `--print --output-format text [--model <m>] <prompt>` | stdout |
| `gemini` | `gemini` | `-p <prompt> [-m <m>]` | stdout |
| `opencode` | `opencode` | `run [--model <m>] <prompt>` | stdout |
| `cursor` | `cursor-agent` | `--print [--model <m>] <prompt>` | stdout |
| `custom` | yours | your `command` template | `stdout` or `report` |

`codex` uses its **native** `exec review` subcommand: it walks the repo itself, so the plugin
does not feed it a diff. Every other preset gets a *diff packet* — change stat, `git status`,
the full patch, and the text of untracked new files — because it has no git awareness of its own.

Because the codex CLI refuses a `[PROMPT]` next to a range flag, **a range always wins**: when
`base`/`commit` is set, the mode's prompt is not handed to codex (and the report's footnotes
say so) instead of the scope being silently dropped.

Untracked new files count as part of the change only for the **uncommitted** scope. For
`base`/`commit` they belong to neither `git diff <base>` nor `git show <commit>`, so they are
left out of the material and the change size, with a note saying so.

A `custom` reviewer is a template plus placeholders:

```yaml
reviewers:
  - id: my-agent
    kind: cli
    preset: custom
    executable: /opt/bin/my-reviewer
    command: [ "{exe}", "--json", "{model}", "{report}", "{extra}", "{prompt}" ]
    capture: report            # read the conclusion from {report}
    promptVia: argv            # or stdin
    model: my-model
    extraArgs: [ "--strict" ]
```

| Placeholder | Expands to |
| --- | --- |
| `{exe}` | the resolved executable |
| `{range}` | `--uncommitted` / `--base <ref>` / `--commit <sha>` (empty when this preset lets the prompt replace the range) |
| `{model}` | the preset's model flag plus the model id (empty when no model) |
| `{ephemeral}` | `--ephemeral` |
| `{report}` | the path the reviewer should write its conclusion to |
| `{reportArg}` | `--output-last-message <path>` |
| `{prompt}` | the full review prompt (empty when `promptVia: stdin`) |
| `{promptArg}` | `--` followed by the prompt — the codex-native shape |
| `{extra}` | `extraArgs` |

A preset with `promptReplacesRange: true` (codex) drops the range flags once a prompt is
supplied, because that CLI refuses `[PROMPT]` together with
`--uncommitted`/`--base`/`--commit`. Every other template keeps its range flags *and* the
prompt.

### `llm` reviewers

The plugin runs git itself, builds a size-budgeted packet, and calls the model through
`ctx.llm` — the same service the agent loop uses. The model answers with text only; it needs
no tool permissions and no repo access.

```yaml
models:
  - provider: bainian           # any provider registered with dsh-llm
    model: qwen3.8-max
    label: Qwen3.8-Max
    llm:
      maxTokens: 8192
      temperature: 0
```

The stream is consumed by the plugin directly (`text-delta` chunks plus the terminal
`finish`), so no `@deepseek-ai/dsh-llm` import and no version coupling.

### `subagent` reviewers

Starts a DSH child agent through `ctx.subagents`. It receives the same review packet in its
prompt, **and** keeps its tools, so it can open files and check call sites the diff alone
does not show.

```yaml
reviewers:
  - id: deep-dive
    kind: subagent
    provider: spawn                       # the ctx.subagents provider name
    agentProvider: bainian
    agentModel: deepseek-v4.1-flash
    label: DSH subagent
    maxDepth: 1
    persona: "You are a meticulous reviewer."
    toolFilter: { ... }                   # passed through to the subagent request
```

## Review modes

A **mode** is a named bundle of: how hard to look (`strength`), what to say (`prompt`), who to
use (`reviewers`), and whether to merge the results (`synthesize`).

| Field | Type | Meaning |
| --- | --- | --- |
| `strength` | `light` \| `standard` \| `deep` | built-in framing appended to the reviewer's system prompt |
| `prompt` | string | your own review instructions for this mode (also reaches codex as its `PROMPT`) |
| `reviewers` | string[] | overrides the reviewer set for this mode |
| `synthesize` | boolean | after the reviewers finish, ask one `llm` reviewer to merge their findings |
| `synthesizeReviewer` | string | which `llm` reviewer does the merging (default: the first selected one) |
| `when` | `always` \| `complex` \| `never` | review policy, used only when `injectPolicy: true` |
| `minChangedLines` | number | threshold quoted by the `complex` policy text |
| `label`, `description` | string | shown in the tool description |

### Default: no policy at all

The plugin does **not** decide when review is mandatory. With no `modes` and no `injectPolicy`,
it adds nothing to the system prompt and the tool description simply says "no modes are
configured" — you constrain the agent with your own prompt, skills, or `AGENTS.md`, whichever
you already use. That is the intended default.

If you *do* want the rule stated in the system prompt, set `injectPolicy: true` and give a
mode a `when`:

```yaml
config:
  injectPolicy: true
  defaultMode: gated
  modes:
    gated:
      when: complex              # or: always / never
      minChangedLines: 50
```

- `always` — “every change must pass through `review` before the task is called done.”
- `complex` — “concurrency, error handling, security, migrations, public interfaces, build
  config, or anything too large to describe in one commit needs review; copy edits do not.”
- `never` — explicitly optional.

This is **guidance in the system prompt, not a hard gate**: the plugin never blocks a turn.
A real gate would have to intercept tool calls, which is a different product decision.

## Configuration reference

Every key is optional; defaults live in `lib/settings.js`.

| Key | Default | Meaning |
| --- | --- | --- |
| `agents` | `[]` | shorthand list of `cli` reviewers; `id` defaults to the preset name |
| `models` | `[]` | shorthand list of `llm` reviewers; `id` defaults to the model name |
| `reviewers` | `[]` | full reviewer definitions (see below); wins over a shorthand with the same id |
| `defaultReviewers` | all enabled | reviewer ids used when the tool call does not pass `reviewers` |
| `defaultMode` | none | mode applied when the tool call does not pass `mode` |
| `modes` | `{}` | named review modes |
| `injectPolicy` | `false` | write each mode's `when` rule into the system prompt |
| `language` | `auto` | `zh` / `en` / `auto` — output language (`auto` follows `instructions`, Chinese when there is none) |
| `waitMs` | `120000` | how long the tool blocks before handing back a job id; `0` = return immediately |
| `hardTimeoutMs` | `3600000` | wall-clock ceiling for the whole review; `0` = unlimited |
| `maxResultChars` | `80000` | cap on the report returned to the model; longer reports are head/tail truncated with a path to the full file |
| `maxDiffChars` | `160000` | cap on the diff packet fed to `llm`/`subagent`/packet-based CLI reviewers |
| `maxFileDiffChars` | `40000` | per-file diff cap |
| `maxDiffFiles` | `60` | at most this many files enter the diff |
| `maxUntrackedFileChars` | `20000` | per-file cap when reading untracked new files |
| `maxArgBytes` | `98304` | single-argument byte cap for CLI reviewers that receive the prompt through `argv` (Linux allows ~128 KiB per argument; without this, a large diff fails to spawn) |
| `collectMaxBytes` | `262144` | retained bytes of reviewer stdout/stderr (diagnostics only) |
| `spillMaxBytes` | `8388608` | spill-file cap for that output |
| `envPassthrough` | `[]` | extra environment variables to forward to reviewer processes (the subprocess service scrubs `KEY`/`PASSWORD`/`SECRET`/`TOKEN`-shaped names) |

Reviewer fields — `kind` may be omitted in `reviewers` and is inferred from which keys you
used (`preset`/`executable`/`command` → `cli`, `provider` → `llm`, `subagentProvider`/
`agentModel` → `subagent`).

<details>
<summary><b>Full config example</b></summary>

```yaml
- id: review
  name: dsh-review
  config:
    language: auto
    waitMs: 180000
    maxResultChars: 60000
    defaultReviewers: [ codex, qwen ]
    defaultMode: balanced
    injectPolicy: true

    agents:
      - preset: codex
        model: gpt-5.6-sol
        timeoutMs: 1800000
      - preset: claude
        executable: /opt/homebrew/bin/claude
        extraArgs: [ "--allowedTools", "Read,Grep,Glob" ]
        enabled: false

    models:
      - provider: bainian
        model: qwen3.8-max
        label: Qwen3.8-Max
        llm: { maxTokens: 8192, temperature: 0 }
      - provider: bainian
        model: glm-5.3
        label: GLM-5.3

    reviewers:
      - id: deep-dive
        kind: subagent
        provider: spawn
        agentProvider: bainian
        agentModel: deepseek-v4.1-flash
        enabled: false

    modes:
      quick:
        label: Quick
        strength: light
        reviewers: [ qwen ]
      balanced:
        strength: standard
        reviewers: [ codex, qwen ]
        when: complex
        minChangedLines: 50
      deep:
        label: Deep
        strength: deep
        description: "every reviewer plus a merged verdict"
        reviewers: [ codex, qwen, glm-5.3 ]
        synthesize: true
        synthesizeReviewer: qwen
        when: always
```

</details>

## How one call runs

1. **Validate** — `base` / `commit` / `instructions` are mutually exclusive, ranges may not
   start with `-` (git would read them as flags), `reviewers` must be a string array.
2. **Resolve** — mode → reviewer set → working directory (`exec.agent.session.header.cwd`).
3. **Collect** — always: `git status --porcelain -z -uall` and `--numstat`. Only when a
   selected reviewer needs it: the full patch and the contents of untracked files, trimmed to
   the configured budget with an explicit note about what was omitted.
4. **Fan out** — every reviewer runs in parallel, each with its own abort controller and
   timeout. One reviewer failing never fails the others.
5. **Merge** — one report: scope header, one section per reviewer (kind, target, duration,
   failure badge, diagnostics in a `<details>` block), the optional synthesis, and footnotes
   for material notes and config warnings.
6. **Return** — the whole thing goes into a `ctx.jobs` job *and* is returned inline if it
   finishes within `waitMs`. Otherwise the tool returns the job id and the agent collects it
   with `job_output` / `job_kill`; the job registry notifies the originating session when it
   settles. `job_output` and the inline result are byte-identical because the ring holds only
   the report — never the reviewer's progress logs, which can be hundreds of kilobytes of
   dumped diff.

The tool result is a small canonical object; the UI shows it as a terminal card titled
`review(codex,qwen) --uncommitted`.

| Output field | Meaning |
| --- | --- |
| `kind` | `completed` (settled) or `running` (job id handed back) |
| `report` | the merged report text |
| `jobId` | present when `kind: running` |
| `status`, `detail` | job status and the `n/m reviewers finished` summary |
| `reviewers` | the reviewer ids that were used |

## Self-test

`selftest.mjs` drives the plugin with a fake `ctx`: no host process, no real codex, no real
model. 100+ assertions cover config normalization, all three reviewer kinds, git collection,
orchestration, synthesis, truncation, and the regressions found by this plugin's own first
real review.

```sh
node selftest.mjs
```

## Design notes

- **Zero dependencies.** Only `node:fs`, `node:os`, `node:path` and the host services. The LLM
  stream is consumed field by field instead of importing `@deepseek-ai/dsh-llm`, so a DSH
  upgrade cannot break this plugin through a peer version.
- **Bad config is loud but not fatal.** A malformed reviewer entry is dropped with a warning
  that shows up in the tool description and in the report footer; only numbers and enums fall
  back silently.
- **argv only, never a shell.** Reviewer commands are template-expanded arrays given to
  `ctx.subprocess`; `base`/`commit` are validated as revisions, not as text.
- **The diff is the material.** Feeding a diff to a model *is* granting it read access to
  those files. Keep that in mind for private repositories.

## Known limitations

- The working directory is always the **session** working directory
  (`exec.agent.session.header.cwd`); you cannot point a review at another repository.
- One call reviews one scope (uncommitted / base / commit), matching the underlying CLIs.
- `base`/`commit` and `instructions` are mutually exclusive — a codex CLI constraint applied
  to every reviewer so the parameters mean the same thing everywhere. Use a mode's `prompt`
  to attach focus to a range.
- Because codex refuses a `PROMPT` next to a range flag, a mode's prompt reaches codex only
  when no `base`/`commit` is given. The range itself is always preserved, and the report notes
  when the prompt was skipped; every other reviewer kind always receives it.
- When a report is truncated, the full text stays in `$TMPDIR/dsh-review-*/report.md` and is
  never garbage-collected. Non-truncated runs delete their temp directory.
- codex only runs inside its trusted directories (`~/.codex/config.toml` → `[projects.*]`);
  the plugin deliberately does not pass `--skip-git-repo-check`, because that trust gate is
  codex's to open, not ours.
- `when` is a system-prompt statement of policy, not an enforcement gate.

## License

[MIT](LICENSE)

---

Forked from [dsh-codex-review](https://github.com/yutingzhao1991/dsh-codex-review), which
established the host-side-subprocess + background-job pattern this plugin still uses.