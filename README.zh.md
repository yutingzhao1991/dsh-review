# dsh-review

[English](README.md) | **中文**

[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![dsh plugin](https://img.shields.io/badge/dsh-plugin-4c6ef5.svg)](https://github.com/deepseek-ai/deepseek-harness)
[![dependencies: none](https://img.shields.io/badge/dependencies-none-brightgreen.svg)](#安装)

代码评审不该绑死在一家身上。把改动交给一个 CLI 编码智能体、交给一个你已经配好的模型，
或者交给一个能自己翻文件的只读智能体——最后读一份合并好的结论。

![配置页](docs/images/gui-zh.png)

## 它能做什么

- **三种评审者。** `codex` / `claude` / `gemini` / `opencode` / `cursor`，或你自己拼命令行的
  任意 CLI；DSH provider 配置里的任意模型；或者一个能读仓库的 DSH 子智能体。
- **多个评审者，一份报告。** 并行跑，结论合并；每个评审者一节，可选再走一遍汇总去重、
  标注共识。
- **评审模式。** 强度与提示词起个名字（`quick`、`balanced`、`deep`……）配一次就能复用，
  不必每次重写评审要求。
- **在 GUI 里配置。** 勾选要用的评审者，其余都收在「高级配置」里。
- **不碰密钥、不碰端点。** provider 与凭据都留在你的 DSH 配置里，插件只用已经有的。

## 安装

clone 到一个长期保留的位置，然后装进 profile：

```sh
git clone git@github.com:yutingzhao1991/dsh-review.git ~/code/github/dsh-review
dsh plugin --profile web add ~/code/github/dsh-review     # web 换成你的 profile 名
```

也可以让智能体调 `plugin_manager` 的 `install_bundle`，`target` 传上面的绝对路径。

装完**重启宿主**。升级同理：`git pull` 之后重启。

## 怎么用

```js
review()                                          // 用你启用的评审者，评审未提交的改动
review({ reviewers: ["codex", "qwen"] })          // 这次指定评审者
review({ mode: "deep" })                          // 深度模式：多个评审者 + 汇总
review({ base: "main" })                          // 工作区相对某个分支的改动
review({ commit: "abc1234" })                     // 某个提交引入的改动
review({ instructions: "只看并发与错误处理" })
```

评审要跑几分钟，所以调用会先等一小段，然后把 job id 交回：用 `job_output` 读结论、
`job_kill` 终止，或者就等着——跑完会自动通知。

评审者是**显式启用**的：一个都没启用时，不带 `reviewers` 的调用会直接报错，而不是
悄悄把能用的都跑一遍。

## 评审者

| 类型 | 跑什么 | 自己会读代码吗 | 依赖 |
| --- | --- | --- | --- |
| `cli` | 你已经信得过的编码智能体 | 看预设（codex 会自己读仓库） | 本机装了那个 CLI |
| `llm` | DSH provider 配置里的模型 | 不会——diff 直接发给它 | 配好的 provider + 模型 |
| `subagent` | DSH 子智能体 | 会，它有工具 | 一个 subagent provider |

CLI 预设：`codex`、`claude`、`gemini`、`opencode`、`cursor`，或 `custom` 自定义命令模板。

```yaml
- id: review
  name: dsh-review
  config:
    agents:
      - preset: codex
        model: gpt-5.6-sol
    models:
      - provider: bailian          # 你 DSH 配置里的任意 provider
        model: qwen3.8-max
```

`llm` 类型走的是 DSH 自己的 LLM 服务，所以 provider、密钥、上下文窗口、是否支持图片，
全都来自你的 DSH 配置——这里不复制任何一份。任何已注册的模型还可以直接指名，不必先写进配置：

```js
review({ reviewers: ["bailian/kimi-k3"] })
```

想让某个 provider 的模型变成一等公民式的评审者（GUI 里能勾、模式里能用），打开模型发现：

```yaml
config:
  discover:
    providers: [ bailian ]
    exclude: [ "*embedding*", "*rerank*" ]
```

## 评审模式

一个模式就是一束「盯多严、额外说什么、用谁」。

| 字段 | 含义 |
| --- | --- |
| `strength` | `light` / `standard` / `deep`——内置的评审措辞 |
| `prompt` | 这个模式自己的评审指令 |
| `reviewers` | 这个模式用哪些评审者 |
| `synthesize` | 把各评审者的结论合并去重 |
| `when` | `always` / `complex` / `never`——给智能体看的评审策略 |

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

一个模式都不配时，插件不追加任何约束——你继续用自己的提示词管智能体就行。`when` 只有在同时
打开 `injectPolicy: true` 时才生效，而且它只是写进系统提示词的要求，不是强制闸门。

## 配置项

所有配置都能在 GUI 里改；下面是同一批键在 YAML 里的样子，只列值得知道的：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `defaultReviewers` | 一个都没有 | 调用没给 `reviewers` 时用哪些；空 = 不启用任何评审者 |
| `defaultMode` | 不设 | 调用没给 `mode` 时套用的模式 |
| `language` | `auto` | `zh` / `en` / `auto` 报告语言（`auto` 跟随你的指令） |
| `injectPolicy` | `false` | 把各模式的 `when` 规则写进系统提示词 |
| `agents` / `models` / `reviewers` | `[]` | 定义 CLI、模型、子智能体三类评审者 |
| `modes` | `{}` | 命名评审模式 |
| `discover` | 关闭 | 直接用 DSH 里的模型，不必逐个列出 |
| `waitMs` | `120000` | 调用阻塞多久后交回 job id；`0` = 立即交回 |
| `hardTimeoutMs` | `0` | 墙钟上限；`0` = 不限制——什么时候停由你决定 |
| `maxResultChars` | `80000` | 报告上限；超出会截断并给出完整报告路径 |
| `maxDiffChars` | `160000` | 需要 diff 的评审者能看到的变更正文上限 |

## 已知限制

- 评审始终在**会话工作目录**里跑，不能指向别的仓库。
- 一次调用只评一种范围（未提交 / 某个分支 / 某个提交），与底层 CLI 一致。范围与
  `instructions` 不能同时给——关注点请写进模式的 `prompt`。
- 模式的提示词只在没给范围时才能到达 codex（它的 CLI 不允许两者同时出现）；范围永远生效，
  提示词被跳过时报告里会写明。
- codex 只在它信任的目录里能跑（`~/.codex/config.toml`）。
- 被截断的报告留在 `$TMPDIR/dsh-review-*/report.md`；未截断的运行会自己清理。

## 开发

```sh
node selftest.mjs    # 用假宿主驱动插件：不需要 DSH、不跑 codex、不调模型
```

## License

[MIT](LICENSE)