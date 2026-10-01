# FLASH-02：明确授权的 Flash 非思考后台记忆

## 交付范围
在89f0418后台取消修复之上，增加独立DeepSeek后台摘要。主聊天、原生compaction与普通provider上下文不变；不自动向主聊天注入记忆。不安装正式版，不复制真实历史或认证，不下载资源。

- 唯一远端模型：`deepseek/deepseek-flash`（SDK显示DeepSeek V4.1 Flash）。API只允许`https://api.deepseek.com`的官方completion路径。
- Pi公开ModelRuntime执行；生产复用现有会话runtime。隔离验收仅让SDK引用已有auth文件，未提取/打印/复制key，不把测试认证路径做成生产默认。
- `reasoning:"off"`，发送前及实际fetch检查`thinking.type==="disabled"`、无reasoning_effort、无工具、messages严格等于已批准请求。禁重定向、重试、额外请求、provider/Web fallback。原本地runner/probe的回环限制保留。
- 最多12000源字符/4000摘要字符；只接受user/assistant文字来源。工具、压缩与分支摘要拒绝发送；没有自动脱敏保证。
- `/task-memory-enable-remote`展示当前原文、官方目标、未脱敏风险，明确批准当前与未来该会话文字；仅保存设置不授权发送。`/task-memory-disable-remote`撤销。授权不落盘，导航/分叉/压缩/切会话/重启清除；设置保存使授权epoch递增，恢复相同设置哈希不能复活旧授权。
- 延续来源指纹、独立AbortController、同步提交与Markdown人工编辑哈希保护。SDK/provider错误不原样暴露认证诊断。

## 小范围检查
21条直接相关测试：后台/取消/身份漂移/人工编辑/通知故障/设置禁用/授权/回退相同配置版本/目标和off payload/禁止fallback/普通上下文不注入；全部通过。新增设置回退回归先失败（旧结果仍追加一条ledger），最小epoch修复后通过。

局部ESLint/Prettier、Host和Renderer TypeScript、diff检查通过。不跑全量verify。Node测试的MODULE_TYPELESS_PACKAGE_JSON警告保留，未为消除警告改项目模块类型。

## 最终隔离包
`/tmp/pi-flash02-desktop-validation/dist/mac-arm64/Pi Agent Desktop Flash Memory Check.app`

最终ASAR SHA256：`59de621321bb1e7f8b3b056eea6bded39923eb3ab815cedd8f5aa068646f9524`。epoch阶段包为`ed742936...`，wire阶段包为`5175816c...`；均是历史证据，不冒充最终事实契约包。

离线打包、171个SDK运行时包校验、ad-hoc深签和严格签名检查通过。bootstrap仅生成到out和验收目录，固定私有home/userData/logs，不纳入生产入口。旧初版ASAR `2118e15f...`为epoch修复前诊断包，不作为最终交付。

## 真实桌面验收（Agent驱动真实Electron UI，非SDK替身）
仅操作隔离APP回环CDP，通过真实textarea、Send、设置Save、扩展确认/预览UI；读取实际JSONL与Markdown并查看截图。会话`01a0f504-6ee7-72f7-ad38-5e34db989dc9`，项目仅`/tmp/pi-flash02-desktop-validation/fictional-project`，主聊天始终本地Qwen；正式Sol没有更换。

1. 初版第一条虚构聊天正常回复；Flash设置已选，但尚未确认来源，远端请求和ledger均为0。授权dialog实际展示原文和当前/未来文字范围；确认后摘要保留两套原名和顺序，148源字符→178摘要字符，预览与ledger一致。
2. 初版普通回复后74ms提交下一轮，旧API任务取消，新来源正常更新；旧源`mem-7c9d12e61534153a651bbb32`没有Markdown/ledger。撤销后再发虚构任务，主聊天仍回复，但无额外API请求/ledger。
3. **epoch签名阶段包**重启未恢复旧授权。实际设置UI先保存规范配置；预置当前来源对应虚构人工笔记，再明确批准请求。模型返回后人工文件未覆盖、未追加ledger，UI报告人工编辑冲突；没有fallback或重试。
4. 在同一最终进程实际UI关闭并恢复设置，确认文件字节与原配置完全相同；下一条虚构聊天正常完成，但权限仍撤销、无API请求。重新审阅并确认后正常保存555源字符→445摘要字符，预览、ledger、Markdown SHA256相同；五组虚构主体/原名/顺序保留，未声称完成执行。
5. **epoch包再次命中真实API后台窗口**：dispatch `01:55:36.985Z`，普通下一条聊天`01:55:37.035Z`，相隔50ms；同刻client cancellation观测。既有旧源Markdown字节不变、无额外旧源ledger；最新645源字符→350摘要字符，预览一致。结束前再次撤销授权。
6. 最后校验4条ledger的Markdown/哈希全部一致，assistant均`ollama-local/stop`。最新`hot/mem-ed39a28f4992d579b09418a0.md`，SHA256`54c058174ac9e59bd3a2aee2cf252251bb59ebf842f55ed4a71281df49718cc9`。虚构人工笔记`mem-91a492fe2e462a9a8d2a95a8`保留。

7. wire阶段在实际fetch解析序列化body，复核完整两条messages的role/content、off、无reasoning_effort/工具、max_tokens≤2048；补SDK hook之后篡改序列化body的受控拒绝断言。实际桌面735源字符→574摘要字符，第8次GUI请求通过；五条Markdown哈希一致。
8. **SUM-02内容问题**：上项574字摘要把三个重复聊天请求写为“两轮”，并把编译指令混作目标/决策。先记录失败样本，再仅收紧system事实抽取契约：不复述方法、不新增建议/推断风险、不统计未显式给出的轮次。相同735来源和生产legacy prompt，单次SDK调用1728ms/422字，保留五组主体/步骤、无错误计数/方法说明（quality-result.json）；这是单次内容回归，不当成全面质量保证。
9. **最终59de...签名包**再走真实桌面：重启未授权，普通虚构请求无远端发送；审阅原文后批准，实发body守卫正常通过；825源字符→345摘要字符，五组主体、原名、数字、顺序保留，错误轮次/方法说明未再出现，未声称执行。预览/ledger/六条Markdown哈希一致；最新`hot/mem-6dba59e9f52dce6c8ec3680d.md` SHA256 `eb18c25c5c81ee0fdea321278016dd51bd7fb98831356a0751e4854559efce72`。撤销授权后关闭GUI/CDP。

全程9次GUI虚构APIdispatch：2次客户端取消、1次人工保护拒绝写入、6次正常落盘；另1次同源质量回归SDK调用，不写盘。共10次明确范围内虚构请求，无探活/重试/fallback。质量脚本最初误计入custom消息而在认证/请求前断言停止；仅过滤user/assistant后执行唯一请求。客户端取消不能证明供应方停止计算/不计费。

验收脚本曾因句号严格匹配、SPA URL查询参数、误写ledger哈希字段markdownHash而停止。修正测试脚本（实际字段hash），只续做未完成本地检查，不隐瞒失败，不重发已完成模型请求；代码包未因此改变。

## 证据及剩余边界
`/tmp/pi-flash02-desktop-validation/`下：remote-audit.jsonl、desktop-phase1-result.json、desktop-phase2-result.json、desktop-final-result.json、desktop-final-cancel-result.json、storage-final-proof.json、consent-dialog.png、final-preview.png、final-cancel-preview.png、desktop-wire-result.json、quality-result.json、desktop-quality-result.json、quality-final-preview.png、quality-package.log。测试GUI/CDP验收后关闭；重新双击候选不会附带调试端口或恢复授权。

- 仅短虚构纯文本路径的自动真实桌面验收，不冒充用户本人验收/所有场景交付。真实长历史、工具、附件、原生压缩、Web回收保持另案。
- 摘要内容已核对主体/原名/顺序、显式数字、计划≠完成、SUM-02观察到的错计数/方法说明。自由文本仍可能出错；只修复了观察样本，不能声称已全面解决幻觉或无需人工审阅。此前错误输出留证，不修改成看似通过。
- 原生几千条事故会话没有自动迁移/外发；含工具/压缩/超12000字符来源将拒绝，不代表现有真实大历史已经可用。
- 设置epoch覆盖正式settings handler保存及已观测到的文件版本变化，不承诺发现任意外部文件在无观察间隙内写回原值。
- 950ms/reasoning0/$0.0000954来自此前单次off评估，不冒充本次生产模板所有请求性能/真实账单。供应方保留政策未保证。
- Markdown与JSONL跨文件崩溃原子性、预算单位、终端原生ABI功能、node-addon-api collector警告、候选app-update.yml警告未扩张修复。
- 正式ASAR仍`6a5b5fea0287deaf5a9ab3f1fed9a50f7ba1f46725667c9eb6bf33f24fde9a9b`。正式安装、真实历史持续外发必须另行授权并准备原回滚路径。
