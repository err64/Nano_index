---
id: verification-ladder
part: 2
title: "我们如何用五级验证阶梯让 AI 交付可复现"
date: 2026-10-07
category: 可复现性
featured: false
summary: "把「AI 改完了代码」从一句主观陈述，变成一条可重放、可对账、可审计的证据链：五级验证阶梯与四个共享地基的完整拆解。"
---
> 这是 Veriforge 实践系列的第二篇。第一篇讲的是对抗面（AI 改测试凑通过），这一篇讲建设面：如何把"AI 改完了代码"从一句主观陈述，变成一条可重放、可对账、可审计的证据链。所有机制均已实现，本文写作当天（2026-10-07）在 Windows 上实测 53 个测试文件、337 个用例全部通过。

## 一、先看不可复现的交付长什么样

一个团队接入编码 agent 之后，通常会经历三个阶段的幻灭：

**第一阶段：结果不可复现。** 同一个任务跑两次，得到两个不同的 diff。第一次全绿，第二次有一个测试挂了。没有人能回答"哪个才是对的"——因为根本没有"对"的参照物，只有两次各自为政的生成。

**第二阶段：结论不可复核。** agent 报告"任务完成，所有验收标准已满足"。reviewer 问：哪个验收标准由哪条命令证明？agent 开始复述它做过什么，但那些话既不能重放，也无法与真实运行记录对账。reviewer 最终只能自己把整套测试重跑一遍——AI 省下的时间，又在验证环节原样还了回去。

**第三阶段：失败不可归因。** 修复"完成"后某个测试挂了。是 agent 改坏了？还是这个测试在我把任务交给它之前就挂着？没人知道，因为**动手之前没有人量化过现状**。于是要么冤枉 agent（把存量失败记成回归），要么放过 agent（把回归当成存量失败）。

这三个问题指向同一个根因：**"完成"是一个没有证据支撑的断言。** 我们对可复现的定义因此非常具体，不是"跑两遍结果一样"这种玄学，而是：

> **Worker 产出的每一条结论——通过、失败、阻塞、验收——都必须能还原为一条真实运行过、结果被持久化、且可被第三方重放的命令证据。**

在 Veriforge 里，支撑这个定义的骨架是五级验证阶梯。它不是五个并行的检查工具，而是一条有严格顺序、严格触发时机、严格语义的流水线。五级的名字直接来自领域模型的一行代码：

```ts
// src/domain/verification.ts
export const VERIFICATION_RUN_KINDS =
  ["BASELINE", "FAST", "FULL", "FULL_PROTECTED", "FULL_WITH_NEW_TESTS"] as const;
```

## 二、五级阶梯总览

```
INIT → BASELINE ──► DISCOVER ──► PLAN ──► EDIT ──► FAST_VERIFY
        (L1)                                    │        │
                                                │    pass?──否──► REPAIR ──► FAST_VERIFY
                                                │        │              (预算内循环)
                                                │       是（可选 SYNTHESIZE 阶段：L5 红绿验证）
                                                ▼        ▼
                                             FULL_VERIFY ──► SELF_REVIEW ──► CompletionPolicy
                                             (L3 + L4 成对)                     │
                                                     全部失败均为 pre-existing ──┘
                                                                        READY_FOR_REVIEW
```

每一级只回答一个问题，谁也不许越权替别的级作答：

| 级 | 名字 | 触发时机 | 回答的问题 |
| --- | --- | --- | --- |
| L1 | `BASELINE` | 动第一行代码之前 | 哪些失败在我动手之前就存在？ |
| L2 | `FAST` | 每一轮编辑/修复之后 | 这一轮修改有没有把事情变得更糟？ |
| L3 | `FULL` | 仅候选版本 | 候选版本整体上是否成立？ |
| L4 | `FULL_PROTECTED` | 与 L3 成对执行 | 撤走你的测试改动，你的代码还能通过吗？ |
| L5 | `FULL_WITH_NEW_TESTS` | 有新测试时 | 为这个 bug 新写的测试，是否在旧代码上红、新代码上绿？ |

阶梯的经济学意图写在 README 第一句里："验证阶梯（不是每次都跑 full suite）"。全量套件只跑在候选版本上（L3/L4），修复循环由最快的 L2 驱动，L1 与 L2 默认共用同一组命令。**贵的东西少跑，便宜的东西多跑，每一分验证成本都花在能改变决策的时点上。**

下面逐级拆。

## 三、逐级拆解

### L1 BASELINE：先量化现状，再谈修复

Worker FSM 的第一站不是让 agent 读代码，而是建一个隔离的 git worktree，然后**在未修改的代码上把基线命令跑一遍**。产出持久化的 `BaselineSnapshot`：

```ts
type BaselineSnapshot = {
  commit: string;          // 基线 commit
  checks: VerificationResult[];  // 每条命令的真实运行结果
  dirtyFiles: string[];    // 脏文件——默认直接 BLOCKED，除非契约显式 allowDirty
  capturedAt: string;
};
```

基线命令默认取 `fastChecks`（契约里不写 `baseline` 字段就自动继承），所以"回归检测开箱即用"；显式传 `[]` 表示无基线。三个细节值得展开：

**pre-existing 归因是逐条命令、逐个失败指纹的。** 不是"基线挂了 3 个、现在也挂 3 个"这种总数对账，而是：每条失败结果按 `command + fingerprint` 与基线精确匹配（下文第四节的指纹机制）。同一个命令在基线失败、现在以**完全相同的指纹**失败 → 标注 `preExisting=true`。

**pre-existing 不等于放行。** 这是很多同类系统的第一个坑：既然失败是存量的，就当没看见。Veriforge 的 CompletionPolicy 把两者严格分开——存量失败**如实标注但照样阻止 READY**，它永远不会被误标为 worker 的回归，也永远不会被悄悄吞掉。归因影响的是"谁的责任"，不影响"能不能交付"。

**基线顺带回答了"任务是否成立"。** 一个声称"修复 bug X"的任务，如果基线（bug 所在的版本）上所有测试都是绿的，说明没有测试在观测这个 bug——这个事实会变成 `TESTS_CANNOT_DETECT_BUG` finding（第一篇详述过）。L1 在它自己的职责之外，免费提供了变异测试的判定。

### L2 FAST：修复循环的心跳

agent 每完成一轮 EDIT 或 REPAIR，先跑 fastChecks（类型检查、lint、受影响的子集测试）。它的产出不是"通过/不通过"二元值，而是决策输入：

- 失败 → 进入 REPAIR（这是数据，不是异常，见第四节）；
- 通过 → 候选晋级，进入 L5（可选）或 L3；
- **重复失败 → 强制换思路。** 这是 L2 真正的独特之处。

修复循环最经典的失败模式是空转：agent 连续五轮"修"同一个失败，每轮都改一点无关痛痒的东西，烧完预算交差。Veriforge 的对策是 ProgressDetector——一个纯确定性函数，输入是连续两轮失败验证的记录：

```ts
export function evaluateProgress(previousFailedRun, currentRun): ProgressDecision {
  // 失败计数增加 → REGRESSING（"失败数 3 -> 5"）
  // 失败计数减少 → IMPROVING
  // 计数不变且失败签名完全相同 → UNCHANGED（原地踏步）
  // 计数不变但失败不同 → UNKNOWN（横向移动）
  // 通过 → IMPROVING
}
```

失败签名的比较靠指纹集合：`runFailureSignature = 把本轮所有失败指纹排序后拼接`。签名连续相同 → `noProgressIterations` 递增；**累计 3 轮无可测量进展 → 直接 BLOCKED**，不再进入下一轮 repair。注意阈值语义：不是"重试 3 次"，而是"没有任何可测量改善的失败轮数达到 3"。agent 可以一直 IMPROVING（失败数 10 → 6 → 2 → 通过）而不被拦，但"每轮都换一种方式撞同一堵墙"会在第三轮被叫停，终态 BLOCKED 的 blockReason 里写明"连续 N 轮无可测量进展（最后失败签名 0x1a2b…）"。

这里体现的是一条设计公理：**模型不能被信任去判断自己有没有进展**。进展必须被外部测量，测量结果必须能反过来终止模型的行为。

### L3 FULL：只有候选才配跑全量

fastChecks 通过后，候选版本获得一次全量验证的机会：完整的测试套件、类型检查、一切在契约里声明为 `fullChecks` 的命令。两条特殊路由：

**全部失败均为 pre-existing → 不再空转 repair。** 如果 FULL 挂掉的那几条，指纹全部与基线吻合，说明修复循环对它们无能为力也无义务——继续 repair 只会烧钱。此时 FSM 直接带着诚实的证据进 SELF_REVIEW，CompletionPolicy 会拒绝 READY 并如实标注。不做无意义的乐观主义。

**TIMEOUT 永远是 TIMEOUT。** 每条验证命令的结果是一个四值枚举：`PASS | FAIL | TIMEOUT | ERROR`。超时被 kill 的命令**绝不会**被记成"测试失败"——它没有产生任何关于代码的结论。这个看似吹毛求疵的区分，是审计时最常救命的一个：把超时当失败，agent 就会学会"把测试跑慢"来骗过重试逻辑。

### L4 FULL_PROTECTED：旧测试对新代码的审判

这一级是第一篇的主角，从可复现的角度再看一眼：它解决的其实是**"验证结论与哪一版测试绑定"**的问题。

普通 FULL 的结论，隐含了一个前提——"测试集 = 候选工作区里现在的测试"。一旦 agent 动过测试，这个前提就漂移了，同一个命令字符串在不同 run 里测的根本不是同一个东西，复现性从根上断了。FULL_PROTECTED 把前提钉死：**在 `git restore --source=<baseCommit>` 还原后的测试集上重跑全量**，agent 新增的测试文件被移除，跑完恢复现场。`ok = protectedRun.ok && withNewTestsRun.ok`，两者缺一不可。

于是任何一条"full checks passed"的记录都有明确无歧义的语义：它要么是"基线测试集上通过"，要么是"候选测试集上通过"，要么两者各有一条记录。reviewer 不需要猜。

### L5 FULL_WITH_NEW_TESTS：新测试必须先红后绿

五级里最"贵"也最严格的一级，只在契约开启 `synthesizeRegressionTests` 时激活。agent 在 SYNTHESIZE 阶段被要求把为该任务新写的回归测试集中放到 `tests/synthesized/<taskId>/` 下，然后 harness 对每个新测试执行双世界审判：

- **RED**：把测试文件拷进一个从 `baseCommit` 新建的临时 worktree（旧代码 + 新测试）→ 必须 FAIL；
- **GREEN**：在候选工作区（新代码 + 新测试）→ 必须 PASS。

任何一侧不满足预期，产生 CRITICAL finding（`SYNTHESIZED_TEST_NOT_RED_GREEN`）。通过审判的测试，其红绿两个结果作为 `EvidenceRef`（`synthesized:<path>:RED` / `:GREEN`）写入验收证据——这条验收标准从此拥有了一个被证明"能区分新旧代码"的见证者。

这一级回答的问题是 L1-L4 都回答不了的：**你的证据本身有没有区分度？** 一个在旧代码上也能绿的新测试，和一句"我测过了"没有区别。

## 四、让阶梯成立的地基

五级阶梯是一条流水线，但流水线能不能产出可复现的结果，取决于四个共享地基。这四块比阶梯本身更值得抄。

### 4.1 地基一：唯一的命令执行通道

整个 worker 里，所有会进入 shell 的命令——契约声明的验证命令、基线捕获、保护验证、红绿合成的双跑——都经过同一个 `CommandRunner`（git 操作另有一条专门的无 shell 封装，`execFile` 直连、不经 shell 解释）。它强制五件事：

- **强制 cwd**：命令永远在隔离 worktree 里执行，没有"当前目录碰巧是哪"这种偶然性；
- **强制 timeout**：超时触发跨平台进程树终止（POSIX 杀进程组，Windows `taskkill /T /F`），结果记为 TIMEOUT——验证永远不会挂死整个 run；
- **输出捕获与截断**：stdout/stderr 全量捕获（32MB 硬上限防内存爆），持久化时按 128KB 做 head+tail 截断——日志既存得进 SQLite，又保住了开头（环境信息）和结尾（失败摘要）两个最有价值的区域；
- **AbortSignal**：用户终止、预算终止、上游超时，一路传导到进程树；
- **命令策略**：`sudo`、`rm -rf /`、`git push --force`、`curl | sh`、fork bomb 等二十类危险模式在 spawn 前拒绝。代码注释里诚实标明了边界："这是纵深防御，不是沙箱"——真正的隔离是 worktree 加进程边界，策略只是最后闸门。

另外一件事容易被忽略：**环境清洗**。spawn 时的环境变量经过 scrub，交付凭据、控制面 token 不会泄进验证进程。可复现性的另一面是"不带入偶然的特权"。

### 4.2 地基二：失败指纹——让"同一个失败"可被机器认定

整个阶梯的归因能力（pre-existing 判定、进展检测、flaky 记忆）都压在一个函数上：

```ts
export function computeFailureFingerprint(command: string, info: FailureInfo): string {
  const parts = [
    command.trim(),
    [...info.testNames].sort().join("|"),   // 从失败输出中提取的测试名，排序后拼接
    info.errorType ?? "",                    // TypeError / AssertionError / ...
    info.normalizedMessage,                  // 规范化后的错误消息
  ];
  return sha256Hex(parts.join("||"));
}
```

`normalizedMessage` 是灵魂所在。原始测试输出是指纹杀手：时间戳每次不同、耗时每次不同、内存地址每次不同、ANSI 颜色码看终端心情。规范化做了四层剥离——

```ts
const VOLATILE_PATTERNS: RegExp[] = [
  /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g,  // 时间戳
  /\b\d+(?:\.\d+)?\s?m?s\b/g,                              // 耗时 120ms / 1.5s
  /\b0x[0-9a-fA-F]+\b/g,                                   // 内存地址
  /\b[0-9a-f]{16,64}\b/g,                                  // 长十六进制（trace id 等）
];
```

——然后只保留包含 `error|fail|expect|assert|exception|not ok|timeout|traceback…` 等关键词的行，去重，上限 40 行。

还有一个反直觉的取舍：**行号不参与哈希**。失败堆栈里的 `src/cart.js:42` 在代码位移后会变成 `:47`——同一根因的两个 run 会因为行号不同而指纹不同，归因机制整个失效。所以指纹绑定的是"逻辑失败"（什么测试、什么异常、什么消息），不是"文本失败"。代价是极端情况下两个不同根因可能指纹碰撞，但我们评估后认为：漏标 pre-existing 的代价（多修一次）远小于错标（归因错误动摇整个证据链）。

指纹是"L1 判 pre-existing"和"L2 判原地踏步"的共同语言。没有它，五级阶梯就是五次彼此孤立的跑测试。

### 4.3 地基三：append-only 事件存储与哈希链证据

所有状态变化进入单个 SQLite 事件存储，三条铁律：

- **append-only**：事件只追加，永不更新。`runId ≠ taskId`，新的 run 永远拿新 id，旧 run（包括崩溃残留的未终结 run）原样保留，`inspect` 命令随时可查——崩溃不是错误状态，是被完整记录的一种历史；
- **迁移即快照**：FSM 每次状态迁移，持久化一份完整的 WorkerState JSON 快照。任何一个 run 在任何一个时刻的完整认知（基线、验证历史、findings、预算消耗）都可以被事后还原；
- **终态与证据同事务**：run 到达 READY_FOR_REVIEW 时，WorkerResult、证据清单、交付意图在**同一个 SQLite 事务**里落库。

证据清单本身是一条哈希链：

```ts
export function buildEvidenceManifest(runs: readonly VerificationRun[]): EvidenceManifest {
  let previous = "";
  for (const run of runs) {
    for (const result of run.results) {
      const digest = sha256(JSON.stringify({ previous, runId: run.id, kind: run.kind, iteration: run.iteration, result }));
      entries.push({ kind: run.kind, id: result.id, digest });
      previous = digest;   // 链式：每条摘要包含前一条
    }
  }
  return { algorithm: "sha256-chain-v1", entries, root: previous };
}
```

`sha256-chain-v1`：每条验证结果的摘要都掺入前一条的摘要，最终得到一个 root hash 与终态一起持久化。链式结构意味着**任何一条历史验证记录被事后篡改，root 就对不上**——第三方拿到事件库，可以独立重算整条链并核对 root。它不是密码学意义上的防管理员篡改（管理员可以连库一起改），但它把"悄悄改一条记录"变成了"必须重写全部历史"，配合 run 的 append-only 语义，审计成本被推到了不现实的高度。

### 4.4 地基四：错误分类学——失败也是可复现的

大多数 harness 的错误处理是一个大 catch。可复现的另一半恰恰在这里：**失败路径本身必须是确定性的**。Veriforge 把所有错误分成五类，每类有唯一确定的终态语义：

| 错误类别 | 例子 | 确定性语义 |
| --- | --- | --- |
| OperationalError | 进程 spawn 失败、runtime 调用超时 | 该次调用重试 1 次，仍失败 → FAILED |
| VerificationFailure | 测试/lint/typecheck 挂了 | **不是异常，是数据**——驱动 repair 循环 |
| PolicyViolation | 越界修改、危险命令、脏仓库 | BLOCKED（范围违规给一次 revert 机会） |
| RuntimeFailure | runtime 异常退出（非零） | FAILED，不重试 |
| BudgetExceeded | 迭代数 / 墙钟 / 花费超限 | BUDGET_EXCEEDED，**绝不偷偷多跑** |

几个细节值得点名。"VerificationFailure 是数据"意味着失败走的是和成功一样的持久化通道——每一轮失败都有指纹、有摘要、有归属，而不是一条丢失了上下文的 stderr。"绝不偷偷多跑"有一条专门的端到端测试（Case 6: *iteration budget exhausted -> BUDGET_EXCEEDED (no sneak extra rounds)*）。还有一个刁钻场景被显式处理：runtime 调用在 deadline 之后才"优雅"返回——照样算超时，"错过 deadline 的成功就是失败"。

预算的三个维度（`maxIterations`、`maxRuntimeMinutes`、`commandTimeoutSeconds`，可选 `maxCostUsd`）全部来自冻结的契约，不是环境变量里的可调旋钮。**可复现的系统不允许运行时偷改自己的规则。**

## 五、最后一公里：从证据到交付

五级阶梯跑完、CompletionPolicy 七条门禁全部满足，worker 才给出 `READY_FOR_REVIEW`。但注意这个词的措辞——**"候选待审"，不是"成功"**。项目规则（AGENTS.md）里专门有一条：*Do not treat READY_FOR_REVIEW as PR/CI success*。

从 READY 到真正的交付，还有三段可复现性工程：

**契约冻结。** 任务以强类型 CodingTaskContract 进入，Zod 校验发生在 worker 构造之前——非法契约直接 exit 2，runtime 从未被调用过一次。校验不只是类型检查，还包括防注入语义：`baseCommit` 禁止前导 `-`（防 git 参数注入）、`taskId` 受限字符集（防路径逃逸）、仓库默认必须干净（`allowDirty` 显式打开才放行——脏仓库是一切归因的天敌）。Web 控制台的需求流更进一步：需求对话确认（CONFIRMED）并编译（COMPILED）后字段锁定，启动运行只提交 `requirementId`，服务端直接取冻结契约——**客户端根本没有机会篡改任务定义**。

**交付走事务性 outbox。** READY 与"交付意图"（一条 PENDING 状态的 outbox 行）同事务落库，之后独立的 dispatcher 认领执行：推送 → 建草稿 PR → 观察 CI。幂等键是 `runId + provider`，PR 按确定性分支名（`veriforge/<taskId>-<runId>`）先查后建——进程在推送后崩溃，重启后对账会发现 PR 已经存在，而不会建出第二个。

**CI 结论绑定精确 SHA。** dispatcher 只接受与候选 `headCommit` 精确一致的 CI 结果；SHA 不匹配就保持 CI_PENDING 并留痕，绝不把"main 分支上 CI 绿了"误报成"这个候选通过了 CI"。HTTP 超时被记为 `DELIVERY_UNKNOWN`——一个专门的中间态，语义是"事实未知，先对账，不重发"，因为推送类操作的重试可能制造第二个 PR。**超时既不是失败的证明，也不是成功的证明**——这句话在验证（TIMEOUT ≠ FAIL）和交付（UNKNOWN ≠ FAILED）里说了两遍。

还有一个跨 run 的可复现性机制值得单独说：**失败记忆**。同一失败指纹如果跨 ≥3 个独立 run 反复出现，系统生成一条 flaky 隔离提案——但注意它的类型签名：

```ts
export type FlakyIsolationProposal = {
  fingerprint: string;
  runIds: string[];
  reason: string;             // "同一失败指纹跨 N 个 run 出现"
  requiresHumanApproval: true;  // 字面量类型：人工审批不可缺省
};
```

`requiresHumanApproval: true` 写进类型系统，隔离决策无法被自动化绕过。跨 run 的失败知识用来**辅助**修复（同一指纹的历史失败会进入 repair 上下文），但任何削弱验证的决策都保留在人手里。

## 六、实测

机制说得再多，最后要看真实输出。`pnpm demo` 会生成一个带真实 bug 的演示仓库（购物车税额计算漏了 20% 税），写入契约和脚本场景，然后调用真实 CLI（真实 `git worktree`、真实测试命令）。README 里记录的实测输出：

```text
Task DEMO-1
BASELINE      DONE
DISCOVER      DONE
PLAN          DONE
EDIT          DONE
FAST_VERIFY   PASS
FULL_VERIFY   PASS
SELF_REVIEW   PASS

Status: READY_FOR_REVIEW

Changed files:
  src/cart.js

Acceptance:
  AC1     VERIFIED
  AC2     VERIFIED

Workspace: .../examples/demo/.run/workspaces/DEMO-1/ws-DEMO-1-<runId>
Head commit: e3886496230457e70e108725ab989db49f76de2a   ← 候选 commit
Run id: run-20260919181936-0478d9da
```

换成 `--runtime codex` 指向同一个契约，真实 Codex CLI 在同一任务上自主定位根因并产出最小修复，同样 READY_FOR_REVIEW——Worker 逻辑零改动。这正是可复现性的外部信号：**换掉"谁在写代码"，验证阶梯和证据链的语义一个字都不用变。**

自动化侧，端到端用例直接以反模式命名：Case 3（重复相同失败 → BLOCKED，无无限循环）、Case 5（基线失败如实标注为 pre-existing，绝不误报为 worker 回归）、Case 6（预算耗尽 → BUDGET_EXCEEDED，绝不偷偷加轮）、Case 7（加 `.skip` → 检测为测试弱化，阻断 READY）。失败路径与成功路径拥有同等的测试覆盖——这是"失败也复现"在工程上的落法。

本文写作当天，我们在 Windows 上完整跑了一遍套件：53 个文件、337 个用例、29 秒，全绿。CI 上同样的套件在 Node 22 与 24 双版本验证。

## 七、几条反直觉的经验

**贵的不是验证，是"结论无法复现"之后的人肉对账。** 我们见过太多团队为了省 CI 时间砍掉全量验证，然后在每次 AI 交付后安排一小时人工复核。阶梯的全部经济学在于：全量验证每候选只跑一轮（L3/L4），修复循环由便宜的 L2 驱动，基线一次性付清归因成本。省的从来不是验证本身，是同一件事被验证第三遍。

**每一次"语义合并"都是复利负债。** 把超时记成失败、把 skip 记成通过、把 UNKNOWN 记成 FAILED、把"全绿"记成"完成"——每一个都是一两行代码的偷懒，每一个都会在几个月后的某次审计里变成事故。四值状态（PASS/FAIL/TIMEOUT/ERROR）、DELIVERY_UNKNOWN、UNVERIFIED 这些"多余"的状态，是可复现性的成本中心，也是它存在的理由。

**机器能验的绝不留给模型，模型能说的必须向机器对账。** 前半句是 CompletionPolicy 的七条门禁，后半句是 EvidenceBuilder 的 claim 对账——agent 声称"AC1 已验证"，那就去最近的验证记录里找它引用的命令：真跑过且 PASS 才升级为 VERIFIED，没跑过就降级 UNVERIFIED 并进人工审阅清单。诚实的不确定性是可复现系统的一等公民，伪确定性才是敌人。

**可复现的敌人不是随机性，是隐藏状态。** 脏仓库（默认 BLOCKED）、未清洗的环境变量、可变的运行时配置、被覆盖的历史 run——这些才是"跑两遍结果不一样"的真正来源。我们花在消灭隐藏状态上的精力，远多于花在"让结果更确定"上。

**阶梯是长出来的，不是设计出来的。** 最早的版本只有三级（BASELINE/FAST/FULL），直到我们抓到 agent 用 `it.skip` 凑通过，才有了 L4；直到我们发现"永远绿"的新测试可以充当伪证据，才有了 L5。每一级都对应一次真实的对抗。不要预先设计一个完美的验证体系，要让你上一次被骗的方式成为下一级阶梯。

## 八、结语

回到最初的问题：怎么让 AI 交付可复现？

我们的答案浓缩成一张图：五级阶梯各自回答一个不可替代的问题（现状如何 / 有没有更糟 / 整体成立吗 / 旧测试认吗 / 新测试有效吗），四个地基保证每一级的输出可持久化、可对账、可重放（唯一执行通道、失败指纹、append-only + 哈希链、错误分类学），一个确定性门禁消费全部输出并独占"完成"的裁判权，一条事务性 outbox 把结论带进交付世界而不丢失、不重复、不冒进。

而这一切的出发点朴素得近乎固执：

> 模型说的不算。跑过的不算数，算过的不作数——**能被独立重放并复核的证据，才作数。**
