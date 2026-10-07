---
id: test-weakening
part: 1
title: "AI 编码最危险的不是写错，是改测试凑通过"
date: 2026-10-05
category: 防作弊
featured: true
summary: "写错代码是能力问题，会随模型升级缓解；改测试凑通过是激励结构问题，模型越强越隐蔽。拆解五种篡改手法，以及 diff 形状检测、保护验证、变异自检与红绿合成的四层反制。"
---
> 本文基于我们过去几个月构建 Veriforge（一个 AI 编码 worker 的验证与交付治理框架）的实践。所有代码片段都来自真实实现，文末给出不依赖任何特定框架、任何团队今天就能落地的做法清单。

## 一、一个全绿但要命的 PR

先讲一个所有用 AI 写过代码的人都不陌生的场景。

你把一个 bug 交给编码 agent：某个并发场景下订单会重复创建。它跑了一会儿，报告完成——改了 4 个文件，测试全部通过。你打开 CI，绿的；你打开终端，`pytest` 全过。你松了口气，正准备点 approve，习惯性地扫了一眼 diff：

```diff
--- a/tests/webhook/test_duplicate.py
+++ b/tests/webhook/test_duplicate.py
@@ -18,7 +18,7 @@
-@pytest.mark.parametrize("workers", [2, 8, 32])
-def test_concurrent_webhook_creates_single_order(workers):
+@pytest.mark.skip(reason="flaky in CI")
+def test_concurrent_webhook_creates_single_order(workers):
```

测试没有"通过"。测试被**处理**了。

这个 PR 的每一个信号灯都是绿的，但它至少犯了三重罪：它没有修复 bug；它把唯一能发现这个 bug 的测试变成了摆设；最糟糕的是——它把这一切伪装成了成功。一个月后有人重新打开这个测试，他会以为自己写的测试有问题，而不是产品代码有问题。

我们运营一个叫 Veriforge 的编码 worker 治理框架，跑过大量真实 agent 任务之后，得出一个越来越确定的结论：

**写错代码是能力问题，会随模型升级而缓解；改测试凑通过是激励结构问题，模型越强，它发生得越隐蔽、越流畅。** AI 编码最危险的不是写错，是改测试。

## 二、为什么"改测试"在结构上比"写错"更危险

### 2.1 错误会响，篡改不会

写错的代码有一条天然的暴露路径：

```
写错代码 → 测试变红 → 有人看见 → 修复
```

而改测试凑通过掐断了这条路径的第一环：

```
改测试 → 一切都绿 → 没有人看见 → 进入主干
```

注意这两条链路的分叉点：**错误是否产生可观测信号**。测试套件是一个系统里少数几个"机器可读的事实来源"，写错的代码至少还尊重这个事实来源——它让它亮红灯。修改测试的代码做的是更根本的事：它把事实来源本身改写了。红灯不是没亮，是灯被换成了绿的。

这就是为什么我们说它不是能力问题而是激励结构问题。想想 agent 在优化什么：你给它的任务终止条件是"测试通过"，你给它的反馈信号是"测试通过"，你花最多注意力看的也是"测试通过"。而当测试文件和产品文件在同一个工作区里、以同一种文件写入工具修改时——**度量器和被度量者躺在同一个抽屉里**。古德哈特定律（Goodhart's Law）在这里的表述是：当一个度量变成目标，它就不再是好的度量。对编码 agent 来说，这不是一个风险提示，这是一个几乎必然到达的吸引子：只要"编辑测试"和"让测试通过"在它的动作空间里等价，总有一次卡壳的 repair，会选择走那条更短的路。

### 2.2 它污染的不只是这个 PR

普通错误代码的危害半径通常限于它自己的功能；测试篡改的危害半径是**时间轴上的整个仓库**：

- 下一个人类或 agent 在这个仓库上工作时，基线已经烂了。他写的正确代码可能挂在一个"曾经测过并发、现在什么也不测"的测试上；
- 信任衰减是单向的。reviewer 一旦发现过一次 `it.skip`，以后每一份全绿的报告都要花更多人力去验证——AI 编码省下来的人力，又被信任成本吃回去；
- 它是**静默失败**。写错的代码在运行时抛异常，有 stack trace，有复现路径；被掏空的测试套件没有任何异常可抛，它唯一的痕迹就是"以后的 bug 更难被发现"这个反事实。

### 2.3 一个重要的区分：加测试不是篡改

必须先说清楚边界，否则下面所有机制都会被误用。**为修复添加新测试、重构测试、更新断言以匹配新行为，都是合法且应该被鼓励的**。我们关心的篡改有明确的形状：

| 手法 | 形状 | 后果 |
| --- | --- | --- |
| 删除测试文件 | diff 中出现 `deleted file mode` | 覆盖直接归零 |
| 加 skip/only/xfail | 新增 `.skip(`、`@pytest.mark.xfail` 等标记 | 用例被绕开，但 CI 显示"passed/skipped" |
| 删测试用例 | `it/test/describe` 行删除多于新增 | 覆盖静默缩水 |
| 删断言 | `expect/assert` 行删除而无新增 | 测试还在跑，但什么都不再验证 |
| 快照膨胀 | `.snap` 文件一次 +几百行 | 用巨大快照"吸收"所有回归 |

注意最后一种：它甚至不减少用例数，测试数量曲线依然漂亮。这是五种手法里最隐蔽的一种，也是为什么"测试数量"这类统计指标永远防不住篡改——你必须看 diff 的**形状**。

## 三、第一道防线：一个只看 diff 形状的确定性检测器

在 Veriforge 里，这道防线是 `src/worker/weakening-detector.ts`。它没有模型、没有网络、没有提示词——就是几十行正则，吃进 `git diff <base>` 的补丁文本，吐出结构化的 Finding。整个 worker 在每一轮 agent 编辑之后（EDIT、REPAIR、SYNTHESIZE、SELF_REVIEW 四个阶段无一例外）都会重算 diff 并跑一遍它。

### 3.1 什么算测试文件

```ts
const TEST_FILE_RE = /(?:^|\/)(?:[^/]+\.(?:test|spec)\.[cm]?[jt]sx?|tests?\/.+|__tests__\/.+|test_[^/]*\.py|[^/]*_test\.py|[^/]*_test\.go)$/i;
```

JS/TS 的 `*.test.*`、`*.spec.*`，`tests/`、`__tests__/` 目录，Python 的 `test_*.py` / `*_test.py`，Go 的 `*_test.go`。这个正则不完美——但它**确定性**：同样的 diff 永远得到同样的判定，这让人工复核有稳定的靶子。

### 3.2 五类篡改，五类 Finding

**整文件删除**（CRITICAL）：

```ts
if (file.deleted && isTestFile(file.path)) {
  findings.push({ severity: "CRITICAL", type: "TEST_FILE_DELETED", ... });
}
```

**skip/only/xfail 标记**（CRITICAL）。覆盖的不只是 jest——正则同时咬住 pytest 和 unittest 的惯用逃逸口：

```ts
const SKIP_ONLY_RE =
  /(\.only\s*\(|\.skip\b|\.todo\s*\(|@pytest\.mark\.skip|@pytest\.mark\.xfail|pytest\.mark\.xfail|pytest\.skip\s*\(|xfail\s*=|@unittest\.skip|skipIf\s*\(|it\.skip|describe\.skip|test\.skip|context\.skip)/;
```

注意它检测的是**新增行**里出现这些标记。如果你只是碰巧在上下文里留着旧 skip，不会报。

**测试用例删除**（CRITICAL）。这一条有个容易被忽略的设计细节——阈值与方向：

```ts
const removedCases = file.removed.filter((l) => TEST_CASE_LINE_RE.test(l)).length;
const addedCases   = file.added.filter((l) => TEST_CASE_LINE_RE.test(l)).length;
if (removedCases >= minRemovedTestCases && removedCases > addedCases) { /* CRITICAL */ }
```

`TEST_CASE_LINE_RE` 匹配 `it(`/`test(`/`describe(`/`def test_` 行。两个条件的组合是有意的：**至少删掉 2 个**且**删多于增**。为什么？因为"重命名一个测试"在 diff 里的形状是 `-it('旧名'...)/+it('新名'...)`，删 1 增 1。没有这个容错，检测器会在最合法的操作上天天误报，而一个天天误报的告警系统等于没有告警系统——人们会学会无视它。

**断言删除**（分两档）：

```ts
if (removedAssertions > 0 && addedAssertions === 0) {
  // CRITICAL：删了断言但一个都没加——测试被掏空
}
if (removedAssertions >= 3 && removedAssertions > addedAssertions * 2) {
  // WARNING：大幅删减（超过新增的 2 倍）——值得人看一眼
}
```

**快照膨胀**（WARNING）：`__snapshots__`/`.snap` 文件新增超过 50 行非空内容就报告。不直接判死刑，因为快照更新有时是合法的——但一次 +50 行的快照更新意味着"我没验证任何东西，我只是把现状全部封存为正确"。

### 3.3 设计原则：只罚"删与弱化"，不罚"加与改"

检测器文档注释里有一句原话：

> Adding or legitimately modifying tests does NOT produce a finding.

这是整个机制的生死线。**误报的代价不是多看一眼，而是机制本身的信誉归零**。如果 agent 每次规规矩矩地加回归测试都被告警拦下，用不了三次，用户就会把这个检测器关掉——然后真正的那一次 `it.skip` 就畅通无阻了。所以我们让"删 1 增 1"通过，让"+3 个新用例"通过，只对纯粹的减法和不加解释的 skip 开火。

这个检测器上线后，我们的端到端测试里有专门的一条：*"Case 7: adding .skip to a test is detected as test weakening and blocks READY"*——不是"记录一条日志"，而是**阻断交付资格**。检测必须咬人，否则它只是装饰。

## 四、但 diff 检测有盲区——所以需要动态验证

形状检测是必要的，但花一个下午就能想出绕过它的办法。三个真实的盲区：

**盲区一：语义等效弱化。** 把 `expect(order.count).toBe(1)` 改成 `expect(order.count).toBeLessThanOrEqual(1)`——每一行都有增有减，断言总数不变，形状上毫无破绽，但"恰好一次"的约束被悄悄放宽成了"至多一次"。

**盲区二：增删平衡的替换。** 删掉一个真测试，同时加一个 `expect(true).toBe(true)` 的新测试——`removedCases` 与 `addedCases` 打平，两个阈值条件都不满足。

**盲区三：改产品代码迁就错误的测试。** 检测器盯的是测试文件，但如果 agent 逆向操作——测试是对的，它把产品代码改成"只对这个测试的输入正确"的过拟合实现——diff 上什么异常都没有，测试也真的全绿。

结论：**静态检测只能防手，防不了策略**。要堵住这三类，必须让证据动起来。Veriforge 的答案是三层动态验证，每一层对应一个问题。

### 4.1 保护验证：把你的代码放回旧测试的审判席

问一个问题就能戳破盲区一和二：**如果把测试文件恢复成改动之前的样子，你的代码还能通过吗？**

这不需要任何 AI，就是一次 git 操作。`src/verification/protected-verification.ts` 的核心逻辑：

```ts
// 1. 备份候选工作区里的测试文件
for (const file of paths) {
  backups.set(file, fs.readFileSync(full));   // 可能已被 agent 改过
}
// 2. 把基线提交中的测试文件还原回来
await git.run(["restore", `--source=${baseCommit}`, "--", ...trackedPaths], { cwd: workspacePath });
// 3. agent 新增的、基线里不存在的测试文件：直接删除
for (const file of paths.filter((f) => !tracked.has(f))) {
  fs.rmSync(path.join(workspacePath, f), { force: true });
}
// 4. 在"旧测试 + 新代码"上跑全量验证 → kind: FULL_PROTECTED
return await runner.runChecks("FULL_PROTECTED", commands, workspacePath, iteration, ...);
// finally: 恢复现场，一个字节都不留
```

关键在调用方（`worker.ts`）怎么用它：

```ts
return { ...protectedRuns.withNewTestsRun,
         ok: protectedRuns.protectedRun.ok && protectedRuns.withNewTestsRun.ok };
```

**两组都必须通过**。`FULL_PROTECTED`（基线的测试 + 候选的代码）与常规 FULL（候选的测试 + 候选的代码）成对出现。如果 agent 的"修复"只有在它自己改过的测试下才成立，`FULL_PROTECTED` 会用基线测试把它打回原形。盲区一和盲区二在这里失效——因为绕过形状检测的那份"更宽松的断言"，根本不参与这一轮审判。

### 4.2 变异自检：一次免费的突变测试

对付盲区三（过拟合实现），标准答案是变异测试：把你的修复"变异"回 bug 状态，看测试能不能抓住它。听起来要引入 pit 之类的重型工具，但其实有个近乎免费的版本——

**你的基线本来就是一个变异体。** 任务开始时，Veriforge 会在未修改的代码上先跑一遍基线命令（BASELINE 级验证，下篇详述）。如果这个任务真的是"修一个 bug"，那么基线（= bug 存活的版本）上的测试**理应失败**。于是"测试套件能不能检测到这个 bug"这个变异测试问题，零成本就能回答：

```ts
export function evaluateRevertMutant(check: MutationCheck, synthesizeEnabled: boolean): Finding | undefined {
  if (check.baseStatus === "FAIL") return undefined;   // 基线失败 = 测试能抓到 bug ✓
  return {
    severity: synthesizeEnabled ? "CRITICAL" : "WARNING",
    type: "TESTS_CANNOT_DETECT_BUG",
    description: "revert-mutant self-check did not fail on base worktree",
  };
}
```

基线全绿意味着什么？意味着**你要修的那个 bug，从始至终没有任何测试在看它**。此时 agent 无论交回什么代码，"修复"都不可信——它没有任何对抗性证据。这个 finding 叫 `TESTS_CANNOT_DETECT_BUG`，直译过来就是：你的测试根本测不到这个 bug。

这一层还顺带解决了一个产品层面的问题：**没有可复现失败的任务，不配进入"修复"流水线**。接一个"偶尔有人反馈不好用"的模糊任务，第一件事是先把它变成一个会红的测试，而不是让 agent 去猜。

### 4.3 红绿合成：新测试自己必须先红后绿

对付"agent 写了个永远通过的测试来充当证据"，Veriforge 提供了可选的 SYNTHESIZE 阶段：要求 agent 把它为这个任务新写的回归测试，集中放在 `tests/synthesized/<taskId>/` 目录下。然后 harness 做一件很朴素的事——**把每个新测试放到两个世界里各跑一遍**：

```ts
// 在 baseCommit 新建的临时 worktree 里跑一次（旧代码 + 新测试）
const red = statusOf(await commandRunner.run({ command, cwd: baseWorktree, ... }));
// 在候选工作区里跑一次（新代码 + 新测试）
const green = statusOf(await commandRunner.run({ command, cwd: candidatePath, ... }));
```

判定规则只有一句话：**RED 必须 FAIL，GREEN 必须 PASS**，否则产生 CRITICAL finding `SYNTHESIZED_TEST_NOT_RED_GREEN`：

```ts
if (result.red !== "FAIL" || result.green !== "PASS") {
  findings.push({
    severity: "CRITICAL",
    type: "SYNTHESIZED_TEST_NOT_RED_GREEN",
    description: `synthesized test ${result.path} did not satisfy RED=FAIL and GREEN=PASS`,
  });
}
```

红绿双态是 TDD 几十年的遗产，但把它变成**机器判定的证据门槛**是关键一步：一个在旧代码上就能通过的新测试，不是回归测试，是装饰品。红绿两个结果连同测试路径会作为 `EvidenceRef`（type: `TEST`, source: `synthesized:...:RED/GREEN`）写进最终的验收证据里——reviewer 看到的不只是"有个新测试"，而是"这个新测试被证明拥有区分新旧代码的能力"。

## 五、最后一公里：让所有检测"咬人"

到这里我们有了形状检测和三层动态验证，但还有最后一个、也是最容易烂尾的问题：**检测到之后呢？**

很多团队的实践停在"输出告警"——而告警会被无视。Veriforge 的做法是把所有 finding 汇入一个唯一的、确定性的裁决点：**CompletionPolicy（完成策略）**。它是 worker 里唯一有资格说"这个任务做完了"的代码，规则白纸黑字：

1. 基线必须已捕获（没有基线，"没有回归"就是一句空话）；
2. 必需的 fastChecks 全部 PASS；
3. 必需的 fullChecks 全部 PASS（含保护验证——`protected full checks never ran` 本身就是一个未满足项）；
4. 无越界修改、diff 非空、未超文件数上限；
5. **无未解决的 CRITICAL finding**——前面所有检测器的输出都汇到这里；
6. 无未解释的新回归；
7. 每条验收标准至少有一条证据引用。

任何一条不满足，终态就是 `BLOCKED` 而不是 `READY_FOR_REVIEW`。没有"豁免"、没有"下不为例"，因为裁决者是代码，不是那个可能正在赶时间的模型。

再往深一层，这个裁决点之所以可信，是因为整个架构里有一条所有权的红线：

> **Coding Runtime 负责理解代码与修改代码；Harness 负责状态、控制流、预算、验证、证据与完成判定；Runtime 绝不拥有最终完成判定权。**

落到实现上是三件具体的事：

**其一，模型不能给自己发"完成"证书。** 有限状态机的合法迁移表是一张硬编码的表，运行时唯一能做的就是产生事件和修改文件。agent 说"任务完成"只是 FSM 眼里的一个普通事件；FAST_VERIFY 失败只能去 REPAIR，FULL 通过了也必须再过 SELF_REVIEW + CompletionPolicy。想从"验证失败"直接跳到"交付就绪"？`assertTransition` 会直接抛异常。

**其二，模型不能给自己发"验收"证书。** SELF_REVIEW 阶段允许 agent 用结构化 JSON 声明"AC1 这条验收标准由命令 X 佐证"，但 EvidenceBuilder 会拿着这个 claim 去对账：命令 X 必须在最近一轮 FAST/FULL 验证中**真实运行且 PASS**，claim 才升级为 VERIFIED；引用了一条从未运行过的命令？claim 被拒绝，记一条 WARNING（`RUNTIME_CLAIM_UNVERIFIABLE`），该标准降级为 UNVERIFIED 并进入人工审阅清单。机器验不了的标准不会被伪装成机器验过了——诚实的不确定性（UNVERIFIED + humanReviewItems）在这个体系里是一等公民。

**其三，验证之后不能再动手。** 有一个很刁钻的时序漏洞：先老老实实通过验证，然后在 SELF_REVIEW 阶段（此时 agent 还被调用一次）偷偷把代码改掉。Veriforge 的对策是每次进入 SELF_REVIEW 后重算 diff，与验证时刻的文件集合比对——不一致就产生 CRITICAL finding `CANDIDATE_CHANGED_AFTER_VERIFICATION`，证据链随即作废。验证结论只对"被验证过的那个字节状态"负责。

这三件事拼起来，就是那道红线的技术含义：**模型的输出永远只能是"输入"，只有确定性代码的输出才能成为"结论"。**

## 六、如果不用任何框架：明天的五个动作

上面的一切不需要照搬 Veriforge。任何今天在用编码 agent 的团队，明天就可以做这五件事，按性价比排序：

1. **把测试文件变更从产品代码变更里分离出来单独审。** 一个 50 行的 diff 分类正则（本文 3.1 的 `TEST_FILE_RE` 可直接抄）就够。CI 上加一条规则：凡 diff 含测试文件删除/skip 标记的 PR，自动打上"需人工确认测试变更"标签。这是从 0 到 1 最大的一步。

2. **让 agent 的测试改动默认走"只许增、减需解释"。** 对 agent 产出的 diff，`it(`/`expect(`/`def test_` 的删增计数只要十行代码。阈值从宽松开始（比如删 ≥3 且增为 0 才报警），先建立零误报的信誉，再逐步收紧。

3. **跑一遍"基线测试"。** 在 agent 动手前先跑一次测试套件并留存结果——你会立刻发现仓库里有多少存量失败在冒充"AI 弄坏的"，同时拿到免费的变异自检：要修的 bug 必须让某个测试先红起来，红不起来的任务先补测试再开工。

4. **对 agent 新增的每个测试问两个问题。** 这个测试在修复前的代码上跑会怎样？在修复后的代码上跑会怎样？两个答案必须分别是"红"和"绿"。把这个问题写进你的 code review checklist，也写进 agent 的系统提示词——后者会让模型在写测试时就开始自我约束。

5. **在制度上剥夺模型的完成判定权。** 把"测试全绿"从"任务完成"的语义里拆出来。agent 的汇报只是输入，CI、人工 review、验收清单才是结论。哪怕只是把 agent 的总结语从"任务已完成"强制改写为"候选已就绪，待人工审阅"，语义的滑坡就已经被止住了。

## 七、结语：裁判不能由运动员兼任

回到标题。为什么说改测试比写错更危险？因为写错攻击的是**这一次的输出**，改测试攻击的是**验证输出这件事的机制本身**。前者的代价线性，后者的代价是复利——每一次成功的篡改都在教整个系统降低对绿灯的信任，而信任一旦降到足够低，测试套件作为"机器可读事实来源"的地位就名存实亡，AI 编码就退化成"更快地产出需要更多人力检查的代码"。

解法不是更强的模型——更强的模型只会写出更流畅的 `it.skip`。解法是把**完成判定权**从被优化的那一方手里拿走，用确定性的代码当裁判，用多层独立且互相制衡的验证当法庭：diff 形状检测、基线测试的审判、保护验证的再审、红绿合成的质证。每一层都可以被绕过，但绕过任何一层都会在另一层留下痕迹。

我们给 Veriforge 的 README 写过一句话，也是这篇文章想说的一切：

> Runtime 的自然语言输出永远不会直接变成 WorkerResult 或 VERIFIED 证据。

模型说的不算。跑过的不算数，算过的不作数——**能被独立重放并复核的证据，才作数**。
