# dsh-review

**English** | [中文](README.zh.md)

[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![dsh plugin](https://img.shields.io/badge/dsh-plugin-4c6ef5.svg)](https://github.com/deepseek-ai/deepseek-harness)
[![dependencies: none](https://img.shields.io/badge/dependencies-none-brightgreen.svg)](#install)

Code review as a tool, not a single vendor. Hand your diff to a CLI coding agent, to another
model you already have configured, or to a read-only agent that can open files itself — then
read one merged report.

![The configuration page](docs/images/gui-en.png)

## What it gives you

- **Three kinds of reviewer.** `codex` / `claude` / `gemini` / `opencode` / `cursor` / any CLI
  you template yourself; any model from your DSH provider config; or a DSH subagent that can
  read the repository.
- **Several reviewers, one report.** They run in parallel and their findings are merged, with
  per-reviewer sections and (optionally) a synthesis pass that de-duplicates and marks
  consensus.
- **Review modes.** Name a strength and a prompt once (`quick`, `balanced`, `deep`, …) and reuse
  it, instead of retyping review instructions every time.
- **Configured in the GUI.** Tick the reviewers you want; everything else stays collapsed under
  advanced settings.
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

## Use

```js
review()                                          // the reviewers you enabled, uncommitted changes
review({ reviewers: ["codex", "qwen"] })          // pick reviewers for this call
review({ mode: "deep" })                          // deep strength, several reviewers, synthesized
review({ base: "main" })                          // working tree vs a branch
review({ commit: "abc1234" })                     // one commit
review({ instructions: "only concurrency and error handling" })
```

Reviewing takes minutes, so the call waits a little and then hands back a job id: read the
result with `job_output`, stop it with `job_kill`, or just wait — you are notified when it
settles.

Reviewers are opt-in: if nothing is enabled, a call with no `reviewers` fails and says so
rather than quietly running everything.

## Reviewers

| Kind | What runs | Reads the code itself | Needs |
| --- | --- | --- | --- |
| `cli` | a coding agent you already trust | depends on the preset (codex reads the repo) | that CLI installed |
| `llm` | a model from your DSH provider config | no — the diff is sent to it | a configured provider + model |
| `subagent` | a DSH child agent | yes, it has tools | a subagent provider |

CLI presets: `codex`, `claude`, `gemini`, `opencode`, `cursor`, or `custom` with your own
command template.

```yaml
- id: review
  name: dsh-review
  config:
    agents:
      - preset: codex
        model: gpt-5.6-sol
    models:
      - provider: bailian          # any provider from your DSH config
        model: qwen3.8-max
```

The `llm` kind reaches models through DSH's own LLM service, so provider, key, context window
and image support all come from your DSH configuration — nothing is duplicated here. Any
registered model can also be named directly, without listing it first:

```js
review({ reviewers: ["bailian/kimi-k3"] })
```

To make a provider's models first-class reviewers (selectable in the GUI, usable in modes),
turn on discovery:

```yaml
config:
  discover:
    providers: [ bailian ]
    exclude: [ "*embedding*", "*rerank*" ]
```

## Review modes

A mode bundles how hard to look, what to say, and who to use.

| Field | Meaning |
| --- | --- |
| `strength` | `light` / `standard` / `deep` — built-in review framing |
| `prompt` | extra instructions for this mode |
| `reviewers` | which reviewers this mode uses |
| `synthesize` | merge the reviewers' findings into one de-duplicated list |
| `when` | `always` / `complex` / `never` — a review policy for the agent to follow |

```yaml
config:
  defaultMode: balanced
  modes:
    balanced:
      strength: standard
      reviewers: [ codex, qwen3.8-max ]
    deep:
      strength: deep
      reviewers: [ codex, qwen3.8-max, glm-5.3 ]
      synthesize: true
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
| `agents` / `models` / `reviewers` | `[]` | define CLI, model, and subagent reviewers |
| `modes` | `{}` | named review modes |
| `discover` | off | pull models straight from DSH instead of listing them |
| `waitMs` | `120000` | how long a call blocks before handing back a job id; `0` = return immediately |
| `hardTimeoutMs` | `0` | wall-clock ceiling; `0` = no limit — you decide when to stop it |
| `maxResultChars` | `80000` | report cap; longer reports are truncated with a path to the full file |
| `maxDiffChars` | `160000` | diff cap for reviewers that receive the diff |

## Known limitations

- Reviews always run in the **session's working directory**; you cannot point them elsewhere.
- One call reviews one scope (uncommitted / a base branch / a commit), matching the underlying
  CLIs. Naming a range and passing `instructions` at the same time is rejected — put the focus
  in a mode's `prompt` instead.
- A mode's prompt reaches codex only when no range is given (its CLI refuses both at once); the
  range is always honoured, and the report says when the prompt was skipped.
- codex only runs inside the directories it trusts (`~/.codex/config.toml`).
- Truncated reports stay in `$TMPDIR/dsh-review-*/report.md`; other runs clean up after
  themselves.

## Development

```sh
node selftest.mjs    # drives the plugin with a fake host: no DSH, no codex, no model calls
```

## License

[MIT](LICENSE)