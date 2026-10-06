# PERF-01b：后台记忆等待最小闭环

## 当前结论

**PERF-01b短纯文本路径的最小闭环通过：真实桌面取消、正常预览、后台期间普通下一轮启动均有日志和落盘证据。修复与验收记录保存在独立分支`perf/background-task-memory`；未推送、未替换正式应用。此结论不包含长历史、附件、工具续轮或摘要内容质量。**

SDK-01 的已验收提交仍为 `91b97bd`。本轮工作分支：`perf/background-task-memory`。
上个隔离 SDK 包仍保留在 `/tmp/pi-sdk01-desktop-validation/dist`。

## 复现

旧扩展 `turn_end` 返回待完成 Promise，SDK 的 `emitBoundary` 等待它；因此本地摘要延长请求的 busy 生命周期。
受控慢 runner 的单条回归测试在修复前失败：`turn_end must not await a slow summary`，实际值是 pending Promise，而不是 undefined。
这项复现没有向真实模型或外部网站提交历史。

## 修复范围

- turn_end 只标记正常完成；agent_settled 后以 setImmediate 启动后台维护，不让扩展占用工具续轮边界。
- 独立 AbortController；新请求、turn_start、切会话/分支、fork、compaction、shutdown 取消旧任务。
- `/task-memory-cancel` 取消后台任务，不删除聊天历史。
- 捕获 sessionManager/sessionId/branchLeaf/entries/设置版本；写入前检查任务身份、idle、设置版本与来源角色/entryId/sourceHash 指纹。
- 编译器新增可选 signal 与同步 commit。后台调用在一个无 await 的提交段内完成校验、Markdown 哈希保护写入、appendEntry；避免写盘后跨 await 使用失效上下文。
- 供应方即使忽略 abort，过期结果也无法提交。UI 诊断失效不产生后台未处理 rejection。
- 仍使用原本地 primary/fallback、探活、摘要限额、Markdown 冲突保护；不改原生 compaction、主聊天模型或 provider 上下文。
- 跨 Markdown/JSONL 的进程崩溃原子性未重构；既有预算单位、120000字符上限、附件/工具续轮限制也不在本轮修复范围。

## 少量检查

14个相关测试通过（background 9、compile 4、preview/context隔离 1）：

1. turn_end立即返回；正常后台完成只追加一个ledger。
2. 下一请求取消，晚结果不落盘。
3. 会话替换、分支leaf漂移不串写。
4. 同leaf来源内容变更也被指纹拒绝。
5. 快速连续轮次旧任务不覆盖新任务及其状态。
6. 计算期间出现人工记忆内容，不覆盖、不追加ledger。
7. 显式取消、shutdown 无迟到写入或持续busy。
8. 模型失败且通知UI也失败，无未处理异常或持续busy。
9. 设置禁用期间不提交。
10. 既有编译/搜索/人工哈希保护、独立AbortSignal提交阻断、disabled模式。
11. 预览仍不注册context、不向普通主provider自动发送摘要。

Host TypeScript、变更文件 ESLint/Prettier、git diff --check通过。
私有node-pty依赖此前从ASAR复用而缺声明；本轮只补同机另一工作树的同版本1.1.0声明，不改源目录、不下载、不重编译原生模块。
声明SHA256：`4bb071c41f8f9aaa3e1691c8c84873fa38a3067161ac0d22f085577a9e483be0`。

## 隔离候选

- app：`/tmp/pi-background01-desktop-validation/dist/mac-arm64/Pi Agent Desktop Memory Background Check.app`
- home：`/tmp/pi-background01-desktop-validation/home`
- userData：上述home下`Library/Application Support/Pi Agent Desktop Memory Test`
- logs：`/tmp/pi-background01-desktop-validation/logs`
- 项目：`/tmp/pi-background01-desktop-validation/fictional-project`
- generated launcher：`out/main/memory-background-validation-launcher.cjs`（构建产物，未纳入生产入口）
- 配置仅复用此前虚构验收的Ollama模型与设置；无历史、auth.json、正式项目、人工记忆复制。
- 全新数据目录仍用Qwen做无认证桌面验收；这不代表正式主聊天应改用Qwen，也不把它约一分钟主请求延迟当作摘要优化收益。
- 仅复用本地Electron、工具链和模型资产，禁止重下载及原生重编译。
- afterPack核对171个模型运行时包；候选已ad-hoc深签并通过严格签名检查。
- ASAR SHA256：`3ffc5e35769f4d1fbf0ecc0d21f54d2134203f602b086a50398b69779e71a718`。
- 2026-09-30T17:26:36.557Z 候选Host ready；尚无用户验收会话或auth.json。
- 托管进程：`proc-7b6adb6b-f6ca-486f-a40e-e0f99ffdaad8` / run `c13fa03c-a5ce-4ad7-968b-6f2bd3dfcc92`。
- 正式ASAR仍是`6a5b5fea0287deaf5a9ab3f1fed9a50f7ba1f46725667c9eb6bf33f24fde9a9b`；旧SDK候选仍是`9a2989fb5f760fda2e6071524a5d68667fc6828fad82de08bd2996cdedc3757d`。
- 构建仍提示已记录的node-addon-api headers collector警告，未纳入本轮修复，也未验收共享终端原生功能。

## 已完成的真实桌面验收（2026-10-01）

会话`01a0f360-3416-760f-9c13-99b722ef3d57`；实际cwd为隔离home下`pi-cwd-20260930`，没有读取正式项目。

- 用户截图确认取消提示和正常预览；本地Ollama托管输出seq663–720确认第一轮回复01:34:40结束、探活约1.80秒，摘要task308在01:34:42启动，01:34:51收到cancel task并释放slot；不是只依据toast判成功。
- 第一轮源entryIds `f5407bcf`、`1e715124`的预期记录`mem-ddce54bf5119075d41a99254`不存在；JSONL只有一个记忆ledger，属于第二轮，未发现取消任务迟到写入。
- 第二轮回复01:36:40.704；探活约1.198秒、摘要约13.148秒；01:36:55.080追加ledger，回复到落盘14.376秒。后台化没有缩短模型推理本身。
- 预览225字符来源、92字符摘要，与ledger及`hot/mem-def92e058869492f32a1ea6e.md`一致；Markdown SHA256与ledger一致：`2dcdbb20a0e434d05fdcdc8777c224e74de22f15ac8c223b499a75c59205474d`。
- 第二轮摘要包含两个任务是正常的：取消停止那次计算，不删除第一轮聊天；第二轮来源表确实含4条消息，仍可重新汇总它们。
- 新发现SUM-01：摘要只声称“顺序已记录”，未保留三项工作及三本书的实际顺序；交付链路成立，不代表内容质量合格。暂不扩展修改范围。
- 主聊天首轮约116.778秒、次轮67.626秒，本地Qwen仍生成224/241输出tokens（含thinking）；UI Off不等于该服务真正禁用思考。该主聊天慢的问题与后台摘要等待分开记录。
- 预览弹窗期间Running command/Stop来自等待用户confirm的预览命令本身，单张截图不能据此判定后台摘要仍占busy。

## 最后一次现场补测：普通下一轮在后台期间启动（通过）

- 会话仍为`01a0f360-3416-760f-9c13-99b722ef3d57`。下面使用本地UTC+8时间，依据JSONL及Ollama托管输出seq1308–1476。
- 01:57:54.632 第一个任务回复；后台探活随后完成，摘要task804在01:57:55.500开始计算。
- 01:57:55.872 下一条普通消息入JSONL（距回复1.240秒）；旧摘要HTTP请求55.873结束500，服务端56.424明确cancel task804，56.587释放slot。这是本地主/摘要共用一个推理slot时的取消传递，不是主聊天失败。
- 新聊天55.933已到达模型服务（距提交61毫秒），56.640开始推理（距提交768毫秒，包含旧slot取消及缓存切换），未等待旧摘要自然结束。
- 01:58:23.935 正常回复“收到”；提交到回复28.063秒，其中主模型推理27.293秒。后台化解决“等待摘要”，不保证主模型快速。
- 被取消源记录`mem-eb02250d39e68f601f427cc8`既没有Markdown也没有ledger；新请求后只观察到最新来源的记忆提交。
- 01:58:36.628 最新记忆落盘：`mem-40f759cae8df95a8a0611b2a`，source587、summary111；SHA256 `66d84bf1cb5eb31500803ffefeedf47e6e0125f6b26abacfc83812863058d80f`与ledger匹配。
- 下一请求主动取消旧摘要，之后由新轮重新汇总完整来源；不是并行放任旧来源覆盖新记忆。
- 当前真实桌面覆盖短纯文本的取消和续聊；切会话/分支、人工编辑等安全边界只有受控相关测试，未宣称完成全场景桌面验收。

## 之前补测与判读边界（现已由上述最后一次补测补齐）

- 普通下一条聊天请求在摘要尚未结束时立即启动：最初用户是在取消后约42秒才发下一任务，不能冒充这一条已经现场验证。
- 补测时间（本地UTC+8）：纸飞机任务01:51:59.213回复，01:52:06.230记忆落盘（7.017秒）；普通测试消息01:54:41.777提交、01:54:53.238回复。提交时摘要早已完成约155.547秒，因此本次只确认普通回复正常，未覆盖背景运行窗口。记忆随后01:54:59.014落盘。用户需预先复制下一条消息，在回复出现后立即发送，避免把这个时序误判为通过。

## 原桌面验收步骤与结果

- 虚构短文本收到回复后，摘要尚未完成时发送`/task-memory-cancel`，命令能够执行。
- 取消后本轮没有迟到记忆ledger或新Markdown。取消命令必须在实际pending期间执行；不能只依据toast或在摘要已完成后执行的取消命令判为通过。
- 第二个虚构任务不取消，后台正常完成；`/task-memory-preview`与新ledger/Markdown一致。
- 读取隔离日志、来源记录和时间，不用“启动成功/单测成功”代替以上结论。
- 本阶段通过前不评价外部摘要API，更不外发真实历史。
