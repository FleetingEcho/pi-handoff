# pi-handoff 设计说明

`pi-handoff` 是给 AI 编程助手准备的自动交接班系统。

AI 每次工作都会把进度、决定和下一步整理好。下次重新打开、切换会话，甚至换一个 AI，也能直接接着做，不需要用户重新解释背景。

## 它解决什么问题

普通 AI 会话经常遇到这些问题：

- 新会话不知道之前做过什么。
- 对话被压缩后容易忘记细节。
- 不同 Git branch 的工作混在一起。
- 项目经验散落在多个 branch 中。
- 用户需要反复解释测试命令、架构约定和踩过的坑。

`pi-handoff` 把重要状态保存在会话之外，让不同会话和不同 agent 都能继续使用。

## 三层记忆

| 记忆 | 范围 | 保存什么 |
|---|---|---|
| Branch handoff | 当前 Git branch | 当前目标、进度、决定、相关文件和下一步 |
| Project knowledge | 整个项目 | 架构、约定、工作流程、可复用决策和常见坑 |
| Pinned rules | 整个项目 | 绝对不能违反的规则和用户明确偏好 |

可以把它理解成一个团队：

- `handoff.md` 是每个小组自己的交接班记录。
- `project.md` 是整个团队共享的知识库。
- Pinned rules 是所有人都必须遵守的红线。

## 为什么每个 branch 单独保存

不同 branch 往往在处理完全不同的任务。例如：

- `main` 正在准备发布。
- `feature/auth` 正在开发登录。
- `fix/payment` 正在排查支付问题。

如果共用一个 handoff，任务状态很容易互相污染。因此每个 branch 都有自己的 `handoff.md`，切换 Git branch 时，插件也会自动切换到对应的 handoff。

测试命令、架构规范和部署流程等知识通常与 branch 无关，所以统一放进 `project.md`，供所有 branch 使用。

## 它是怎么工作的

正常使用时，用户不需要维护任何文件：

1. 插件记录每轮对话中真正有用的信息。
2. 内容积累到一定程度后，在后台调用模型。
3. 模型把新内容合并进当前 branch 的 `handoff.md`。
4. 下一次请求时，插件自动把 branch handoff 和 project knowledge 放入上下文。
5. 新会话可以直接从上次进度继续。

所有文件都保存在项目之外，不会污染 Git 仓库：

```text
~/.agent/agent-handoff/<project>/
├── project.md
├── project-candidates.json
├── project-meta.json
└── <branch>/
    ├── handoff.md
    ├── events.jsonl
    └── meta.json
```

## Project knowledge 如何产生

插件不会随便把某个 branch 的内容当作整个项目的事实，而是采用“提取、建议、人工确认”的流程：

1. 扫描多个 branch 的 handoff。
2. 找出可能长期有用的知识。
3. 生成 project suggestions。
4. 用户逐条 review。
5. 用户确认后才写入 `project.md`。

建议不仅能新增知识，还能替换过时知识、删除错误知识，或者撤回已经被新证据推翻但尚未 review 的建议。这可以避免知识库逐渐堆满过时或错误的信息。

## Project knowledge 和 pins 的区别

Project knowledge 是可以持续维护的普通项目知识，例如：

- 项目采用事件驱动架构。
- 测试使用 `bun test`。
- 发布前需要运行某个检查。
- 某个模块负责统一权限判断。

Pinned rules 是不能被自动摘要修改的硬规则，例如：

- 不允许修改 generated files。
- 部署必须经过指定脚本。
- Staging 数据库只能读取。
- 用户明确要求始终遵守的工作偏好。

简单来说：

> Project knowledge 是“这个项目通常怎么工作”。
>
> Pinned rules 是“无论如何都必须遵守什么”。

## 使用它有什么好处

### 不用反复交代背景

新开会话后可以直接说“继续做”。AI 已经知道当前目标、完成情况和下一步。

### 长任务不容易断档

即使任务持续很多天、经历多次上下文压缩，关键状态仍然保存在外部文件中。

### 切换 branch 不串台

每个 branch 有独立的工作记忆，同时又共享项目级经验。

### 多个 AI 可以交接

`pi-handoff` 和 `opencode-handoff` 使用相同的存储格式。一个工具生成的 handoff，另一个工具也能读取。

### 项目经验会逐渐沉淀

原本只有当前会话知道的架构判断、命令和常见问题，可以经过 review 变成整个项目长期可用的知识。

### 用户仍然掌握最终控制权

普通工作进度可以自动更新，但全项目知识不会静默写入，必须经过 review。

## 可靠性设计

`pi-handoff` 不只是让模型随便写一个 Markdown，它还处理了长期运行中的工程问题：

- 文件使用原子替换，避免写到一半损坏。
- 多进程通过短时间文件锁协调写入。
- 两个 AI 同时总结时，不会覆盖更新的版本。
- 刷新期间新产生的事件仍会留给下一批处理。
- Cursor 只会推进到真正交给模型的事件。
- JSON 损坏时会尽量恢复。
- 敏感信息会在写入和发送给模型前进行过滤。
- 所有持久化文件都有容量限制和自动清理。
- `events.jsonl` 最多保留 1,000 行或 4 MB。
- handoff 超长时按 section 压缩，不会直接把末尾的“下一步”删除。

## 日常使用

通常什么都不用做，正常工作即可。常用命令如下：

```text
/pi-handoff status
/pi-handoff flush
/pi-handoff clear
/pi-handoff project refresh
/pi-handoff project
/pi-handoff pin <硬规则>
```

| 命令 | 用途 |
|---|---|
| `status` | 查看当前 branch、待处理事件和 project suggestions |
| `flush` | 立即更新当前 branch handoff |
| `clear` | 为新任务创建一份干净的 branch handoff |
| `project refresh` | 从各 branch 提取项目知识建议 |
| `project` | Review 等待处理的建议 |
| `pin` | 保存不能被自动改写的硬规则 |

## 一句话总结

> `pi-handoff` 把 AI 编程过程中的短期任务状态、长期项目知识和不可违反的规则分层保存，让 AI 能跨会话、跨 branch、甚至跨工具持续工作，同时通过人工 review 防止错误知识自动扩散。
