---
id: circuit-breaker
part: 3
title: "同因失败 3 次就熔断，省下 42% 预算"
date: 2026-10-07
category: 成本治理
featured: false
summary: "agent 不会喊停：同一失败签名连续 3 轮无可测量进展即熔断。失败指纹的数学化、三段式处置、42% 的账，以及它诚实的边界。"
---
> 这是 Veriforge 实践系列的第三篇。第一篇讲防作弊（AI 改测试凑通过），第二篇讲可复现（五级验证阶梯），这一篇讲一个更现实的问题：**钱**。当一个编码 agent 在原地打转时，谁有权喊停？

## 一、agent 不会喊停

先看一次真实的失败运行（数字细节已做脱敏，形状是真实的）。

一个"修复并发重复下单"的任务交给 agent，`maxIterations = 6`。第 1 轮 repair，它给订单服务加了检查，测试还挂着同样 2 个失败。第 2 轮，它把检查换成了数据库唯一索引，还是那 2 个失败。第 3 轮，它给 webhook 加了幂等表——注意，思路确实在换，但每次都没换到点子上，测试输出里的失败签名一模一样。第 4、5、6 轮继续。最终 `BUDGET_EXCEEDED`，一无所获。

这笔账单上每一行都是真实的成本：每一轮 REPAIR 是一次带着完整失败上下文的模型调用——这类调用恰恰是整个流程里最贵的，因为它要携带失败摘要、当前 diff、历史尝试记录；每一轮之间还夹着一次 FAST 验证，挂着 CI 的墙钟。六轮下来，真金白银的模型费和五十多分钟墙钟全部沉没，**产出的预期收益为零**。

问题不在模型不够聪明——换个更强的模型，它可能第 2 轮就解出来，也可能第 4 轮才解出来，你永远不知道。问题在于一个结构性的真空：**这个系统里没有任何一方有立场、有依据、有权限喊停**。

- 模型不会喊。它对"这轮修复有没有实质进展"的判断是乐观的——每一次生成都感觉接近成功，何况它根本看不到账单。
- 人不该喊。让人盯着每次运行、在第 3 轮失败时人肉判断"要不要杀掉"，等于把自动化省下的人力又还了回去。
- 预算上限不会及时喊。`maxIterations` 是最后防线，但它是定时器，不是熔断器——下文详述。

Veriforge 的答案是一个确定性熔断器：**同一失败签名连续 3 轮无可测量进展，立即终止，不再进入下一轮修复。** 这篇文章讲它的机制、它的账，和它诚实的边界。

## 二、迭代上限是定时器，不是熔断器

一个常见的误解是：预算上限本身就是熔断。不是。`maxIterations` 回答的问题是"最多允许几轮"，而熔断器要回答的问题是"**还有没有理由继续**"。这是两个正交的问题，混在一起会两头都错：

**卡死的任务烧满预算。** 上面的例子就是：6 轮全部花在一个签名完全相同的失败上。上限在第 6 轮才生效，前 3 轮的沉没成本里没有一分钱花在改变结果的可能性上。

**有进展的任务被一刀切。** 反过来，如果一个任务每轮都在真实改善——失败数 10 → 7 → 4 → 2 → 通过——你不会想在任何一轮掐掉它。一刀切的定时器只能选择一个对所有任务都错的数字。

熔断器的本质区别在于它**感知故障的特征**，而不只是故障的次数。电力系统的熔断器不看"今天用电多久"，看电流是否异常；修复循环的熔断器不看"修了几轮"，看**失败是否在实质上原地踏步**。我们的端到端测试里专门有一条以这个性质命名——"Case 3: repeated identical failure -> BLOCKED with **bounded runtime calls (no infinite loop)**"：卡死必须被拦截，且运行时调用次数必须有界。

要实现"感知特征"，第一个前提是把"同一个失败"变成机器可比对的数学对象。

## 三、"同因"的数学化：失败指纹

"同因失败"在人类嘴里是一个模糊判断，在熔断器里必须是一个精确谓词。Veriforge 的定义分两层。

**第一层：单条失败的指纹。** 每条失败的验证命令产出四元组——命令本身、从输出中提取的失败测试名集合（排序后拼接）、错误类型（`TypeError`、`AssertionError`……）、规范化后的错误消息——对四元组做 sha256：

```ts
export function computeFailureFingerprint(command: string, info: FailureInfo): string {
  const parts = [
    command.trim(),
    [...info.testNames].sort().join("|"),
    info.errorType ?? "",
    info.normalizedMessage,
  ];
  return sha256Hex(parts.join("||"));
}
```

`normalizedMessage` 是整个机制的命门。原始测试输出是不可哈希的：时间戳每秒不同，耗时毫秒级抖动，内存地址每次分配都变，ANSI 颜色码看终端心情。规范化干四件事：剥离五类易变模式（时间戳 / 耗时 / 内存地址 / 长十六进制 / ANSI 残留）、只保留含 `error|fail|expect|assert|exception|not ok|timeout|traceback…` 关键词的行、去重、40 行封顶。

还有一个刻意的取舍：**行号不参与哈希**。`src/cart.js:42` 的失败在代码位移后会变成 `:47`——同一根因的两个 run 会因为行号不同而得到不同指纹，熔断器将永不跳闸。指纹绑定的是逻辑失败（哪个测试、什么异常、什么消息），不是文本失败。

**第二层：整轮验证的签名。** 一轮 FAST 验证可能挂多条命令、每条命令可能报多个失败。整轮的签名定义为：把本轮所有失败指纹收集起来、排序、拼接：

```ts
export function runFailureSignature(run: VerificationRun): string {
  const parts = [...fingerprintSet(run)].sort();
  return parts.length === 0 ? "" : parts.join("|");
}
```

为什么要整轮签名而不是只比失败条数？因为"2 个失败"和"2 个失败"可能根本不是同一堵墙——上一轮挂的是超时和断言，这一轮挂的是另外两个断言，条数没变，问题换了。签名同时编码了**哪些失败**和**失败集合的恒定性**，排序保证了与出现顺序无关。

指纹的质量决定熔断器的精度上限，这是一对必须直面的两难：归一化太弱（比如直接哈希原始输出），时间戳和行号会让同因失败每次都"不同"，熔断器永不动作；归一化太强（比如只比错误类型），两个不同根因会被压成同一个指纹，熔断器会误杀。40 行封顶加关键词过滤是我们在"丢掉噪声"和"保留根因特征"之间反复调整后落下的位置。

## 四、进展的四种状态：模型无权自评

有了签名，"有没有进展"就变成一个可以纯确定性回答的问题。`progress-detector.ts` 全文核心只有一个函数：

```ts
export function evaluateProgress(previousFailedRun, currentRun): ProgressDecision {
  if (currentRun.ok) return { progress: "IMPROVING", reason: "verification run passed" };

  const currentFailures = failedResults(currentRun).length;
  if (!previousFailedRun) return { progress: "UNKNOWN", reason: "first observed failure for this candidate line" };

  const previousFailures = failedResults(previousFailedRun).length;
  const sameSignature =
    runFailureSignature(currentRun) !== "" &&
    runFailureSignature(currentRun) === runFailureSignature(previousFailedRun);

  if (currentFailures > previousFailures) return { progress: "REGRESSING", ... };
  if (currentFailures < previousFailures) return { progress: "IMPROVING", ... };
  if (sameSignature)             return { progress: "UNCHANGED", ... };
  return { progress: "UNKNOWN", ... };  // 数量相同但失败不同：横向移动
}
```

四种状态的语义值得逐个咂摸：

- **IMPROVING**：通过，或失败数下降。哪怕只少了一个失败，也算——量变值得继续投入。
- **REGRESSING**：失败数上升。改坏了。
- **UNCHANGED**：失败数不变**且签名完全相同**。这是熔断器的信号态：不仅没有变好，连失败的"内容"都一模一样——这一轮和上一轮在验证器眼里是不可区分的两次世界状态。
- **UNKNOWN**：失败数相同但失败不同。在横跳，既没变好也没变坏，但也谈不上原地踏步——给它在置信区间外留的位置。

两条设计公理藏在其中。**其一，判定只消费验证记录，不消费模型的任何自述。** agent 在 repair 输出里说"这轮我找到了真正的根因"——熔断器对此没有耳朵，它只看下一轮验证的签名。**其二，状态必须能反过来终止模型的行为**（下一节），否则判定只是仪式。

## 五、三段式处置：轻推、观察、熔断

检测到"原地踏步"之后怎么办？Veriforge 不是一刀切，而是一个三段式的梯度，全部由 harness 代码拥有，模型只接收结果。

**第一段：轻推（同签名第 2 次）。** 同一签名连续出现 2 次时，系统还不动手，但会把一个明确的信号写进下一轮 REPAIR 的运行时上下文：

```ts
// context-builder.ts —— 注入 RuntimeContext 的字段
latestFailures,        // 最新失败的命令、指纹、输出摘录、pre-existing 标注
repeatedFailure: state.progress.repeatedFailureCount >= 2,
noProgressIterations: state.progress.noProgressIterations,
knownFailureMemory,    // 跨 run 的失败记忆：同一指纹过去在哪些 run 出现过
```

`repeatedFailure: true` 翻译成人话就是："你上一轮的假设错了，换一个。"同时注入的还有最近 3 次尝试的摘要（`attemptSummaries.slice(-3)`）——让 agent 看见自己走过的弯路，而不是只在同一个坑附近打转。这一段是给模型的机会，成本几乎为零。

**第二段：观察。** 轻推之后再给一轮。如果 agent 换了假设，签名会变（UNCHANGED 打断，计数归零）；如果它没换，签名第三次原样出现。

**第三段：熔断。** `UNCHANGED` 累计到 3，`decideRepair` 直接转向 BLOCKED：

```ts
// worker.ts
const NO_PROGRESS_BLOCK_THRESHOLD = 3;

if (this.state.progress.noProgressIterations >= NO_PROGRESS_BLOCK_THRESHOLD) {
  const reason =
    `no measurable progress for ${this.state.progress.noProgressIterations} consecutive failed verification runs ` +
    `(last failure signature ${this.state.progress.previousFailureFingerprint?.slice(0, 16) ?? "n/a"})`;
  this.state.blockReason = reason;
  this.state.pendingUnresolved.push({ type: "NO_PROGRESS", description: reason });
  await this.transitionTo("BLOCKED", `${fromPhase} FAIL -> BLOCKED (no progress)`);
  return;
}
```

三个实现细节都是有意为之。**其一，熔断结论自带证据指针**：blockReason 里带失败签名的前 16 位十六进制，拿着它去事件库一查，就能看到这三次失败每一次的完整命令、输出摘录和指纹——熔断不是黑箱判决，是可以重放的裁定。**其二，检查顺序在预算检查之前**：先判"没进展"再判"没预算"，所以卡死的任务终态是 BLOCKED 而不是 BUDGET_EXCEEDED。这两个终态在人工收件箱里的语义完全不同——BLOCKED 的意思是"这个任务值得一个人看一眼，它卡住了，证据在这里"；BUDGET_EXCEEDED 的意思只是"钱花完了"。让卡死的任务披着"超预算"的外衣沉底，是最可惜的一种浪费：明明已经有了完整的诊断材料，却没有人去看它。**其三，`NO_PROGRESS` 同时作为 WARNING 级 finding 和 unresolved 项留痕**，进入最终 WorkerResult。

**为什么是 3，不是 2 或 5？** 论证是一个简单的期望收益计算：当签名完全相同时，第 N 轮的初始信息状态与第 N−1 轮几乎一致（仅多了一句"你已经失败过一次"），其期望产出约等于上一轮——上一轮的产出是零。边际期望收益为零、成本恒正的行动，多执行一轮都是纯亏损。但第 2 次与第 1 次之间有一个例外：第 2 次失败时 agent 还没收到"你在重复"的信号，它的循环可能只是缺一面镜子。所以 2 次触发轻推、3 次熔断，把"给机会"压缩到恰好一次。至于 5——每一次额外的等待都是在为"也许下轮就好"支付确定性成本，而这句话在签名相同时没有任何信息含量。

## 六、省下 42% 的账

现在兑现标题。先说清楚口径：下面是一次**算例**（仓库自己的商业方案文档同款惯例——数字是算例，不是实测基准），但成本结构来自 Veriforge 真实记录的分阶段用量遥测（`WorkerResult.usage.byPhase` 按阶段记 token 与费用），任何人拿自己的数据两行脚本就能算出自己的版本。

**成本模型。** 一次运行的成本 = 前情固定成本 F + 每轮修复成本 R × 轮数：

- **F（前情）**：BASELINE（基线命令执行，无模型费但占墙钟）+ DISCOVER + PLAN + 首次 EDIT；
- **R（每轮）**：一次 REPAIR 调用 + 一次 FAST 验证。注意 R 往往**贵过** F 里的任何单项——REPAIR 是全流程携带上下文最重的调用（失败摘要 + 当前 diff + 尝试历史 + 失败记忆全部注入）。

**算例参数**（`maxIterations = 6`，与示例契约一致）：

| 项 | 模型费 | 墙钟 |
| --- | --- | --- |
| 前情 F（DISCOVER 0.9 + PLAN 0.6 + EDIT 1.0；墙钟 2+1+3+基线 4） | ¥2.5 | 10 min |
| 每轮 R（REPAIR 2.2；墙钟 3+FAST 套件 4） | ¥2.2 | 7 min |

**两条命运的分岔**：

| | 无熔断（烧穿） | 有熔断（3 轮 BLOCKED） |
| --- | --- | --- |
| 模型费 | 2.5 + 6×2.2 = **¥15.7** | 2.5 + 3×2.2 = **¥9.1** |
| 墙钟 | 10 + 6×7 = **52 min** | 10 + 3×7 = **31 min** |
| 迭代预算 | 6 轮 | 3 轮 |

节省：模型费 **42%**（6.6 / 15.7），墙钟 40%，迭代预算 50%。标题取的是模型费那一项。

**这个数字的敏感性边界**值得摆出来，免得读者拿去当普适常数。一般化公式：`节省 = (N−T)·R / (F + N·R)`，其中 N 是迭代上限、T 是熔断阈值。两个极限：当 R 远大于 F（repair 极贵），节省趋近轮数比 `(N−T)/N` = 50%；当 F 远大于 R（前情极重、修复极便宜），节省趋近 0。42% 对应 R ≈ 0.88F——"一轮带全套失败上下文的 repair，略贵于理解任务并做完首次修改的总和"，这恰好是 REPAIR 调用上下文最重这一结构性事实的合理投影。**你的 N、T、F、R 与你的契约和模型定价一一对应，请代入你自己的遥测**——但只要 R 不是小到可以忽略，三倍于熔断阈值的烧穿 waste 就稳定存在。

比数字更重要的，是被省下的那部分成本的**性质**：它不是"为了省钱省掉的验证"，而是**预期收益为零的支出**。签名相同时，第 N 轮买到的是一张已知不会中奖的彩票。熔断器省下的每一分钱，都是拒绝购买这种彩票的钱。

## 七、熔断之后：从黑洞变成工单

熔断不是把失败的任务扔掉，而是把一个**无限烧钱的黑洞**转换成一个**带完整证据的人工决策点**。到达 BLOCKED 时，这个 run 已经拥有：

- `blockReason`：可读的原因，带签名指针；
- 完整的三轮失败记录：每轮的命令、指纹、输出摘录、时长，全部持久化在 append-only 事件库里；
- `NO_PROGRESS` finding 与 unresolved 项，进入 WorkerResult；
- 一个仍然保留的隔离 worktree（默认 `--keep-workspace`），agent 最后一次尝试的现场原样可查。

Web 控制台的收件箱把 BLOCKED 归入"需要处理"类，人工介入后有两条路：直接接手修复（现场都在），或者点击 retry——以**冻结的契约**开启一个全新 `runId`，旧 run 原样保留、永不覆盖。新 run 不是从零开始：跨 run 的失败记忆会把旧 run 里同指纹的失败历史注入新 run 的 REPAIR 上下文——第 N 次尝试的人类与机器，都站在前 N−1 次的肩膀上，而不是重复前 N−1 次的坑。

还有一条更长的回声：当**同一个指纹**跨 ≥3 个独立 run 反复出现，失败记忆会生成一条 flaky 隔离提案。这一刻，单次运行里"看似原地踏步"的失败，在跨运行的视角下被重新归类——它可能根本不是 agent 的问题，而是一个间歇性测试在污染所有经过它的修复任务。

## 八、诚实的边界

熔断器不是免费午餐，四个已知边界我们都踩到过：

**指纹交替绕过熔断。** 熔断触发条件是签名**完全相同**。如果一个 flaky 测试导致失败集合在 A、B 两种状态间交替（A→B→A→B），每轮签名都不同，判定落在 UNKNOWN——既非 IMPROVING 也非 UNCHANGED——计数不增不减，最终烧穿预算，以 BUDGET_EXCEEDED 终结。这是当前真实存在的漏洞，缓解手段是跨 run 的 flaky 提案机制（上面第七节），但那是事后追认，不是实时熔断。更彻底的方案（把 UNKNOWN 也纳入加权计数）会增加误杀横跳型 agent 的风险，我们选择保留这个边界并如实呈现。

**慢爬行不受保护。** 每轮只要失败数下降哪怕 1，就是 IMPROVING，计数清零，永不熔断。一个"每轮修好一个失败、总共 500 个失败"的任务会一路爬到预算耗尽。这是有意的设计而非疏忽：有可测量改善就继续投入是熔断器的另一面承诺，病态案例由预算上限兜底——两道防线各司其职。

**归一化碰撞的残余风险。** 规范化丢掉的信息里，理论上可能包含区分两个不同根因的细节（40 行封顶之后的报错堆栈被截断）。后果是误熔断——把两次不同的失败判成同因。我们把这类错误的代价设计为可恢复：BLOCKED 只是终态之一，人工看一眼证据就能推翻，重开新 run 的成本远低于误熔断省下的成本。

**指纹依赖输出的可解析性。** 极端格式化的测试框架（或严重交织的并行输出）可能让测试名提取失败，退化后指纹只由命令 + 错误消息构成，精度下降。这也是我们把 `verification.reproduce` 命令放进契约的原因——它今天已经采集、尚未参与判定（这是 README 里如实承认的待办），未来用于把"同因"的判定从输出特征推进到复现特征。

## 九、结语：乐观的是模型，悲观的是账本

三篇文章到这里可以合成一句话了。

第一篇说：**验证结论不能由被验证的一方书写**——所以测试弱化要被检测、完成判定权要收归 harness。第二篇说：**每条结论都要能还原成可重放的证据**——所以要有五级阶梯、失败指纹和哈希链。而这一篇说的是第三件事：**验证体系不仅要说"对不对"，还要说"值不值"**。

修复循环是一个优化器，而一切没有止损机制的优化器最终都会把预算花在零收益的路径上——这不是智能水平问题，是任何 optimizers 的通病，加多少算力都一样。熔断器的全部哲学浓缩起来是一组不对称：**对"是否继续"保持悲观（签名相同就停），对"如何修复"保持乐观（轻推之后给足机会），对"为什么停"保持诚实（结论自带可重放的证据链）。**

模型负责乐观。账本负责悲观。而让账本有资格在正确的时刻开口说出那个数字——是治理的工作。
