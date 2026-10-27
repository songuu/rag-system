---
type: sprint
status: in-progress
tasks_completed: 2
tasks_total: 13
task_ids: ["W0","W1","W2","W3","W4","W5","W6","W7","W8","W9","T16","T17","R18"]
open_task_ids: ["W2","W3","W4","W5","W6","W7","W8","W9","T16","T17","R18"]
---

# RAG / Neo4j 生产门禁与可点击引用后续 Sprint

- 状态：Sprint owner 已批准完整范围；仅在可审计 supersede 事务绑定 active pointer 后授权进入正常阶段流转
- 日期：2026-09-09
- 上游计划：`docs/plans/2026-09-07-neo4j-knowledge-graph-integration.md`
- 总体目标：保持原 T16/T17 验收范围不变，先补齐所有本地可执行门禁工具和正文引用链，再在真实生产输入、阈值与维护窗口到位后完成生产 Shadow、单 corpus 灰度、故障降级、回滚和发布周期留存
- 最新局部证据（2026-10-13）：具名 publication 反例与全量见证已按新四SHA完成双审；累计回归的安全归因切片（private39码、own descriptor、8层、域分requestIdHash、mapper前链、已封存5xx返回、sink隔离）完成RED→GREEN、真实项目2根/119源strict、功能/TS各90/90与独立安全12+6的三面限定APPROVE。主流程strict28/lint31退出0，原47首次896/897的旧durable agent首次500/200保留；同原30s/90s/并发及全部旧46测试的安全摘要复核897/897、106文件无漂移，仅捕预期503，未证明旧间歇500/503根治。证据 `docs/reports/2026-10-10-rag-publication-conformance.md`。这不是全仓W9/build、完整W5/IAM/origin/企业conformance或生产验收；八formal requirements、完整read-only测量、制品/registry/evidence/runner和合法空基线继续未完成，2/13、11open、18AC不变，无commit/push/生产变更。

- 最新W5制品增量（2026-10-13，续接而不改写上条历史）：新增私有actual whole-reader→固定AAD/key AES-GCM→exclusive seal→独立exact read/full decrypt→fresh clock的reference桥接；公开owned error降级HIGH与core/artifact clock cursor断开HIGH、encrypt后旧time seal的MEDIUM均独立实证、持久RED后修复。最终artifact27/27，新精确2SHA功能/TS双面限定APPROVE；共享actual seq/time/nonce游标、fresh sealContext、完整uncertainty interval/整体deadline与UNKNOWN保留，不自动retry/delete或声称取消。主流程strict29/lint33退出0，原48完整**923/924**：Ask诊断return fixture首次seed POST503/200；实际domain hash关联pre-map STEP_FAILED→EPERM/PAUSED503，精确syscall/根因仍unknown，108文件无漂移，不重跑绿色冒充修复。证据仍为 `docs/reports/2026-10-10-rag-publication-conformance.md`。此本地single-report plaintext64KiB制品不是企业来源/IAM/完整readonly/conformance或生产验收，registry/evidence/runner/合法空基线和其余依赖仍open；八formal要求、任务2/13、11open、18AC与完整Goal不变，无commit/push/生产变更。

- EPERM后续只读证据（2026-10-13）：一次同48清单的临时loader诊断924/924，checkpoint/result/runtime三实际hook已加载、rename352+76均fail0，110文件无漂移；未捕目标EPERM，不称原923/924已修复或根因确认，不放宽预算/断言、不盲目retry/delete。后续按依赖补完整manifest→actual publication artifact对应消费，rawmanifest/identity/index/角色/窗口与引用需精确绑定；对应关系不能代替验签、registry/evidence/只读IAM或生产授权。完整Goal/2/13/11open/18AC及生产外部输入状态不变。

- 默认输入选择（2026-10-13）：owner 回答“可以暂时使用默认的么”，本地实现和验证继续使用仓库既有 `local-reference` 配置、合成 roster/manifest/provider 夹具与参考时钟；不需要为这些本地工作等待生产输入。默认值不具备真实生产数据、企业 registry/approval、独立 conformance 或维护窗口的证明能力，不改变安全 hard gate，不将 synthetic scope/签名/时间当生产事实，也不勾选 T16/T17/R18 或缩减完整 Goal。

- 完整manifest→actual artifact局部（2026-10-13）：新closed五字段入口绑定完整原始manifest、actual PublicationIdentityRef/schema/index、scope/run、executor/readOnly、授权摘要、有效window及T17 active target N+1；私有原whole-reader/crypto/exactstore/decrypt不改，运行期phase/mutation/UNKNOWN保留，signature/registry/evidence/machineGate/生产标志仍false。独立0/20 RED→主20/20，精确新2SHA功能与TS/async双审限定APPROVE；strict30/lint35均exit0，保留原48加新20的49文件一次实跑944/944、110文件无漂移。此前EPERM失败保留、根因unknown，不把本次绿写为修复或全仓W9/build/完整W5完成；证据 `docs/reports/2026-10-10-rag-publication-conformance.md`。下一步按依赖继续完整read-only/合法baseline与runner/gate，本地默认继续，完整2/13/11open/18AC/活动Goal不变。

## 0. 重基线边界

当前本地接续（2026-10-13）：直接读回现有conformance/observer及native PG源码，五个ACTIVE场景已使用完整实际业务projection的pre/post witnesses；原 `read-only-state` 仍not-run，现有Source API只读/SQL只有SELECT不等于独立数据库IAM权限证据。不得通过重复matching读或把not-run改名passed来补全八项formal requirements。下一处确定缺失为W3 canonical Ask target：现有production-policy target仅hermetic控制面，通用RagEval runner也不具备部署registry/manifest/arm请求规划。先复用完整manifest与ProviderTrustPolicy validator实现纯local-reference目标计划，冻结origin/固定路径、manifest roster/arm/trial与registry引用；实际DNS/IP/TLS/credential/HTTP、原始dataset读回和机器gate留待后续真实消费。完整Goal/2/13/11open/18AC与生产false不变。

W3当前局部证据（2026-10-13）：新Ask目标纯planner实际复用完整rawmanifest/独立deploymentpolicy validator，绑定registry完整ref、scope、selected Ask adapter/version/config、全有效window；固定POST /api/ask，冻结roster/阶段arm/试验与预热ordinal，输入拒绝URL/headers/creds/factory/成功标签及getter/Proxy。新0/21 RED→21/21，精确新2SHA功能/TS/安全三审限定APPROVE；actual项目2root上下文0diagnostics，首leaf35缺Node ambient诊断保留，不改tsconfig。strict31/lint37均exit0；原49加Ask21的50文件一次实跑**964/965**，112文件无漂移。唯一旧broken-sink test first正常POST500/200；mock在first前已安装并吞日志，目标code/cause/阶段unknown，不误写成替换sink前、不把其他预期503或旧EPERM当根因，不重跑求绿。证据 `docs/reports/2026-10-10-rag-publication-conformance.md`。后续安全观测被mock吞掉的已有metadata并继续实际runner/transport/dataset/gate依赖；planner不联网/取凭据、相关真实性和生产标志全部false，W3整项/全仓W9/全部任务不记完成，完整Goal/2/13/11open/18AC不变。

后续新观测证据（2026-10-13）：保留原正常程序964/965；第一临时 mock sidecar 同50文件仍964/965，broken-sink200→503完成，但另一persistence首次500且可见未包装EPERM，共用requestId尚不能精确归因。为此新增内存AsyncLocalStorage调用点与原生fs/FileHandle闭集关联观测，预检保留99 POST参数、633 assert、12 mock；一次同清单原预算965/965，114源码无漂移、120动态POST完成，但EPERM未复现，精确syscall/竞争主体unknown，不能当修复或累计原程序已绿。strict/lint本次未重复，原源未修改。证据均追加原报告，不删除旧失败。按依赖继续W3完整V2原hash/同序roster/完整gold-canary冻结对应，本地默认可用，但不替代runner/transport/gate、完整W5/IAM或生产事实；2/13、11open、18AC、八formal要求和完整Goal保持不变。

W3完整数据对应增量（2026-10-13）：新增独立primitiveJSON→完整原V2 parser/hash/private freeze→精确manifestdataset/同序roster/case scope/trust集合→原Ask request wrapper；单独local资源预算8MiB/depth64/nodes200000，超限不截断、不误用256KiB canonical数据hash，不过滤安全canary、不输出query/gold。actual rawDatasetVerified=true只属新wrapper核验，nested旧plan及其false/hash不改，授权/网络/生产仍false。独立缺源RED19=1fixturepass18fail→root19/19，精确新2SHA功能/TS/安全三面限定APPROVE；actual2roots项目strict0diag及rootstrict32/lint39均exit0。原50加新19的51文件一次983/984，唯一旧scoped PDF page evidence用例失败，数值摘要未保留断言差异，根因unknown，不误归因旧EPERM/新binding、不重跑求绿；114文件无漂移。证据追加原报告，先继续此新失败的安全归因；完整W3/runner/transport/gate/W5与2/13/11open/18AC/完整Goal不变。

最新诊断续记（2026-10-13）：新增有限PDF目标观测保留633断言/99POST/12mock，原PDF目标11/11通过、failed根因未复现；诊断同51实际982/984，两个不同旧失败为generation-A durable首次500与journal negative-timeout判定。已用独有合成requestId的既有domain hash精确核对generation-A seed EPERM/catch，而不是已执行PATCH恢复；具体syscall仍unknown。journal冻结10ms，不知道实际失败scenario/断言，下一步先做闭集scenario/UNKNOWN与实际invoke关联，不改预算/旧oracle或将两次失败覆盖成绿色。118源码无漂移、无生产IO/commit/push，完整2/13/11open/18AC/Goal继续active。

本轮双观测续记（2026-10-13）：补两store各12个handle及journal缓冲闭集dispatch/status观测，原99POST/633assert/12mock、journal10ms/原oracle不变。同51实跑983/984，唯一新失败是nested integrity用例首次seed POST503/200；同case/site原生result rename EPERM→STEP_FAILED/PAUSED503已精确关联，不能补填旧generation-A未知operation。journal此轮76dispatch、negative1/rootDigest/timeout-pending、UNKNOWN保留且后13项not-run，原断言通过不代表前轮失败修复。独立核对七类控制文件写入与process-only锁，没有lease/deadline重校验合同，故不盲目retry/delete。再新增只读临时目录物理containment/lstat与七类writer上下文的一次同预算运行984/984、116文件无漂移，但EPERM未复现、失败category/metadata未知，保留全部旧失败而不宣称根治。strict/lint本轮未重复，产品源不变；证据追加 `docs/reports/2026-10-10-rag-publication-conformance.md`。下一独立本地依赖为完整冻结V2由actual reference evaluator消费，transport/runner/stage gate仍open；默认合成输入只供local-reference，完整Goal/2/13/11open/18AC/八formal要求与生产false不变。

W3完整labels消费增量（2026-10-13）：保持原binding精确四key，单独reference evaluator共享私有冻结准备，完整dataset进入原runRagEval/private validator/四oracle，显式冻结manifest topK；结果JSON只容闭集全roster原序同arm/phase/ordinal，独立cursor，ordinary proof只固定finite数字/有序hash/静态错误，无query/gold/answer/evidence/原error。真实RED后新增19与旧19合计38/38；合法重绑定span/fact/双relevance/security实际改变指标，非仅hash拒绝。精确四SHA功能/TS/安全三面限定APPROVE，actual2root/14非声明源0diag，13组876安全反例含溢出failclosed；旧oracle/hash/parser未改。本地offline评分不证明查询或来源真实、transport/registry/阶段阈值/审批/加密制品仍需实际消费。正常52回归已启动、strict32/lint41为0，等真实完整结果，不提前标记W3/W9/全部任务完成。证据仍追加原报告；所有旧间歇失败和完整Goal/2/13/11open/18AC/productionfalse保留。

该增量正常回归终态（2026-10-13）：全部独立进程结束后，原51加新19的52文件一次实际**1003/1003**、0fail/cancel/skip/todo/exit0，strict32/lint41均exit0，116文件无漂移、三审四SHA匹配；无diagnostic loader、旧断言/预算/Oracle改动，session29498终态已drained。原labels评分消费局部已有完整证据，但不宣称旧EPERM/PDF/journal间歇失败根治、全仓W9/build或完整W3/Goal完成。下一步按依赖实际producer/transport、受控制品与manifest阶段gate消费；defaults仍仅local-reference，真实T16/T17/R18输入与授权不得伪造，2/13/11open/18AC/八formal要求/productionfalse不变。

W3完整正文字节分片增量（2026-10-13）：实际读回原制品64KiB AEAD/256KiB object/256项索引与16MiB Ask network合同后，新增独立 local-reference framer，闭集 primitiveJSON/base64url、按原完整bytes分片、空片/中文跨边界与16MiB/256片不截断；原AAD十字段/ordinal范围不变，actual arm+phase+ordinal+part映射最大563199无别名。ordinary proof只机密hash/长度/索引，明确私有forEncryption plaintext handoff，完整回读不接受缺片/重复/顺序/AAD/正文交换；不冒充实际producer/KMS来源/生命周期、授权或阶段验收。合法旧AEAD fixture RED1/14后实际14/14、strict/lint2与6SHA无漂移；Review找到MEDIUM返回proof类型可写/literal拓宽，按真实类型RED修 readonly/literal interface与显式返回型，运行时未变，新SHA三面限定APPROVE，actual两root579源0diag/readonly赋值3处预期TS2540，功能563200槽无别名、完整16MiB，安全14组2728断言；错误synthetic probe不记全绿。一次正常53文件实际**1017/1017**、0fail/cancel/skip/todo/exit0，strict33/lint43退出0、118SHA无漂移，session17706终态已drained；详情追加原报告，旧setup/探针/间歇失败均保留。本地framing局部完成，下一依赖为私有framer→实际受控writer/fresh clock/总deadline/UNKNOWN/完整index，再继续实际producer/transport与manifest gate；完整W3/W9/Goal仍未完成，2/13、11open、18AC、八formal要求/read-only-state not-run、productionfalse与本地默认边界不变。

本计划不把未完成工作改名为“完成”，也不缩小活动 Goal。Sprint runtime 以内容寻址的 `sprint-migration-receipt/v2`、owner 批准证据、显式任务映射和 CAS 绑定旧 pointer 与新计划；批准本计划本身仍不等于迁移成功。迁移必须满足：

1. 旧 Sprint 在事务提交前保持 `compound/blocked, 16/18`；禁止调用 `complete --expected compound`，也禁止手工改写、删除或覆盖 pointer。
2. Sprint owner 批准“旧 T16/T17 → 新 T16/T17、W0-W9、R18”的完整映射和不缩减 Goal；任何源 open task 都不得消失或改记为完成。
3. `supersede` 事务以 CAS 绑定旧 pointer/计划 hash、新计划 hash、owner 批准记录、任务映射和规范化 receipt，保留旧 Sprint 的未完成/迁移事实；不得复用 completion record。
4. 只有 migration receipt 与新 pointer 均通过权威 readback 后，本 Sprint 才能从正常 `think -> plan -> work` 状态机启动；失败或证据漂移必须保留旧 pointer 和恢复证据并 fail-closed。

当前批准记录：

| 字段 | 状态 |
|---|---|
| Sprint owner | 当前 Codex task 的用户 owner |
| 批准人 / 时间 | owner 明确要求“必须全部完成”；精确时间由 approval evidence 与可信运行时钟绑定 |
| 批准记录或签名 | 本地主机观察边界内的消息定位符与 UTF-8 SHA-256；不冒充密码学签名 |
| 事务化 supersede/migration 能力 | runtime 提供只读 proposal、调用方精确落盘 receipt、CAS supersede 与崩溃恢复 |
| 任务映射与新旧计划 hash receipt | 由迁移事务按规范化任务 ID 和精确文件 hash 生成并回读 |
| Pointer 迁移 | 仅允许 runtime 的精确事务执行；禁止手工改写 |

W3实际受控制品writer增量（2026-10-13）：新增私有原framer→原clock/KMS/store完整每片encrypt/seal/exact-read/decrypt→原完整byteproof/index组合，包含实际16MiB/256片/1025fresh-clock、中文300000bytes及五类body/T17 arms/phases；共享绝对deadline/跨actor单调time+sequence/全窗口uncertainty、nonce+长度先seal拒绝、closed/busy/已sealed语义槽、UNKNOWN与mutation保守保全、不重试或声称取消。合法fixture缺源RED1/20→20/20，再两项长度/nonce独立RED21/23→新23+原14实际37/37；strict/lint2均0、6SHA无漂移。两个新SHA正在功能/TS/安全三面限定复审，原53+新23的54文件1040项/strict34/lint45/120watch仅准备未执行；错误新fixture失败全部保留，旧产品/crypto/预算/Oracle不改，原Ask MM保留。普通只机密hash/index，实际组合匹配不授予source/encryption/store/time/生产真实性，不代表whole-run/producer/transport/阶段门禁；详情追加原报告。完整2/13、11open、18AC、八formal要求/read-only-state not-run、productionfalse与Goal active不变。

writer独立复审续记（2026-10-13）：功能旧SHA实际37/37及index/root/close互补，TS旧SHAactual两root581源/17非声明0diag与readonly/literal正常，安全实际发现MEDIUM readonly port owned mutationtrue被localfalse覆盖；root持久RED23/24后OR合并，并先求值innerPending防止short-circuit。功能另MEDIUM3660d配置vs原store3650d，root两独立负例RED25/27与合法later2ms正例后，按实际observedAt/window精确3650d前置守卫，不缩窄startsAt预算。最终新27+原14实际41/41、strict/lint2/6SHA无漂移；新两SHA三面最终delta仍待终态，正常54文件1044项/strict34/lint45/120watch仍仅准备。独立失败/修改/旧与新SHA均追加报告，不借旧通过冒称最终整体通过；任务计数/AC/完整Goal与productionfalse保持。

writer本轮终态续记（2026-10-13）：最终d54a12/1f7b75三面限定APPROVE，两MEDIUM按真实RED/最终delta关闭，actual两root581源0diag及41/41窄通过；不混拼旧与新SHA。主strict34/lint45均0，但正常保留原53+新27的54文件一次实跑**1040/1044**、4fail/0cancel/skip/todo，120SHA无漂移、session83083终态exit1/drained。失败为旧durable checkpoint/replay首次503/200及旧publication-artifact两项deadline、publication-conformance一项late-clock；API异常EPERM链共用hash不能定位本案syscall，后三phase/loop/pending/mutation未知，不拿绿色或名称当因果证明。已只读确认原20ms/80ms及4-witness→5th-clock合同，下一步闭集调用点/原own error阶段+dispatch/native-FS安全观测，不放宽预算/Oracle、不blind retry/delete；新27及最终三审只批准本地writer局部，完整W3/producer/transport/gate、W9/Goal与2/13/11open/18AC/八formal要求/read-only-state not-run/productionfalse保持，旧失败全部保留，证据追加原报告。

四项旧失败闭集观测续记（2026-10-13）：新增两份隔离诊断资产，原99 POST/633 assert/12 mock、27/148和20/95断言与原预算均不变；两轮纯内存RED→GREEN31/31关闭误报唯一cause、getter/held泄露和revoked Proxy替换谓词结果问题。最终两SHA779e3b/5145fc三面35/21/42 checks限定APPROVE，syntax2/lint2/preflight0；default仍仅local-reference。一次原54文件单loader诊断子测试1044/1044/status0、UTC14:30:18.058–14:30:49.505Z，但父观测数据处理harness-error退出1，trace batch及122freeze未到达，不能记整体通过或旧正常1040/1044已修复。随后12关键SHA实际无漂移；直接子stdout合成边界未复现截断，TAP fixture调用未返回/无文件/未执行，不伪造结果。下一安全步骤为闭集解析隔离+finally冻结及受控TAP复现，再继续实际Ask producer/transport/gate等依赖；证据追加原报告，所有旧间歇失败、完整2/13、11open、18AC、八formal要求/read-only-state not-run与productionfalse/Goal active保留，无commit/push/生产变更。

TAP父程序修复续记（2026-10-14）：真实合成Node TAP证明大frame被64KiB comments分片而非丢字节；旧54原stdout未留存，唯一根因仍不补造。新增闭集重组/长度hash拒绝/finally实际freeze工具，三项独立MEDIUM先9/12 RED再修matched prior-failure关联、CLI numeric/hash摘要和普通native rejected carrier；unsafe carrier仍unknown。canonical配置原import加载超时，改为createRequire读取同已安装CJS数组，不改rules/ignores/packages；最后一个eval-only unused warning显式序列化同catalog解决。最终12/12、syntax3、canonicalLint3/max-warnings0实际0，五SHA无漂移，runner0256e8/test4e8cb2/configfce645精确身份已交三面delta复审，54尚未派发。用户允许默认值仅local-reference/synthetic，不补生产事实/授权；下一W3按原API topK≤50/合法字段/server arm与tenant scope/完整预算和实际response provenance接私有dataset-owned producer/transport/writer/oracle，不伪造usage。详细失败及UTC/hash追加原报告；2/13、11open、18AC/八formal/read-only-state/旧间歇失败和生产false/Goal active保持。

最后privacy增量（同日）：安全exact run fake-spawn发现旧status/causeDepth quotedstring旁路，独立功能旧0256批准不覆盖它。root持久actual-path13项先12/13 RED后Number.isSafeInteger/HTTP100..599/causeDepth0..8修复，最新13/13+syntax3+canonicalLint3/max-warnings0实际全0、五SHAdrift=[]；最终runner c75df5/test1a3be9/configfce645已交三面只读delta，54仍待全部复审真实终态。不加预算、不改Oracle、不将局部工具或旧普通间歇失败记为全Goal/生产通过。

父诊断最终真实终态（同日）：三面按c75df5/1a3be9/fce645全部限定APPROVE后，一次原54单loader实际1030pass/0fail/1cancel（1031tests）、UTC04:43:17.942–04:43:50.649Z/exit1/stdout81d7a9fd…。cancel的域分hash静态54源/10275literals及file spelling唯一映射旧native-publication-sources.test.mjs，14原tests未完整交付；原cancel错误/CPU根因仍未采集。闭集trace真正complete=true/3frames/0reject/0overflow/0observerFailure，大frame236795B实际4comments重组；finally125freeze真实drift=[]且最终observation/freeze完成但unitSucceeded=false。工具展示裁剪大型record行，不冒充全raw capture；旧四失败当前无断言失败但普通1040/1044及native取消等间歇故障不关闭。诊断解析/冻结缺口关闭，累计/Goal不通过；完整2/13、11open、18AC、八formal/read-only及真实生产事实保留，default只local-reference，无commit/push/生产变更，详细证据追加原报告。

## 1. Think Frame

### 1.1 要做

- 复用现有 RagEval V2 dataset/hash、metrics、matrix、Snapshot CAS、PostgreSQL Outbox、Neo4j artifact store 和 Milvus 文档查询能力。
- 实现分阶段 fail-closed、可审计的生产门禁 manifest、production Ask runner、T16/T17 receiptCore/acceptanceBundle、PublicationIdentity readback 与崩溃恢复 journal；质量/延迟阈值可配置，安全 hard gate 不可放宽。
- 实现普通 Ask 与 agent 路径的结构化引用输出、服务端诊断，以及正文 `[n]` 到最终 served Evidence 的安全、可持久化映射。
- 在本地隔离环境完成正向、负向、故障、篡改、回滚和敏感数据泄漏测试。
- 生产数据和审批到位后，按冻结合同完成 T16/T17，不用 synthetic 或 hermetic 结果替代。

### 1.2 不做

- 不在仓库、普通日志、receipt、shell argv、stdout/stderr、OTel/APM、崩溃转储或工单中保存 Token、Cookie、认证头、生产原始问答/gold 或 PII。
- 不把 WORM/append-only 当作审批真实性。审批必须来自身份可验证的签名或企业审批事件，并与防篡改存储同时存在；二者不能互相替代。
- 不允许请求参数临时绕过进程级 `RAG_GRAPH_MODE`，不在共享 Neo4j 上执行停库故障注入。
- 不直接 UPDATE PostgreSQL Pointer/Outbox，不直接用 Cypher 改 Pointer，不用删除 Snapshot、卷或重建 Milvus 充当回滚。
- 不在 Pointer lineage 已分叉时刷新 revision 后盲目 CAS；自动 mutation 只能作用于仍属于本 run 的前驱和目标。
- 不允许 manifest 放宽跨 scope Evidence、认证绕过、Secrets/PII 普通落盘或无效审批等安全 hard gate。
- 不在发布周期留存证据通过前删除旧文件 Store 或历史图谱。

<!-- design-authority:start -->
### 1.3 Design Authority（shadow）

- Revision：1，2026-10-09；将原已批准的 18 项成功标准逐字迁移为 AC-1～AC-18，不改变产品范围。后续语义修订必须显式记录 revision 并重新核对关联任务。
- 问题与用户价值：架构图共同强调混合检索、知识图谱、评估和来源引用；当前 Graph 核心已有实现，但缺少可审计生产门禁和普通/agent 一致的安全引用链。
- 范围 / 非目标：严格遵循 1.1 / 1.2 与 W0-W9、T16/T17/R18；不增加企业基础设施实现，不执行共享环境故障或历史 Store 删除。
- 备选方案、选择与理由：选择复用既有 RagEval / Graph CAS / Evidence 并新增 provider-neutral ports；直接用本地 fixture 冒充生产 provider 不具备身份与独立验收证据，全量替换现有框架增加不必要的迁移范围。
- 组件、消费者接口、状态与错误路径：阶段 validator -> ports -> runner/gate -> receiptCore -> 独立 attestation -> acceptanceBundle；API/agent -> served-ID -> opaque locator -> 当前主体授权的内部预览。所有失败保留诊断、零越权 mutation；实际生产恢复仅执行冻结的降风险动作。
- Acceptance Criteria（唯一语义 owner；下方 checklist 仅为精确 transport projection）：
  - AC-1: **WHEN** 当前阶段所需字段、hash、审批真实性、可信时间或窗口无效，**THE TOOLING SHALL** 在该阶段任何生产写入和切流前退出；T17/Retention 字段缺失不得反向阻塞只读 T16。
  - AC-2: **WHEN** 同一 roster 执行 `off` 与 `shadow`，**THE TOOLING SHALL** 锁定相同 image/build/model/index 和 `sharedConfigHash`，分别保存完整 `armConfigHash` 与回读的 `rolloutMode=off|shadow`；两 arm 只允许批准的模式字段不同。
  - AC-3: **WHEN** 保存生产 Ask 数据，**THE TOOLING SHALL** 默认不保存响应头，按批准白名单最小开放；请求、gold、响应、错误和遥测全链路脱敏，原始制品使用 AEAD、每对象唯一 nonce 和每 run KMS/envelope key，AAD 绑定 environment/scope、run、manifest、artifact type/ID、case/ordinal 与 schema version；receiptCore 只保存机密级伪名索引和 hash。
  - AC-4: **WHEN** 跨 scope、认证绕过、普通落盘 Secrets/PII、无效审批或其他 hard gate 任一触发，**THE TOOLING SHALL** 立即停止后续请求和 mutation；manifest 只能收紧，不能调宽为非零容忍。
  - AC-5: **WHEN** T16 Shadow 完成，**THE RECEIPT CORE SHALL** 证明“无新增 serving/control-plane/index mutation”：served Evidence、context/prompt digest、cache identity 与 off 强一致，Pointer/Outbox/BuildJob/Neo4j/Milvus/流量无未批准变化；回答按批准的语义非劣化阈值比较，只有 provider 明确保证 deterministic seed 时才额外比较 answer digest；报告区分 cache hit/miss，避免缓存掩盖生成路径。批准的加密审计制品、受控遥测、模型计费和与 off 等价的普通缓存写入单列为预期副作用。不得据此宣称 Active 最终答案提升。
  - AC-6: **WHEN** 任一阶段结束，**THE ACCEPTANCE SHALL** 按无环三层对象生成：先封存不含 post-run 签名反向引用、但包含权威 journal root digest/entry count 的 immutable `receiptCore`，再由独立 `resultAttestationEnvelope` 绑定 exact `receiptCoreDigest`、report/artifact hash、verdict、同一 run nonce、执行身份和完成时间，最后由 `acceptanceBundle` 引用 receiptCore、attestation 与防篡改对象证明；只有完整 bundle 可作为阶段完成凭据，pre-run authorization 不得替代结果签认。
  - AC-7: **WHEN** T16 未达批准阈值、无有效 acceptanceBundle 或其中任一 digest/version/防篡改对象证明不匹配，**THE SYSTEM SHALL** 拒绝 T17。
  - AC-8: **WHEN** T17 开始，**THE ORCHESTRATOR SHALL** 先验证 execution authorization 并冻结独立 recovery authority 与只允许降风险动作的 `SafetyRecoveryPolicy`，再取得带单调 fencing generation 的权威分布式 scope lease，并证明专用 canary 零流量且进程处于 `off`，然后执行 lineage/fencing-bound CAS；流量、模式、fault adapter 和 journal 都必须拒绝 stale token。所有非零流量权重必须带不长于 lease 的控制面 TTL，lease/owner 失效时由流量控制面自动归零；旧 token 不能救援，任何后续 rescue mutation 还必须先取得绑定实际新 generation 的 SafetyRecoveryAuthorizationEnvelope。
  - AC-9: **WHEN** T17 放量前探针运行，**THE GATE SHALL** 对同一 roster 和相同 image/build/model/index/sharedConfigHash 的 `off`/`active` arm 配对，分别保存 armConfigHash/mode readback，验证批准的 trial/warm-up、多跳质量、引用、安全、错误、P95 和超时指标；未达标不得放量。
  - AC-10: **WHEN** T17 灰度放量，**THE ORCHESTRATOR SHALL** 只执行签名 manifest 中冻结的最大权重/请求数、dwell、逐级 ramp 和 abort 规则，并逐步记录权威流量 readback；每级非零权重使用 lease-bound TTL/deadman，续租失败不得继续放量。
  - AC-11: **WHEN** 执行故障注入，**THE FAULT ADAPTER SHALL** 只接受签名 FaultPlan 的闭集动作、不可变资源 ID、参数上限、TTL、预期影响、撤销动作、stop condition 和 kill switch；故障必须由 adapter 端 TTL/deadman 自动撤销，禁止任意 shell、Cypher 或 URL。
  - AC-12: **WHEN** canary Neo4j 隔离故障，**THE SYSTEM SHALL** 保持 Dense/Milvus 问答可用，并记录 Graph 降级；故障身份不得触达共享 Neo4j、Milvus、Outbox 或流量选择器。
  - AC-13: **WHEN** 自动回滚，**THE ORCHESTRATOR SHALL** 在持有当前 fencing generation 时先摘除 canary 流量并回读进程 `off`，且仅在 Pointer 仍匹配本 run 的前驱/目标 lineage 时 CAS；若已失锁，lease-bound 流量 TTL 必须自动归零且 fault TTL 自动撤销，旧 owner 停止全部动作。只有取得新 generation、有效 SafetyRecoveryAuthorizationEnvelope 且通过 journal hash-chain/head 与现场 readback 校验的 rescue operator 才可继续安全恢复；lineage 分叉或 journal 截断/分叉时禁止自动 Pointer mutation 并进入事故处置。
  - AC-14: **WHEN** 回答含合法 `[n]`，**THE UI SHALL** 只按权威 served-ID 映射 opaque CitationLocator；候选/served-ID 映射中的重复或缺失 ID 非法，但正文可多次引用同一合法编号。
  - AC-15: **WHEN** 用户点击来源，**THE SERVER SHALL** 跨实例解析带 TTL/完整性保护且不赋权的 CitationLocator，再按当前主体重新校验 tenant/corpus/trust/version；浏览器状态不具授权能力。
  - AC-16: **WHEN** IndexedDB 恢复、账号/租户切换、权限撤销、TTL 到期、文档删除、locator key rotation 或 schema 迁移，**THE UI/SERVER SHALL** 分区验证或清理最小引用元数据，拒绝 stale/cross-scope ID。
  - AC-17: **WHEN** T17 获得执行授权，**THE MANIFEST SHALL** 同时冻结 retentionPolicy 和旧 Store manifest/hash；R18 只能验证该既有政策和同一 Store 身份，不能事后选择更短周期。
  - AC-18: **WHEN** retentionPolicy 尚未满足，**THE RETENTION ACCEPTANCE SHALL** fail-closed；达到完整发布周期后按 receiptCore/resultAttestation/acceptanceBundle 三层对象生成凭据。实际清理属于 Goal 外独立动作，仍需 `validateForCleanup` 和单独删除授权。
<!-- design-authority:end -->

<!-- acceptance-contract:start -->
- [ ] AC-1: **WHEN** 当前阶段所需字段、hash、审批真实性、可信时间或窗口无效，**THE TOOLING SHALL** 在该阶段任何生产写入和切流前退出；T17/Retention 字段缺失不得反向阻塞只读 T16。
- [ ] AC-2: **WHEN** 同一 roster 执行 `off` 与 `shadow`，**THE TOOLING SHALL** 锁定相同 image/build/model/index 和 `sharedConfigHash`，分别保存完整 `armConfigHash` 与回读的 `rolloutMode=off|shadow`；两 arm 只允许批准的模式字段不同。
- [ ] AC-3: **WHEN** 保存生产 Ask 数据，**THE TOOLING SHALL** 默认不保存响应头，按批准白名单最小开放；请求、gold、响应、错误和遥测全链路脱敏，原始制品使用 AEAD、每对象唯一 nonce 和每 run KMS/envelope key，AAD 绑定 environment/scope、run、manifest、artifact type/ID、case/ordinal 与 schema version；receiptCore 只保存机密级伪名索引和 hash。
- [ ] AC-4: **WHEN** 跨 scope、认证绕过、普通落盘 Secrets/PII、无效审批或其他 hard gate 任一触发，**THE TOOLING SHALL** 立即停止后续请求和 mutation；manifest 只能收紧，不能调宽为非零容忍。
- [ ] AC-5: **WHEN** T16 Shadow 完成，**THE RECEIPT CORE SHALL** 证明“无新增 serving/control-plane/index mutation”：served Evidence、context/prompt digest、cache identity 与 off 强一致，Pointer/Outbox/BuildJob/Neo4j/Milvus/流量无未批准变化；回答按批准的语义非劣化阈值比较，只有 provider 明确保证 deterministic seed 时才额外比较 answer digest；报告区分 cache hit/miss，避免缓存掩盖生成路径。批准的加密审计制品、受控遥测、模型计费和与 off 等价的普通缓存写入单列为预期副作用。不得据此宣称 Active 最终答案提升。
- [ ] AC-6: **WHEN** 任一阶段结束，**THE ACCEPTANCE SHALL** 按无环三层对象生成：先封存不含 post-run 签名反向引用、但包含权威 journal root digest/entry count 的 immutable `receiptCore`，再由独立 `resultAttestationEnvelope` 绑定 exact `receiptCoreDigest`、report/artifact hash、verdict、同一 run nonce、执行身份和完成时间，最后由 `acceptanceBundle` 引用 receiptCore、attestation 与防篡改对象证明；只有完整 bundle 可作为阶段完成凭据，pre-run authorization 不得替代结果签认。
- [ ] AC-7: **WHEN** T16 未达批准阈值、无有效 acceptanceBundle 或其中任一 digest/version/防篡改对象证明不匹配，**THE SYSTEM SHALL** 拒绝 T17。
- [ ] AC-8: **WHEN** T17 开始，**THE ORCHESTRATOR SHALL** 先验证 execution authorization 并冻结独立 recovery authority 与只允许降风险动作的 `SafetyRecoveryPolicy`，再取得带单调 fencing generation 的权威分布式 scope lease，并证明专用 canary 零流量且进程处于 `off`，然后执行 lineage/fencing-bound CAS；流量、模式、fault adapter 和 journal 都必须拒绝 stale token。所有非零流量权重必须带不长于 lease 的控制面 TTL，lease/owner 失效时由流量控制面自动归零；旧 token 不能救援，任何后续 rescue mutation 还必须先取得绑定实际新 generation 的 SafetyRecoveryAuthorizationEnvelope。
- [ ] AC-9: **WHEN** T17 放量前探针运行，**THE GATE SHALL** 对同一 roster 和相同 image/build/model/index/sharedConfigHash 的 `off`/`active` arm 配对，分别保存 armConfigHash/mode readback，验证批准的 trial/warm-up、多跳质量、引用、安全、错误、P95 和超时指标；未达标不得放量。
- [ ] AC-10: **WHEN** T17 灰度放量，**THE ORCHESTRATOR SHALL** 只执行签名 manifest 中冻结的最大权重/请求数、dwell、逐级 ramp 和 abort 规则，并逐步记录权威流量 readback；每级非零权重使用 lease-bound TTL/deadman，续租失败不得继续放量。
- [ ] AC-11: **WHEN** 执行故障注入，**THE FAULT ADAPTER SHALL** 只接受签名 FaultPlan 的闭集动作、不可变资源 ID、参数上限、TTL、预期影响、撤销动作、stop condition 和 kill switch；故障必须由 adapter 端 TTL/deadman 自动撤销，禁止任意 shell、Cypher 或 URL。
- [ ] AC-12: **WHEN** canary Neo4j 隔离故障，**THE SYSTEM SHALL** 保持 Dense/Milvus 问答可用，并记录 Graph 降级；故障身份不得触达共享 Neo4j、Milvus、Outbox 或流量选择器。
- [ ] AC-13: **WHEN** 自动回滚，**THE ORCHESTRATOR SHALL** 在持有当前 fencing generation 时先摘除 canary 流量并回读进程 `off`，且仅在 Pointer 仍匹配本 run 的前驱/目标 lineage 时 CAS；若已失锁，lease-bound 流量 TTL 必须自动归零且 fault TTL 自动撤销，旧 owner 停止全部动作。只有取得新 generation、有效 SafetyRecoveryAuthorizationEnvelope 且通过 journal hash-chain/head 与现场 readback 校验的 rescue operator 才可继续安全恢复；lineage 分叉或 journal 截断/分叉时禁止自动 Pointer mutation 并进入事故处置。
- [ ] AC-14: **WHEN** 回答含合法 `[n]`，**THE UI SHALL** 只按权威 served-ID 映射 opaque CitationLocator；候选/served-ID 映射中的重复或缺失 ID 非法，但正文可多次引用同一合法编号。
- [ ] AC-15: **WHEN** 用户点击来源，**THE SERVER SHALL** 跨实例解析带 TTL/完整性保护且不赋权的 CitationLocator，再按当前主体重新校验 tenant/corpus/trust/version；浏览器状态不具授权能力。
- [ ] AC-16: **WHEN** IndexedDB 恢复、账号/租户切换、权限撤销、TTL 到期、文档删除、locator key rotation 或 schema 迁移，**THE UI/SERVER SHALL** 分区验证或清理最小引用元数据，拒绝 stale/cross-scope ID。
- [ ] AC-17: **WHEN** T17 获得执行授权，**THE MANIFEST SHALL** 同时冻结 retentionPolicy 和旧 Store manifest/hash；R18 只能验证该既有政策和同一 Store 身份，不能事后选择更短周期。
- [ ] AC-18: **WHEN** retentionPolicy 尚未满足，**THE RETENTION ACCEPTANCE SHALL** fail-closed；达到完整发布周期后按 receiptCore/resultAttestation/acceptanceBundle 三层对象生成凭据。实际清理属于 Goal 外独立动作，仍需 `validateForCleanup` 和单独删除授权。
<!-- acceptance-contract:end -->

## 2. 目标架构

```text
T16 executionAuthorizationEnvelope + tamper-resistant storage
  -> validateForT16
  -> frozen shared identity + off/shadow arm descriptors
  -> controlled production Ask runner (off)
  -> controlled production Ask runner (shadow)
  -> paired Shadow/SideEffectPolicy gate
  -> immutable T16 receiptCore + tamper-resistant proof
  -> independent post-run resultAttestationEnvelope
  -> T16 acceptanceBundle
  -> T17 executionAuthorizationEnvelope + frozen SafetyRecoveryPolicy
  -> validateForT17
  -> dedicated canary zero traffic + process off readback
  -> authoritative per-scope lease/fencing + CAS/hash-chain write-ahead run journal
  -> lineage/fencing-bound expectedRevision CAS
  -> Outbox ack + PublicationIdentity readback
  -> active process/mode readback
  -> frozen-arm off/active pre-traffic quality gate
  -> signed ramp plan + controlled canary traffic
  -> signed closed-set FaultPlan + isolated failure injection
  -> withdraw traffic + process off readback
  -> recovery-authorized lineage/fencing-checked CAS rollback + final readback
  -> immutable T17 receiptCore + independent resultAttestationEnvelope
  -> T17 acceptanceBundle
  -> R18 executionAuthorizationEnvelope + trusted elapsed-time evidence
  -> validateForRetention
  -> retentionPolicy checker
  -> immutable retention receiptCore + independent resultAttestationEnvelope
  -> retention acceptanceBundle
```

回答引用链独立于生产切流，但共享同一 Evidence 身份：

```text
ordinary/agent generation -> structured citation output + server diagnostics
  + API candidate evidence
  + contextPacking.includedEvidenceIds (authoritative served order)
  -> partitioned/TTL assistant persistence with opaque IDs only
  -> validated citation map
  -> inline [n] internal link
  -> server re-authorization with current principal
  -> scoped source preview
```

## 3. 版本化合同

### 3.1 分阶段 Gate manifest

基础 schema 建议为 `kg-production-gate-manifest/v1`，但 validator 必须提供三个非循环视图：

- `validateForT16`：只要求 dataset/roster、scope、制品、off/shadow arm、T16 指标、SideEffectPolicy、受控制品策略和 T16 execution authorization；不得要求尚未安排的 T17 维护窗口或 retentionPolicy。
- `validateForT17`：在已验证 T16 acceptanceBundle 上增加专用 canary/流量控制身份、PublicationIdentity、off/active arm 与 trial/warm-up/阈值、最大流量权重/请求数、dwell/ramp/abort、签名 FaultPlan、变更单/窗口/on-call、停止/回滚条件、scope lease/fencing、T17 execution authorization 与 SafetyRecoveryPolicy/recovery authority。RetentionPolicy 与旧 Store manifest/hash 最迟在这里冻结。
- `validateForRetention`：在已验证 T17 acceptanceBundle 上验证已经冻结的 retentionPolicy、旧 Store identity、权威时钟、经过时间/后继发布证据和 R18 execution authorization；不得事后替换政策，也不要求删除授权。
- Goal 外另设 `validateForCleanup`：只接受有效 retention acceptanceBundle 与独立删除授权；清理不属于 R18 验收本身。

基础字段组：

- 数据身份：dataset ID/version/normalized SHA-256、伪名 roster case IDs、trial count。
- Scope：environment、tenant、corpus、允许 trust levels、专用 canary host/instance 与流量选择器身份。
- 制品身份：commit、build/release、image digest、`sharedConfigHash`；每个 arm 单独保存完整 `armConfigHash`、`rolloutMode` 和实际进程回读。
- 模型与索引：LLM、Embedding、Reranker，以及 PublicationIdentity 引用。
- 阈值：T16 Shadow 与 T17 Active 使用独立批准阈值；质量/延迟可配置阈值仅引用当前 schema 可计算的指标。跨 scope、认证、Secrets/PII、审批有效性等安全不变量是不可放宽 hard gate，manifest 只能收紧。
- `SideEffectPolicy`：列出 T16 允许的加密审计制品、受控遥测、模型计费和与 off 等价缓存写入，以及禁止的 serving 输出、Graph 专属缓存、Pointer/Outbox/BuildJob、Neo4j/Milvus/index、模式和流量 mutation；定义每项 pre/post readback 与计数差异。
- `FaultPlan`：动作来自版本化闭集，绑定不可变目标 ID、参数上限、最大 TTL、预期影响、撤销动作、stop condition 和 kill switch；禁止携带任意命令、Cypher 或 URL。
- 敏感制品策略：默认空响应头白名单、KMS key policy、访问范围、保留/删除/legal-hold 策略。
- T17 extension：owner、approver、变更单、窗口、on-call、停止条件、回滚 owner、JIT mutation credential policy、独立 read-only identity、SafetyRecoveryPolicy/recovery authority/duty role，以及 PostgreSQL/外部分布式 lease 的单调 fencing generation。
- Retention extension：在 T17 授权时冻结的周期定义、起点事件、最短时长或后继发布条件、权威时钟、回滚/重置规则与旧 Store manifest/hash。

Secrets 不属于 manifest，也不得从 CLI 参数或 shell argv 注入；只允许由部署侧 secret provider 在目标 origin 校验完成后提供。

### 3.2 审批与 Receipt

建议 schema：

- `kg-t16-shadow-receipt-core/v1`
- `kg-t17-canary-receipt-core/v1`
- `kg-retention-receipt-core/v1`
- `kg-stage-acceptance-bundle/v1`
- `kg-gate-run-journal/v1`
- `kg-safety-recovery-authorization-envelope/v1`

每阶段按固定无环顺序构造 execution/result 两个通用且不可互换的 envelope 和三层验收对象；T17 另冻结 SafetyRecoveryPolicy，并只在真正 rescue 时签发第三类受限 envelope：

1. pre-run `executionAuthorizationEnvelope`：在任何请求、CAS、流量或 fault 动作前，绑定 canonical manifest hash、environment、tenant/corpus、operation、阈值、窗口、唯一 run nonce 和授权时间。
2. `SafetyRecoveryAuthorizationEnvelope`：由独立 recovery authority 基于 T17 中已冻结的 policy 按需签发，绑定原 run/authorization、environment/scope、精确 predecessor/target lineage、新 fencing generation、rescue role、短有效期、JIT credential reference 和闭集 allowed actions。它只允许流量归零、撤销既有 fault、切换/recreate 为 `off`、精确回滚到已签名 predecessor；禁止激活、增加流量、新建 fault、更换 target 或跨 scope。协调面可在冻结 policy 下取得新 lease，但任何 serving/control-plane 恢复 mutation 前必须取得绑定实际 generation 的有效 envelope；原 execution authorization 过期/吊销/窗口关闭不能被复用。
3. immutable `receiptCore`：执行结束后一次性封存，包含 execution authorization 与适用的 recovery authorization 引用、规范化 manifest/data/config/artifact/report hash、journal terminal root digest/entry count、机密级受控制品索引、逐步状态、machine verdict、执行身份和终态；不得包含尚未生成的 result attestation 或任何反向引用。
4. tamper-resistant object proof：由独立只读身份回读 receiptCore，精确绑定其 object ID、canonical digest、object version、锁定模式和保留截止时间。
5. post-run `resultAttestationEnvelope`：由独立结果审批者或权威系统绑定同一 receiptCore digest/version、report/artifact hashes、machine verdict、run nonce、执行身份、终态和完成时间。
6. immutable `acceptanceBundle`：只引用 receiptCore、result attestation 和 tamper-resistant proof 的精确 digest/version，不回填或修改 receiptCore。只有完整、无环且逐项可回读的 bundle 才是阶段完成凭据；T17 只能消费有效 T16 bundle，R18 只能消费有效 T17 bundle。

Validator 必须校验 signer 角色、执行授权人/recovery authority/执行人/结果签认人职责分离、密钥版本、有效期、吊销状态、nonce 唯一性、顺序和跨环境/跨 scope/跨结果重放；SafetyRecoveryAuthorization 还必须验证单调降风险动作和实际 fencing generation。WORM/append-only 不能替代审批身份，pre-run authorization 也不能替代 post-run 结果签认。路径实现必须限制 ID 字符集/长度，固定并验证存储根，拒绝绝对路径、`..`、junction/reparse point、硬链接和 TOCTOU；使用 exclusive create、受限 ACL、大小上限、fsync 和原子 rename。没有有效终态 acceptanceBundle 永远不是成功。

权威 `RunJournalStorePort` 使用数据库事务 compare-and-append 或防篡改 append store 实现不可原地修改的 write-ahead journal。每条记录绑定 runNonce、manifestHash、environment/scope、fencingGeneration、严格递增 seq、prevDigest、idempotencyKey、actor/authorization digest、intent|result、闭集 action/parameters digest、before/after readback digest 与 trustedTime；任何外部动作前先持久化 intent，动作后追加 result。权威 head 以 CAS 更新并独立回读，receiptCore 封存 terminal root digest 与 entry count。恢复必须验证完整 hash chain/head 和现场状态，拒绝缺口、截断、删除尾部、重排、重复、分叉、旧 fence 条目注入或 journal/live-state 不一致。

权威 lease 必须由 PostgreSQL 或外部分布式锁提供单调 fencing token，journal、CAS、部署、流量、mode 和 fault adapter 全部强制拒绝 stale generation。崩溃恢复先验证 journal、lease、SafetyRecoveryAuthorization 与现场状态，再按 lineage/fencing 决定安全续跑、受限回滚或人工事故处置；journal 不可信时不得据其执行自动 Pointer mutation。

### 3.3 PublicationIdentity

`PublicationIdentity` 不是要求异构字段字符串相等，而是定义可验证关系：

- `scope`：environment、tenantId、corpusId。
- `graph`：graphVersion、artifactDigest、Pointer revision。
- `documents`：按 documentId/version/trustLevel 排序的集合，以及每文档 expectedChunkCount 或内容 manifest digest。
- `milvus`：collection、schema manifest hash、index manifest hash 和精确文档行版本集合。

权威回读关系：

- PostgreSQL Pointer/Outbox 提供 scope、graphVersion、revision 和投影 ack；BuildJob 提供 artifactDigest 与文档身份。
- Neo4j Pointer/Snapshot 提供相同 scope、graphVersion、revision、artifactDigest 和 DocumentVersion 集合。
- Milvus verifier 以只读身份按 scope/文档版本查询精确行，并校验 chunk/content manifest 与 collection/schema/index manifest。

任一段缺失、超集、子集、版本、digest、revision 或 scope 不匹配均 fail-closed。

### 3.4 Production target 与数据保护

- 仓库只定义 provider-neutral `SecretProvider`、`KmsEnvelopePort`、`ApprovalVerifier`、`TamperResistantArtifactStore`、`TrustedClock`、`ProductionAskTargetPort`、`PublicationReadbackPort`、`RunJournalStorePort`、`DistributedScopeLeasePort/FencingAuthorityPort`、`DeploymentModeControlPort`、`TrafficControlPort`、`FaultControlPort` 和 `CitationLocatorCodec/StorePort`，以及受限本地 reference adapters 与统一 conformance suite；不在仓库自研企业 KMS、审批、WORM、分布式锁、部署或流量系统。
- 部署侧维护 manifest 不可放宽的 `ProviderTrustPolicy`/registry，冻结每个企业 provider 的 ID、用途、签名 adapter artifact/image digest、版本、允许配置摘要、endpoint/origin、TLS trust roots 和凭据引用。manifest 只能选择已注册用途，不能自举信任根、注入 endpoint 或降级到 fake/reference/local fallback。
- T16/T17/R18 启动前，真实 adapter 必须由独立 harness 通过同一 conformance suite；provider/registry version/config identity、adapter digest 和已封存的 conformance receipt 写入 manifest 与 execution authorization，不接受 adapter 自报通过。production profile 发现未注册 digest、reference/fake adapter 或 fallback 时 fail-closed；receiptCore 回读的实际 provider identity 必须与 ProviderTrustPolicy 和 execution authorization 一致。
- Ask、Approval、KMS、tamper store、Clock、Readback、Journal、Lease、Deployment、Traffic、Fault 和 CitationLocator 等所有出站 provider endpoint 都只来自 ProviderTrustPolicy；强制 TLS hostname/chain 校验，默认禁重定向，绝不跨 origin 转发凭据。
- 所有出站连接统一约束 DNS/IP/端口/代理、response schema/size、流式累计、解压后大小和 timeout，拒绝 metadata、loopback（非显式本地测试）、link-local、私网越界与 DNS rebinding。
- 凭据在 registry、adapter digest、origin、DNS 和 TLS 校验成功后才从 secret provider 注入；生产 mutation 使用 JIT、最小 scope、不可 wildcard 身份，readback 使用独立只读身份。
- 请求 query/gold/case ID、响应、错误、日志、遥测、临时文件与崩溃转储统一结构化脱敏；生产制品使用 AEAD、每对象唯一 nonce 和每 run KMS/envelope key，AAD 至少绑定 environment/scope、run nonce、manifest hash、artifact type/ID、case ID、ordinal 与 schema version，防止同 run 密文互换，并记录轮换和访问审计。CitationLocator 使用独立 key purpose/policy。
- Receipt 使用伪名 case ID；hash 和受控索引本身按机密数据保护。删除必须覆盖对象版本、缓存、派生报告、replica/backup，并处理 legal hold，生成可验证 deletion/crypto-shred receipt。
- FaultControlPort 只接收 schema 校验后的闭集 FaultPlan 和 fencing token；adapter 不提供任意 shell、Cypher、URL 或共享资源 fallback。

### 3.5 引用授权合同

- 标准 Ask 与 agent 路径都必须产生结构化引用或明确的无引用诊断；不能只依赖模型偶然输出 `[n]`。
- 服务端先按 served-ID 验证编号、Evidence 唯一性、scope、trace 和引用诊断；Markdown 代码块、链接文本及恶意内容不得被误解析。
- 服务端生成版本化 `CitationLocator`：只能是至少 128-bit 的高熵随机句柄并存入按 environment 隔离的共享 TTL store，或使用 AEAD 的自包含 opaque token；signed-only payload 最多只能携带随机 opaque handle，禁止向客户端暴露 document/Evidence/scope/version/URL/title。locator 必须跨重启、跨实例可解析，并冻结/验证 schema version、issuer、audience、environment、purpose、key ID、issued-at、expiry、服务端固定 max TTL 和唯一 jti。
- CitationLocator key rotation 必须定义新 key 生效、旧验证 key 不超过既有 locator max TTL 的接受窗口和紧急吊销；轮换不得延长原 `exp`。跨 environment/audience/purpose 重放、未知/吊销 key、共享 store/keyring 不可用、超出 max TTL 或恢复已删除文档均 fail-closed。不得要求客户端从任意 Evidence ID 反解析文档身份。
- 浏览器只持久化 CitationLocator 与最少显示元数据，按当前用户/tenant/corpus 分区并设置 TTL；登出、切换账号/租户、权限变化、文档删除和 schema 迁移时清理。
- 点击只访问受控内部预览路由；服务端解析 locator 后按当前 principal 重新授权 Evidence scope/version/trust，并查询权威 version/tombstone 状态，拒绝篡改、过期、已删除、缓存残留、stale 或 cross-scope locator，不信任 IndexedDB 中的 scope、trace、URL 或 title。

## 4. 任务与依赖

2026-10-09 局部完成记录（不改变下表原任务/验收范围）：

- W0 完成：既有 143/143 基线与新增红测已执行；当前 hermetic 复核 172/172、0 skipped，35 文件前后摘要无漂移。复核只在测试子进程设置已有 `RAG_SEMANTIC_ROUTER=off`；未关闭用户功能。证据：`docs/reports/2026-10-09-rag-production-baseline.md`。
- W1 完成：两个新增结构合同模块、29/29 定向测试、strict TypeScript、ESLint 与独立 APPROVE；Proxy、scope 拆锁、manifest/auth 自循环修复均有红绿证据。返回值仍明确为 `structural-only / productionAuthorized=false`；真实签名、审批有效性、可信时间和 predecessor bundle 信任校验由既定 W2 实现，不能用本条局部完成替代生产许可。
- W2 进行中：journal 首个结构/reference 切片已通过 12/12、strict TypeScript、ESLint、独立 APPROVE，合并 hermetic 回归 184/184；证据 `docs/reports/2026-10-09-rag-production-journal.md`。真实 trust/envelope/receipt/writer authorization 仍未实现，W2 不记为完成。
- W2 审批结构/reference 切片：三类不可互换 envelope、独立本地签名/key/role/time/nonce 验证、降风险恢复闭集与 signed frozen/rollback Pointer revision 已交付；authorization 13/13、manifest 17/17，局部合并 55/55、strict TypeScript/ESLint 与独立 APPROVE。W1 T17 preflight 同步为发布/回滚预留两次 revision 自增预算。最终完整回归两次 198/198；首轮单次 197/198 未复现且根因未知，证据不抹除。39 文件运行前后稳定，2 个 manifest 主动修复及其他任务 readiness 变化已区分记录。证据：`docs/reports/2026-10-09-rag-production-authorization.md`。上述结果固定 `productionAuthorized=false`，W2 整项仍 open。
- W2 provider trust 合同/reference 切片：deployment policy 与 manifest selection 分离、独立 conformance/runtime 签名、精确 provider/artifact/config/origin/run identity、stage/provider-set 重标 P1 红绿修复已交付；12/12 定向、67/67 局部组合、210/210 整体回归、strict TypeScript/ESLint 与独立 APPROVE，41 文件运行前后稳定。证据：`docs/reports/2026-10-09-rag-production-provider-trust.md`。必测项清单不代表 behavioral suite 已执行；真实 registry/clock/store/measurement 与生产许可未证明，结果固定 `productionAuthorized=false`，W2 整项仍 open。
- W2 受控制品操作/reference 切片：两个 provider-neutral KMS/store ports、实际 AES-256-GCM/每 run key/跨 rotation 唯一 nonce/十字段 AAD/吊销无 fallback、exclusive seal/独立 exact readback 和机密伪名 index page 已交付；逐例 case ID 缺失有红绿修复。16/16 定向、83/83 局部组合、226/226 整体回归、六模块 strict TypeScript/新增两文件 ESLint 与独立 APPROVE，43 文件运行前后稳定。证据：`docs/reports/2026-10-09-rag-controlled-artifacts.md`。内存 reference 不提供企业 KMS/WORM、持久/跨实例连续性、可信时间/身份或真实保留政策；ports 固定 `productionCapable=false`，index 固定 `productionAccepted=false`，W2 整项仍 open。
- W2 回执结构/reference 切片：三阶段无环 core、full journal/head/终态组合、本地实际 AEAD 封存及独立解密读回、前向 bundle 结构一致性已交付；四类 P1 与新增函数 getter/Proxy P1 均有红绿修复，最终 27/27 定向、110/110 局部组合、253/253 整体回归、七模块 strict TypeScript/新增两文件 ESLint 与独立 APPROVE，45 文件前后稳定。首轮 242/243 的 Ask agent-entered 2 秒观察超时保留；独立隔离及后续回归未复现，根因未知，不宣称已修复。证据：`docs/reports/2026-10-09-rag-production-receipts.md`。本 helper 对缺少完整 recovery 组合验证的 bundle fail-closed，合法 rescue 验收、真实 trust/time/nonce/WORM/predecessor/机器 gate 仍未完成；固定 `productionAccepted=false`，W2 整项仍 open。
- W2 授权日志/reference 切片：完整 actual-signed execution/recovery 注册、逐写 live checks、原私有 CAS、stage action 闭集、exact retry、pending 撤销和引用语义角色防混用已交付；三个独立 P1 与 fence headroom 均有红绿证据，最终 30/30 定向、140/140 局部组合、283/283 整体回归、八模块 strict TypeScript/新增两文件 ESLint 与独立 APPROVE，47 文件前后稳定。证据：`docs/reports/2026-10-09-rag-authorized-journal.md`。注册+pending 17、撤销 tombstones 64 均有界且耗尽 fail-closed；实际验签的原批准可在过期/吊销后作为 rescue provenance，但不能由声明自举。该内存参考切片不证明持久/跨实例 authority、IAM、真实 writer/readback 或完整 recovery acceptance；所有生产能力/验收标志仍 false，W2 整项 open。
- W2 KMS/store 独立行为探针切片：中立 ports 的 18 个实际 probe、全部 AAD/scope/profile/管理角色、历史 nonce/撤销、重复对象变体、注册 keyRef 交叉替换、拒绝后同 ID/active key/readback 控制与完整 observations core hash 已交付；独立假通过 PoC 均有红绿修复，最终 32/32 定向、172/172 局部组合、315/315 当前 20 文件 hermetic 回归、九模块 strict TypeScript/两文件 ESLint 与独立 APPROVE，50 文件运行前后稳定。中间 253/312 的 59 项 Ask 失败和共享 runtime 新增漂移保留，准确根因未知；后续 Ask 75/75 与完整回归绿色不作为根治证明。证据：`docs/reports/2026-10-09-rag-artifact-conformance.md`。只执行 reference/明确实验室包装，全部 KMS/store 完整 requirements 仍未通过；输出固定 `productionAccepted=false / requirementVerdict=incomplete`，timeout 保留晚到完成未知。真实企业资源/身份/持久性/可信时间及统一完整 conformance 未证明，W2 整项 open。
- W2 journal 独立行为探针切片：18 个实际中立 probe、精确 head/entry binding、并发 CAS+同 ID loser 重试、拒绝后状态/ID 可用性、旧 owner fencing、合法续代、result/已完成 key 语义闭集、同 terminal ID 的最终封存和终态历史 exact retry 已交付；独立假通过 PoC 均有实际红绿证据。同步修复 journal/artifact descriptor `__proto__` map getter 漏洞。最终 Journal 48 + Artifact 33 合并 81/81、十组合同 221/221、当前 21 文件回归复核 364/364、十模块 strict TypeScript/四文件 ESLint 退出 0及四文件精确独立 APPROVE，52 文件前后稳定；3 条非阻断测试 lint warnings 保留。首轮 363/364 的 Ask durable replay EPERM 未在隔离 1/1、Ask 75/75 或后续完整组合复现，根因仍未知，不声明修复。证据：`docs/reports/2026-10-09-rag-journal-conformance.md`。全部 run-journal 完整 requirements 保持未完成，fixture fencing 不冒充生产 authority；输出固定 false/incomplete，无真实企业资源/身份/持久跨实例信任证明，W2 整项 open。
- W2 clock/authorization-nonce 操作端口切片：中立时钟读数/nonce-store ports、有界单实例 reference、challenge/sequence/全误差有效期、issuer+nonce 墓碑（不含 run/kind/digest）、同步原子消费与独立 exact confidential readback 已交付。定向 28/28、十一组合同 249/249、当前 22 文件回归 392/392、十一模块 strict TypeScript/新两文件 ESLint 退出 0及两文件精确独立 APPROVE，54 文件前后稳定；证据 `docs/reports/2026-10-09-rag-authority-ports.md`。测试明确证明良构伪造 clock/approval 标签不是身份认证，且新实例没有共享/重启防重放；ports 固定 `productionCapable=false`，结构校验固定 `productionAuthorized=false`。没有真实 trusted clock/IAM/签名审批组合/持久 nonce authority 或企业 conformance，W2 整项仍 open。
- W2 本地签名/clock/nonce 组合切片：共用实际 Ed25519 stateless verifier、初始与最终全误差时钟检查、独立构造 nonce claim/精确读回、有界串行与不确定提交 halt 已交付；deadline starvation 与消费者 actor 替换 P1 均有实际 RED/GREEN。普通路径绑定 signed executor，恢复要求与全部 signed participants 独立的冻结 actor/role/credential，不以 role 代替主体。最终定向 81/81、十二组合同 289/289、相同 23 文件最终复核 432/432、十二模块 strict TypeScript/四文件 ESLint 与四文件精确独立 APPROVE，56 文件前后稳定；前两次 Ask 10 cancelled、后续 1 fail/10 cancelled + EPERM 均保留，根因未知，隔离 75/75 和最终绿色不作为根治证明。证据 `docs/reports/2026-10-09-rag-authority-approval.md`。没有真实 registry/IAM/JIT、可信时间/在线撤销/持久跨实例 nonce authority 或完整 recovery provenance；生产能力/授权标志固定 false，W2 整项仍 open。
- W2 clock/nonce 独立行为探针切片：17 组实际中立 probe、独立 expected claim/exact readback、scope/profile/reader/challenge、单调时钟、issuer+nonce 墓碑、并发 loser 可用性、全误差有效期、过期/容量及拒绝后正向控制已交付；五类独立假通过 mutant 有实际 RED/GREEN。最终 34/34、四组组合 115/115、十三组合同 323/323、24 文件累计回归 466/466、十三模块 strict TypeScript、新两文件零警告 ESLint 与两文件精确独立 APPROVE，58 文件运行前后无漂移。首轮累计 465/466 的既有 approval timeout pending 标志失败保留，真实 phase/根因未知，不声明根治；证据 `docs/reports/2026-10-09-rag-authority-conformance.md`。本地行为输出固定 `productionAccepted=false / requirementVerdict=incomplete`，不证明真实 IAM/可信时间/在线撤销/持久跨实例 nonce 或完整企业 conformance，W2 整项仍 open。
- W2 统一 provider 调用边界切片：四消费者共用有界调用器，实际 RED/GREEN 修复同步超预算假通过、thenable/Promise metadata、descriptor 比较与 async payload 二次 adoption；非法 carrier 统一 UNKNOWN，negative probe 不误计拒绝，approval halt。四个 pending timeout 测试保留 20 ms 并明确 phase/barrier，真实 elapsed 及 settled phase 独立验证，历史未知失败不抹除。最终 payload 定向 9/9、五文件独立定向 188/188、十四合同 358/358、25 文件累计 501/501、strict14/十文件零警告 lint 与十文件精确独立 APPROVE，60 文件运行前后无漂移；证据 `docs/reports/2026-10-09-rag-bounded-provider-call.md`。不提供同进程沙箱/取消/回滚，不证明企业 authority 或整个 W2；生产标志仍 false，W2 整项 open。
- W2 registry 精确读回消费链切片：新增中立 readExactPolicy port、实例受限只读 reference registry、独立 expectation 的 exact context/challenge/source/policy 验证；每次重新读回后执行实际 Ed25519 provider trust，无成功缓存/fallback。验证 busy/capacity、单调 caller time、快照与 UNKNOWN halt；enterprise 标签仍只提供结构校验，所有 reference production flags false。最终定向 18/18、十五合同 376/376、26 文件累计 519/519、strict15/两文件零警告 lint 与两文件精确独立 APPROVE，62 文件运行前后无漂移；证据 `docs/reports/2026-10-09-rag-provider-registry-readback.md`。没有企业 IAM、可信时间、在线撤销/持久 replay authority、完整 behavioral suite 或生产 runner 集成，W2 整项仍 open。
- W2 authority-aware 回执实读组合：registry/trust、稳定 journal 全链、独立 store/KMS 及实际结果签名/clock/nonce 消费链已实现；封存过期与后发 provider 资格追认两个 P1 有实际 RED/GREEN。定向 68/68、十六合同 396/396、strict16/五文件零警告 lint 与五文件精确独立 APPROVE，65 文件前后无漂移。累计当前明确未通过：首轮 Ask 30000 ms 取消、隔离复现及两次 lint 90000 ms 超时；加载诊断绿色后原命令复核为 538/539，既有 durable replay HTTP 500/200 不符，根因仍未知，不无依据重试或声称全仓稳定。证据 `docs/reports/2026-10-09-rag-authority-receipts.md`。此组件不验证 machine gate、predecessor/recovery 和长跑周期证明，输出固定 false/incomplete，W2 整项 open。
- W2 receipt writer 调用边界：复用统一有界调用器，四阶段 native Promise/payload detach、预算、UNKNOWN/累计 mutation/禁止自动 retry 已实现；独立提出的实际提交后语义错误 P1 有 RED/GREEN，五类语义检查归入相同阶段边界。最终定向 9/9、五文件组合 121/121、strict16/七文件零警告 lint、两文件精确独立 APPROVE（独立 36/36），65 文件前后无漂移。扩大回归仍未通过：十六合同 385 passed/1 cancelled，27 文件453 passed/2 cancelled；journal 30秒超时在完整文件隔离33 passed/1 cancelled复现，但两个pending/concurrent leaf各1/1，根因未证实，不把leaf绿色替代整文件验收。证据 `docs/reports/2026-10-09-rag-receipt-writer-boundary.md`。仅补局部 writer 调用边界，未实现生产写入 authority、完整 W2 或实例间恢复/取消，生产标志仍 false。
- W2 journal 不可变读回工作量切片：原预算 TAP/同步 hook/CPU 采样支持累计工作量与输出缓冲解释，不把缺少 TAP 当 leaf 死锁。只复用 admission 已私有验证/deep-freeze 的 reference head/entries，并移除 invoke 后消费者重复 snapshot；实际 RED/GREEN 7→0 与 4→3，保留入站 detach、独立 equality/完整链验证、undefined 分类与所有生产 false 标志。最终定向 3/3、strict16/lint11 退出0、local16 408/408、cumulative27 551/551，65 文件前后无漂移；四文件精确独立终审 APPROVE（独立3/3、62/62、strict16与lint4）。相同最终快照较早 journal 隔离仍35 passed/1 cancelled；第一候选 journal/Ask timeout、nonce 提前失败与旧 Ask 500/200 等历史记录全部保留，不宣称环境根治。第一候选 snapshot64漏fixture 已公开区分，最终明确路径恢复65。证据 `docs/reports/2026-10-09-rag-journal-readback-work.md`。W2 整项不记完成。
- W2 私有 execution-session/authority-aware sealing 切片：运行前 actual signature/clock/registry+nonce consume/exact claim readback、稳定空 journal、私有 startNotBefore 与终态完整链、逐 crypto/store 操作前 live checks、实际 clock 派生 sealedAt、UNKNOWN/写后失败 halt 已实现；journal IO 跨过期和重叠 uncertainty verifier 假倒退两个实际 RED/GREEN 已修复。新定向19/19、strict16/lint2退出0、local17 427/427、cumulative28 570/570，66文件前后无漂移；安全/code 与 TypeScript 两项精确身份独立 APPROVE（独立39/39与strict16/lint2）。保留 strip-only 参数属性错误及历史未知失败。证据 `docs/reports/2026-10-10-rag-authority-receipt-writer.md`。执行 nonce 只在 begin 消费，不在 seal 重消费；无企业身份/可信时间/WORM、完整 manifest、machine gate、predecessor/recovery/长跑续期证明，全部生产/完整验收标志 false，W2 整项 open。
- W2 完整 manifest/authority receipt 绑定切片：新增 raw manifest 与独立 expected execution 的精确绑定，版本化 thresholds projection、九项 derived core identities、T17 window/roles、predecessor 精确 ref 与 R18 原冻结 refs；writer/reader 在 crypto/store/result approval IO 前拒绝错绑定，新入口不接受手填 identities 或假授权 view。新10/10、local18 437/437、strict16/lint8退出0；累计首轮579/580出现既有Ask replacement POST 503/200，隔离leaf1/1、完整Ask75/75、原样累计复跑580/580，根因未知不称修复。69文件前后无漂移，两项精确身份独立APPROVE（独立66/66与strict16/lint8）。fixture提取、unused import lint 与验证编排ENOENT均保留。证据 `docs/reports/2026-10-10-rag-manifest-authority-binding.md`。这里只证明manifest对应与local reference组合，不证明独立企业manifest authority、前驱验收、真实retention/recovery/续期或computed machine gate，全部生产/完整验收标志false，W2整项open。
- W2 历史 approval exact-claim provenance 基础：新增只读 `verifyExistingClaim`，actual historical signature/key 全误差有效性、独立expectedClaim/ref digest派生、actual exact nonce readback、前后fresh clock/顺序/序列、safe capture/UNKNOWN halt已实现；共享旧consumer职责检查，旧nonce不重消费，三个authorization/consumption标志false。新13/13、strict16/lint2退出0、local19 450/450、cumulative30 593/593，70文件前后无漂移；两项精确身份独立APPROVE（独立57/57与strict16/lint2）。保留首expanded13的fixture冻结ref修改错误、barrier未释放异步超时及所有历史未知失败。证据 `docs/reports/2026-10-10-rag-approval-provenance.md`。只补完整前驱读回所需底层能力，未接入完整predecessor bundle/机器gate、企业信任/在线撤销或续期；构造兼容并暂存optional consume方法但从不dispatch，不冒称独立只读IAM，W2整项仍open。
- W2 既有 receipt authority 完整只读观察链路：普通与 manifest-aware reader 新增独立 `verifyExistingBundle`，复用实际 registry/稳定完整 journal/exact encrypted store/AEAD core/actual signatures/独立 result payload 与最终全误差 provider/retention 检查；历史分支 actual exact claim provenance，不重消费/不续权，两入口共享 busy/halt/attempt budget，正常入口仍一次性消费且拒绝 caller skip/history/decision 标签。中间14/464/607全绿后，独立审查实际发现跨入口clock cursor的HIGH；3项真实RED，内部pair共享实际validated seq/time/challenge cursor后定向104/104，最终新17/17、strict16/lint3退出0、local20 467/467、cumulative31 610/610，71文件前后无漂移，新3SHA两项独立终审APPROVE（独立104/104+原PoC拒绝/nonce2→2，及strict16/lint3）。证据 `docs/reports/2026-10-10-rag-existing-receipt-readback.md`。保留HIGH/3红测、重构同步抛错31/32（恢复async后32/32）、同步string fixture合同13/14（修正后14/14）及所有历史未知失败。完整前驱阶段衔接、computed machine gate、企业信任/IAM、recovery/renewal/实际elapsed仍未完成，全部生产/完整验收标志false，W2整项open。
- W2 冻结前驱 bundle 的真实物理对象衔接：新增独立 `createReferencePredecessorReceiptVerifier`，T17→T16/R18→T17 实际 manifest/stage/scope/hash 绑定，logical plaintext ref 与 ciphertext storage ref 同 ID/version 不同 digest；候选内容先匹配冻结 hash，实际 exact store/proof/AEAD 解密后复用完整历史 authority reader，不重消费 nonce。R18 逐项绑定实际 T17 整个 frozenRetention；共享 lock/budget/halt、UNKNOWN 迟到完成阻断。额外真实时序 RED 0/1 暴露 bundle 创建时间早于 actual original approval，修复为完整 uncertainty 上界早于 T17 窗口。最终新增19/19、strict16/lint2退出0、local21 486/486、cumulative32 629/629、72文件无漂移；新2SHA两项独立终审APPROVE（功能独立98/98，TS strict16/lint2）。证据 `docs/reports/2026-10-10-rag-predecessor-bundle-readback.md`。保留0/17、14/17、16/17夹具定位及所有历史未知失败，不改原测试条件。本切片不是完整递归前驱验收或 computed machine gate；productionAccepted/stageAcceptanceComplete/executionAuthorized/machineGateComputed/predecessorChainComplete 均false，W2整项open。
- W2 私有 authority 会话实际 bundle sealing：普通/manifest writer 新增只接受 actual resultEnvelope 的 sealBundle，复用私有已封存 core/journal/clock/nonce verifier；独立 result signature/actual nonce 后实际 AEAD 封存并逐个 exact store/read-only decrypt result、core proof 与 bundle，可直接接入历史与冻结前驱 observer，无夹具手工 persistence。独立审查提出 actual completion 与最小会话 challenge 预算疑点，主 agent 两项真实 RED 0/1 后修复为 core actual completion 全误差上界与有界完整 session 80 challenges；原 approval max1 仍拒绝 result/no 重建。最终新19/19、strict16/lint3退出0、local22 505/505、cumulative33 648/648、73文件无漂移，新3SHA两项独立终审APPROVE（功能97/97与actual时序拒绝，TS strict16/lint3）。证据 `docs/reports/2026-10-10-rag-authority-bundle-writer.md`。保留首次16/502/645中间绿色、真实两红测与18/19初始uncertainty夹具错误；未知历史失败不抹除。所有production/stageAcceptanceComplete/machineGateComputed均false，W2整项open。
- W2 provider evidence 实际读取/reference 切片：新增中立证据 readback port、受限内存 fixture store 和只接受闭集 {} 的 verifier；从实际 registry/clock/证据 callback 读取精确 certificate/runtime，核对 source/challenge/selector/object 与独立角色签名，fresh completion 全误差校验、跨调用实际时钟与有界 challenge、UNKNOWN halt，无 caller 对象/时间/缓存成功替代。真实对象版本别名 RED 0/1 后预留所有 future certificate 并拒绝 current/future/runtime ID/version 混用。最终21/21、strict17/lint3退出0、local23 526/526、cumulative34 669/669、75文件无漂移；新3SHA两项独立终审APPROVE（功能/安全68/68，TS strict17/lint3），审前后一致。证据 `docs/reports/2026-10-10-rag-provider-evidence-readback.md`。保留入口缺失 RED、别名 RED、首次 lint 未使用 import 失败及所有历史未知失败。旧 trust/writer 未接新入口，fixture store 不测量企业进程；productionAuthorized/stageAcceptanceComplete/behavioralConformanceComplete/conformanceSourceAuthenticated/runtimeSourceAuthenticated 均false，W2整项open。
- W5 独立核心增量（2026-10-10，完整证据见 `docs/reports/2026-10-10-rag-publication-identity-readback.md`）：依赖已完成 W1，新增 frozen PublicationIdentity、三来源只读 ports 与受限内存 reference sources/reader；从实际 callbacks 验证 PG Pointer/acknowledged Outbox/published BuildJob、Neo4j Pointer/active Snapshot 的 scope/version/revision/artifact/doc 集合、Milvus 精确行/chunk/content 与 collection/schema/index manifest。两次完整分页扫描和新 graph barriers 仅证明本地观察一致性，production/stage/sourceAuthenticated/linearizable 标志全部 false，不是跨库原子快照。实际 future-ack RED 后补 completion uncertainty 下界；补审独立复现同值 hash 接受缺失 manifest 的原8值漏洞，撤回旧 APPROVE，再建立实际 RED 并在每页读取端补非空 record 最低结构检查（新12值负测），不以 fixture 防护或伪造 SDK 字段替代后端语义。最终 publication24/24、strict18/lint2、local24 文件550/550、cumulative35 文件693/693、77文件 drift=[]；修复后独立功能/安全复审44/44、bounded APPROVE；串行TS专项独立strict18/lint2 exit=0、bounded APPROVE，两轮审前后源码/测试SHA均与最终报告一致。首次既有 Ask 容量用例第一个请求500/200导致691/692失败，原预算隔离1/1及同身份692/692复核均保留，未知根因不因后续693绿色而宣称修复。W5 仍 open：实际 SQL/Cypher/Milvus SDK 只读 adapters、BuildJob/document manifest 持久关系、SDK schema/index 必需语义、artifact/registry/evidence/runner 接入和完整独立 conformance 均未完成；active publication core 不冒充空/deactivated baseline 或真实生产支持。
- 当前下一工作在实际 authority bundle sealing、前驱物理对象链接和 provider evidence 实际 callback 读取基础上继续 W2 剩余共同 operation ports、实际 measured-runtime/入口接入、各 purpose/完整独立 behavioral harness，按依赖完成 frozen-policy recovery/新 fence/独立 rescue principal、周期续期证明组合，以及 W4 computed machine gate/完整递归前驱阶段验收、其余权威 approval/time/revocation/nonce 与 trust/registry；同时在上述 W5 core 基础上完成实际只读 backend adapters、持久文档清单、artifact/evidence/runner 接入和完整独立 conformance。局部回归和审查不能代替完整 machine gate 或生产验收；首轮Ask及历史失败仍单列保留，不缩减完整目标；本地组件不替代企业信任。W3-W9、T16/T17/R18 仍开放，18 项端到端 AC 尚不标记通过。

- W5 PostgreSQL native 业务数据增量（2026-10-10，证据 `docs/reports/2026-10-10-rag-postgres-publication-readback.md`）：新增完整 closed BuildJob publicationManifest 和实际单 SELECT Pointer/acknowledged Outbox/published BuildJob 回读；worker 从实际全量 Snapshot 获取并核对清单，同 UPDATE 绑定 scope/version/digest 与实际租约。真实 PG17 RED 揭示 acknowledgement 微秒截断和过期/事务内到期租约，改为保守 CEIL 毫秒及 clock_timestamp guard；隔离随机租户 fixture 全部事务回滚并读回 count=0，无 DDL/role/global claim。独立初审实际发现 getter 注入 reserved metadata、ASCII 文档标识兼容回归，后续 TS 又发现 digest getter 两读漂移；主 agent 均建立实际 RED，修复 detached canonical metadata、沿既有 opaque 文档合同和 digest 单次观测绑定，三项 HIGH 保留失败证据并按新SHA关闭，不用44/746、48/750中间绿色替代终审。最终窄49/49、真实PG3/3、strict22/lint10、保留原35+新增6的累计41文件751/751、91文件drift=[]；功能49前一轮48/48及最终delta16/16、TS strict22/lint10串行独立boundedAPPROVE，10files审前后身份一致。productionCapable=false，environment仅本地标签，业务adapter不是Source proof/独立IAM/跨库快照。W5仍open：Neo4j/Milvus实际adapters、SDK必需语义、native→proof私有绑定、registry/evidence/artifact/runner和完整conformance未完成；此租约guard不证明多连接锁等待到期或完整W6。计划2/13、11open、18AC未勾选，历史未知Ask/approval失败保留，无commit/push/生产变更。

- W5 Neo4j/Milvus native 业务回读与容量增量（2026-10-10，证据 `docs/reports/2026-10-10-rag-neo4j-milvus-publication-readback.md`）：两类实际 SDK adapter 回读实际完整 scope 数据、SDK schema/index 必需语义、opaque 身份和 core 两遍 65K 短行容量已实现。多轮独立 HIGH 均实际 RED 后修复，最终 Neo44/Milvus18/core28=90/90，strict24/lint18 exit0，真实 Neo4j4/Milvus2/PG3 均通过；新精确身份各串行功能/TS bounded APPROVE。累积43仍失败：807/808 的旧 Ask 首次 POST503 和随后816/817的取消 fixture signal2秒未到均保留；隔离与原 Ask75绿色不作为根因修复，97文件drift=[]。native→私有 source factory 两文件已实现且14/14（fake SDK两遍65K/1028proof）及双审通过，但 reader 首次 owned UNKNOWN reason 遗失已实际RED，正进行下一轮最小修复；该 factory 不是企业來源认证。W5整项仍open，registry/evidence/artifact/runner/完整conformance、实际大库存和空/deactivated baseline未闭合；计划2/13、11open、18AC不变，无commit/push/生产切流。以此最新状态续接上述历史“尚未实现”条目，不改写旧时点事实。

- W5 native→source→reader UNKNOWN及真实三库组合增量（2026-10-10，证据 `docs/reports/2026-10-10-rag-native-publication-sources.md`）：实际owned UNKNOWN reason遗失和随后20ms/80ms截止降级MEDIUM均先RED再最小修复，默认bounded API仍不保留raw reason，opt-in只保留私有引用，constructor登记仅可保守halt而非认证；新exact6功能70/70与TS strict3/lint6/70/70串行bounded APPROVE。Mil唯一BigInt语法等值修复消除真实项目ES2017 TS2737，原8入口/35源码project strict0；新exact3功能/TS各18/18和syntax/lint通过且独立bounded APPROVE，不沿用旧依赖SHA。真实同identity三库新联测先1/2及正向诊断0/1，三处prototype-sensitive Oracle改精确canonical编码后原完整2/2通过：两fresh完整扫描、四barriers、8proofs及same-scope额外版本拒绝，正反cleanup实查PG六项0、Neo0、owned Mil集合不存在；分别PG3/Neo4/Mil2的先行实际集成及新Mil2均另列，不把相加当组合证明。最新projectStrict25/lint23/窄132均通过，但保留原35的44文件累积841/842：旧Ask同完整性fixture首次POST500/200，100文件drift=[]，既有503及取消signal2s和本次500原因仍unknown，绿色不冒充根治。当前只读诊断该失败并按依赖继续W5 artifact/registry/evidence/runner/完整conformance及空/deactivated baseline；企业origin/IAM/跨库原子/实际65K库存均未证明。W5整项open、计划2/13/11open/18AC不变，无commit/push/生产切流；本条续接而不改写上述旧时点事实。

- W5 isolated active-view conformance进行中（2026-10-13，证据 `docs/reports/2026-10-10-rag-publication-conformance.md`）：沿已有publication-readback purpose/八formal requirements新增固定场景runner，私有构造whole reader而非caller自报decision，readonly-state固定not-run/全部requirements incomplete/productionAcceptedfalse。原9先0/9再9/9且真实ES2017类型RED保留；独立功能审查实证HIGH整体截止后后台继续派发和MEDIUM四负场景alias，未批准。四持久RED0/4后per-reader闭合/单调deadline同步派发gate使三HIGH用例通过；全unit12/13、ES2017strict/lint2通过、新两SHA稳定，随后功能/TS两项精确HIGH专项通过，整体仍WARNING，MEDIUM未关闭。旧72071结果handle缺失且查无相同活进程，未收到141/851不补计完成。后续真实scenario witness/完整状态observer/制品证据链仍需完成，不能以读取次数或局部绿色简化证明。W5整项open，2/13、11open、18AC不变，原Ask首次500/503/取消信号偶发失败原因仍unknown；全部Goal及生产外部前置保留，无commit/push/生产切流。

- W5 具名反例全量见证增量（2026-10-13，同报告）：新增独立 raw sources/clock 的完整PG/Neo投影及全部Milvus分页 observer，与实际whole reader前后绑定稳定性；baseline实际decision完整identity/manifest绑定，extra严格保全原行并增加完整新版本组，missing非空真子集、empty恰为空、deactivated只允许Neo active→inactive，恢复完整等于baseline。八持久MEDIUM反例实跑0/8后8/8，新observer0/16后扩展20/20；冻结组合40/40，包含原HIGH迟到PG/clock/CPU三例且不将额外witness替代whole两遍扫描。组合strict27与独立TS审查实际复现ports类型TS2345 RED，仅恢复inputPorts:unknown+删除unusedtypeimports（runtime/Oracle零变化）后实际consumer+observer strict/lint2及20/20通过；新4身份功能/TS各40/40与额外反例、真实项目ES2017strict/syntax/lint4通过，两项独立限定APPROVE、各4SHA前后无漂移，MEDIUM关闭，非完整W5批准。主流程strict27/lint27退出0；首轮46实际868pass/0fail/1cancel（旧native unit原30s文件超时），隔离旧native14/14与历史17s一致，保留未知。最新原46实际880/882：旧Ask容量fixture首次POST500/200、generation cleanup fixture首次POST503/200，0cancel/skip，104文件无漂移；正只读捕获脱敏错误链，不以重跑绿色或全局日志作根治证明。64MiB完整65536长中文行拒绝仅纯内存容量边界，>256KiB串流不成功截断；不认证真实库库存/IAM/origin/跨库原子，read-only固定not-run、八formal requirements仍incomplete，后续完整状态测量/制品/registry/evidence/runner与正向空基线仍需完成，W5与全部Goal继续open，2/13、11open、18AC不变，无commit/push/生产变更。

- 上述W5生命周期新精确两SHA随后完成两项独立专项复核（2026-10-13）：功能原13项12/13、449.6507ms及原PG PoC关闭后额外dispatch0；TS真实ES2017单入口22非声明源strict0/syntax/lint2通过、原13项12/13、430.865ms，四late-rejection/getter/Proxy探针4/4、hooks0/dispatch0/unhandled0/UNKNOWNtrue。两轮各自审前后SHA稳定，HIGH按限定范围关闭；整体仍WARNING，MEDIUM alias未关闭、全requirements incomplete、readonly-state not-run，不将剩余1fail视为通过。正在按完整具名实际状态与fresh绑定设计scenario witness，后续source新身份重新完整验证；任务数/AC/Goal及生产外部前置不变。

| Task | 工作 | 依赖 | 风险 | 完成证据 |
|---|---|---|---|---|
| W0 | 冻结现有 RagEval、Ask、Graph CAS、Evidence 与 IndexedDB 行为基线；先补失败测试 | 无 | L2 | 基线测试清单；新测试先红后绿 |
| W1 | 实现分阶段 manifest、arm descriptor、`SideEffectPolicy`、闭集 `FaultPlan`、`SafetyRecoveryPolicy`、冻结 retention 扩展、规范化 hash、不可放宽 hard gate 和 `validateForT16/T17/Retention` | W0 | L3 | 阶段缺字段、篡改、审批失效、跨阶段自循环、arm 非批准差异、FaultPlan/RecoveryPolicy 越界、retention 事后替换和安全阈值调宽负测 |
| W2 | 实现全部 provider-neutral ports 的共同 trust/conformance 基础、`RunJournalStorePort` 与受限 reference adapters、受控制品索引、execution/result/recovery envelope、无环 receiptCore/acceptanceBundle、CAS/hash-chain journal 与 writer/validator | W1 | L4 | envelope 不可互换与 recovery 单调降风险、自引用/core-bundle 混淆/object-version 替换、journal 修改/截断/重排/fork/旧 fence 注入、intent/result 崩溃边界、signer/角色/密钥/吊销/时间/nonce/重放、独立 harness、防篡改 readback、AEAD/AAD swap、路径/链接/TOCTOU、泄漏和删除负测 |
| W3 | 实现受部署侧 origin allowlist 约束的 canonical Ask target 与同 roster `off`/`shadow` runner | W1、W2 | L4 | SSRF/DNS rebinding/跨源重定向/TLS/代理/压缩炸弹/超时测试、隔离 E2E、逐例机密 hash/index |
| W4 | 实现 manifest 驱动的 T16 `off`/`shadow` SideEffectPolicy gate 与 T17 `off`/`active` 放量前质量 gate，并统一执行不可放宽安全 hard gate 与阶段独立的可配置质量/延迟 gate | W3 | L3 | T16 pre/post mutation readback、T17 arm identity/mode readback、阈值边界、逐例配对、立即终止、失败分类、遗漏安全指标及机器 verdict |
| W5 | 实现 PublicationIdentity 及 PG Pointer/Outbox/BuildJob、Neo4j Snapshot、Milvus exact rows/index manifest 的统一只读 readback | W1 | L4 | 本地三存储关系测试；scope/集合/chunk/version/digest/revision 不一致与超集/子集负测 |
| W6 | 实现 `DistributedScopeLeasePort/FencingAuthorityPort`、`DeploymentModeControlPort`、`TrafficControlPort`、`FaultControlPort` 及受限 reference adapters；完成 lease renewal/fencing、stage-aware runner、lineage+fencing CAS、Outbox、RampPlan、FaultPlan、流量/fault TTL deadman、幂等 resume 与需 SafetyRecoveryAuthorization 的新 generation rescue/off-first 回滚 | W2、W4、W5 | L4 | 双 orchestrator/网络分区/续租竞态/失锁/stale token、owner 崩溃后流量自动归零/fault 自动撤销、原 auth 过期/吊销/窗口关闭、recovery auth 缺失/过期/跨 scope/跨 lineage、rescue 尝试激活/加流/新 fault 拒绝、journal/live-state 不一致、每级 ramp、CAS 后崩溃、回滚和终态缺失测试 |
| W7 | 实现在 T17 授权时冻结 retentionPolicy 与旧 Store identity 的 checker、机密制品删除/crypto-shred 与清理前门禁 | W1、W2 | L3 | 政策/Store 被替换、起止、可信时钟、后继发布、回滚重置、legal hold、对象版本/缓存/replica/backup 与未满周期拒绝测试 |
| W8 | 实现标准 Ask/agent 结构化引用、服务端诊断、`CitationLocatorCodec/StorePort`、权威 served-ID 映射、最小 IndexedDB 持久化和当前主体重新授权的内部预览 | W0、W2 | L3 | 随机句柄/AEAD、跨重启/多实例/环境重放、TTL/maxTTL、未知/吊销 key、轮换边界、store/keyring 中断、普通 Ask/agent/无引用、重复合法编号、非法 ID、Markdown、历史迁移、账号切换、权限撤销、tombstone/删除后缓存、恶意元数据和跨租户点击测试 |
| W9 | 全量集成、安全审查、构建、Runbook、本地 reference adapter conformance 与操作演练；明确真实企业 adapters 为外部前置 | W2-W8 | L4 | TypeScript/ESLint/定向与全量测试、生产构建、本地 Docker E2E、ports/reference adapters conformance、独立代码/架构/安全复审 |
| T16 | 使用通过独立 conformance 的真实企业 adapters 与有效 T16 execution authorization 执行 `off`/`shadow`，验证 SideEffectPolicy 与 Graph 候选诊断，封存 receiptCore 后取得独立 result attestation 并组装 acceptanceBundle | W9 + 全部 T16 外部输入 | L4 | pre/post side-effect readback、cache hit/miss、受控制品、arm readback、paired Shadow report、machine verdict、三层验收对象、真实 provider/registry identity、防篡改证明和零泄漏 |
| T17 | 消费有效 T16 acceptanceBundle，以 T17 authorization 与冻结 SafetyRecoveryPolicy 取得 scope lease/fencing；按冻结 arms/RampPlan/FaultPlan 完成零流量激活、放量前门禁、灰度、降级、摘流、受限 rescue、回滚和 PublicationIdentity readback，再组装 T17 acceptanceBundle | T16 + 全部 T17 外部输入/维护窗口 | L4 | arm/build/model/index/config/mode identity、lease/fencing、journal root/count、逐级权重/dwell/sample/SLO/TTL、FaultPlan 自动撤销、失锁自动零流量、适用的 SafetyRecoveryAuthorization/JIT 身份、rescue action、三层验收对象、最终 off/稳定 Pointer 与完整 readback |
| R18 | 只按 T17 authorization 已冻结的 retentionPolicyHash 与 oldStoreManifestHash 验证完整发布周期，不执行清理；封存 receiptCore 后取得独立 result attestation 并组装 acceptanceBundle | 有效 T17 acceptanceBundle + 冻结 Retention extension + 可信时间/后继发布证据 + R18 execution authorization | L3 | policy/store hash 精确匹配、回滚重置、时钟、legal hold、后继发布和事后换政策负测；三层验收对象；清理仍需 Goal 外独立授权 |

依赖顺序：W0 → W1；W1 后执行 W2、W5；W2 后按未完成依赖执行 W3、W7、W8；W3 → W4；W2+W4+W5 → W6；W2-W8 全部完成后由 W9 汇总。共享工作树及 L3/L4 任务串行执行。W0-W9 只交付 provider-neutral ports、受限 reference adapters、独立 conformance harness/suite 和本地证据，不自行冒充企业 provider。T16 只消费有效 T16 authorization；T17 只消费有效 T16 acceptanceBundle 与 T17 authorization；R18 只消费有效 T17 acceptanceBundle、T17 时已冻结的 policy/store hash、经过时间证据与 R18 authorization。三阶段严格串行，不得与本地开发证据混淆。

## 5. 预计修改边界

优先复用而非复制现有能力，实际文件名在 Work 阶段以当前代码结构为准：

- `src/lib/rag/eval/**`：分阶段 manifest、arm、production target、runner、hard/configurable gate、journal、receiptCore 与 acceptanceBundle 合同。
- `scripts/**`：production gate 与 T17 编排 CLI；默认 dry-run，生产 mutation 需有效阶段审批、JIT 最小权限身份和专用 canary readback。
- `src/lib/knowledge-graph/**`、`src/lib/rag/storage/**`：PublicationIdentity、统一只读 readback、lineage 与幂等编排；不开放任意数据库查询。
- provider ports/reference adapters：实现第 3.4 节列出的 provider-neutral 接口、production-profile fail-closed 与统一 conformance harness；只暴露专用 canary 的零流量、模式切换/recreate、闭集 fault 和权威 readback，不包含真实企业 provider 实现。
- `src/app/api/**`、`src/app/page.tsx`、`src/components/ChatMessage.tsx`、`src/lib/indexeddb.ts`：标准/agent 引用输出、CitationLocator、最小持久化、诊断和当前主体重新授权的内部来源预览。
- `docs/runbooks/**`：经过测试的 operator 命令、JIT 权限、停止条件、崩溃恢复、回滚和机密证据定位。

禁止把生产凭据、完整 env、原始生产请求/响应、gold、用户数据、受控索引或可关联 hash 加入 Git。

### 5.1 文件级实施边界与 AC 引用

以下新增文件名以已核对的代码结构为基线；Work 如需调整位置，应先记录原因，禁止复制已有能力或覆盖无关脏更改。所有 L3/L4 任务串行推进，不标记 `[P]`。没有用户为本 Sprint 选择 Harness，不启动或绑定外部 Harness。

| Task | 文件 / 模块边界 | AC 引用 |
|---|---|---|
| W0 | `docs/reports/2026-10-09-rag-production-baseline.md`；现有 RagEval、Ask route/runtime、Graph CAS、context/Evidence 测试；新增 W1 红测 | AC-1、AC-14～AC-16 |
| W1 | 新增 `src/lib/rag/eval/canonical-json.ts`、`production-gate-manifest.ts` 与对应 `.test.mjs`；不改现有 dataset hash 与 runner 语义 | AC-1、AC-2、AC-4、AC-8～AC-11、AC-17 |
| W2 | 新增 eval 域的 `production-gate-ports`、`production-receipts`、`production-run-journal`、受限 reference adapter/conformance 模块及测试 | AC-3、AC-6～AC-8、AC-13、AC-18 |
| W3 | 新增 `production-ask-target`、`production-ask-runner` 及出站安全/数据保护合同测试，复用既有 request validation | AC-2、AC-3、AC-5 |
| W4 | 新增 `production-stage-gate` 与 tests；复用已有 metrics，不放宽现有 safety gate | AC-4、AC-5、AC-7、AC-9 |
| W5 | `src/lib/knowledge-graph/publication-identity` 与 tests；适配现有 PG/Neo4j/Milvus 只读 ports | AC-8、AC-13 |
| W6 | eval 域 `production-canary-runner`、lease/fencing/traffic/fault reference ports、受限 CLI 与 tests | AC-8～AC-13 |
| W7 | eval 域 `production-retention` 与 tests；清理实际执行仍需 Goal 外授权 | AC-17、AC-18 |
| W8 | 新增 `src/lib/rag/citations/**`、内部预览路由；在现有 `src/app/api/ask/runtime.ts`、route、`src/lib/indexeddb.ts`、`src/components/ChatMessage.tsx`、page 串行集成并保留其他任务更改 | AC-14～AC-16 |
| W9 | 定向/全量测试、类型/ESLint/build、conformance、`docs/runbooks/**` 与独立复审 | AC-1～AC-18 |
| T16 | W9 交付的 runner/validator/ports 与真实外部输入，不引入替代 fixture | AC-2～AC-7 |
| T17 | 已冻结 canary/lease/ramp/fault/recovery 合同及真实维护窗口 | AC-8～AC-13、AC-17 |
| R18 | 冻结 retention policy/store identity 与真实时间证据，仅验收不清理 | AC-18 |

最窄反馈环：先运行已有基线测试并记录实际结果，再新增 `canonical-json.test.mjs` / `production-gate-manifest.test.mjs` 红测，随后实现 W1。已有 `production-policy-contract` 明确为 hermetic/control-plane-only，不能替代生产门禁。

旧native取消专项采样（2026-10-14）：保持原30s/90s、完整14tests和65,536两遍扫描，仅singlefile CPU profiler一次，实际14/14/status0/17874.5735ms、五SHA无漂移；原profile612389B/SHA b94dfce3…、11652样本显示fake SDK query/filter3806、structured clone2892、canonical2431、Milvus1214为主要leaf位置。并发CPU竞争是推断，原累计cancel错误仍unknown；不降低库存/扫描/预算、不改mock求绿、不记旧故障修复。采样和证据保留在报告，进程全部终态；下一W3实际producer/transport/完整oracle链等依赖继续，默认仍非生产，任务/AC/Goal状态不变。

## 6. 验证策略

### W4 实际完整人口阈值比较实施边界（2026-10-14）

完整原始读回封存接续边界（2026-10-16）：根串行 owner 新 `production-shadow-artifact-framing.ts`、现有 Ask writer 的私有共享加密/独立exact-read/decrypt内核和独立 shadow factory、原 side-effect runner 的私有实际接入及原 paired/native tests。沿原已批准 `readback-proof` 类型，不改 CONTROLLED_ARTIFACT_TYPES/AAD/manifest/Oracle：receipt 的 `(readback-proof,null,0)` 保留，新完整状态分片固定使用 ordinal `1+observationIndex*128+partIndex`（0..4999观测、最多128片、1..640000），与 Ask 的五正文类型及 receipt 0 分离。原64KiB片/8MiB完整数据/200000nodes/256条index/1000000 ordinal/10000 provider寿命/同一授权窗口与budget不放宽；无caller factory/proof成功替代，真正受控KMS/seal/独立readOnly exact-read/完整decrypt及fresh clock执行。完整26实际状态读回与各分片索引进入私有原sampler的外层proof；Source IAM、企业认证和普通缓存等价定义仍false/缺项，制品封存不是生产许可。先持久缺接口与实际未封存RED，再最窄→原类型/lint/相关完整合同→三面独立复审→原完整回归/报告，不修改原18AC或2/13、不挪用原正文/receipt槽、不动无关dirty/staged/Harness/pointer/contract revision。

完整原始读回接续终态（2026-10-16）：实际完整26状态观测→私有固定framer→原共享KMS/seal/独立exact-read/decrypt/fresh clock，全部分片索引/hash进入完整外层proof；rawReadbacksEncryptedAndMatched只在完整实际消费后为true，移除本地raw-artifacts-not-sealed缺项，不升级source/production/stage/machine/SideEffectPolicy。comparisonWindow明确first-to-last-source-observation，末次源观测早于其自身审计封存；观察到的audit delta与终态archive proof分开，不伪造全执行副作用总量。真实8tests/1baseline pass/7fail RED→首版7/8，owned archive错误被generic覆写实证后保留firstFault→8/8，再10/10。功能/安全共同HIGH：每raw archive callback没有父source-window gate；首夹具未到延迟点不记实证，改按真实grant/window交集后实际encrypt74/预期0 RED，复用当前observe.check于每callback同栈并取有效时间交集后1/1；初始clock读取耗时另实际readback26/预期0 RED，clockRequestedAt计入有效区间且不收缩原独立timeout预算后1/1。

最终五SHA framer1c084dd6/writer5d2069eb/source6c1e58b6/pairedTest8489cc29/nativeTest6ab51863，功能/安全最终五身份只读审前后stable，两面限定APPROVE/HIGH关闭；TS五??/普通diff空与全仓门禁STOP，未语义批准。最终原相关7文件194/194，UTC02:39:05.412–33.033Z、27577.0956ms/status0；actual12roots979sources/43非声明strict0、原CLI18 errors/warnings/fatal0、18freeze[]。旧1b51/36b五身份正常60一次1186/1187 HTTP500/预期200/testCodeFailure，映射原Ask route:1883 durable-agent重放首POST，原因unknown。最终新五身份原60一次1185pass/0fail/1cancel（1186tests），UTC02:44:09.702–46.209Z、36463.6177ms/status1，实际native HTTPS文件testTimeoutFailure、143freeze[]/parent75006 terminal1/drained；原44源码actual45roots1483sources/91非声明strict0、原CLI62全0，30s/90s/16MiB/默认并发/routeroff/no loader、原Oracle/完整采样不改。原预算native整文件一次耗时诊断34/34、24412.5097ms/status0/7freeze[]，228行完整真实authority grant+12采样/replay用例14338.9609ms、290行上游deadline微任务反例2313.2894ms；只有实际耗时分布，不宣称CPU竞争/取消/HTTP500根治，不复发整套求绿。原2/13、11open、18AC完整projection b318ae9e、八formal/read-only not-run、W4/W9/T16/T17/R18和完整Goal仍未完成/active。下一按原W9定位此完整native关键路径，在保留全采样/全部checkpoint/原安全门禁与预算前提下验证优化，再续剩余W2-W9/生产依赖。完整UTC/hash/失败记录在同一原报告，无commit/stage/push/学习/删除或外部状态变更。

W4副作用实际消费接续边界：root串行owner新增 `production-shadow-side-effects.ts`、原neutral transport ports增加只读声明、原paired/native tests追加反例与实际消费；原producer/paired/authority/native/Oracle/manifest不改。新local-reference facade私有构造原paired runner，首尾及每实际POST前后经独立reader/clock回调取得完整primitiveJSON状态，匹配冻结publication-readback注册/原binding/原request nonce和响应bytehash，不接受caller snapshots或passed report。完整九类禁止状态与单调mutation计数共同检查，原全roster/arm/暖机保留；四serving内部字段逐例off/shadow比较，四允许副作用保存实际计数差异。普通缓存写入等价细节没有冻结定义时只报告未验证，不自造生产算法；source IAM/authentication、完整readback制品封存和machine verdict仍是独立缺项。闭锁/迟到UNKNOWN/截止/静态错误与原8MiB/200000nodes资源保持，原18AC/2/13/Goal不升级，不改无关dirty或stage/生产状态。

副作用接续验证（2026-10-16）：完整本地12实际POST、26首尾/逐POST读回、6off/shadow配对，完整九类状态+mutationCount、四serving字段及四允许副作用计数实际消费；270000字符完整状态不按256KiB截断。独立复审发现共享POST期限被读回开销越过后仍派发、busy污染主请求故障、response envelope/decoded body/tree先于原producer限额消费三项，持久三RED均实查expected0/actual1后最小修正。最终4项修正定向全绿，再最终16/16、actual3roots972sources/36非声明strict0。四冻结SHA为sideEffects165582c4/ports6d488def/pairedTest3baa213f/nativeTest8338eac2；功能/安全最终身份两面限定APPROVE，TS仍??/普通diff空与旧全仓319errors109warnings门禁STOP，未语义批准，不stage或改规则绕过。

本轮原CLI61与CLI4均在原30s预算ETIMEDOUT/无诊断输出；CLI版本与原配置独立加载正常，不据此确定超时根因。同一原配置SHA fce645f0、完整规则/ignores、不修复/不缓存的独立ESLint API检查4与61文件零error/warning/fatal，明确不冒充原CLI通过。最终完整strict44roots1482sources/90非声明0diag；API-backed原60文件一次实跑1143tests/1140pass/1fail/2cancel、UTC01:50:17.216–01:51:01.952Z、44693.642ms/status1，142freeze[]、parent60584 terminal1/drained；保留原30s/90s/16MiB/默认并发/routeroff/no loader/原Oracle。失败名精确映射原Ask route、native-publication-sources文件及原manifest-publication-artifact.test的20ms whole-operation六阶段用例；Windows TAP转义路径补充只为静态映射，三个文件一次原预算专项114/114未复现，不称修复或全量green，不盲重跑。source IAM/authentication、完整readback受控制品封存、普通缓存等价冻结定义与完整W4/W9/生产仍未完成；原2/13、11open、18AC完整projection b318ae9e、八formal/read-only not-run和全部production/stage/machinefalse、Goal active保持。完整UTC/SHA及所有失败历史追加同一原报告，无commit/stage/push/Compound/学习/删除用户数据或生产/其他外部状态变更。

root 串行 owner 新 `production-stage-gate.ts`、原 producer ownership 防伪接点、paired runner 私有消费及 paired/native tests 追加断言。依同一完整raw manifest/dataset与原binder冻结全部sampling/arm/threshold；只接受当前私有producer实际生成的immutable proof，不接受caller/serialized/clone/proxy的评分标签。全部原warmup/trial原序两arm进入collector，原metrics对各完整人口重新聚合，P95不平均，warmup不混trial；逐arm并列比较所有原quality字段，缺定义/缺独立measurement的timeout/semanticDegradation/multiHop指标保留unavailable，不自造阈值语义/标签集合/0值。七原安全数值在所有人口检查，其余runtime hard gates和完整SideEffect/readback未具备则保持not-run/全stage不通过；这是实际计算依赖，不是完整W4或machineGate许可。

保留完整已批准采样、原逐例安全立即停止、原制品/Oracle/producer字段与source真实性false，不以临时前缀人口可改进的质量均值提前裁剪roster/trials。最终report有完整population summary、limits/status/unavailable与原全部arms的有序roots，私有collector支持闭锁/严格顺序/去重/完整性/原8MiB与200000nodes资源。先实际RED→最窄真实producer+原metrics正负边界→type/lint→正常原预算全回归→独立三面→原记录；原2/13/18AC/production与Goal不升级，未选择Harness/pointer/contract revision、不修改无关dirty/staged。

完整人口质量比较本轮续记（2026-10-14）：用户允许暂用默认值，继续限定既有local-reference/synthetic，不补生产environment/tenant/corpus、roster/gold、阈值、registry或审批事实。新stage collector仅接受模块私有WeakSet登记的真实immutable producer proof，在任何字段/Proxy/getter反射前拒绝伪造、clone和serialized载体；冻结原manifest/dataset/sampling/limits，完整原序双arm暖机/试验，复用原metrics按完整逐例人口聚合P95，不平均/截断/混暖机。paired实际私有消费，完整qualityReport/root进入原全proof/hash与8MiB/200000nodes预算，最后检查完整JSON含字段名/分隔符；原authority/native最终派发/制品/Oracle合同不改。

缺接口真实RED为1pass/9fail（10tests），首次10/10，再178/178。独立安全审查发现零暖机空summary七个默认安全0误标passed，原测试追加完整11项null/not-run及非空trial七真实0/四未知断言，持久0/1RED后只加非空人口guard，1/1GREEN、最终178/178、actual9roots977sources/41非声明strict0、syntax8与17文件lint全0、26SHAfreeze[]。最终五身份stage782b437f/producerb266c88b/pairede7e2d57f/pairedTest800bfca4/nativeTestbe154144已由功能/安全只读复核，原MEDIUM关闭并限定APPROVE；TS仍五文件??/普通diff空、历史全仓319errors109warnings无新整体通过而STOP，未语义批准，不stage/改规则绕gate。

旧stage0857/pairedTest1a12身份首次正常60为1110pass/0fail/3cancel（1113tests、status1），三个domain hash唯一映射原Ask route/native-publication-sources/nativeHTTPS文件，原TAP取消详情未留存、原因unknown，静态初次漏域分隔无匹配不记定位成功。原预算专项三文件127/127不能证明取消根治。修复后新五身份正常原配置60一次1163/1163、UTC14:55:29.977–14:56:02.013Z、31991.6281ms/status0、0fail/cancel/skip/todo；42源码actual43roots1481sources/89非声明strict0、canonical lint60全0、141SHAfreeze[]，parent22545 terminal0/drained。原runner c75df5、30s/90s/16MiB/默认并发/routeroff/no loader/Oracle、采样、规则和用户MM/staged保持；不复用旧1153/第一轮178身份绿色或覆盖旧取消、500/EPERM等未知问题。

本轮只完成实际数值阈值比较依赖，不完成整个W4：timeout/semanticDegradation/multiHop缺真实测量或冻结定义仍null/unavailable；四运行时hard gate及完整pre/post、servedEvidence/context/prompt/cacheIdentity与允许副作用读回仍not-run。非空人口七原安全真实数值可比较，零暖机两空组11项全部null/not-run；整体只failed/incomplete，production/stage/machine/SideEffect/runtime/source真实性均false。原2/13、11open、18ACunchecked（完整projection b318ae9e）、八formal/read-only not-run、T16/T17/R18与完整Goal active不变。下一依原W4 contract补独立完整状态与实际副作用来源；真实定义/授权不能由默认值替代。完整UTC/hash和失败历史追加原报告，无commit/stage/push/Compound/学习/删除或生产/其他外部变更。

### W3/W4 完整逐例评分人口实施边界（2026-10-14）

当前原 evaluator proof 只有每 arm 的 summary/P95 和 outcome hash；不能拿均值化 arm P95 代替完整 trial 人口，也不能从汇总值还原缺失的逐例 latency/metric-null/abstention。root 串行 owner `production-ask-dataset-binding.ts` 的私有评分内核/独立 measurements factory、新 measurements test、原 producer 私有消费和相关追加断言。复用同一个实际原 `runRagEval` 结果，只公开闭集逐例 caseIndex/status、原 metrics、abstention 与有类型 usage/null；不输出 caseId/query/gold/answer/evidence/tags/trajectory/错误。旧 evaluator/four-key binder API、旧v1 evaluation proof/hash与旧Oracle语义保持；完整新人口有独立域分有序root，不能用256KiB控制对象预算截断1000例，沿8MiB/200000nodes限制。

先实际缺人口RED，再用原case scores逐项对应、失败closed/null、tokens/partial/cost、完整1000例、warmup/trial分离与真实producer/native私有评分联测；不接受 caller summary或自报measurement proof替代原评分。之后窄→strict/lint→正常原预算完整回归→独立三面→原报告。它是完整W4所必需的实际数据依赖，不是完整SideEffectPolicy/hard-gate来源、timeout测量、语义阈值定义或stage verdict；T16/T17/R18/18AC及任务2/13不据此升级，生产全部false，未选择Harness/改pointer或contract revision，不动无关dirty/staged。

完整逐例人口本轮续记（2026-10-14）：原evaluator/four-key binder与原v1 proof/hash保持；新独立measurements factory复用私有engine同一次原runRagEval，公开完整caseIndex/status/原metrics/abstention/typed usage/null与独立有序root，失败仅static码，不输出raw IDs/query/gold/answer/evidence/tags/trace/trajectory/error。producer实际私有消费，原逐例安全/整armOracle仍执行，完整measurements进入producer→paired→authority proof，native12请求完整warmup/trials实际携带。缺接口RED11为1pass10fail；first10/11唯一新1000case root断言漏count后NUL，只修新test后167/167。功能/安全独立发现MEDIUM原runner不校验usage两个enum，新独立出口可复制任意JSON；真实RED1fail+空producerfile pass后仅新projection闭集runtime拒绝，12非法variants都保持legacy completed/newstatic拒绝，不默认unknown为unavailable。最终168/168、8roots976sources/40非声明strict0、syntax8/lint16各0、25unique freeze[]；旧26entry重复监测producer test的记录保留，不误称26unique。

最终五SHA binding `54a11cbd3ba3ca7fd758b3d58d5594f4437b12b6cec60159ef05cf01258e0ccf` / producer `bae0aabcddf51cce396ca3ecd877b8af95c6932697191e2e47d9cd4b956c69ac` / producerTest `26286b89b65b01e18e56f7b4d23d193ce19b720988f625a8da036a913c969c8c` / measurementsTest `06d9713d9ab6c2f6c38f592ded3b2fd06fc06a40874f043bcba5f500b6de1b16` / nativeTest `2e4e71b1e33d5842f31061d6a0279a75b1a660496eb689590d9459b157ef5aa5`。独立功能/安全最终5身份审前后稳定、两面限定APPROVE；TS最终5身份只读stable仍??/旧全仓319errors109warnings无新全仓通过而STOP，未语义批准。最终正常原预算60文件1153/1153，UTC14:05:58.425–14:06:30.737Z、32266.4993ms/status0/0fail/cancel/skip/todo，41源码actual42roots1480/88 strict0、canonical lint59各0、140freeze[]，parent47915 terminal0/drained。此前旧身份1152等绿色不复用为新身份批准，所有旧失败保留；完整质量/SideEffect gate、多跳/timeout/hard-gate实际来源、阈值定义、W3/W4/W9及生产仍未完成。完整2/13/11open/18ACunchecked/八formal与read-onlynot-run/productionfalse/Goal active不变，证据追加同一原报告，未commit/stage/push/学习/清理或外部变更。

### W2/W3 authority-bound 原生 Ask 消费边界（2026-10-14）

root 串行 owner 新 `production-ask-authority-runner.ts` 与原 native HTTPS test 的追加用例；复用原 approval、signature、registry/evidence verifier、native HTTPS 与配对 runner，不改它们的输入语义/资源预算/旧断言。输入完整 raw manifest/dataset、真实本地 Ed25519 execution envelope 和既有 neutral ports，独立绑定 actor/scope/ref/window/provider selection。先实际 challenged registry/conformance/runtime 读回，再验签/一次nonce消费/独立exact读回，之后才允许原 Ask/制品执行。完整 evidence checkpoint 置于私有 fresh-clock await 内，让原 writer/native 的 post-await 绝对截止及 peer gate 覆盖最后一次昂贵检查：原 writer 每次制品派发、native deployment/Secret/POST 各依既有 fresh-clock 链覆盖；measurement 保持原 native 时钟合同并做廉价 immutable expiry fence，不虚称其有新增独立读回。昂贵授权/key/完整 attestation 有效期在 fresh-clock 重验，最终 raw callback 同栈同步派发并立即安全 drain，之后才观察和 canonical detach；不以之前成功标签放行。只有私有模块产生的结果参与状态，拒绝caller grant/factory/观察结果。

关闭/超时/未知nonce提交立即fence全部后续raw callback、Secret和POST，不自动retry/回滚或承诺远端取消；nonce outcome、pending与已派发/可能mutation保守保全。共享时钟分actor沿原validator，并额外保留跨actor全局进度。仍仅loopback/local-reference，真实IAM/online revocation/来源认证/完整SideEffectPolicy、机器gate、T17前驱/lease/ramp与生产许可未完成，所有生产标志false；不据此勾18AC或更改2/13/11open/Goal。先持久真实签名/读回正向和缺源RED，再配置交换、actual replay、握手后到期无Secret、getter/thenable、close/晚nonce、全采样native链验证，定向→原预算全回归→独立三面→原报告。

authority 消费续记（2026-10-14）：新增 genuine Ed25519 execution/attestation、原 registry/evidence 与一次 nonce 独立读回的实际 native 消费，不接受 caller grant/result。初缺源 RED 1/8，首次定向111/112及TS2345；到期测试只纠正服务端事件不能作为客户端Secret前屏障的夹具顺序，产品只改正确post参数类型，之后112/112及旧两SHA正常1135/1135。独立复审进一步提出并持久实证 checkpoint微任务链跨deadline后新增2业务派发、Secret/measurement fulfilled payload各读then getter1次、最终Secret与peerGate不同原生async context；修复均仅新facade，原native/writer/producer/pairedrunner/BPC不改。同步close后throw的UNKNOWN丢失另持久RED，最终合并全局/immutable故障事实；已派发raw返回的观察超时另保守UNKNOWN，两个候选探针原版本已green，不虚称独立复现。单共享参考evidence生命周期4096与完整约5408读取不相容的失败保留；合成输入包两个既有不同source身份各独立原store4096，不reset/evict/扩大原profile，全部checkpoint/采样不减，非生产容量批准。

最终冻结source `9c7f30606031e97ed2bdfe13931e58e86c3eb53df6ec389a4c370aee126cca64` / nativeTest `85cca4514dd96d5644729934b45531ee7334961a8248743bcdb02138ba69eb86`：118/118定向、8roots976sources/40非声明strict0、syntax6/lint14各0/24freeze[]；原配置正常59文件1141/1141，UTC13:24:33.216–13:25:04.119Z、30845.525ms/status0/0fail/cancel/skip/todo，41源码actual42roots1480/88 strict0、canonical lint58各0、139freeze[]，parent11393 terminal0/drained。TS最终身份只读仍STOP，??/旧全仓319errors109warnings未有新全仓通过证据，未语义批准；功能/安全最终两SHA审前后稳定，两面限定APPROVE本地消费者改动，原HIGH/已实证MEDIUM闭合，不据root局部green代替整体Review。所有旧失败/生产输入/来源真实性/完整SideEffectPolicy、W4/W6/W9、阶段机器gate、T17前驱/retention/read-only/引用依赖仍保留；原2/13、11open、18AC unchecked、八formal/read-only not-run、production全部false、完整Goal active。完整时间/SHA/失败与候选区别追加原报告，无commit/stage/push/学习/清理或外部状态变更。

### W3 完整配对 runner 实施边界（2026-10-14）

沿原 W3/AC-2、AC-3、AC-5 和同一 Design Authority，root 串行 owner 新 `production-ask-runner.ts/test.mjs`，不改原 manifest/dataset/hash/oracle/producer/HTTPS/预算或引用前端。私有构造原 producer，只从完整冻结 manifest 读取 sampling 与 off/shadow（T16）或 off/active（T17 本地放量前配对）；全部 warmup 后全部 trial、每个 ordinal 两 arm、每 arm 完整同序 roster。入口只允许空执行请求，不接受 caller 的 arm/样本数/结果/runner factory。输出完整每 arm 原 producer proof/制品索引和逐例对应 hashes，预热与 trial 分开，不平均 P95、不自报 SideEffectPolicy 或机器 gate。

本地完整 proof 使用原 binder 8MiB/200000nodes 资源边界，配置若连完整逐例配对最低表示都无法容纳则执行前拒绝；实际输出达到预算后保守停止，不截断/减 roster/调阈值/预算求绿。closed/busy/single-use、同步 owned close、失败/晚 Promise/UNKNOWN 与 mutation 保守保全；不重试、不声称远端取消、跨重启续跑或生产许可。先持久失败测试，验证原采样边界/完整真实 producer→writer→oracle、配置防注入、warmup隔离、失败立即停止、close/busy/重复执行、资源上限，再定向 strict/lint、独立只读三面和原预算完整回归。完整 W3/W4/W9、八formal/read-only、真实 provider trust/审批/生产数据等依赖仍未完成；原18AC/任务2/13/11open和完整Goal不变。

配对 runner 本轮续记（2026-10-14）：新增 runner source/test，原native HTTPS test仅额外返回原fixture ports并新增一项全采样联测，原18用例及产品producer/HTTPS/binder/writer/Oracle不改。原producer/writer/oracle baseline先通过，持久缺源RED11真实1pass/10fail；初版定向102/103，唯一新测试误将citation metricCoverageRatio解释为结构化引用存在率，核对原metrics以gold span可用性定义后仅修正新断言：缺引用meanCoverage0、原可用率0.5、token/cost仍null，不改原算法。最终原合同+新runner103/103，再加真实native12TLS/12Secret/12measurement完整warmup1+trial2双arm原KMS/store/read/decrypt/oracle联测104/104；actual7roots972sources/36非声明strict0、syntax6/lint13各0、23freeze[]。

新三SHA runner629f0749/test8d5d402b/nativeTest88e5e32a，独立功能/安全两面只读最终增量限定APPROVE，TS仍??/旧全仓319errors109warnings无新的通过证据而停审，未语义批准。原预算正常59文件一次1127/1127，UTC11:54:03.687–11:54:34.016Z、30283.2101ms/status0/0fail/cancel/skip/todo；40源码actual41roots1479/87 strict0、canonical lint57各0、138freeze[]，parent27997 terminal0/drained。所有旧500/EPERM/取消未知原因保留，不能凭新绿根治。完整body/同roster/slots与原制品索引配对已本地执行，但仍不是完整SideEffectPolicy/机器阶段gate、authority/registry消费或生产事实；资源负例直接覆盖完整最低表示不可能fit的配置，运行时聚合ceil守卫未单独构造极限触发，不称全部资源边界验收。原W3/W4/W9和全部任务/18AC/八formal/read-only仍未完成，2/13、11open、productionfalse、Goal active不变；完整证据追加原报告，无commit/stage/push/学习/清理或外部状态变更。

### W3 实际 HTTPS reference transport 实施边界（2026-10-14，尚未完成）

复用既有 Design Authority revision1/AC-1～AC-5 和第3.4节，不新增第二语义owner、不改checkbox/阈值/Harness选择。实施前代码没有SecretProvider或ProductionAskTargetPort声明/实现；当时原producer只观测注入callback，不能据此证明真正出站安全。按原W2→W3依赖补neutral Secret/deployment/measurement接口及受限native HTTPS reference adapter，**不实现企业secret/registry/审批系统，不以callback自报认证服务器测量，不执行真实生产请求**。下方续记分别保留各实施时点的事实，不把历史“未实现”误读为最新局部状态。

选择先native DNS精确核验/pin→建立并校验TLS链/原hostname→取得最小scope credential→在同一私有TLS socket固定POST `/api/ask`→按wire/stream/decompressed预算读实际完整bytes。拒绝全局fetch/代理/自动redirect、请求提供任意URL/header/credential/agent；不新造deployment/measurement HTTP端点，仍通过原批准的provider-neutral读回ports。参考网络正向执行只允许显式loopback测试策略/本地测试凭据，enterprise profile/fallback不开放；public/private DNS策略的纯验证不等于允许reference跨外部网络执行。真正企业adapters/conformance/registry/IAM/clock/measurement和阶段authorization仍外部前置。

| 有序任务 | 文件owner/边界 | 前置/风险 | 完成证据/原AC |
|---|---|---|---|
| N1 | root：`production-ask-request-contract.ts`；最小复用原producer的固定body/deployment校验，原source/test保留 | 原binder/validator/plan，L3 | 相同原bytes/hash/字段与原20回归；AC-1～AC-3 |
| N2 | root：`production-ask-network-policy.ts`及test；完整raw DNS/TLS artifact ref、scope/origin/window、IP分类与pin | N1/原networkPolicy，L4，串行 | metadata/link-local/loopback非显式/私网越界/mapped IP/rebinding及PEM/ref交换反例；AC-1/AC-4 |
| N3 | root：`production-ask-transport-ports.ts`、`production-ask-https-transport.ts`及隔离native TLS测试 | N1/N2与neutral credential/readback边界，L4，串行 | 实际TLS正负、同socket、late Secret、无proxy/redirect、压缩炸弹/截断/超时/close/晚Promise；实际全roster body无调用注入；AC-1～AC-5 |
| N4 | root：原producer/test最小消费optional transport.close与无伪测量HTTP错误 | N3，L4，串行 | close后不能晚发POST/取下一credential；200仍强制完整真实measurement；非200完整bytes封存不造usage；AC-3/AC-4 |
| N5 | 独立只读功能/TS/安全复审；原normal回归/identity freeze；原报告 | 全新最终SHA/L4 | scoped→全量，保留旧EPERM、全仓319/109与未完成生产gate；不凭局部绿勾W3/W9 |

| 合同/消费者 | Before | After必须保持/新增 |
|---|---|---|
| 原producer/新TLS transport → body | 原validator生成固定八字段 | 共用同一builder/完整bytes，不增加URL/graphMode/seed/header |
| deployment → 两消费者 | 相同scope/arm/hash/model/parameters的reference读回 | 共用原闭集校验，仍不称authenticated |
| 成功200 → 原oracle | 原完整correlated usage/abstention/citation | 所有原字段/安全硬门禁保持；不从时间/HTTP200补LLM调用量 |
| 非200 → 原writer | 原wire要求measurement导致真实无测量错误无法封存 | 只对非200允许无measurement，保存实际全error bytes，不新增伪usage |
| 生命周期 → 原producer/私有socket | callback可在上游close后继续内部步骤 | optional owned close立即fence私有socket/后续credential及POST；不承诺远端取消/回滚 |

隐私：raw请求/响应仅走原机密writer；token/auth头/keylog/原SDK错误不进普通输出/索引。TLS参考测试私钥只为本地合成证书，不作生产authority。每一步先持久RED，最多三轮已知根因修复；不以SSL verify=false、延长原预算、减少roster/原断言或默认生产事实换绿。原18AC/2/13/11open/Goal active与productionfalse保持，整套 N1～N5 **尚未执行完成**。

N1/N2 局部续记（2026-10-14）：owner 再次确认可暂用默认值；继续只用既有 local-reference/synthetic，不补造生产 scope、数据、阈值、审批或凭据。抽取原固定八字段 body/完整 deployment 契约，由原 producer 实际复用；新增完整 raw DNS/TLS artifact ref/scope/origin/window、IP 分类、all-result allowlist 与私有 validated-instance pin。此层不执行 DNS/TLS/HTTP/Secret IO，tlsEstablished/registryAuthenticated/productionAuthorized 均 false。合成 X509 fixture 的 OpenSSL child stdout 保持私有，不写私钥文件或输出 key；不是原生 TLS 握手测试。

已知根因反馈：Windows OpenSSL stdin-key 夹具初始化失败保留，修正为私有 stdout 生成后才建立真正 1/8 RED；初版 6/8 因共享 BlockList 的 IPv6 mapped 规则误拒所有 v4，拆分族后 33/33。另持久 IANA 例外 RED0/1 后只对协议网段增加更具体公网分配例外，不覆盖 metadata/hard-deny。首轮 35/35、actual4root strict0/lint6均0；原57完整 1090/1090。独立功能 MEDIUM 发现 body 抽取误用控制面 canonical Unicode，原 validator 允许的 lone-surrogate query 被拒；持久1/2 RED后改五primitive own-descriptor捕获，原 validator/JSON bytes 与 deployment canonical不变。安全 PEM 尾部候选在同编码 clean-DER 正向控制和三种尾部反例下未复现，保留回归但不改源码、不称已修复漏洞。

最终新 SHA 定向37/37，actual4roots969sources/33非声明strict0，syntax3/lint6均0、16freeze[]；正常原预算57文件一次1092/1092，strict37源码（actual38roots1476/84）0diag、lint52各0、133freeze[]。功能/安全对 request d925db7f / network e96f0011 / producer38cba51e 及新 tests ad33eba7/b476fd8f 限定 APPROVE；TS角色仍因原全仓319errors/109warnings与??范围停审，未语义批准，整体 Review/W9未通过。不 stage/放宽规则绕过门禁。完整UTC/SHA、原失败与审查证据追加原报告。N3/N4 真实 HTTPS/late Secret/同socket/measurement/close 尚未实现，不能凭本层绿勾 W3、八formal/read-only not-run或任何生产阶段；旧EPERM/500/native取消根因仍 unknown，2/13、11open、18AC、Goal active保持不变。

N3/N4 最新局部续记（2026-10-14）：owner 再次询问暂用默认值，继续仅 local-reference/synthetic。新增 neutral Secret/deployment/measurement 声明与受限原生 HTTPS：完整私有 dataset/binder/body，实际 all-answer DNS 核验/literal pin、批准合成 CA/原 hostname TLS、握手后且同一私有 socket 上取得合成本地 credential 并固定 POST；无代理/redirect/pool/session reuse，实际 wire/decoded 上限、压缩/截断、整体 deadline/close、晚 Promise 和 measurement correlation 均有持久反例。原 producer 最小消费 optional owned close；非200允许无 measurement，封存实际完整错误 bytes，不补 usage/abstention；200仍保留原完整测量/oracle。原 helper 增加同 intrinsic/species fence 的同步 Promise discard drain，旧两 API/Ask ceiling/无 hooks 原生加载合同不变。

真实 N3 RED1/11→首次9/11（冻结 plan 负例与 HTTP keep-alive 截断夹具失败），六 TS 诊断及 lint1error/1warning均保留，已知根因最小修复；N4 RED0/2及联测RED0/3后53/53。第一次58文件正常回归1107/1108，旧容量 seed 首POST500/200，当前具体原因未捕获，不据历史EPERM补填。本轮独立 HIGH 同步close拒绝 Promise drain、MEDIUM native pending UNKNOWN 与启动诊断门禁分别真实 RED5=0/5后90/90；旧重复头流回归最初1/1不是 RED。安全终审另发现早拒绝响应仍误置pending=false及启动缓存NODE_DEBUG删除绕过，新增/加强两反例真实0/2后最小修复，最终92/92、actual6roots971sources/35非声明strict0、syntax5/lint11各0、21freeze[]。修复后的58文件正常原预算一次1115/1115，UTC11:15:51.807–11:16:20.757Z、28905.0799ms/status0/0fail/cancel/skip/todo；39源码actual40roots1478/86 strict0、lint55各0、136freeze[]/所有进程终态。中间91/91与1114/1114各自身份和首次旧失败均保留，不冒用旧通过给新SHA背书或称旧500已根治。

最终 source/test：HTTPS f3a4c744/d7ee1774、ports a2d338a8、producer f618d669/7b7bf1f3、helper d27bf155/32535488；功能/安全两面只读新七SHA限定APPROVE，原HIGH/MEDIUM及诊断门禁残余关闭，不声称实际观测到凭据泄漏、来源认证、远端取消或全C++/OS诊断封锁。TS仍??无普通diff且全仓319errors/109warnings无新的通过证据，停审未给语义批准；root定向strict/lint不替代整体Review。完整UTC/SHA、所有失败/修复证据追加原报告。N3/N4本地实现/验证已交付，N5整体Review、W3/W9、其余本地runner/gate/read-only/registry/evidence/引用依赖及真实T16/T17/R18仍未完成；不改原18AC语义/checkbox、2/13/11open、八formal/read-only not-run、production全部false或完整Goal active，不commit/push/Compound/学习/删除用户数据/生产或其他外部状态变更。

W3 私有数据生产者增量（2026-10-14）：新增 `production-ask-producer`，私有原完整 dataset/binder/parser、固定原 validator 实际 body、逐例 fresh clock/deployment reference callback、实际 request/rawgold/responsebytes→原 encrypted writer/exact read/decrypt→原逐例与整arm oracle。input selector 仅批准 arm/phase/ordinal、缺 measurement 不补0、无 structured citation 标 absent；仍无真实出站安全/认证测量/registry/provider authority。初版1/16 RED→16/16但实际两TS错误/lint warning保留；64-case大证明、同步超时丢UNKNOWN与分数计数三个持久反例16/19 RED后最小修复，不扩256KiB控制预算/截断roster/索引。最终定向19/19、actual原配置2roots967/31 strict0、syntax0、canonicalLint2各0、11freeze[]，source3b2ba9/test19845b；原MM预算与所有依赖保持。旧cell86观察句柄丢失 outcome unknown，实际确认无同名活Node才恢复反馈，不宣称旧输出成功。三独立只读source复审进行中，35源码/47lint/55原生文件/127freeze未执行；既有全仓319/109、完整Review/W9和全部生产事实仍open。默认只local-reference/synthetic，不替代production数据/阈值/时间/审批/凭据；2/13、11open、18AC/八formal/read-only not-run与生产全false不变。完整UTC/SHA/终态证据见原报告。

上述最新续接：TS角色在source读取前因新文件??无git diff与旧全仓319/109门禁停审，未给批准；功能/安全独立实证完整entries会在所有合法post后才撞原8MiB聚合上限，MEDIUM回Work。新增第20容量反例targeted0/1 RED后复用原bindingProof.resourceBudget(8MiB/200k)、完整envelope字节/逗号/节点累计，溢出actual响应全封存后capacity-exhausted/停止下一POST，不截断或增预算。最终20/20、原配置2roots967/31 strict0、syntax/lint2各0、11freeze[]；source9e706e/teste99e27，功能/安全新SHA delta限定关闭MEDIUM，TS/整体Review仍未通过。首次正常55真实1038/1041(1fail/2cancel)，原publication-conformance:175失败+两unknown取消；修复后一次正常55真实1062/1073(1fail/10cancel)，Ask旧route:2224返回500/预期200、十cancel同文件静态匹配，根因未保留/仍unknown，不盲重跑求绿。两轮均35源码actual36roots1474/82 strict0、canonicalLint47各0、127freeze[]/真实parent终态；原预算/并发/旧54和规则不变。旧间歇故障、W9全仓/build、真实transport/registry/evidence/read-only/阶段gate与生产输入保持未完成。2/13、11open、18AC与Goal active/productionfalse不改，无外部状态变更；详细UTC/hash/审查证据见原报告。

2026-10-14再续接：唯一改原MM Ask route.test 的recovery夹具；确认pre-step .catch终态而entered永不settle的可触发cancel路径，新增2例真实0/2RED→3/3含原recovery、syntax/lint0、7freeze[]，新route1eeee675、runtime/store/producer与全部原assert不改。race entered/terminal保留cause，t.after先release/drain再restore/rm；功能/安全新SHA限定APPROVE，TS能定位tracked diff但仍全仓319/109停审，无整体Review批准。一次观测55真正1074/1075(1fail/0cancel)定位容量seed500/200，唯一request hash证明pre-map bare EPERM，具体native syscall/竞争主体因745预期ENOENT导致输出中段截断仍unknown；不重启同full55或造关联。一次新定位target有界观测1/1正常、38rename/非预期IO未复现，不作根治证明。最终真正普通无loader35源码/47lint/55一次1075/1075、UTC07:30:23.086–07:30:50.498Z、127freeze[]/所有进程终态，原30s/90s/默认并发/旧54/规则保留；仅闭合fixture路径与本轮正常交付，旧EPERM/间歇故障与完整W9仍open。默认只reference，下一按原依赖继续W3安全实际transport/registry/evidence/read-only/阶段gate；2/13、11open、18AC/八formal/read-only not-run与productionfalse/Goal active不变。旧persistent diagnostic generator未改仍绑定a5a7db，内存派生绑定1eeee675需重新核验，不称CLI已更新。细节原报告。

W3实际Ask预算依赖（2026-10-14，最新）：新增boundedAskRequestCall保持原两API60000与Promise firewall/UNKNOWN，支持当前client285s；初版从预算相对import，31/110局部绿遮住原生无hooks加载回归，正常54实际895/905/10fail保留。第32项真实standalone child先31/32 RED后移除相对依赖、固定独立参考资源ceil285000（test与实际client核对、不自动扩大），恢复原static测试导入并撤hooks；原23+新9全部32/32、project2roots565/1strict0、lint2零警告，最终source4f526a/test6bfe04/budget原dd4c3a精确冻结。功能/安全新SHA限定APPROVE，TS实际同项目type0但全仓lint721files/319errors/109warnings gate失败，角色仍停审/完整Review未过，原JSON未保存不补造归因。实际修复后原34源码projectstrict35roots1470/78diag0、canonicalLint45各0，正常54全部1053/1053、UTC05:42:22.090–05:42:47.350Z、无loader/0skip/cancel、125freeze无漂移；不借此关闭历史间歇故障。前置环境setup和父脚本原生syntax失败tests0均单列保留。预算MM未改、无rule/ignore放宽；该入口仍非actualproducer/network/授权/完整W3。下一继续私有dataset-owned实际请求/响应→完整writer/oracle/registry/read-only/gate与W9全仓/build，default仅synthetic，2/13、11open/18AC、生产false/Goal active保持，无外部变更。完整UTC/hash证据在原报告。

### 6.1 本地自动化

- 单元：分阶段 schema/normalization/hash、T16/T17 arm diff、SideEffectPolicy、hard/configurable gate、RampPlan/FaultPlan、SafetyRecoveryPolicy/envelope、execution/result envelope、无环 receiptCore/acceptanceBundle、PublicationIdentity、冻结 retention 与 CitationLocator。
- Port 合同：第 3.4 节全部 provider-neutral ports 使用独立 conformance harness；fake/reference adapter 必须在 production profile fail-closed，真实 adapter 的 provider/version/config/artifact identity 可回读且不能自报通过。
- 安全合同：所有 provider endpoint 的 registry/origin/TLS/DNS/redirect/proxy/schema/size/timeout、Secret 晚注入、响应头默认空白名单、全链路脱敏、KMS AEAD/唯一 nonce/AAD object swap、签名角色/吊销/nonce/职责分离、闭集 FaultPlan 与不可放宽 hard gate。
- 文件、journal 与验收对象：路径穿越、reparse/hard link、exclusive create、fsync/atomic rename、大小上限、receipt 自引用/core-bundle 混淆/object-version 替换、journal entry 修改/删尾/截断/重排/重复/fork/旧 fence 注入、intent/result 每个崩溃边界、防篡改独立 head/readback及无终态 acceptanceBundle。
- 并发与恢复：两个 orchestrator 争用同一 scope、lease renewal/loss/network partition、stale fencing 对 journal/CAS/deployment/mode/traffic/fault 的逐端口拒绝；原 execution auth 过期/吊销/窗口关闭时，缺失/过期/越权 SafetyRecoveryAuthorization 必须拒绝，只有新 generation + JIT 身份可执行冻结的降风险动作。
- 集成：PostgreSQL + Neo4j + Milvus PublicationIdentity、Outbox ack、冻结 off/active arms、每级 RampPlan readback、FaultPlan TTL/撤销和 lineage+fencing rollback。
- E2E：本地专用 canary 的 `lease/fencing -> zero-traffic/off -> journal intent/result -> CAS -> projection/readback -> frozen off/active arms -> signed ramp -> signed fault -> withdraw/off -> recovery-authorized fenced rollback -> receiptCore(journal root/count) -> result attestation -> acceptanceBundle`，另覆盖已放量后 lease 过期/owner 崩溃时流量自动归零、fault 自动撤销，以及 rescue 尝试激活/加流/新 fault/跨 lineage 时被拒绝。
- UI/API：CitationLocator 随机句柄/AEAD、跨重启/实例/环境、TTL/maxTTL、key rotation/revocation、store/keyring 中断、当前主体重新授权、tombstone，以及普通 Ask/agent/无引用/合法重复编号/Markdown/历史迁移/恶意元数据/跨租户边界。
- 数据生命周期：T17-frozen policy/store hash、可信时钟、回滚重置、对象版本、缓存、临时文件、派生报告、replica/backup、legal hold 和 deletion/crypto-shred receipt。
- 回归：现有 RagEval、Ask route、Graph control、生产构建与 standalone trace。

### 6.2 生产门禁

生产命令只有在 W9 通过、对应阶段 validator 通过、部署侧 ProviderTrustPolicy 与独立 conformance receipt 有效、受控制品/KMS/secret provider 可用时才生成。任何正常生产请求或 mutation 前必须验证对应阶段 executionAuthorizationEnvelope；原授权过期/吊销/窗口关闭后的 rescue 不得复用它，只能以绑定实际新 fencing generation 的有效 SafetyRecoveryAuthorizationEnvelope 执行已冻结的降风险动作。执行完成后必须先封存 receiptCore 并独立回读防篡改对象，再由独立结果审批者签发 resultAttestationEnvelope 并组装 acceptanceBundle，才允许该阶段通过并成为下阶段输入。T16 只需要 T16 view；T17 和 R18 分别验证自己的 extension。任何 hard gate 失败立即停止，任何预检失败都必须零生产写入。生产验证结果只按有效 T16/T17/R18 acceptanceBundle 判定，控制台成功文本、HTTP 200、健康页或人工截图均不能单独替代。

## 7. 生产输入状态

| 输入 | 当前状态 |
|---|---|
| 脱敏代表性 V2 roster 及 gold | 缺失 |
| T16 批准的 trial 数、质量/延迟阈值；不可放宽安全 hard gate | 缺失 |
| off/shadow arm、shared/arm config hash、部署侧 target origin allowlist | 缺失 |
| 目标 environment/tenant/corpus、专用 canary/流量选择器、不可变 fault 资源 ID 与 PublicationIdentity | 缺失 |
| 部署侧 ProviderTrustPolicy/registry、各真实 provider/adapter 的版本/config/artifact identity、独立 conformance receipt 与 reference/fake/fallback 禁用证明 | 缺失 |
| Secret/KMS/Approval/TamperStore/Clock/AskTarget/Readback/Journal/Lease/Fencing/Deployment/Traffic/Fault/CitationLocator 企业 provider 与凭据引用 | 缺失 |
| 独立 result attestor 身份、职责分离、可信签认入口与防篡改存储 readback 身份 | 缺失 |
| CitationLocator 共享 store/keyring、服务端 Evidence resolver、TTL/maxTTL 与 rotation/revocation policy | 缺失 |
| T17 冻结 off/active arms、trial/warm-up、shared/arm config hash、逐级权重/请求数/dwell/abort、lease TTL/renewal/fencing 语义、签名 closed-set FaultPlan 与 SafetyRecoveryPolicy | 缺失 |
| T17 变更单、维护窗口、on-call、JIT mutation/read-only/rescue 身份、独立 recovery authority/签认入口、停止/回滚 owner | 缺失 |
| T17 authorization 时冻结的 retentionPolicyHash、oldStoreManifestHash、周期起点/重置规则与 TrustedClock provider | 缺失 |
| R18 execution authorization、经过时间或后继发布证据；实际清理授权另属 Goal 外 | 缺失 |

## 8. 回滚与终止条件

- 本地实现任一 L4 安全/一致性测试失败：停在 Work，不进入 Review。
- T16 数据、制品、sharedConfigHash、armConfigHash/mode 或 roster hash 不一致：作废整次 run，不拼接报告；served Evidence/context/prompt/cache identity 强一致，回答只按批准语义阈值比较并区分 cache hit/miss。
- T16 未通过：保持 `off`/`shadow`，禁止 T17。
- T17 任一 off/active arm identity、trial/warm-up、Outbox ack、PublicationIdentity、RampPlan step/dwell、权威流量 readback 或放量前 verdict 不一致：不得进入下一 ramp；摘流并执行 off-first、lineage+fencing 回滚。
- T17 失锁、续租失败、fencing generation 变化或 owner 崩溃：旧 token 对所有 adapter 拒绝，流量 lease TTL 自动归零、fault TTL 自动撤销；旧 owner 停止动作。rescue 必须取得新 generation、独立 SafetyRecoveryAuthorizationEnvelope 与 JIT 凭据，并验证 journal chain/head/live state；只能执行冻结的降风险动作。缺少授权、journal 不可信或无法确认零流量/off 时禁止自动 Pointer mutation，并进入事故处置。
- 已放量后普通 gate 失败：持有有效 generation 时先从权威流量控制面摘除 canary，强制切换/recreate 为 `off` 并回读，再按本 run lineage 回滚 Pointer；CAS 只恢复图身份，不能代替流量和进程模式回滚。
- FaultPlan 签名无效、动作不在闭集、资源 ID/参数/TTL 越界、stop condition/kill switch 触发、撤销失败或影响非 canary：立即停止 fault；由 adapter deadman 执行冻结撤销动作，无法确认恢复时进入事故处置，禁止继续采样。
- 阶段凭据缺 pre-run executionAuthorizationEnvelope、immutable receiptCore、独立 post-run resultAttestationEnvelope、无环 acceptanceBundle、exact digest/version 防篡改证明或终态：该阶段无效；按 journal、lease/fencing 与现场 readback 安全恢复或人工处置。
- 安全 hard gate 任一触发：立即停止后续请求/mutation，不用聚合平均值覆盖单例违规。
- 发布周期未满、权威时钟不可用、legal hold 未解除或删除范围不完整：禁止历史清理。

## 9. 完成定义

只有下列条件全部成立，活动 Goal 才能标记完成：

- W0-W9 均有与风险等级匹配的测试、构建和独立复审证据。
- 所有 provider-neutral ports、独立 conformance harness 和受限 reference adapters 已实现；production profile 对 fake/reference/fallback fail-closed，且真实企业 adapters 由外部独立 conformance receipt 证明后才进入 T16。
- 标准 Ask 与 agent 路径均产生结构化引用或明确无引用诊断；CitationLocator 跨实例可解析、具 TTL/完整性和受限 key rotation，点击时由当前 principal 重新授权且查询 tombstone，客户端 Evidence/locator 均不具有授权能力。
- T16 acceptanceBundle 同时具备有效 execution authorization、immutable receiptCore、独立 result attestation 和 exact 防篡改存储证明，证明 Shadow SideEffectPolicy 与候选诊断达到冻结阈值，但不越权宣称 Active 答案提升。
- T17 在放量前通过同 roster `off`/`active` 多跳质量、引用、安全、P95/超时门禁，并完成 lease/fencing、可验证 journal chain/root、逐级 RampPlan、闭集 FaultPlan、失锁 fail-safe、专用 canary 激活、降级、摘流、SafetyRecoveryAuthorization 受限 rescue、lineage 回滚和最终 PublicationIdentity readback；T17 acceptanceBundle 三层对象全部有效。
- 最终 canary 权重为零且进程 `off`，Pointer 位于批准的稳定身份，未遗留意外 Active Pointer、非零 TTL 流量或共享/未撤销故障注入。
- R18 只按 T17 时冻结的 retentionPolicy/old Store identity 验证完整周期并生成有效 acceptanceBundle；旧 Store 的实际清理不属于本 Goal，仍需 `validateForCleanup` 与单独删除授权。
- 没有把 synthetic、hermetic、本地 Docker、HTTP 200 或截图冒充生产质量证据。

## 2026-10-16 W9 接续：实际热点优化，完整回归仍失败

上一轮 native 取消后，只对原完整 native 文件做一次原 30s/90s 预算的本地 CPU 采样诊断；未开启 TLS keylog/网络 debug、未改原采样与断言、不是正式验收。34/34，采样表明 canonical JSON 累计约 11.0s、authority live 约 6.5s、checkpoint 约 1.8s，完整源码身份不变。仅修改私有 authority runner：完整检查点容量由反复扫描全部前缀改为精确增量字节/节点计数，先校验后追加，最终 whole-core 上限保留；同一次有序误差区间只构建一个原 trust verifier，两端完整验签保持，每次 live 重新构建，不跨时钟/调用缓存成功或减少来源读回。

持久反例加入原完整授权、12 POST、全 checkpoint 和 replay 测试，实际 338 次完整前缀序列化 RED→0 GREEN；不是机器依赖的速度阈值。最终 source `1f49607f158a0527128693f5975b18499a1086cb423c0b72333539c43bf9656d` / native test `42ceb6c034c50587d973157a3b91fd3e658ed79e61aea8506621f881e3aaa4ef`，定向1/1，actual45roots/1483sources/91非声明strict0，原CLI62 errors/warnings/fatal0。一次正常原60文件实跑 **1187/1189、2fail/0cancel/skip/todo、exit1**，143身份无漂移；无 profiler/diagnostic loader、原30s/90s/默认并发/完整Oracle保持。本次未出现native取消，不能推定历史超时根治；两个 unhandledRejection 静态唯一映射原 publication artifact:289 whole-seal-deadline 与 manifest publication artifact:338 的20ms whole/1000ms inner用例。源码显示它们先等 started 再处理 pending，存在拒绝前置或永不 entered 的待查路径，但本次实际 error phase/entered/cause 未保留，不能冒充已证明根因。

功能/安全对上述精确两SHA审前后稳定、无新增actionable，限定APPROVE本地性能delta；TS因??范围/普通diff空与原全仓319errors109warnings门禁 STOP，未进入语义审查。下一步先以有界、完整的迟到/拒绝观测和释放清理确认两旧夹具路径，保留全部六个实际provider阶段、20ms/1000ms、UNKNOWN/mutation/zero-followup断言及历史失败，不blind完整重跑/提高预算/改规则或stage求绿。详情继续同一原报告；2/13、11open、18AC、八formal/read-only未完成、所有生产/stage/source/SideEffectPolicy false及完整Goal active保持，不commit/push/Compound/学习/生产变更或删除用户数据。

## 2026-10-16 W9 延迟夹具接续：完整原 60 文件 1194/1194

仅测试侧新增共享 `production-provider-entry.test-support.mjs`：等待 entered 前同步观察 pending 的成功/拒绝，提前终态明确失败且保留 cause；两六阶段及最终 completion-clock 测试以 release→await pending 的顺序清理。原20ms whole/1000ms inner、全部6实际provider阶段及UNKNOWN/mutation/halted/no-followup/decrypt断言不改，实际业务writer/source和原绝对deadline没有修改。持久反例包括前置拒绝/成功、entry后迟到拒绝、真实clock同步80ms耗尽原20ms导致KMS未entered，以及getter/Proxy零执行；闭集错误上下文只用Proxy guard后的own value descriptor、固定code/phase/boolean或unknown，不将错误字段作为来源或权限证明。

实际反馈：早期3例1pass/2fail RED→5/5；真实writer反例0/1RED→两完整文件51/51；首次正常原60为1190/1193、3fail/0cancel，新增失败静态唯一映射原last-completion-clock等待，旧两个loop cause/phase未被TAP呈现，不补造原因。补第三等待和闭集诊断后，元数据2例0/2RED→最终两文件52/52、CLI3 errors/warnings/fatal0。最终03:50:58.762–03:51:34.486Z原60文件实跑 **1194/1194、0fail/cancel/skip/todo、exit0**，144身份无漂移；actual45roots/1483sources/91非声明strict0，原CLI63 errors/warnings/fatal0，原30s/90s/16MiB/默认并发/routeroff、全部原测试/Oracle/无profiler或diagnostic loader保持。完整TAP仅由父进程私下收集，ordinary仍闭集摘要/hash。该绿只证明本轮正常交付，不证明历史HTTP500/EPERM/超时或三失败原始cause根治。

最终helper `f97363158e1f2512c11bcda5c5ae53bb82f6d71f7839d07d40d00bd4c03265c1` / publicationTest `b7eb8d743d651d5715a9dd278b33a8d231b7e1b266c3af268ed4ab580fb41f95` / manifestTest `bc5b46de6b878a6308ce5966aa443fc41210af75cb3894bf0aa7ad6ce36dc3a1`。功能/安全最终三SHA前后稳定、限定APPROVE本地测试infra；TS仍??/普通diff空的范围gate STOP，JS-only跳过类型检查不等于类型失败，未语义审查race/cleanup/context，不冒称三面全审通过。下一步回到原W9全仓lint/build当前基线及W2-W8完整依赖，不以局部normal通过关闭完整Review或生产gate。2/13、11open、18AC全部unchecked、八formal/read-only未完成、所有生产/source/stage/machine/SideEffectPolicy false、完整Goal active保持；详细UTC/SHA/失败证据继续原报告，不stage/commit/push/Compound/学习/清理用户文件或变更外部状态。

### 2026-10-16 W9 实际全仓门禁与隔离构建：319→288，构建通过但 lint 未完成

owner 的默认值选择继续仅用于 local-reference/synthetic。实际完整 ESLint CLI 基线739文件319errors/109warnings，完整原 tsconfig 为444roots/2572sources/440非声明、0diagnostics；不是此前45roots定向检查。构建前发现原文章生成器会读取 dotenv 并在配置存在时自动同步 Notion，故先以持久5例得到2pass/3fail RED，再只给原 prebuild/build 增加 `--local-only`，生成器在 dotenv 读取及自动同步前短路，直接无参数生成和手动同步旧行为保持。5/5 GREEN；用户 MM package 的依赖和其余脚本经原始完整 JSON 对比未改。独立 disjoint owner 只将 observability 的31个显式 any 换成业务类型/unknown，实际编译产物字节相同，不改 trace/回调/持久化运行逻辑。

修改后实际完整 CLI740文件288errors/109warnings，31个错误已消除、警告未减少，**整体 lint 仍失败**；完整原 tsconfig 再次0diagnostics。04:22:08.197–04:26:36.961Z 实际原 `pnpm run build` status0，原 postbuild lifecycle 也执行并通过 standalone trace/runtime guard，未另造替代 build。子进程显式清空两 DB URL、禁用 tracing/telemetry；实际 Next dotenv loader 合成探针验证空值不被 dotenv 覆盖。生成路径 realpath/非链接/工作区包含关系预检后，原 normalizer 只清理重建 `.next/standalone`，未删用户文档；文章数据 SHA 未变。Next 自动把 next-env 路由类型入口由 dev 改为 production，保留其生成结果。构建后 root 组合15/15、实际CLI7零error/warning/fatal，完整444roots类型再次0diagnostics，10身份freeze[]；原构建726观察项除明确生成的 next-env 外 sourceDrift[]。整合父进程status1来自全仓lint288，不是构建失败。

最终四SHA：package `49a2c069131c2e21be1212dd5bb1a42c55b268067bf9221ad9c7645dfdeff9c6`，generator `4867b543524a86883f32b32b77aab88bc4b1b723633a3f2bc77fbd5874b638e8`，新test `a077cf49ee06bea0886eea7c37f2e4325eeaa26739b7baf56a1a9512ae65415a`，observability `0d7b0bdf33681f4272380935af1d3a3db6f9393dd16bf47b50d61a2d308a7860`。功能/安全两面只读审前后四SHA稳定、限定APPROVE本地delta；TS已能确定tracked delta，但因实际全仓288/109停止、未给语义批准。W9还需剩余全仓lint、完整本地依赖/conformance/E2E/Review，W2-W8和生产T16/T17/R18不据build绿勾选；原2/13、11open、18AC unchecked/projection b318ae9e、八formal/read-only未完成与全部production/source/stage/machine/SideEffectPolicy false保持。完整Goal active，不stage/commit/push/Compound/学习、改contract/Oracle或生产状态。详细UTC、原RED及基线校验失败保留在原报告。

### 2026-10-16 W9 上下文与延伸类型边界：253/102，既有路径风险优先

上一Goal轮有实际进展（31个lint错误消除、隔离build通过），本轮继续原W9，不缩减完整范围。完整读取Work/Review技能后识别两独立disjoint任务：root仅owner `context-management.ts/test.mjs`，worker仅owner `conversation-expansion.ts/test.mjs`；用户dirty/staged及所有其它代码/配置保留。上下文实际基线19errors/5warnings，改metadata/details为unknown、SSE为匹配原四类payload的判别联合、15处const及未用局部代码清理；新增持久类型合同先真实5个TS2344 RED，随后6/6（消息/检索/状态/SSE/失败/摘要）GREEN，文件系统/模型/Milvus均为内存夹具。首轮两夹具错误（虚拟Windows路径6053、VM Error realm）单列保留，未误称产品缺陷。

对话延伸实际基线16errors/2warnings，worker持久10例6pass/4fail后实现精确Runnable和unknown JSON守卫；合法旧JSON/fallback/三路候选保持，非法锚点或策略字段不再join/map崩溃，questions字符串不再逐字符生成问题，10/10及root真实组合通过。root首次组合31/31、全配置types0，但新增测试的局部module变量触发Next lint，whole254/102；只重命名夹具变量（sandbox key module保持）后最终31/31、4文件实际CLI零error/warning/fatal、完整444roots/2572sources/440非声明strict0、实际whole742files **253errors/102warnings**。730source/config观察无漂移，Git index SHA保持 `fc6919c7577505a35e6fe7d6f6cae54f80084b0cbbeac9e4c2463a922872587b`；未放宽规则或stage。

本轮复审另发现必须先修的**既有CRITICAL**：`context-management.ts:274`把API sessionId直接拼入会话文件路径，GET/POST/DELETE直接转发，可静态推导父目录片段使load/save/delete越出会话目录；实际部署网关可达性unknown，未执行利用、真实会话IO或声称已泄漏。功能review保留BLOCK，安全只限定本次delta无新增问题；整体W9/Review不能通过。下一L4优先：先用内存/专用合成夹具证明越界读写删除在任何文件IO前被拒绝，统一安全ID与canonical containment、链接/reparse/文件身份拒绝，保留合法既有session流程并核对API错误边界；不得用攻击现存会话、静默删除/迁移、忽略本finding或降低安全门禁换绿。当前新源码build暂未运行，上一轮旧源码build成功不复用为当前身份通过。

最终source/test：context `d930f04e6db5c5c573617a1bdb03d5e173c2fa1739e18efb39016b4cd531f0d8` / `f480ad21bc6ce345eb4de61130286cba618d889ae79b7b98a90842fa23ff36fb`；expansion `95f43efb7f595bd2ea3a5bb0be72f61bd1a667e2e83b8f56d36c1dedba3c5607` / `35b35fa656a85e9f621ac9bdadc47375659c52cd5ba6601c803600149a982fd4`。TS角色仍因全仓门禁STOP、未语义批准，root类型/测试不替代角色结论。完整2/13、11open、18AC原投影b318ae9e且全部unchecked、八formal/read-only未完成和production/source/stage/machine/SideEffectPolicy false保持；完整Goal active，有安全可执行后续，不是blocked/complete。T16/T17/R18真实输入/批准阈值/凭据与维护窗口不由defaults替代；不commit/push/Compound/学习、改Oracle/contract或生产/其它外部状态。所有UTC、原失败与当前身份追加同一原报告。

### 2026-10-16 W9 会话路径安全与真实构建失败：46/46，standalone 仍拒绝

owner“可以暂时使用默认的么”继续按第22行现有边界执行：local-reference、合成roster/manifest/provider、参考时钟可用于本地实现，无须等待生产输入；不伪造生产environment/tenant/corpus、阈值审批、registry/IAM/凭据或维护窗口。root串行实现统一ASCII安全ID、目录lstat/realpath containment、文件nlink/BigInt dev+ino/fd绑定、新文件O_EXCL、校验后截断、metadata ID精确匹配及静态受控IO错误；API400/503、SSE首项预取/晚期code、摘要保存错误重抛。真实路径RED与review反馈3项RED后，最终六完整文件46/46、三文件CLI0、原完整444roots/2572sources/440非声明strict0diag。前提仍是可信服务OS独占目录，未解决租户鉴权、资源配额或敌对parent改名原子性；cwd别名可先mkdir再复查拒绝，不宣称零目录副作用。已有legacy-route-policy尚未接入此路由，是后续独立安全项。

最终source `596101a9dde442ee5d89e520caba7756d4dd0a0739dfe0e6f57ea70b63b63edb` / test `c5bd409b3ff4074ffc7121c184b08e874f8f9680cd3f6e0b81f91ce2b22a1c77` / route `3792562a89a3bf9457f48b2dfebfadef2f2a85112e2e9161dc23a771b7c83be0`。实际whole742文件仍252errors/102warnings、status1。三次原pnpm build均编译/type阶段完成，但不变postbuild guard都拒绝80个raw source/test；依次移除根realpath、根path.resolve仍未解决实际Turbopack whole-project tracing，不能把局部路径范围测试当构建Oracle。直接JS NFT合成探针在失败旧源码也会绿，移除仅本轮新增无效探针；其超时/Windows夹具失败保留，不记产品RED或修复。按Work三轮上限停止盲改/重跑，下一先建立最小真实Turbopack复现/调用原因，不改excludes、ignore、依赖或切webpack绕过门禁。

功能/安全独立只读首尾SHA匹配，限定APPROVE本地安全增量；TS因whole门禁STOP，未语义批准，build/整体W9不通过。06:12:23.458–06:12:24.044Z核验精确生成目录后，由原cleanStandaloneOutput仅移除被拒绝的 `.next/standalone` 副本，原始会话/文档不动，trace/NFT诊断保留，产物可重新构建。730source/config freeze[]、index仍fc6919c7…，用户其它dirty/staged保留。所有原失败、UTC/hash、隔离参数、清理边界和投影编码差异追加原报告；原2/13、11open、18AC unchecked/投影b318ae9e、八formal/read-only未完成及所有production/source/stage/machine/SideEffectPolicy false不变。Goal active，继续真实诊断及既有安全/引用/conformance/E2E依赖；不stage/commit/push/Compound/学习、改Oracle/contract或生产/其它外部状态。

### 2026-10-16 真实 Turbopack 全存储追踪：47/47，原构建与双门禁通过

按Work/Review先做真实Next16.2.6隔离矩阵。循环realpath可独立复现宽追踪，抽同条件helper并显式双检查后目录片段绿，但实际whole build仍80raw失败，保留该负证据；实际NFT还显示3个会话路径。新增持久compiler回归因此扩展到actual函数调用闭包的directory/load/save/list/delete：独立公共asset阳性，loop阳性，全部私有root/source/session阴性；纠正旧不恰当session阳性，不弱化断言求绿。增强实际RED定位load/list仍带三个哨兵，其余仍带session；中途组合46/47、失败standalone按精确生成目录安全清除，不删原始数据。

随后读回并复用仓库既有局部runtime-path标记，只注记两处私有路径构造和已验证fd读取，不改任何运行时ID/canonical/fd/link检查、全局excludes、发布guards或依赖。真实五路径三个私有哨兵全false，public/loop阳性保留；最终47/47、四文件lint0、完整444roots/2572sources/440非声明strict0。**06:46:28.033–06:47:14.244Z原pnpm build及原postbuild trace/runtime guards均通过**；实际NFT1842项，原始源码/运行数据/会话数据/other路径全0，仅1831依赖+11生成项，SHA d4e37779…。整合父exit1只是whole lint743文件252errors/102warnings，不能将build通过当整体W9完成。

最终source `d6469cdc729dca499296fe4c4a40f83940331772474fbd98b1e8b3ec92a33ee4`；新真实tracing test `9139386486cf08b72e39f197892a8f1510f552666ea34b5a2663695738d40243`；context test c5bd409b…、route3792562a…未变。build后只纠正一处test旧说明，去注释编译码073ad5d1…完全相同，不改Oracle，最后47/CLI4/fulltype/whole按新身份重验；产品/config与实际制品未变。功能/安全四SHA只读限定APPROVE，TS仍STOP未语义批准；可信OS、目录创建、鉴权/配额/rename/IAM和继承环境/后代进程证明边界保留。731监测项freeze[]、Git索引不变，原用户dirty/staged保留。

所有原失败、夹具root错误、局部绿不能覆盖whole失败、全存储RED/GREEN、生成副本清理及实际NFT/UTC/hash已追加原报告。下一安全优先：TDD复用已有legacy-route-policy，context接口在非本地demo封闭，避免把无canonical tenant/corpus的会话API当生产多租户入口；再继续其余lint及原W2-W9/引用/E2E/conformance/阶段依赖。默认继续仅local-reference/synthetic；完整2/13、11open、18AC unchecked/原投影b318ae9e、八formal/read-only未完成与全部production/source/stage/machine/SideEffectPolicy false不变，完整Goal active，不缩减范围或宣布全部完成。无stage/commit/push/Compound/学习、原验收Oracle/contract或生产状态变更。

### 2026-10-16 Legacy 会话路由封闭与全发布清单隐私门禁：76/76，制品仍不接受

已按既有 legacy-route-policy 在 context-management 的 GET/POST/DELETE 最前面拒绝非本地 demo，位于请求解析及 manager 调用之前。生产即使显式 local-dev 或携带合成 Bearer 仍返回固定410；非生产 local-dev 合法旧流程保留，缓存 manager 后切换环境仍逐请求重验。新增4例先1pass/3fail RED，再完整 context25/25、八文件55/55；未改原策略或加入伪生产租户。该封闭不保证静态 import/module 初始化无IO，内存模型调用计数也不证明完整模块图无副作用。

07:07:43.726–07:08:26.408Z 实际原 pnpm build/postbuild status0，但这是旧全局 trace guard 的历史结果。后续 native HTTP checker 的真实预检在启动任何子进程/HTTP前拒绝制品：无dotenv，但 standalone含3个会话文件，另18份路由NFT各引用3条、合计54；context路由自身清单为零从来不等于整个制品安全。只读取清单及文件系统元数据，没有读取真实会话内容。HTTP为未运行，不是28例通过。

因此保留原四源码规则，收紧 check-standalone-traces：检查 server 子树和 .next 根部发布NFT，私有会话引用同时按词法/规范目标比较，允许普通依赖别名；拒绝链接遍历、畸形元数据及制品私有目录，违规仅计数、不输出标识。checker同时拒绝大小写dotenv、data父链接/悬空session、入口/元数据祖先及最终链接；error不冒充close，终止证明只限直接子进程。新增回归依次8例2pass/6fail、13例9pass/4fail、18例17pass/1fail RED→最后18新+3原清理共21/21 GREEN。原18AC/contract及四源码禁区不削弱，不用新的局部门禁替代原完整验收。

07:32:52.516–07:32:53.180Z 校验精确生成路径后只清除 `.next/standalone` 副本；733源码/配置无漂移、index不变，原会话未操作，NFT诊断保留。07:39:29.933–07:39:30.878Z 新门禁仍实际拒绝54条引用；缺失生成副本不是隐私修复通过。最终07:41:41.033–07:41:58.482Z十完整文件76/76、CLI7零error/warning/fatal、原完整444roots/2572sources/440非声明strict/noEmit零诊断；733观察freeze[]、索引仍fc6919c7…。07:42:04.621–07:42:19.890Z whole ESLint745文件仍252errors/102warnings/0fatal、status1。

最终 route57d4e7dc…/contextTest7d2aa64d…；guard e49d2d85…/guardTest1eca0b93…/checkerfc6ab740…。功能/安全三文件只读首尾身份稳定，限定APPROVE修复；TS因whole lint仍STOP、未语义批准。下一先对共同持久化读取路径建立真实Turbopack最小复现，修好54条引用来源后才重建、全清单/制品读回及真实HTTP；不删源数据或加全局excludes求绿，再继续原其余W2-W9与T16/T17/R18。默认仅本地合成，真实生产输入/阈值/审批/registry/IAM/窗口仍不由默认值补造。完整Goal active；2/13、11open、18AC全unchecked及原投影、八formal/read-only未完成、全部production/source/stage/machine/SideEffectPolicy false保持；无stage/commit/push/Compound/学习或外部状态变更。

### 2026-10-16 实体元数据路径增量：54→48，完整门禁仍失败

本轮先扩大真实Turbopack回归，提取EntityMetadataStore实际constructor/三状态字段/loadFromFile/resolvePersistPath，仅替换Embedding创建、不启动HTTP。原5c42174f…源码真实0/1 RED：五条会话路径私有哨兵均false，只有entity读取带session哨兵。只给data分支的runtime-root参数沿用仓库局部追踪注记及WHY后，六路径三私有哨兵全false、原public/loop阳性不变，1/1 GREEN。当前source779abd58…/testeb1e4c57…；修正CRLF逆向探针后精确还原旧5c42174f…，去注释实际编译码逐字节相同。没有改运行时路径逻辑、发布guard、配置、依赖或原安全断言；实体持久态应由运行期存储提供，不依赖构建时复制快照。

07:59:56.871–08:01:47.870Z原pnpm build实际status1：compile/type完成，postbuild隐私门禁拒绝，runtime guard未执行，不复用此前build成功。08:03:04.654–08:03:06.069Z只读gate确认privateReferences **54→48**，仍有packaged state；实际16份清单各3条，只有adaptive-entity-rag/conversation-expansion移除。原3个会话文件仅元数据指纹核对前后一致314411ee…，733源码/配置与index无漂移。08:05:45.056–08:05:46.375Z再次仅清除本轮失败standalone副本，原数据未动，NFT诊断保留；HTTP仍未启动，整个发布门禁仍不接受。

两个新增Postgres checksum探索夹具均在原20s编译预算内ETIMEDOUT、没有有效完成清单，不能当产品RED或剩余来源证明；没有改Postgres实现。明确部署脚本/Dockerfile另有schema复制合同后，移除本轮未验证的探索性扩展、精确恢复已验证eb1e4c57…六路回归，旧Oracle/预算保留，失败记录不抹除。最终十文件组合预期76项，实际08:17:20.757–08:17:50.883Z仅52项：51pass/0fail/**1cancel**、status1；闭集hash精确映射取消项为未改的context-management.test.mjs，原因仍unknown，不用旧76/76替代。CLI8为0error/warning/fatal；08:18:33.039–08:19:23.665Z原完整444roots/2572sources/440非声明strict/noEmit零diag，733freeze[]/index unchanged。whole仍745files252errors/102warnings，TS STOP；功能/安全两冻结SHA限定APPROVE不等于W9或生产通过。

后续只读分类确认Ask/graph-health/maic-upload均仍含5个data JSON（其中3会话）；health还带入两份embedding/index测试模块等9个公开源码模块，MAIC无这些源码模块。不能把共同data集合简单归因单个Postgres方法，也不能据一次CPU76%/剩余内存约7GiB快照断言超时根因。下一先定位剩余共享文件追踪边界及原context取消原因，再按原预算验证全部76/原全量及新整仓build/制品/HTTP；不再盲目重跑同一超时探针、不删真实数据或加全局excludes/文件名黑名单求绿。原完整Goal、2/13、11open、18AC unchecked/投影、八formal/read-only未完成和全部生产标志false保持，无stage/commit/push/Compound/学习或外部变更。

### 2026-10-20 测试夹具重复转译与真实 schema 回归：78/78，发布仍拒绝

默认值继续只用于 local-reference/synthetic，不替代 T16/T17/R18 的真实范围、输入、批准阈值、registry/IAM/凭据或维护窗口。按 Work/Review 将不相交的本地任务分开处理：context 测试夹具重复转译，以及实际编译器的 schema 路径回归；没有修改 Postgres、context、route、adaptive 或发布 guard 实现。

只读源码计数确认 context 原 25 项执行约 242 次 context、70 次 policy、70 次 route 转译，共 382 次，不能据此断言它是此前取消的唯一原因。先新增确定性缓存失效 RED，再只缓存不可变转译字符串，按绝对文件名与本次新读的完整源码匹配；每次仍创建新 VM/exports/依赖/FS/manager/env。新增隔离回归后 context 27/27，原 25 测试块逐字投影不变。只读逆变换精确重建旧 7d2aa64d…；当前 test3e6c0dd0…，三面独立复审限定无可操作问题，不等于 W9/发布通过。

schema namespace-import 夹具在原 20 秒预算实际 ETIMEDOUT，不能记成产品失败；改为与真实 Postgres 源码一致的 default path import 后，原预算内完成。继续抽取完整实际 checksum 函数、两状态、错误类及两个纯 helper，共六节点，新增第九条私有哨兵断言；public/loop 正控及原八路径保持。最终 compiler testf4e6bafa…，九路径 root/source/session 哨兵全 false，静态及实际 schema asset 阳性。单独 pg 导入、实际 client 导入的脱敏对照也完成；实际 client NFT 对原会话目录引用为零。但完整 MAIC 路由探索 compile status1、无有效 NFT，不能用于隐私判定；失败保留，一次性诊断脚本与自有合成目录已清理，正式回归保留。

03:10:10.664–03:10:20.217Z 十完整文件实际 **78/78**、0 fail/cancel/skip，9512.1436ms；原默认并发、30 秒测试、20 秒 compiler、90 秒父预算未改。03:12:08.858–03:12:40.344Z 原完整 tsconfig 444 roots/2572 sources/440 非声明、strict/noEmit/incremental false，0 diag；两变更文件 CLI lint 全零，关键源码与 Git index 无漂移。03:14:39.169–03:14:58.561Z 原 whole lint 745 files 仍252 errors/102 warnings/0 fatal、61 problem files，status1。

03:11:50.696–03:12:07.337Z 原全局 trace guard 仍 status1；03:16:38.587Z 独立元数据回读确认16份 NFT/48条会话引用、standalone缺席。原3文件 regular/0 links，元数据指纹仍314411ee…，没有读取内容或输出名称。未重跑整仓 build、启动 native HTTP 或生产；不能用夹具阳性、删除失败副本或批准本地差异来补造发布通过。下一优先定位完整依赖追踪的48引用，再按原门禁重建、全制品回读及 HTTP；1194/原60正式范围未重跑，八formal/read-only仍未完成。

原2/13、11open、18AC全部unchecked、LF无尾换行投影b318ae9e…及全部production/source/stage/machine/SideEffectPolicy false保持，无acceptance binding。完整Goal active，继续全部既定任务，不标complete或因尚有本地可执行工作而标blocked；无stage/commit/push/Compound/学习、Oracle/contract、生产或其它外部状态变更。完整UTC、SHA与审查边界追加同一发布报告。

### 2026-10-20 运行态 JSON 追踪边界：48→0，原整仓构建通过

继续使用已授权的 local-reference/synthetic 默认输入，不补造生产 scope、阈值审批、registry/IAM、凭据或维护窗口。本轮先建立完整真实模块 RED，再定位路径生成本身：artifact-cache creator-only 无任何 FS 读取也收集合成 session，reader/writer-only 则不收集；Graph 五个 JSON getter 的无 FS 对照也各自复现。前三次 cache 候选及 constructor-only graph 候选均未解决，全部精确撤销后才按新因果证据修复；未用全局 excludes、文件名黑名单、删原数据、改依赖或预算换绿。

最终仅两处产品改动：artifact-cache 的末级 cache_file join 标记运行态数据；Graph 五个 JSON getter 用单次求值目录 alias 和首参局部标记。完整实际模块回归、原安全/容量/锁/TTL 逻辑保留。功能/安全限定复审无剩余问题；审查发现 graph POST 夹具无效，已先用真实纯 creator 前置断言复现 RED，再补齐 schema 字段，未把原“仅编译”说成已执行写入。

04:03:55.034–04:07:24.902Z 原 pnpm12.3.4 run build 实际 status0，原 trace guard 和制品 runtime 依赖检查均通过；738 source/script/config SHA、Git index、三原 session 的元数据前后不变。04:08:14.760Z 及04:19:27.636Z 独立全部 NFT 元数据读回为私有会话引用0/受影响0（旧48/16）；standalone存在且原checker preflight拒绝私有会话/链接/dotenv的检查通过。未读原会话内容或输出文件名，自有临时目录残留0。

04:15:06.221–04:15:13.740Z 保留原十文件并加完整相关回归，15文件实际 **131/131**，默认并发、原30秒test/20秒compiler/90秒父预算；原完整 tsconfig 444 roots/2572 sources/440非声明、strict/noEmit true、incremental false、0diag，四变更文件lint0。原whole lint746文件仍252errors/102warnings/0fatal、61problemFiles、status1；TS角色据此STOP，未语义批准，整体Review/W9不通过。

原native HTTP首轮04:09:42–04:09:50Z requests失败、completed0；首个只status/hash诊断也失败，错误类别尚未知。其后受控只观测诊断28/28；为检验是否依赖hook，一次原checker无hook对照04:18:04.659–04:18:06.023Z实际28/28、两个prefix全410、服务关闭且制品身份不变。保留首次失败，不能把后续通过写成间歇故障已修复或生产已验收。

当前产品/cache-test/graph-test SHA分别0a9d7cfe…、1cf79d44…、d60f4951…、99bb70b1…；完整SHA、UTC、RED与失败证据见同一报告。原2/13、11open、18AC unchecked/投影b318ae9e…、八formal/read-only未完成及production/source/stage/machine/SideEffectPolicy false保持，1194/原60未重跑。完整Goal active；下一继续原HTTP间歇归因、全仓lint及剩余W2-W9/企业conformance/E2E/生产输入，不mark complete/blocked、不stage/commit/push/Compound/学习或改Oracle/contract。

### 2026-10-20 后端类型边界：lint 252→212，联合与 HTTP 未过

默认授权仍仅 local-reference/synthetic，不能替代 T16/T17/R18 的真实输入、目标范围、批准阈值、provider registry/IAM、凭据引用或维护窗口。本轮按 Work/Review 继续本地任务；未 stage/commit/push/Compound/学习或改变生产/外部状态。

lane-handlers 以真实事件/检索/历史类型替换 any，7/7 回归；去注释实际编译 JS 与原工作区 CRLF 源码逐字相同。intent-distillation 对请求、磁盘 JSON 与模型响应建立 unknown 边界，19/19，JSON ±1e400 的非有限数拒绝；合法有限值、旧 confidence 0→0.5、改写/模型/检索算法保持，不新增概率钳制或维度策略。原 whole ESLint 从252errors/102warnings降至229errors/99warnings，仍失败。

原 HTTP checker 仅增加闭集失败证据，保留21项原assert、28案例、预检、5秒请求/35秒总期限/真实关闭及所有原预算。新18项反例与原18守卫共36/36；失败不输出任意错误、响应、URL或服务日志。本轮第一次真实检查04:53:46.784–04:53:54.314Z明确 request-timeout、attempted1/completed0、serverClosed=true；不能仅按时长猜测原因。

基于真实路由急切导入证据，先新增3项 RED，再将上下文运行时延迟到每请求原禁用门禁之后；并发测试另复现重复创建 manager，修至 await 后同步检查/创建。原27项逐字保留、现31/31；首次全量类型发现3个TS2775，显式类型绑定后原完整444roots/2572sources/440非声明 strict/noEmit、incremental=false零诊断。最终18完整文件默认并发179/179，原30秒test/20秒compiler/90秒父预算不变；本轮12文件lint零。功能/安全限定审查无可操作问题，TS仍因整仓229errors/99warnings STOP，不宣告整体Review/W9通过。

05:11:19.267–05:12:06.608Z以最终route2bb96662…执行原pnpm12.3.4 run build，status0，原trace guard和制品runtime依赖检查均通过，741源码/配置及index无漂移。05:13:05.050Z安全替代只读核对全部生成NFT，私有会话引用0/受影响0、standalone存在、自有fixture残留0。原会话目录再次枚举被安全审查拒绝，已停止该检查；本次最终读回未读原会话目录项、名称或内容，不用此前元数据指纹冒充本次重验。

新产物无hook真实HTTP05:13:40.486–05:13:47.915Z仍在第一请求5秒超时，attempted1/completed0、serverClosed=true；懒加载不是已证实的超时根治。一次仅客户端闭集观察也超时：TCP连接与请求发送已完成，没有响应头。另一次服务端内存观察28/28，但acceptanceRun=false且改变时序，不覆盖原失败、不作为无hook验收或唯一根因。没有自动重试、放宽预算或用诊断绿替换发布门禁。

后续领域向量route22/22与词元分析器9/9，原算法/完整合法响应及opaque持久化记录保留；Trace-Trie仅let→const，100个纯内存旧新输出全等。新增批次之后原全量类型05:44:55.602–05:45:03.338Z仍零诊断，17文件lint零。原20文件联合05:44:12.845–05:44:21.088Z却为209/210，图谱compiler0且私有哨兵均false，但具体父项失败类型尚未知；单独诊断1/1不替代联合失败。同期自有合成夹具残留先使原wholelint扫描816文件/328errors/3236warnings；只可恢复隔离该已验证owner夹具、未改规则后，05:49:04.607–05:49:19.020Z原wholelint实际751文件/212errors/97warnings，仍不通过。夹具保留于out/diagnostics/graph-trace-quarantine-20261020-054412-MyyVTc，没有删除用户数据。

05:52:43.542–05:55:40.052Z最终后端批次的原pnpm build实际status0，743源码/配置及index无漂移、原trace/runtime门禁通过；本次完全不枚举原会话目录项。05:58:38.124Z全生成NFT仍私有引用0/受影响0，根自有fixture前缀残留0（上面的隔离诊断仍保留）。随后只清理domain类型声明一个空格，精确逆变换恢复已构建15648f6f…且全文件编译JS逐字相同；不改写构建时源码标识。新BUILD_ID无hook原生HTTP05:59:29.837–05:59:37.362Z仍第一请求5秒超时、0/1、服务真实关闭。Next实际实现与05:35只观测对照确认Ready日志早于handlers完成，但尚不能证明它是这些5秒失败唯一原因，未改就绪合同/预算或用诊断绿放行。保存失败仍success、保留键不保存centroid、SDK旧两参encode等独立风险明确未解决，不能把类型收敛称为全部任务完成。

06:02最终收尾仍使用未改原完整tsconfig：实际445roots/2573sources/441非声明、strict/noEmit true、incremental false，0诊断，27个关键文件无漂移；本次真实根数量与前述444不同，不把旧计数套用于新程序。原ESLint . 06:02:29.819–06:02:44.737Z仍751files/212errors/97warnings/0fatal、56problemFiles、status1，stdout85ed3474…；17文件lint零，最终git diff --check status0（只有既有LF→CRLF提示）。06:04:10.921Z原18AC仍全部unchecked、原投影和index不变，生成NFT私有引用仍0，原会话目录项未读取。

本轮全部SHA/UTC/RED与失败证据追加同一发布报告。原2/13、11open、18AC全部unchecked及原投影b318ae9e…、无acceptance binding、八formal/read-only未完成和production/source/stage/machine/SideEffectPolicy false保持；1194/原60正式范围未重跑。完整Goal active；下一继续HTTP因果归因、原wholelint及所有剩余W2-W9/企业conformance/E2E/T16/T17/R18，不标complete/blocked、不改Oracle/contract。

### 2026-10-20 默认演练续接：23 文件 278/278，生产准入仍待验

继续沿用第22行已约定的 local-reference/synthetic 默认配置、合成 roster/manifest/provider 与参考时钟；不新建真实生产 scope、批准阈值、registry/IAM、凭据或维护窗口，也不将测试签名当作生产审批。

Trace-Trie API 只收敛6处显式 any 并省略未使用 key，实际完整模块22/22；旧模型顺序、错误响应、receiver 与两参 encode 保留，SDK 参数兼容风险未修复。Graph 集成测试只增加闭集失败阶段/cleanup 观测，原15 assert、12模板字节和预算不变；原异常原样重抛，27项整模块 mock 通过。功能/安全四文件增量审查未发现可操作问题；TS角色仍因 whole lint 失败 STOP，不宣称整体 Review 通过。

06:30:39.399–06:30:51.566Z 保留原20文件并加入上述两测试及现有 reference evaluator 的23文件，实际278/278、0fail/cancel/skip/todo；默认并发、30秒test/20秒compiler/90秒父预算未改，源码冻结和index无漂移。原209/210与间歇失败不被覆盖，本次没有复现它们，也未证明根治。06:31完整原tsconfig为445roots/2573sources/441非声明、0diag，20文件lint零；原whole ESLint 753files仍206errors/96warnings/0fatal、55problemFiles、status1。

06:33安全读回仅检查生成NFT与原会话根身份：私有引用0/受影响0、根自有fixture残留0、18AC全unchecked/原投影及index不变；原会话子项未读取。原HTTP超时仍未解决，本次没有用默认值或诊断观测替代生产验收，也未对新API源码重跑全应用build。精确原54诊断runner已找回，但它的loader CLI不是normal60；六项增量集合有证据，历史60原序未恢复，不据此称1194正式回归已重跑。

完整2/13、11open、18AC、八formal/read-only与全部production/source/stage/machine/SideEffectPolicy false保持，Goal active；下一继续HTTP因果定位、whole lint和原W2-W9/企业conformance/E2E/T16/T17/R18，不缩减范围或标完成。无stage/commit/push/Compound/学习、生产或其它外部状态变更；详细SHA/UTC与完整23文件顺序见同一发布报告。

### 2026-10-20 按需入口加载：真实新制品 HTTP 28/28

本轮先做同一制品、同开销的预加载开启/关闭/恢复开启诊断：第一轮5秒超时，关闭后28/28约0.4秒，恢复开启后28/28约3.8秒；均非验收且产物未改。结合已安装Next的全入口后台加载实现，将非static export的preloadEntriesOnStart设为false，保留正常请求时加载；冷暖缓存仍影响结果，不宣称这是全部历史超时唯一原因。

新增实际配置测试最终9项：原7pass/2fail RED→9/9，保留basePath归一化、rewrite、static export、native SDK和tracing范围。功能/安全增量审查未发现可操作问题，安全review与root各自精确内存逆向恢复旧配置e16d0d44…；除新增块外仅邻近空行/注释换行变化。TS因whole lint失败仍STOP，未整体批准。

06:49:02.138–06:49:49.850Z原pnpm run build status0，746源码/配置及index无漂移，原trace/runtime门禁真实通过。新产物配置读回preloadEntriesOnStart=false；06:51:31.841–06:51:35.889Z无hook/Inspector/预热/重试的原HTTP检查一次 **28/28**、双前缀、原5秒预算、serverClosed=true，checker65965158…未改；productionAccepted仍false。这只闭合本轮真实HTTP门禁，不证明其他路由冷启动或全生产E2E。

06:52保留上轮完整23文件，同序追加next-config.test.mjs的24文件实际 **287/287**、0fail/cancel/skip/todo、原并发/30秒test/20秒compiler/90秒父预算保持，freeze/index无漂移；原完整445roots/2573sources/441非声明strict/noEmit、incremental false、0diag，22文件lint零。whole lint仍754files/206errors/96warnings/0fatal、status1，W9和整体Review不通过。

06:54安全读回新制品全部NFT私有引用0/受影响0、根自有fixture残留0；未读取原会话子项。原2/13、11open、18AC全部unchecked/原投影、无acceptance binding、八formal/read-only和production/source/stage/machine/SideEffectPolicy false保持。完整Goal active；继续whole lint、可重放完整生产工具回归、原W2-W9/企业conformance/E2E/T16/T17/R18，不缩减范围或以本轮绿覆盖历史失败，不stage/commit/push/Compound/学习或改变外部状态。完整SHA/UTC见同一发布报告。

### 2026-10-20 前端增量与完整60集合本地回归

默认值继续只用于local-reference/synthetic，用户允许暂用默认值不等同提供生产事实或批准生产阈值。本轮未改Oracle/contract、18AC或生产放行条件。

三个原本clean的前端模块按TDD修复：实体页图例同提交派生/真实读取卸载门控/D3类型；Process去除未展示的派生state、收敛D3类型并清空空图残留SVG；QueryAnalysis分离nullable边界与三个无条件memo、按实际消费字段收敛类型。真实完整模块React DOM/jsdom/D3测试分别10/26/8项通过；Query旧版在React19未复现运行时Hook异常，只把静态生命周期契约与渲染更新作为证据，不宣称修复已复现崩溃。既有Process taskId无轮询/Profile与Simulation禁用、实体页提取轮询与simulation清理等未被本轮补全。

新建可重放入口docs/reports/.diagnostics/run-normal-rag-regression.mjs及显式v1 inventory：原54顺序加有证据的六项增量按字典序，完整60集合而非旧loader CLI；历史60原序未恢复，historicalOrderRecovered=false。07:36:46.277–07:37:21.417Z真实原生60文件回归 **1194/1194**，0fail/cancel/skip/todo，原30秒test/90秒父预算、16MiB、默认并发、router off均保留。752源码/配置/入口/清单冻结及index无漂移，productionAccepted=false。入口13项隔离测试通过；早期自有CJS入口lint4个require错误后改标准ESM，未豁免规则。

07:39:03.532–07:39:13.713Z保留上轮完整24文件并追加三个UI测试与入口单测的28文件实际 **344/344**、无失败/取消/跳过；原两compiler 20秒预算保留，freeze/index无漂移。07:40原全量445roots/2573sources/441非声明strict/noEmit、incremental false、0diag，本轮30文件lint0/0。whole lint实测759files/**153errors/83warnings**、0fatal、52problemFiles、status1，较206/96减少53/13，W9及整体Review仍不通过。

07:41:18.883–07:42:06.141Z原pnpm12.3.4 run build成功，749源码/配置与index无漂移，原trace/runtime守卫实际成功。07:42:36.977–07:42:41.213Z新制品原HTTP checker一次 **28/28**、双前缀、原5秒请求/35秒总期限、serverClosed=true；没有hook/Inspector/预热/重试，checker未改，仍非生产验收。07:55新制品NFT私有引用0/受影响0、根自有fixture残留0。

功能/安全九文件增量审查通过；Process单测原两处假绿（卸载兜底stop、Number(null)）已补强并复核，344联合运行使用补强后版本。TS专项仅核实scope/SHA，因whole lint失败保留STOP。实体页早期窄类型解析曾沿用原** include，可能枚举工作区目录，未读取会话内容；最终改显式files并禁止readDirectory。保留此历史限定，不声称本轮所有检查从未枚举目录。

agent-browser独立CLI两次daemon启动失败；工作区socket/最小环境/禁用自动状态清理的第二次仍失败。前台5秒诊断ETIMEDOUT且无stderr，不证明daemon已就绪；真实浏览器/E2E **未完成**，不拿jsdom代替。首个CLI继承环境未审计，其默认自动状态处理是否运行未知，未复查个人保存状态；后续已显式禁用。仅检查三个精确自有PID回执均不存在，不据此断言绝无残余子进程。独立loopback服务器已收到closed=true；其stdin关闭导致显式stop发送失败，随后硬期限自动关闭，未杀其他进程。

原2/13、11open、18AC全unchecked/原投影、无acceptance binding、八formal/read-only及全部production/source/stage/machine/SideEffectPolicy false保持，Goal active。完整W2-W9、企业conformance、真实E2E、T16/T17/R18仍未完成；继续清理剩余lint与安全的真实依赖验证，生产输入/阈值/registry/审批仍不能以默认值冒充。无stage/commit/push/Compound/学习、生产修改或用户数据删除；完整SHA/UTC和可执行入口见同一发布报告。

### 2026-10-20 第二批前端与浏览器合成验证：完整回归仍未闭合

用户允许暂用默认值继续仅适用于local-reference/synthetic；不构成生产environment/tenant/corpus、批准阈值、V2 roster/gold、registry或审批凭据。未修改Oracle/contract、18AC或生产放行条件。

本轮四个实际产品文件与三个完整TSX模块测试：Milvus按实际字段收敛类型、同源memo依赖并在真实fetch订阅中加卸载门控；Adaptive面板同源依赖与实际消费类型；Agentic页只作类型收敛，Trace id改为可选以兼容实际engine步骤，保留已有id回退。最终16/11/14项通过。功能/安全独立增量审查无剩余finding；TS专项仅核实scope/SHA，因whole lint失败保持STOP。未以空Promise/计时器或规则豁免绕过lint。

08:32:38.056–08:32:53.117Z保留上轮28文件同序追加三个测试，原生31文件 **385/385**、0fail/cancel/skip/todo；原预算和断言不变。全量445roots/2573sources/441非声明strict/noEmit、incremental false、0diag；37文件lint0/0。whole lint实测762files/**128errors/77warnings**、0fatal、49problemFiles、status1，较153/83减少25/6，整体Review/W9仍不通过。

完整60入口本轮真实运行08:33:44.507–08:34:20.159Z **1193/1194、1fail**；失败定位到Ask过期owner租约恢复用例，原失败断言细节未捕获。一次仅作观察的完整60诊断又出现1168tests/1165pass/1fail/2cancel，Ask与HTTPS transport文件超时以及既有20ms publication用例失败，不能充当验收或推定原因。09:09单独选择租约用例1/1通过，只说明未在隔离运行复现；没有改断言、延长预算或以这次绿覆盖整包失败。三次均保留，生产仍false。

08:43:07.515–08:46:23.226Z原pnpm12.3.4 build成功，752源码/配置及index无漂移，原trace/runtime守卫实际成功。按既有Docker/部署配方仅向生成standalone补齐57个static和8个public文件，逐文件SHA一致且只新建、不覆盖/删除。08:48新制品原HTTP一次 **28/28**、双前缀、原5秒/35秒预算、serverClosed=true；不等于Linux/DockerE2E。

agent-browser手动运行已安装的官方Node daemon入口，最小环境、独立socket、禁止旧状态自动处理和非loopback网络；实际监听后CLI可用。补齐资源后JS/CSS200；首次CLI body路由未生效，未当作成功fixture。随后证实真实API请求被abort，再安装页面内明确合成fetch，通过真实刷新按钮得到2节点/1边并截图，两个节点仍呈旧黑色着色，未称修复。真实浏览器合成UI链路完成一个场景，不是provider/数据库E2E或完整W9。浏览器close成功并收到daemon真实exit0，独立本地服务收到closed=true。

09:07仅生成NFT扫描：私有引用0/受影响0、根自有fixture残留0；未枚举原会话子项。原2/13、11open、18AC全unchecked/投影、无acceptance binding、八formal/read-only与production/source/stage/machine/SideEffectPolicy全部false保持，Goal active。下一优先诊断完整回归失败，继续剩余lint、W2-W9/企业conformance/真实依赖E2E/T16/T17/R18；无stage/commit/push/Compound/学习、生产修改或用户数据删除。完整UTC/SHA与限定见发布报告。

### 2026-10-20 原生60闭集诊断：定位503与进入前超时

本轮先补既有完整60入口的封闭失败目录，两个既有诊断文件改动；未改生产代码、测试集合、inventory、Oracle/contract、原预算/并发或判绿式。目录只输出标签hash、已验证源文件索引/行列、闭集错误类型、100..599中性整数与已有provider-entry闭集上下文，并明确截断。原13项保留：18项13pass/5fail RED→19/19；独立复审发现整数误称HTTP和EOF漏报，两项再经22项19pass/3fail RED→22/22。功能/安全最终delta关闭finding；JS/TS专项仍因整体lint失败仅身份核实/STOP。精确内存逆向恢复旧runner和原13用例完整SHA，原门禁不变。

09:52:47.832–09:53:55.016Z一次原生完整60实际 **1167tests/1163pass/2fail/2cancel/0skip/todo、status1**，755源码/配置/入口/清单/来源及index前后无漂移，productionAccepted=false；因两个文件超时没有完整1194交付，不记整包通过。新证据唯一映射Ask用例1884的首次POST断言1902，实际503/预期200；不是2475的租约恢复，旧心跳竞态只保留为独立fixture风险。另一个失败为production-publication-artifact.test.mjs:362等待entry，已有helper报告operation-timeout/clock/pending=false/mutation=false，说明这次在目标provider进入前终止，不是363行UNKNOWN断言丢失。两个文件级30秒超时精确归属Ask和native-publication-sources，不能混称旧HTTPS超时或认定与503同因。

下一步保持原20/1000/80ms与默认并发：先对Ask目标首次响应做最小闭集观测，实际code/stage尚未捕获，不能从503认定storage/EPERM；旧observer的route SHA已失配，不绕过preflight。publication定向fixture需要同realm独立模块/一致可控clock，保留真实writer/reader/bounded、六阶段及独立真实CPU超时用例；不在已捕获monotonicNow的全局subject上临时mock造成双时钟，不让进入前超时变成pass。具体模块私有proof/realm兼容仍须实现验证，当前没有声称已修复。

两文件最终lint/语法0、22/22不是整体W9通过。本轮未重跑全量TS/build/浏览器，上一轮whole lint128errors/77warnings仍未关闭；2/13、11open、18AC全unchecked、八formal/read-only、无acceptance binding与全部production/source/stage/machine/SideEffectPolicy false保持，Goal active。无stage/commit/push/Compound/学习、生产修改或用户数据删除。完整UTC、SHA、复审及下一诊断边界见发布报告。

### 2026-10-20 私有测试时钟与首次响应闭集诊断实装

本轮按已确认边界完成两项测试/诊断增量，不改生产实现。publication helper 编译实际 writer/reader/bounded 为同 realm 独立闭包，仅替换该实例的 node:perf_hooks；原生 Promise/timer、原20/1000ms、六阶段 entry/UNKNOWN/mutation/停止后IO断言保留，独立真实20/80ms CPU测试逐字保留。新两项先RED再GREEN，10:21Z整个publication文件34/34；这只证明私有时钟语义，不证明真实准备阶段总能在20ms内完成。

Ask只增加10个纯合成测试和原目标首次POST状态断言的闭集消息，未知字段unknown，不读取header/query/error/path；formatter/parser拒绝getter/Proxy及非canonical字符串。父入口只从真实TAP error提取该消息，新增3项含真实纯Node断言TAP，25/25；原22项、通过判定与全部预算/顺序精确内存逆向恢复。六文件最终语法及原规则定向lint均0，功能/安全独立复审限定通过；JS专项因当前type/整体lint前置证据不足STOP，不冒充三面全部通过。inventory仅更新Ask/publication两行源码hash，原60顺序及其余字节恢复旧SHA完全相同。

新证据不能写为整体修复：12:38Z独立完整Ask为72tests/70pass/1fail/1cancel；失败标签对应最小checkpoint/replay用例，原始差异未留存，不能补猜503原因。12:44:02.054–12:45:39.546Z一次原生完整60为1043tests/1037pass/1fail/5cancel、status1，757源码/配置/清单/来源无漂移、index不变。五条文件级timeout与publication真实CPU测试419行断言均保留；此轮没有捕到目标first-response诊断，不据缺失推断流程未运行。完整回归仍失败，不因局部34/34或10/10改记W9完成。

12:47Z代码范围canonical lint因90秒父预算终止，status=null/spawnErrored=true，无完整统计；不是新的全仓lint通过，也不覆盖此前128errors/77warnings。未重跑全量TS/build/浏览器。下一优先调查真实CPU测试进入前耗时和文件级超时，以及Ask实际失败；不放宽原预算、不跳过用例或替换生产门禁。W2-W9、T16/T17/R18全部仍open，2/13、18AC全unchecked、八formal/read-only及所有真实性/生产标志false保持；默认值只用于local-reference。完整Goal active，无stage/commit/push/Compound/学习、生产变更或用户数据删除。精确SHA/UTC与验证限制见发布报告。

本轮终态补记：12:50:55.564–57.268Z新inventory下父入口25/25/status0、三文件freeze=true；12:53:48.553Z仅与60清单的native TAP固定路径编码作hash匹配，五个文件级超时唯一归属Ask、graph-control-worker、local-graph-build-executor、neo4j-publication-readback、native-publication-sources，未匹配项0。这是身份归属，不是CPU/IO根因证明，也不把五个超时合并为一因。

### 2026-10-20 真实CPU测试的派发归因修正与下一组合依赖

13:01Z原真实CPU用例隔离1/1，没有复现上一完整运行419行失败，不能凭名称确认原错误字段。实际代码证明整个20ms预算包括两遍reader与clock，晚期encrypt可能安全地没有进入；因此不能按scenario标签推定mutation=true。本轮有意修正该测试的这一假设：仍用原native subject、20/80ms、完整timeout谓词、halted和终态后零IO，mutation严格等于独立fixture记录的实际encrypt派发次数（先限定0或1），不是任选布尔值。新提前超时例硬断言KMS entry0；另新增私有准备后在实际KMS entry才跟随native elapsed的独立例，硬断言entry1/真实elapsed≥80/mutationtrue/seal0/halted/noIO。原生timer/Promise/global性能及生产代码不变，不声称整准备+KMS能在真实20ms内完成；这不是对上轮“原CPU测试字节未变”历史事实的追溯改写。

新增3项13:14Z先0/3 RED、13:20Z再3/3 GREEN；13:24Z整个publication文件37/37、syntax2及canonical lint2全0。功能/安全独立复审限定APPROVE，JS专项缺当前完整type/whole lint前置证据仍STOP。helper精确逆向恢复上轮SHA；测试逆模板及有限换行匹配未恢复基线，原因unknown，不声称该字节级保护已通过，生产writer/reader/bounded三SHA复核无漂移。

inventory仅更新该测试hash并精确恢复上轮清单，其余60顺序/预算/门禁不变。13:31:44.297–13:32:43.054Z一次原生完整60为1154tests/1151pass/0fail/3cancel/0skip/todo/status1，757源码与index无漂移，仍不是整包通过。三条均文件级timeout，固定路径hash精确归属Ask、native-publication-sources、production-ask-https-transport；没有足够事实归因同一CPU/IO原因，不用本次零断言失败覆盖旧失败。原whole lint128errors/77warnings未关闭，未新跑全量TS/build/浏览器。

只读架构核实的下一处本地消费缺口是authority runner与Shadow副作用runner各自私有创建普通sampler，尚无同一次authority-owned T16执行的组合入口；不是缺基础quality collector或Shadow比较器。后续应复用已有facade，在actual evidence/approval/nonce之后执行同次run-before→完整采样→run-after，共享实际clock/expiry/派发围栏，不接收caller报告或事后拼同hash。质量定义、缓存等价性与企业IAM仍不能假设补齐。所有W2-W9/T16/T17/R18、2/13/11open/18AC、八formal/read-only、无acceptance binding与生产/真实性false保持；完整Goal active，无stage/commit/push/Compound/学习、生产变更或用户数据删除。

### 2026-10-20 Authority-owned T16 Shadow 本地组合与无损证据表示

完成 `createReferenceAuthorityShadowAskRunner` 本地组合入口：沿原 authority 的实际 evidence/签名/nonce 精确读回，调用同一私有 Shadow facade 的 run-before→完整采样→run-after，不收 caller sampler/report，不事后拼接独立结果。仅 T16、严格 readback 端口；raw state 仅 primitive string 沿原 8MiB 上限交给原 facade 做完整解析、全字节加密归档。旧工厂仍拒绝新增端口；原 fresh clock/checkpoint、expiry、native peer/绝对截止、close/UNKNOWN/nonce 围栏保持。所有生产、来源、IAM、stage、machine 与 SideEffectPolicy 标志仍 false，缓存等价性定义未补猜。

新增11项13:59Z先真实RED；初实装14:06Z正向触文件30s，不能算通过。后续封闭计数显示第11次POST后 evidence-failed；静态查到重复完整 provider 表使第441条checkpoint超原200000节点，且本层capacity被错包。修复仅新Shadow证明的无损provider表驻留，保留所有实际复核、动态字段和原decisionHash，逐条可还原；旧证明结构不改，原8MiB/200000预算和来源生命周期不加大。本层capacity现保留原错误。实测494条完整展开224277节点，紧凑全proof85150节点/3084430字节，每条原hash还原一致；这是表示改进，不是缓存复核成功或删证据。

将原HTTPS前置fixture机械提到共用test-support，新11项独立文件，不挤原文件30s预算。14:52Z纯内存逆向提取和已知边界换行，精确恢复原整HTTPS SHA42ceb6…为true，原用例/fixture无旁改得到字节级证据。临时stdout计数已移除，仅留闭集容量数字。同步close+throw测试按既有fault优先期待operation-failed，UNKNOWN/消费nonce/mutation硬断言不减，新增!posted；另一个晚到readback关闭例仍硬要求halted。

最终14:44:47.199–14:45:13.083Z新11/11，14:45:13.085–37.821Z旧HTTPS完整34/34；均原30s/90s/16MiB、无skip/cancel、source freeze。syntax3及canonical lint4均0，14:49Z项目上下文strict/noEmit/incrementalfalse检查1root/634sources/0diag，不冒充全项目TS。功能/安全独立复审限定通过，JS专项因当前whole lint前置未满足STOP，不冒充三面全语义批准。

库存只更新HTTPS一行hash，逆向精确恢复旧d598…，原60顺序、预算、默认并发、router off和全部false标志保持。14:50:08.676–14:51:16.946Z一次正常原生60为1177tests/1174pass/1fail/2cancel、status1；759源码/配置/清单/runner/authority及Git index无漂移。唯一断言定位Ask2135行actual500/expected200；Ask与native-publication-sources文件级timeout保留，不能推断共同根因。未因11/11与34/34关闭W9，旧失败历史保留。

下一优先基于该Ask固定位置定位500及两文件超时，不盲目放宽时间或跳过；未新跑全量TS/build/浏览器，旧whole lint128errors/77warnings未关闭。2/13/11open、18AC全unchecked、无acceptance binding、八formal/read-only及生产真实性边界不变。默认值只用local-reference合成验证，不能替代T16/T17/R18真实输入、阈值、审批或窗口。完整Goal active；无stage/commit/push/Compound/学习、生产变更、原会话子项读取或用户数据删除。精确source/test SHA与运行证据见发布报告。

### bounded replay 诊断与 native SDK 分页替身验证增量

实际隔离bounded replay首次响应例1/1，未复现原500，不能据此关闭业务故障。新增owner固定bounded标签，与原agentic标签共用严格own-data/无hook formatter；parser只接受两种精确canonical消息，原200断言只加失败时的闭集消息，不输出response/error正文。新4项先0/4 RED，真实TAP子进程补用既有最小环境后4/4；父catalog新增bounded标签仍硬要求passed=false/exit1。只改测试与诊断，不改生产路由。

native fake SDK原每页先filter全表再slice；现仅收足合法limit即停止，保留seen过滤和原顺序。新suffix边界/非prefix seen等价两项先1pass/1fail再2/2；65536行、两次完整reader scan、1028readbacks及全部原14例/容量/截止均保留，不是缩样或缓存成功。完整native16/16、父runner26/26，syntax5与原规则lint5零错警。功能/安全独立限定复审通过；JS专项调用后的最终结果未取得，不当作语义批准；未新跑全量TS/build/浏览器，旧整体lint未关闭。

Ask原完整文件曾触30s；两次过滤诊断分别29/29与90/90，但实际标签重叠29，预设互补分组并未成立，不能拼成完整验收或据此归因。一次验证句柄60775经工具确认不存在且结果未取回，该次结论unknown；随后核验五SHA未变再重取结果，非把观察超时当成功。

库存仅更新Ask/native两行hash，内存反替换精确恢复旧e97…；原60顺序、30s文件/90s父/16MiB、默认并发/router off与生产false不变。2026-10-22T03:25:50.358–03:26:34.563Z一次正常完整60为1211tests/1210pass/1fail/0cancel/skip/todo、status1，760源码和index无漂移。唯一失败定位manifest-publication-artifact测试350行：provider-before-entry，operation-timeout/publication-read/pending=false/mutation=false；不是已进入目标晚期阶段的UNKNOWN。下一优先修正该例目标阶段控制，保持独立真实CPU/20ms截止覆盖，不据本次零cancel关闭历史500/超时。2/13/11open、18AC与生产/来源/IAM/stage/machine/SideEffectPolicy false、无acceptance binding、完整Goal active保持；默认合成值不替代真实生产输入/审批/阈值/窗口，无stage/commit/push/学习/生产写入或私有会话子项读取。

### manifest 延迟阶段的实例私有截止验证

只修正目标阶段尚未进入就先耗尽真实20ms的fixture选择，不改生产截止或错误处理。复用既有instance-private monotonic helper，新增固定manifest入口，将真实manifest wrapper、私有writer及PublicationArtifactError放在同一bundle；不接受caller factory/report或ducktyping，不patch全局performance/Promise/timers。原六阶段逐一确认实际entry=1后advanceTo(20)，保留UNKNOWN、mutation、halted及晚到零新增IO；新增真实慢PG准备后实际KMS进入和独立实例隔离2例。旧helper API保留；真实全部准备20ms SLO不由此证明。

2026-10-22T03:31:45.772–.935Z新2项0/2 RED确实缺API；03:34:43.730–44.192Z为2/2 GREEN。最终manifest测试SHA8aba11ddc5afca96fbc846bd647236518f34ccb7b76f870e753412ee0cfe2cb1，helper5079f72ba4884118763b3a1962f33261e36b02a961db7fd57e8dfbe85145822e。独立原生80ms/20ms CPU块931bytes/SHA3895b7b181439eb3073464e720c3bdd4a9437fc8278edd7f6a8e2e422d1d13f1、原publication测试df940635…及三个生产writer/reader/bounded SHA均实测未变。syntax2和canonical lint2零错警，完整manifest22/22、原publication37/37。功能/安全独立静态复审限定通过；JS专项仅核SHA，因缺当前whole-repo lint与tracked前态diff而STOP，不计语义批准。

03:39:20.580Z库存仅manifest一行hash更新，SHA de717dd08b20ef54aff6832086aa1558a89f6111205cc9617558c0681dd947b5；内存单行逆替换精确恢复上一bdfb0e…=true，60针脚全匹配，原顺序40c068…、预算/默认并发/router off/生产false不变。03:42:28.795–03:42:59.830Z一次原生正常完整60为 **1213tests/1213pass/0fail/cancel/skip/todo/status0**，source760前后无漂移，index仍fc6919c7577505a35e6fe7d6f6cae54f80084b0cbbeac9e4c2463a922872587b；stdout47e29718fafcb12e5c4d577ca7d610925334ac4a1a48e7ba6d49c13d96cf01e8，stderr空、失败目录空且未截断。新bounded独立4项仍不冒称纳入原60；本次GREEN不证明历史Ask500或文件超时已根除。

2/13完成、11项open、18AC未勾选、无acceptance binding、完整Goal active与全部生产/source/IAM/stage/machine/SideEffectPolicy false保持。W9的whole-project TS/lint/build、完整本地Docker E2E与其余正式门禁尚不能据局部测试关闭；旧whole lint128errors/77warnings仍未关闭。默认值仅供local-reference合成验证，不替代T16真实roster/gold/scope/阈值/registry/审批与T17窗口/JIT/恢复授权。未stage/commit/push/Compound/学习、生产写入、用户数据删除或原会话子项读取。

2026-10-22T03:55:09.932Z只读回读20个冻结文件全部匹配、60针脚/顺序/预算/false保持；两文档本轮新增段之前的历史前缀分别精确恢复605b20…/6c4529…=true。03:56:14.273Z纠正AC正则后18项全unchecked、LF投影b318ae9e7befb7a6c8d48fbb3ad528ac133c58277255dadbfb6b8888e76c09fb；初次0项不作证据。Git全索引910路径不是staged数量，git diff --cached只读确认仍22个changed paths且索引hash不变。NFT106份/privateRefs0/affected0；session根目录为非symlink目录，realpath SHA5ece9a9b2685652210d16e32e73e5e8d63f62510ebf04b2bbf817d2c47beafdc，未枚举/读取子项。diff --check仅报本计划新增尾部空行，随后仅整理本轮文档EOF；该检查不替代lint或测试。

### W9 检查工具的运行时目录剪枝

上一Goal turn为progress：实际修正manifest fixture并取得正常60的1213/1213。本轮继续W9，发现canonical ESLint/TS根目录发现扫描未显式剪枝runtime data。先新增仅owned tmp fixture的scripts/private-runtime-data-config.test.mjs：2026-10-22T04:16:16.923–26.787Z为0/2 RED，确实选中合成data文件并尝试枚举fixture data；只增加ESLint data/**与TS裸data后04:17:44.961–46.463Z为1/2，保留失败。独立功能复审及安装TS6.0.3原生matcher证明裸data扩为data/**/*仍枚举目录节点；按实际语义改data/**，不削弱zero-enumeration断言。04:22:25.897–27.390Z同2项2/2 GREEN。源文件no-explicit-any错误仍被检出、strict/noEmit保持；两配置仅内存反替换增量后精确恢复原SHA，已有createRequire脏改动保留。

冻结ESLint3a564d73b0f7e5900172725e9887d89dd04c9db34cb65323e8d4dce1ea265707、TS bb05c5b7754ab52bfaf4b6a81b55b323960845b5336b7f78d662cb715167a092、新测试d967945b7a283043a8698302e0c40188508f24c0824ee45e0ba4787639238b4a。定向canonical lint2和syntax2零错警。功能/安全限定复审接受literal发现扫描剪枝，不是文件系统隔离：显式import/reference、显式lint alias文件仍可带回excluded文件。未执行真实TS program；完整TS需额外安全依赖读取边界。JS/TS专项因全仓前置未过STOP，不计语义批准。

04:25:20.945–47.736Z现有canonical全仓ESLint默认.实际terminal status1：768files/128errors/77warnings/0fatal，stdout77d6099c7abc614e4f92cc916cee8fe1bd0741e391ed502babe289a9710df6b7、stderr空，801源码/配置/诊断文件及index无漂移，未选中data路径。没有降级规则或使用fix/cache，旧whole lint问题实际仍存在，不再仅依赖历史计数。

04:29:15.601–51.182Z一次原固定60回归为1213tests/1212pass/1fail/0cancel/skip/todo/status1，761源码及index无漂移，stdoutcbca790722b9a85ff872d466157b548b8e2389812b113487a1d57a34cdb6a2d7。唯一Ask index10 line2357，PATCH delete管理员/revision-fence/purge测试的首次POST200/500，标签a972a0d9ace69702986b86622d0110673de0673800f08eccd603ac823cee67c7；不是本轮配置导致的已证因果，未取得该点bodyCode/静态cause链，不能推断租约/预算/并发根因，未盲重跑或调宽截止。上一轮全绿保留为历史快照，不覆盖本次失败。新2项独立，不偷加60清单。

下一优先取得该Ask失败的安全闭集证据并定位根因，再修W9当前lint诊断及安全TS读取/其余集成。2/13完成、11open、18AC全unchecked、无acceptance binding、完整Goal active保持；T16/T17/R18的真实生产输入、授权/阈值/窗口不能用默认数据替代，所有生产/source/IAM/stage/machine/SideEffectPolicy仍false。无stage/commit/push/Compound/学习、生产写入、真实会话子项读取或用户数据删除。

### W9 Ask 原子替换诊断与类型 lint 首批修复

本轮实际进展不等于整项完成。2026-10-22T05:18:03.394–05:18:35.322Z，在不改磁盘runner/原60顺序与预算的内存闭集日志观察中，1213tests/1212pass/1fail，容量测试首次POST200/500对应单层EPERM、durable-catch、status=null。先建立新IO诊断6项与Ask集成1项RED，再仅为原safeDurableErrorDiagnostic增加literal true可选的闭集systemCall；旧单参数三字段形状、HTTP映射、IO、重试、限额和截止不变。05:57实际6/6+1/1；06:02–06:03原12+新6共18/18、Ask诊断4/4、定向lint4零错警，guarded scoped strict两root/1877源0diag，未读取私有data子项。功能/安全限定批准；JS/TS因全仓前置STOP，不计语义批准。

06:08:37.608–06:09:05.191Z闭集观察1214tests/1212pass/2fail，容量及delete测试的首次POST均EPERM+rename。两store源码均await close后rename，未证实泄漏句柄，不擅加重试。后续owned ask-durable-route-*目录的单次原调用转发实验只输出固定目标类别，纯内存8项和preload smoke通过；07:46:42.840–07:47:30.681Z实验1197tests/1194pass/1fail/2cancel，无rename失败事件，不能定位或宣称EPERM修复。该实验使用显式诊断preload、改变拒绝微任务观察，明确非canonical验收；原失败、两个文件超时及conformance旧20ms CPU断言失败全部保留。

按W9继续本地可执行缺口。07:48:14.902–07:49:18.480Z canonical whole lint仍失败；随后先新增embedding/contextual离线行为8项，07:55修改前8/8且原配置lint确实7errors RED。两模块只收紧request/response静态类型、Record unknown与回调推断；07:56修改后8/8、四文件lint零错警GREEN。08:00:58.521–08:01:07.663Z guarded scoped strict两root/629源0diag，blockedPrivate/readDirectoryCalls均0；两个模块编译JS逐字节等同原dirty版本，独立功能复审亦验证逆向恢复原SHA和8/8。响应类型注解不是运行时schema验证。JS/TS专项再次按whole lint/TS前置STOP，不冒称类型兼容整体验收。

最终代码上的无preload原915eb0f5…runner实际08:01:59.542–08:02:56.123Z为1199tests/1197pass/1fail/1cancel/status1，764源码及index运行内无漂移；失败为原authority approval同步consume deadline用例的断言与另一文件超时，不能写成全绿或归因于本轮纯类型改动。08:03:34.315–08:04:07.019Z canonical whole lint实际771files/121errors/77warnings/0fatal，较128errors减少7，仍未关闭W9。新6项IO与新8项离线测试独立，不加入原60；inventory仅Ask行更新为b3f0b9ad…，新inventory21ebee80…，原40c068…顺序/30s/90s/16MiB/default concurrency/router off不变。

并发状态事实：此前index fc6919c7…/22 staged changed paths，本轮08:00:58.328Z只读发现为1ad56021…/272 paths，四个embedding/contextual文件均在index；来源未核实，本轮未发出git add/reset/commit/push，不回退或覆盖。历史freeze只表示各次执行区间不变，不能升级为整个会话index未变。完整2/13、11open、18AC未勾选、无acceptance binding、Goal active保持；所有生产/source/IAM/stage/machine/SideEffectPolicy标志仍false，默认值仅local-reference。下一继续真实剩余W9 lint/安全whole TS及集成与W2-W8依赖；T16/T17/R18外部真实事实、授权和窗口不能伪造。不访问真实会话子项、不删除用户数据、不运行Compound/学习。

最终只读审计2026-10-22T08:09:27.981Z：31 pins全匹配，原60全部pin与顺序/预算不变，18AC仍0 checked/projection b318ae9e…，无acceptance binding；本节之前两个文档原SHA前缀均精确恢复、marker唯一/EOF单换行。index保持新1ad56021…/272 paths，而非原fc6919c7…/22；106个生成NFT无context-sessions引用，真实会话根只取lstat/realpath，childrenInspected=false。unstaged diff --check为0，但staged --check为2：08:10:35.502Z确认19条均runtime trailing whitespace（stdout a7844257a5cd68d1d90d659c50f5b00ba4d759e68d7d1abaa782ec719be65545）；08:11:24.912Z只在内存撤销本轮日志增量精确恢复原fcfd82c0…，证明这19条属于原dirty内容，未为清零检查而改动它们。不把未暂存检查通过冒充staged/whole检查通过，亦不stage、unstage或回退并发变化。

### W9 非 UI 类型边界、tokenizer 修复与持续回归接线

上一轮为progress，本轮继续真实本地缺口。五个非UI模块消除9处lint错误及5个未用项警告，同时实际修复DecisionCaptureEngine两处SDK encode调用：第二参是text_pair，options必须第三参；原调用用本地纯内存WordLevel tokenizer实证TypeError。SDK vocab是字符串数组，原逻辑漏读标准tokens_to_ids Map，现优先读取它并保留四种legacy布局。15项合成离线回归先9pass/6fail，再14/15（新fixture把原fullwords阶段误写tokens，按原源码及类型合同纠正，不改生产阶段），2026-10-22T08:27最终15/15，六文件canonical lint零错警。reasoning-indexeddb仅metadata any→unknown经两次自动审核拒绝后，人类明确授权才落地；未触碰并发indexeddb.ts引用链。

实际11root消费者strict首次1diag是缺Next styled-jsx ambient，不是metadata渲染bug；纠正归因并补项目已有Next ambient，08:33:37.816–41.044Z为1232sources/0diag，1243→1291依赖读取中最终无漂移/private block0/readDirectory0，不修改组件/tsconfig。它不是whole TS。功能/安全分别独立15/15且六SHA稳定限定批准；JS/TS专项因whole前置未过STOP。新增独立script guard 0/2 RED后，仅新增test:rag-local-boundaries并在wave1原四门禁前串行接入；08:36实际pnpm 75/75，不改原四门禁或固定60清单，package内存逆向精确恢复原dirty 49a2c069…。

12:30当前whole lint突增584errors/1543warnings，12:34分解证明.gitignore既有.codex-tmp生成bundle贡献全部472errors/1471warnings，业务源码仍112errors/66warnings，scripts另6warnings。新增第三项只owned tmp的scratch扫描fixture，先2/3 RED；配置仅加.codex-tmp/**，原规则和原两项data/TS边界测试保留。12:49实际pnpm完整76/76，功能3/3及安全限定复审通过；配置/测试内存逆向恢复原3a564d73…/d967945b…为true。12:51:51.116–12:52:35.473Z canonical whole lint实际790files/112errors/72warnings/status1，未清零；生成bundle噪声移除不冒充修复472个业务错误。本轮原模块相对121/77真实减少9/5。

原固定60在08:38:49与12:32:37均preflight拒绝、未派发测试。并发Ask测试先b3f0b9ad…→6ff8cfab…；12:30:48.879Z纯内存撤销新增4测试/合成模型helper后精确恢复b3f0…，仅据此将local inventory一行pin更新，新inventory91ea79f6…。随后12:32发现Ask又变02229f7d…，未追pin或覆盖并发代码。原60顺序/30s/90s/16MiB/default concurrency/router off与生产false不变；此回归仍缺最终当前快照，所有历史失败保留。12:30旧lint句柄24304已确认不存在才重跑；只读自动审核超时未启动的一次请求按工具许可仅重试一次。

完整Goal仍active、2/13完成/11open、18AC未勾选，无acceptance binding。W2-W9/T16/T17/R18原完整范围、production/source/IAM/stage/machine/SideEffectPolicy false及本地默认边界不变。下一优先处理真实剩余112/72（避免覆盖并发首页/引用链）、稳定Ask增量的正式集成回归及安全whole TS/build/E2E，继续原W2-W8依赖。未stage/unstage/reset/commit/push/Compound/学习、生产变更、真实会话子项读取或用户数据删除。

最终只读核验2026-10-22T13:07:13.071Z：16个本轮实现/安全pin全匹配，本节以前两文档的f39fad4c…/f1b17132…前缀均精确恢复，marker唯一/EOF单换行；18AC仍0 checked、projection b318ae9e…，13任务/11open及无binding保持。当前inventory只有Ask index10不匹配（expected6ff8…/actual02229…），不绕过preflight；原60顺序/预算/false标志不变。index又由1ad56021…/272 paths变为c9ad2d8781f2390fd9b8267ff1998c38b6a32563265fdcc7b20a7a84e09ee55c/324 paths，来源未核实；本轮未发出stage/unstage/reset，保留并发状态，不声称全程index冻结。owned unstaged diff --check为0；106个生成NFT无context-sessions引用，真实会话根仅lstat/realpath、childrenInspected=false。Goal仍active，完整验收不记完成。

### W9 UI 类型边界与请求失败恢复（2026-10-23）

本轮仍执行完整 Goal，不缩减 W2～W9/T16/T17/R18 范围。5 个源文件在本批开始时 clean，避开并发首页、Ask、引用链和 src/lib/indexeddb.ts。按 Work/React/Review 技能先建立失败测试：新增 rag-ui-type-boundaries.test.mjs 的 8 项中原实现 6 pass/2 fail，真实页面 handler 在 null rejection 直接读取 message 抛 TypeError，在普通不透明对象的 message getter 抛错时二次拒绝。改为 catch unknown + instanceof Error 时保留原 message，否则显示“未知错误”；finally/loading 与成功消息逻辑不改。其余改动只为 unknown metadata/input/output、三种 tab ID 字面量、React 原生 Input/Textarea props type alias 和去 unused useEffect。

原定向 lint 12 errors/1 warning；修后 8/8、定向 lint 0。UI 与 guard 接线复核 10/10；guard 先因 package 缺新增 suite 1/2 RED，再仅往 test:rag-local-boundaries 加新 UI suite token，原 wave1 后续四道门禁不删不重排。2026-10-23T02:49:11.204–02:49:20.438Z 实际 pnpm test:rag-local-boundaries 84/84，0 fail/cancel/skip/todo，status0，八修改文件运行内 freeze。stdout SHA c9ae6ae048b01231e7271c9c49463e725754c181cfe5457fa9d4cdfd200d8fc6；stderr 非空、SHA 086d7c02b9261b564c84cc1f5362cd26fb2ef8d79ede6749e6eff681ea101fb0，未保存原文、不猜归因。最小环境、COREPACK_ENABLE_NETWORK=0、router off，只用离线 synthetic fixture。此前旧句柄 24926/65155、exec cell33 均经工具确认 missing 后才补跑；审批超时/被续接中断不记成功或失败，候选 Node PID29940 后续已消失，不以观察超时判定终止。

类型检查历史证据为 2026-10-22T13:25:13.830–13:25:20.271Z：explicit7roots（5源、self-rag 页面及内存原生props正反例）/681sources/715deps，strict/noEmit true、incremental false、既有 node/next/next-image ambient，0 diagnostics/依赖漂移，readDirectory/private data access 均0，610越界metadata探针跳过。上述八源身份本次重读仍一致；未将历史 scoped strict 冒充当前 whole TypeScript/build。实际 ES2022/ESNext/ReactJSX transpile 与 HEAD 比较，四个纯类型模块逐字节 emitted JS 相同：corrective visualizer 0008faef4e8773faf3bf6945e1ee78d80a9c54d170d1b82b488afb48e2076a15，SelfRAG c95e369e8fa29fdc21a21674a6a904cf7e5e801a3f45b1478713a4519a84d64d，Input b7a0ad11a65392cae7cb6cb811a27501d62c9969877340990ce24c8d2c5032fd，Textarea 13dd439c3ac6c45442849944efeb1a1c3dd2c6d51c6410b6858db13cd825e581；page 仅预期 catch 行为使 emitted SHA 变为 1beaefb9ceef351feb929c5b0cce87fdef08bbc0f1ac223853197802141c694d。package/guard 的新增 token/行只在内存撤销，精确恢复本批旧 dirty 基线 cdd31b13…/f94df8e4…，未回滚实际文件。

最终八 SHA：

- src/app/self-corrective-rag/page.tsx：354cddae86c3c9ced9d2255105a6a9fd6eed2bd2d2b6459d6627fdae965712d8
- src/components/SelfCorrectiveRAGVisualizer.tsx：ba43da14e29a6d640a1ed6a7b1e4b9c42f2efdb1720ee9f0ecbd5f5b811b12a7
- src/components/SelfRAGVisualization.tsx：21c9fbf6bd8b53097b0062ee6d0ba57c05964248ae20d4e4ab8fb8021d5eadcc
- src/components/ui/input.tsx：203aff2eb33eb19acd77e5ef55dfb152a7b2ca0a46ed1992cd41134f2cadf18c
- src/components/ui/textarea.tsx：917d2f9a03bbc4d9027967a244bcc342038a6d7c73d9856b9fb6ad37c9f2262b
- src/components/rag-ui-type-boundaries.test.mjs：104bc44c3209bfd7f459a10af4342dbbd3b3fe0249218516e46051d8bbdee805
- package.json：cd74ef77cbe14859150f6f42eeb5412fe5af787a9ca5362eb6fab3bf2e900f71
- src/lib/rag/local-boundary-script.test.mjs：00bc035e2e3408dbc4250546f84c2e788bf98b4057d11e145323a0e62988cc14

2026-10-23T02:49:45.840–02:50:08.085Z canonical whole lint（node node_modules/eslint/bin/eslint.js . --format=json --max-warnings=0）实跑 791files/101errors/73warnings/0fatal/status1、stderr空；config冻结、无 data 文件被选中，stdout SHA 9c0b8b5aec1a5dc6f0da964f934a65cb521325a4562d0b121f9e00d167caf4a1。本批确实消除12errors/1warning；相对旧112/72另有并发 indexeddb-citations.test.mjs 新1error/1warning、chat-citations.test.mjs 新1warning，不覆盖或减弱并发断言，不能写成100/71或W9全绿。安全独立 UI8+guard2=10/10、八SHA审前后稳定，未发现本批新增可复现finding，限定批准；TS/JS专项因whole lint红/wholeTS未跑STOP，工具refresh故障且未独立采集八SHA，不记语义批准。功能独立 UI8+guard2=10/10、diff --check 0、八SHA审前后匹配，实际handler/三tabs/native props与ref/下游unknown兼容限定APPROVE；不以两面限定批准代替wholeTS/build/整Goal。

验证边界：受控hook/实际React SSR/实际handler不等于浏览器E2E；unknown只是静态类型约束，不是载荷隔离。SelfRAG新测试仅idle，既有JSON.stringify(step.input/output)分支未修改或安全化；Error子类message getter和Proxy陷阱未声称解决。未引入后端运行时到client或调整UI布局/effects。

2026-10-23T03:01:48.117Z只读核验：本节前计划 b4d405b953b29d7ca20611a436cefc4c4906ec1ec7121b947e3d88548124c414、报告 be820c917a5dc99c83e13ec423f2c776c29f330ff6cedee3d4fba19fa4dd4be2 保持；18AC仍0checked、无acceptance绑定。LF规范化从 acceptance-contract:start marker 至 end marker 前的完整切片 SHA e0a1dd94d2c9b71981b2e51a5af656d079e346a6b5e13d93d3437021b387b5c6（不同于旧AC行projection算法，不替换旧历史hash）。原60 inventory91ea79f6…、runner915eb0f5…、完整顺序40c0685c…及生产false不变，仍只有index10 Ask mismatch：expected6ff8cfab…，actual已并发变为52c9168f2094eafe4f6bd2a83b7900e1a6d505f61f070fc07376d964de64ce9d。不绕过preflight，不追pin或把未派发当整包回归通过。index SHA仍c9ad2d8781f2390fd9b8267ff1998c38b6a32563265fdcc7b20a7a84e09ee55c；本轮未stage/unstage/reset/commit/push，owned diff --check 0，Git仅提示LF/CRLF转换。未读取真实会话子项、未删用户数据或做生产写入。Goal active、2/13/11open/18AC及所有真实生产/source/IAM/stage/machine/SideEffectPolicy门禁保持未完成，默认值仍仅local-reference。下一按优先级继续源码lint和实际集成/完整conformance缺口，真实外部事实不可由默认夹具替代。

### W9 监控领域类型、Trace 生命周期与测试断言可靠性（2026-10-23）

本批四源开始时均 clean，仍避开并发首页/Ask/引用链/indexeddb；既有 UI 测试从8项扩为18项，复用固定源码loader和hook harness，无新package接线或规则降级。RealtimeMonitoring只type-import现有rag-system领域的增量向量化/查询/检索projection，移除any；与HEAD的ES2022/ESNext/ReactJSX emitted JS完全相同，SHA 6fe6f2af0dcfff5ffc8c4b5388549d456d28cc1b362d6f451f8a3361e669fc1e。CognitiveParsingPanel以Partial计数并按局部entities依赖memo，保留只显示已出现类型；RetrievalDetailsPanel使用unknown metadata、数值柱图回调形状及稳定readonly空结果，原嵌套metadata格式化行为保留。

Observability复用type-only Generation/Observation/Score的UI projection，input保持unknown，仅string question可显示；先slice再sort，避免原地修改state。首屏loading初始化true，effect只启动纯fetch及Promise结果回调，cleanup abort且then/catch/finally都忽略该signal取消后的完成；手动刷新事件包装单独设置loading，不把click event当signal，既有clear/feedback权限与请求未改变。取消保护只覆盖effect发起的首屏请求，不包括原先无signal的manual refresh/feedback重载；不宣称所有请求取消、最新请求顺序或完整StrictMode/浏览器E2E已验证。

失败反馈保留：初始15测11pass/4fail，柱图fixture单doc未触发既有length>1分支是测试夹具错误，改两doc保留原断言；随后真实16测12pass/4fail，分别为首屏loading、缺cleanup、冻结state数组被sort写入、opaque question导致React child崩溃。第一async/await候选16/16但effect lint仍1error，不能记全绿；改纯fetchTraceList与.then/.catch/.finally结果回调后18/18且五文件lint0，未用disable、伪延时或减少断言规避。原定向15errors/1warning均消除。2026-10-23T03:16:55.872–03:17:10.432Z初版explicit4roots strict0；最终Promise版03:22:10.388–03:22:50.111Z再实跑4roots/1084sources/1139deps、0diagnostics/漂移，strict/noEmit true/incremental false、privateBlocked/readDirectory0、641越界metadata探针跳过，无includes发现或生成路由读取。scope strict不是whole TypeScript/build。

独立安全提出有效P2：manual refresh测试的首signal断言位于fetch mock内，会被产品catch吞掉；将该断言在内存替换assert.fail后18/18仍绿，旧测试SHA f028eed6…不能当该断言有效的证据。修正为mock仅记录signals，首屏instanceof AbortSignal及刷新signal===undefined均移到mock外并加WHY；实际UI18+guard2为20/20。独立同一强制失败探针变为17pass/1fail/status1并正确定位断言，原始20/20，新test d9cf0e27…稳定，P2闭环。功能独立对原产品增量20/20、五SHA/空白检查稳定限定APPROVE，修后仅复读新断言位置与新SHA保留限定批准；安全无新增生产finding、对修正复审通过；TS/JS专项因whole lint/whole TS前置STOP，只读五身份/状态，无语义批准。

完整回归失败也保留：2026-10-23T03:22:24.862–03:22:55.770Z实际pnpm test:rag-local-boundaries为92tests/91pass/0fail/1cancel/status1，文件级标签scripts/private-runtime-data-config.test.mjs，七相关文件freeze。stdout SHA 53f84018b809049c8f028f54a45d9c5b2cf03850ec628b74fcdbd77258f9de45，stderr b9f8bd4980f9748d569074d0bfa00b6ba29e87afcd2de64aca7cd071762947e9非空；未保留取消detail，不能确定原因。与本轮strict执行区间重叠约25秒，资源竞争仅是推测，不宣称timeout根因已确认或解决。未改既有30秒native/90秒parent预算、默认文件并发或隐私测试。03:30:59.613–03:31:01.347Z同预算独立隐私配置3/3/status0，三个leaf耗时73.7072/17.7612/24.7168ms，stdout fe84a8463564c879ea5f908e0aa7f82dad26cdc438bb0b97341c188d1a8d0d8d、stderr空；只创建/清理自有synthetic tmp，未访问真实data/scratch。诊断与P2修正后，不与本轮TS/wholelint重叠，04:01:03.182–04:01:16.329Z原package命令/预算实际94/94、0fail/cancel/skip/todo/status0、七pin freeze。stdout b24de0070335526c8f0898b0925517b83fa863d10a08a7237732a323ae8cbe58；stderr 086d7c02b9261b564c84cc1f5362cd26fb2ef8d79ede6749e6eff681ea101fb0非空，未保存原文、不猜归因。后来的绿色不抹除92项取消历史或证明稳定性根治。

最终五SHA：

- src/app/observability/page.tsx：258829be0871f54dae1ae174c5a9d223e0d9ad3589bb817316dfedb797b37ce5
- src/components/RealtimeMonitoring.tsx：1fc0020db78a6ae1d9240044094fd3a54f0eed4ce42494f9d3b13aa1ac3c1936
- src/components/CognitiveParsingPanel.tsx：5b599d639f6bccd4a2976617481952c30aba301b3d9df861bd6eced03e6e31ae
- src/components/RetrievalDetailsPanel.tsx：7828b98768e86cc272476e2ceedfc471eac3898f5c30b6969acd415459351d67
- src/components/rag-ui-type-boundaries.test.mjs：d9cf0e27409466461cc46a1827a9f2ba93d24e0f37e9b9ab9c7d8bb6d06bb933

03:22:58.932–03:23:40.419Z最近canonical whole lint仍失败：791files/85errors/70warnings/0fatal/status1，config冻结、无data选中、stderr空，stdout a4d5baf07bb6dd3231e839453237a54702cf9271e5dedcec0add9354550c28ad。本批只归因15errors/1warning；相对前101/73另有并发引用测试1error/2warnings已消失，不冒领或修改并发文件。该全仓运行时测试为f028版本；d9cf仅移动测试断言，最终五文件canonical lint再为0，不把定向lint升级为whole gate已通过。完整TS/build/Docker E2E/conformance仍未完成。

04:10:55.545Z本节前计划d01547a5ede7a9f5426d1dadb36e2df7441edaa77ad5f34f00bfe8c1bda3d014、报告058a761ad42862a04ea5913128eff46ccf5e60e12023038947e270f19ddc9c32保持，owned diff --check0；04:11:37.170Z原18AC仍0checked、LF marker切片e0a1dd94…不变、无binding。原60 inventory91ea79f6…/runner915eb0f5…/顺序40c0685c…保持，仍只有Ask index10 expected6ff8cfab…/actual52c9168f…失配，不绕过preflight、不重复派发或追pin。index仍c9ad2d8781f2390fd9b8267ff1998c38b6a32563265fdcc7b20a7a84e09ee55c；package cd74ef77…及guard00bc035e…未改。本轮不stage/unstage/reset/commit/push/Compound/学习、生产写入、真实会话子项读取或用户数据删除。Goal active、2/13/11open、18AC及全部生产/source/IAM/stage/machine/SideEffectPolicy未通过状态不变。下一仍需按优先级核对稳定Ask增量、恢复原60回归并补余下实现/全仓门禁，真实生产输入、阈值、审批、窗口和周期不可用默认夹具替代。

### W9 模型配置与文件列表生命周期（2026-10-23）

本批 ModelConfigPanel、QuestionSelector、ReasoningFileManager 开始时均无工作区改动，避开并发首页/Ask/引用链/indexeddb。按 React 规则将独立请求与 JSON 读取并行，effect 只启动请求和异步结果回调，初始 loading 已在 state 初始化；Model/Reasoning effect 均绑定 AbortController，成功/失败（Model 含 finally）忽略已取消结果，Reasoning 在父 onStatusChange 前检查取消。刷新/重试事件不透传 click event 为 signal；reload POST 仍等待后续 GET，上传、向量化、删除、确认框及载荷未改变。QuestionSelector 的 queryAnalysis 改 unknown，仅作既有真值筛选、不读取其属性；这是静态约束，不是接口 schema 验证。取消保护仅覆盖 effect 请求，不包括旧事件操作，不声称最新请求竞态、真实 StrictMode/DOM/E2E 全部验收。

复用既有源码 loader/hooks，原18测试及共享前缀精确恢复旧 d9cf0e27409466461cc46a1827a9f2ba93d24e0f37e9b9ab9c7d8bb6d06bb933；新增9项先 RED：2026-10-23T05:08:03.272–05:08:05.235Z，27tests/21pass/6fail/0cancel/status1，失败为同步effect写state、缺cleanup/取消signal。stdout 2df3c4e8d36495862836a351b0c81acb4c5af283032162b9110013e29853b23a，stderr空。修后05:10:11.071–05:10:11.890Z实际27/27/status0、stderr空，stdout f5b7f3d4f3482254ab95d03b8b149b4a3d1685b001d1c1c5da21fc7db45e4baf；同一串行命令随后四文件canonical lint退出0，无disable/预算降级。所有新请求均mock，未调用真实配置重载或文件操作；新断言位于产品catch外。

05:13:59.551–05:14:04.974Z显式3根/565sources/588读取依赖，strict/noEmit true、incremental false、0diagnostics/依赖漂移、privateBlocked/readDirectory0，610越界metadata探针跳过。未用includes发现或运行全仓TS。05:15:01.019–05:15:22.679Z原canonical whole lint实际791files/82errors/70warnings/0fatal/status1，stderr空、七监测文件无漂移，stdout 8706280f8d3aa8fe93cb20bf98c83d060697956e0c6a21546bbd8b0e80af2b44。本批仅消除3errors，whole W9/TS/build仍未完成。此轮raw .git/index SHA 0326b6f4b626870f11d0d5d2762b57c916c745d8407eb5ad38c83a41788a876e前后相同；该算法不同于历史git ls-files --stage -z投影c9ad2d87…，不能将二者差异推断为并发索引变更。root曾误报该跨算法比较，现明确纠正。

05:17:09.517–05:17:30.575Z原package test:rag-local-boundaries实际103/103、0fail/cancel/skip/todo/status0、stderr空，stdout 5056975fcc456cd132a725b6b6de3be8c2fd685a969769b47efa29c804176c73，九监测文件无漂移；原native30s/parent90s/default并发未改，此次不与root编译/lint重叠。功能与安全只读独立审查四SHA稳定、无新增finding，限定批准；TS/JS专项因whole lint红/wholeTS缺失STOP，不记语义批准。未覆盖回调身份变化后的真实React自动cleanup，未把hook harness冒充浏览器验收。

最终四SHA：

- src/components/ModelConfigPanel.tsx：da7cd2e1b08d3414613d0a746a17aa4998bbf5fb41d49bb68cd03a437f23e18e
- src/components/QuestionSelector.tsx：e749a27ee1b72307e935ffea0ef453fe8c058af042a9ea575ca03a8d96b0d35a
- src/components/ReasoningFileManager.tsx：53923e42f0c633245259f82c8ab95f01a4621254055ee57977bada6cdf9fdf60
- src/components/rag-ui-type-boundaries.test.mjs：fca3b8306e987dcf90cf3277f6e28b0c63c88f37d9f19f5ecef2b3f2fa829695

### 经 owner 授权的 Ask 本地重基线与完整60回归（2026-10-23）

旧6ff8cfab…快照完整正文无法恢复，不能证明其中后来四个用例逐句等价。只读复核HEAD70测试均保留，69个测试全部断言前两参数一致；剩余ordered-context预算90s→240s已有10月14日记录支持，不是本轮加时。rawURL新15行测试+import精确逆还原02229f7d…；更广的有界逆向候选未恢复6ff8，不把“多数断言相同”当旧冻结版本等价证明。旧混合EOL、完整差分来源仍未知，旧失败历史不抹除。当前独立Ask在2026-10-23T04:47:47.002–04:48:09.379Z按原native30s/parent90s、无preload/最小env实际99/99、stderr空、八watch pin稳定，stdout 47ccd04b8f0ff623053c3f6ce68cf8f9d74738b51b37d393412c198e6187fd70；这当时并不证明原60通过，功能/安全也未批准无授权迁pin。

owner 随后明确回复“授权当前 Ask 本地重基线”。仅将 inventory tests[10] Ask pin 从6ff8cfab4d49c7981b332466615ee5759673dd48dea25f5634bd4e8258b70e6d改为52c9168f2094eafe4f6bd2a83b7900e1a6d505f61f070fc07376d964de64ce9d，未改Ask正文或其他59项；新inventory c01e4a100a7cfb9c9ecab83071d10ddc4e0c8a88bde02be8c2a57e25b738d75e，内存单值逆替换精确恢复旧raw91ea79f6d43f7ffb45c2215578222824c8a0239f75a8a38dd8ababde4ff31601，证明其余字节未变。60完整JSON顺序40c0685c909520864d5a2e6bd979080cb04a3a0034ccb4f1c76caf8cfa36f274、first54/authority均不变；runner仍915eb0f5b64cab49b28bc468555a765c8c835121e92662de37895421b940bad2，原30s/90s/16MiB/default并发/routeroff/cleanenv/preflight保持。两个独立静态审查面均验证单pin及其逆hash，限定批准；缺失旧快照的事实继续保留，批准的是当前local基线，不是旧快照恢复或生产授权。

05:26:10.862–05:26:11.427Z原runner守卫26/26、status0、stderr空，stdout e93609f22d7361853647e693b35d66ab57cb8b910ed773b48e63eeba79344249。随后同一原runner于05:26:11.468–05:26:59.719Z真实派发原60文件完整回归：1222/1222、0fail/cancel/skip/todo/status0、spawnErrored false，sourceCountBefore/After790、sourceDrift空、index投影前后c9ad2d8781f2390fd9b8267ff1998c38b6a32563265fdcc7b20a7a84e09ee55c、sourceFreezePassed true、failedDiagnostics空且未截断；stdout d8bc543a92d9ae7e97585ee4e982d48cea309ec4d14c1c2bd905476b4c28e2ac、stderr空。原生session50509已收终态exit0，未因上一轮中断而重复启动。该绿不证明旧EPERM/超时/首次POST500/503根因已消除，不抹除旧1199回归失败，也不等于完整W3/W9/企业conformance或生产验收。

本节前计划7e9940737bb37508bb0eb07fc6d703b8e98c7c92f81e793665a1d29e84b42a43、报告552acc3d95037d2230780c9ddfb0acde150345cd4d961670eecc299988f4889a为追加基线。未stage/unstage/reset/commit/push/Compound/学习，未读真实会话或scratch子项、未删用户数据、未进行生产写入。local-reference默认边界、全部生产/source/IAM/stage/machine/SideEffectPolicy false、完整Goal active与2/13/11open/18AC保持；全仓lint仍82/70，完整TS/build/E2E、各未完成合同与真实T16/T17/R18继续按原优先级推进。

### W9 展示 metadata、散点身份与 tooltip 文本边界（2026-10-23）

三个源文件开始时无工作区改动，继续避开首页/ChatMessage/indexeddb 的并发 MM 链。ThinkingChainDisplay 的 metadata 改 unknown、移除紧凑 map 的未用索引，原嵌套 JSON.stringify/String 行为保持；不声称可隔离 getter/toJSON/循环引用。MilvusQueryVisualizer 的 source 缓存为 unknown，仅非空 string 可渲染，其余按文档编号兜底，避免对象型 React child 崩溃；未改变 status/search 请求、计时和事件流程。TraceTrieVisualization 的 scatter 使用具名四元素 tuple/回调形状；密度按 tokenId 关联，缺失为1但保留合法0，大小继续限制8..25；移除未用变量/type/destructure及冗余memo依赖。当前安装 ECharts TooltipHTMLContent.js:316 实际以 innerHTML 插入 formatter 字符串，故局部 helper 按 amp-first 转义 token 的 & < > " '，不引入 backend runtime 或大型依赖。label 保持普通文本，不将类型声明当运行时 schema 验证。

原27测试及共享hook前缀可精确恢复 fca3b8306e987dcf90cf3277f6e28b0c63c88f37d9f19f5ecef2b3f2fa829695；新增5项复用既有loader/SSR/stub option，所有关键断言在产品catch外。2026-10-23T05:46:15.613–05:46:16.569Z RED32tests/29pass/3fail/0cancel/status1：实际对象source React child、原tooltip未转义、密度数组错位[2,1,1]而非[0,2,1]；stdout59aa2bad51c9a476743ca52a98053e2f6b52316da88e3c57df0dce5d4c731024、stderr空。05:49:32.749–05:49:33.541Z真实GREEN32/32/status0、stdout cbdff712a0e3e1cfc8222c2dbd373dc4da5552123b271bcfa6ef8107c630e8a1、stderr空；随后串行四文件canonical lint退出0。05:49:35.775–05:49:40.197Z显式3root/594sources/622读取依赖 strict/noEmit true、incremental false、0diag/漂移、privateBlocked/readDirectory0、610越界metadata探针跳过，无includes发现或wholeTS。

05:52:45.946–05:53:02.417Z原canonical whole lint实际791files/77errors/65warnings/0fatal/status1、stderr空，八监测文件无漂移；stdout62dbba0e23334de3a391186d7c1e8bd18fbf5eb1934db823b7568dffe1b45ba6。本批消除5errors/5warnings，未关闭规则或修改无关并发链；raw index0326b6f4…前后相同（不与git条目投影c9ad2d87…混比）。05:53:02.456–05:53:05.475Z原package本地边界测试108/108、0fail/cancel/skip/todo/status0、stderr空、九watch无漂移，stdout f38e5964bf49e57fd628bc38945888c98a1a6d011481d8840d3438dd20a6c5e9；原30s native/90s parent/default并发未改，与root lint/编译串行。

功能/data-integrity与安全独立只读审查四SHA审前后匹配、无新增finding、限定APPROVE；原断言保留及新测试可捕捉三个RED点已静态复核。TS/JS专项因whole lint红/wholeTS缺失STOP，仅核对身份/状态，不记语义批准。图表测试是stub options和真实formatter直接调用，不是ECharts DOM或真实浏览器XSS执行验收；Milvus测试未flush effect，因此不代表真实status/search/取消流程；其他旧waterfall/model-comparison密度回退不在本批更改或覆盖范围。

最终四SHA：

- src/components/ThinkingChainDisplay.tsx：d6c8649664dc087e8b034e1760f3df23b9ad99d2688403ac64c1bbc7f1b1d1bd
- src/components/MilvusQueryVisualizer.tsx：d5fb04b9e343c1b6e808b5f6bc8c1c9ff3bcfc0172765a5f295f3f46e5c2b3c1
- src/components/TraceTrieVisualization.tsx：1b710a223ea16dedf04e7e8190383e41297d98a56b8b1a5ac0391e63c1d8f622
- src/components/rag-ui-type-boundaries.test.mjs：0188b4d15c49c66a3699fdd0542644841d009139ca1e72023083f533e255d72c

为核验本批三个新源版本而非重复求绿，05:55:05.926–05:55:40.187Z再次真实执行原60 runner，仍1222/1222、0fail/cancel/skip/todo/status0、spawnErrored false；790源前后无漂移，index条目投影前后c9ad2d8781f2390fd9b8267ff1998c38b6a32563265fdcc7b20a7a84e09ee55c、sourceFreezePassed true，failedDiagnostics空/未截断，stdout7a8cd26e7a3a19a3a8d7ca8a1c84fb71ed982a0a57ebc0c168f632fa8d4f98e1、stderr空，session7800终态已drained。inventory仍owner授权的c01e4a10…、Ask52c9168f…、runner915eb0f5…、原60顺序40c0685c…和全部预算未再改。绿色不证明旧间歇错误根因已解决，也不替代wholeTS/build/E2E/conformance或生产验收。

前节归档第一次marker校验以旧ASCII编码器编码中文常量，误报marker0/prefixfalse；属于只读验证器编码错误，不是文档损坏。改用UTF-8编码后，2026-10-23T05:36:53之后再次实测两个文档marker各1、旧前缀精确保持、single EOF true；18AC仍0checked、LF合同切片e0a1dd94d2c9b71981b2e51a5af656d079e346a6b5e13d93d3437021b387b5c6、无acceptance绑定。本节追加前计划e746da3441fbc56754e543334e263a6e7563556a1dbf007158b01cb71e01faf7、报告fe72ffe38f0196a9d4337969b8d2abd1da4832e833c0486160393c27ba4e5141。一个只读检查自动审批超时，按工具允许仅重试一次成功；未由超时推断动作不安全或进程已完成。

Goal仍active、原2/13/11open/18AC不变。全仓lint77/65、wholeTS/构建/Docker E2E/Runbook/完整ports-reference conformance、W2-W8余下依赖及真实T16/T17/R18继续未完成；默认仅local-reference，不改变任何生产/source/IAM/stage/machine/SideEffectPolicy false。未stage/unstage/reset/commit/push/Compound/学习、访问真实会话或scratch子项、删除用户数据或生产写入；下一按原依赖继续本地门禁，不覆盖MM链或让缺失真实外部事实变成默认通过。

### W9 领域向量页加载与在途种子编辑保护（2026-10-23）

本轮开始 domain-vectors/page.tsx clean，原SHA ec2ec6a13bc2500522f674ef519025167d06d6aeb4ff6e23f09a45a21d110d8b；同查 adaptive 页但未修改，继续避开首页/ChatMessage/indexeddb MM链。按实际domain-vectors API源的字段定义DomainSimilarity/DomainQueryResult和闭集GET action helper，移除5个any/effect错误与7警告；仅静态返回类型，不声称runtime schema校验，未读取真实centroids.json或运行Ollama。三路GET原本已独立启动，现保留独立Promise/catch而共用effect取消signal；then/catch忽略取消完成，初始checking由state提供，manual refresh事件单独设置checking且不把click当signal。POST/actions/confirm/通知timer/既有日志与API协议未更改。

质心GET开始时快照每domain编辑版本；手工编辑和AI种子更新均递增版本，响应以functional prev合并，仅同步版本仍相同的领域，避免迟到读覆盖在途新编辑，同时保留未编辑领域的远端种子词。不把seedWords加入effect依赖制造重载；固定[]回调稳定，编辑不重发初始化GET。保护范围是GET在途窗口，不声称POST自身乱序、多个GET排序、通知timer或所有事件请求均取消。

既有32测试/hook前缀精确恢复0188b4d15c49c66a3699fdd0542644841d009139ca1e72023083f533e255d72c，新增7项先RED：2026-10-23T06:18:06.198–06:18:07.492Z 39tests/35pass/4fail/status1、0cancel、stderr空，stdout3854d4ea10c0e8ceb1228f4e2617fa4e66d333738873378290d9b0e2f89d718f；实际失败为同步effect写state、resolve/reject均无cleanup、user-edited被stale-tech覆盖。第一修复06:21:22.839–06:21:23.764Z 39/39、stdout562b2ca6eb983cc4e41845b5a7e1c93e02b706b1eae945fad8695e505b79a0be；两文件canonical lint0。06:21:35.307–06:21:39.273Z显式1root/563sources/586读取依赖 strict/noEmit true、incremental false、0diag/漂移、privateBlocked/readDirectory0、610越界metadata跳过，未用includes或wholeTS。

功能只读复审无新增产品finding、限定APPROVE，确认原断言保留、独立并发与版本合并。安全指出有效测试限制：tabs/format测试的mock直接throw可能被产品catch吞掉，不能证明无网络；该旧test5282df44acfd5a39cf000a28d96cb22c704ab70c1f59d9bb225f485c917565e6的绿色不作该性质证明。等待已运行68984终态以保source freeze后，mock改为只计数/正常返回、最终在catch外assert.equal(fetchCalls,0)。首次只读探针未处理spawn stdout undefined而自身退出1，无有效mutation结论，errno未保留、不猜原因；改stdin传源码并显式记录spawn错误后，06:32:15.986–06:32:16.699Z同一helper内存注入被async/catch吸收的合成fetch，仅运行目标测试：旧1/1/status0、stdout87230c2415f509762c7c4dc6f37257f4f4ebb8a45d56aee7cad84b8bceedf716，新0pass/1fail/status1、stdout96b53c70a1f673fef178389933c50371607fefce09a54628d7ae5eeeba46cdd6，均stderr空。逆替换精确恢复5282旧hash，探针无文件写入。实际未注入06:32:16.738–06:32:17.686Z 39/39、stdout9bfd537c9396dd42918a3d20c258e6567512c8251f46b36cddeb8b6401c3ac9a、stderr空，修后定向lint0；功能保持限定批准，安全只读新断言/新SHA确认限制闭环。TS/JS专项仍因whole lint红/wholeTS缺失STOP，不记语义批准。

最终双SHA：

- src/app/domain-vectors/page.tsx：b0eeb7fe55f6471b29fb10b5b5a76b4bbd2e159d157913e254dd8050338e544f
- src/components/rag-ui-type-boundaries.test.mjs：a4e3cbd7fd3f6bf02e648a267ac429f7da07db48d8e2b3b4b56668f8be079f23

06:26:20.160–06:26:42.764Z原canonical whole lint实际791files/72errors/58warnings/0fatal/status1，stderr空、六watch无漂移，stdoutd15f2bd996cbcfd0f4f4bef92584e29468406a25c8a775f885e6c4bb55e62490。本批消除5errors/7warnings；运行时test为5282版本，之后仅计数断言修正、定向lint0，不将窄检查当全仓门禁。raw index0326b6f4…前后相同，不与git条目投影c9ad2d87…混比。原package本地边界06:26:42.807–06:26:46.933Z旧test实际115/115、stdout1164b0b3a58de2b6e9941278e63d28bf44ceda94376ffa9a99aca2f63ee440e1；最终a4版本06:34:37.549–06:34:39.527Z再实际115/115，0fail/cancel/skip/todo/status0、stderr空、七watch无漂移，stdoute2e12af521a3a41de4e4a123bf203b0adc25d74d9a65cd46a77deaf2a610b9e3。原native30s/parent90s/default并发不变，root编译/lint/回归串行；未用真实React/浏览器或AI POST竞态验收替代。

完整60两次结果都保留，不折叠为全绿：06:26:46.981–06:27:26.428Z在旧test5282时1222/1222、790源与index投影无漂移，stdout3faf4da8a7352c04f16cb2ed908efcb83a75c24c0744aba039201543d3fba6cf。最终a4版本06:34:39.569–06:35:16.177Z实际1222tests/1221pass/1fail/0cancel/skip/todo/status1，stdout564f8f57229064b2abe6ab85af19897d4fc2356b1fe9973210d5d3ec13f87bdb、stderr空；790源/索引前后冻结，spawnErrored false，failedDiagnostics未截断。唯一旧Ask index10:2234:10、labelSha21d7ded2b19133803f023c9f23e3ef7d063d3dbd74ffafe4ef091e5e0d216ba1，strictEqual expected200/actual503；闭集firstResponse为durable-agentic-replay-first-post/v1、DURABLE_WORKFLOW_PAUSED、durableStatus/replay unknown、Milvus connect/search各1、model embed1/generate0、scopedAgentCalls1。只能证明该响应/调用计数，不能确定错误阶段或根因，不拿旧绿色抵消最终失败、不blind rerun求绿。68984与55307均终态已drained；当前下一优先只读定位该首次POST 503，未修改Ask或其pin/Oracle/预算。

本节前计划df2c3a3a571ba17256aa90cd975f7f882655a5eab401ccee2eee7b860ec020f5、报告6215061243171528dc6dc85cbeaaf67dbbff7b0ab8335baed4bb589707a17cfa，按原记录追加。inventory仍owner授权c01e4a10…/Ask52c9168f…、runner915eb0f5…、完整顺序40c0685c…，生产false与历史顺序未恢复标志不变。未stage/unstage/reset/commit/push/Compound/学习、读真实会话或scratch子项、删除用户数据或生产写入；Goal active、原2/13/11open/18AC和local-reference/全部生产/source/IAM/stage/machine/SideEffectPolicy门禁保持未完成。W9 wholeTS/build/Docker E2E/完整conformance、W2-W8余项和真实T16/T17/R18仍按原范围推进。

### W9 既有安全日志的事后诊断（2026-10-23，2026-10-25续接归档）

原native完整60的06:34:39.569–06:35:16.177Z 1221/1222、首次POST 503失败仍未解决。只读runtime确认DURABLE_WORKFLOW_STEP_FAILED统一映射为DURABLE_WORKFLOW_PAUSED；catch还覆盖执行、租约和checkpoint保存，仅响应不足以定位失败步骤。旧源码注入观测器三轮仅内存preflight分别更新固定SHA、修正实际DurableIoErrorDiagnostic类型名、严格支持唯一LF/CRLF锚点，仍在nonunique frozen anchor拒绝；0产品测试派发、0源码写入，停止该路径，不进行第四次模糊匹配。

新增existing-durable-diagnostic-observer.mjs及同名test.mjs，SHA分别a41f92e64e9511df4bc83f9f4ad28b0df4c85b4d11c9ce85233d4b6a7b290edd、fb0fa6fe376966c069da3c2a62e734417f77cd7aa39ce64f46e9b385f3b9cbbb。只从固定legacy c75df5c0… AST提取闭集catalog和纯文本reader，不执行旧CLI/preload/源码补丁；primitive string≤16MiB、reader VM1秒、最多128行/8层cause，未知文本丢弃。complete只表示frame计数及上限，不证明字段完整、来源、因果或工作流成功；attribution固定unproven、productionAccepted=false。父程序仅改报告名称和stdout产生后的解析点，原两处spawnSync表达式经AST逐字比较相同；esbuild CJS/VM父程序是独立诊断profile，不能冒称原native父进程等价。

TDD：07:23:31.492–07:23:31.934Z模块缺失先0/7；扩展直接reader getter/malformed frame后07:26:41.423–07:26:41.892Z 8/9，恶意getter实际执行一次暴露缺口。将primitive/size guard提前到任何方法读取前，07:27:45.441–07:27:45.879Z 9/9、0fail/cancel/skip/todo/status0，stdout a7532ac5bd81eee83a6bbac28c0895c5c97595a78a9dc7264dfd06ad3a2913ec、stderr空，两文件定向ESLint0。功能/安全独立只读精确SHA限定APPROVE，明确9测没有编译后VM集成；TS因whole lint红/wholeTS缺失仍STOP，不代表全仓批准。

07:31:13.902Z同算法canonical git ls-files --stage -z投影从历史c9ad2d87…外部变为0ca80a9c2ae6b1efd8c383936f0696d5a7254c03d108ef8c201b9e65e710bd0a，不是raw index混比。07:35:10.608Z复核Ask52c9168f…、runtime bbd534dd…、inventory c01e4a10…、normal runner915eb0f5…、legacy c75df5c0…及新两文件均未变；root未暂存/反暂存。新的运行窗口实际794源，旧790源历史记录不改写。

唯一实际诊断CLI（session33009已终态drained）：07:35:43.279–07:36:32.492Z派发原60，单测30秒/父90秒/16MiB/default并发/router off/最小clean env不变，无preload；memoryParentSha526df5a78f36e94f08db341d391d0769486c87a46ae5f0e29db0565270ea2a12。实际1183tests/1180pass/0fail/3cancel/0skip/todo/status1、spawnErrored=false，stdout ca4032ff970514b10708fe972ebf7a8912cd657eda8597d71269ad5430c5c2f7、stderr空；794源/canonical index前后冻结，observer/legacy冻结通过。三项均testTimeoutFailure/ERR_TEST_FAILURE、sourceLocations空、未截断；labelSha c4d8cedbd30ed4bfcfe48721fb29da54f4dab4d42010be1b7dcdeb03431445fa、64ea36477d59c27f8d5648b35dbc733e0762eed2330b6a59f98ed870ac9ca916、50d45a59acc27ac5e096558fa319cedde4c2693f3b1ba8c9555560fc1d40d4c1。固定路径形式和3495个静态调用首参字面量只读hash匹配均未命中，生成label/具体文件仍未知，不继续猜测。

仅观察到一条durable-catch/status503、mappedCode DURABLE_ASK_RESULT_CAPACITY、codeChain[DURABLE_WORKFLOW_STEP_FAILED,DURABLE_ASK_RESULT_CAPACITY]、causeDepth2/end，frame计数完整/未截断；不能归因于原失败用例，也不以原断言未复现声称修复。最新原native失败与新诊断失败并列保留，不blind rerun求绿或修改pin/Oracle/预算。2026-10-25恢复时读回新两文件及计划/报告SHA均保持原样，确认中断前归档未落盘后才追加本节；继续其他可本地执行任务。

本节前计划9bf074065fd1122deedf4b45813cbd1de6111d009eb455f1495e075980c3b72a、报告f0b8c22369ecbbb5e251fcb2a188b17d8e33cfd5761a7442ae77971f0b8087f8，冻结Contract、18未勾AC、2/13完成/11open与未绑定acceptance不变；所有生产/source/IAM/stage/machine/SideEffectPolicy标志仍false。未读真实会话/scratch子项、删用户数据、改索引、commit/push/学习或生产写入；Goal active。

### W9 自适应实体页读取与工作流类型边界（2026-10-25）

本轮开始adaptive-entity-rag/page.tsx clean、原SHA ee1e67e2a6e994d342267172a209c5d82b3a602a92f694616bcada4845c77638。按实际业务写入字段定义页面WorkflowStepDetails，未消费的constraints保留unknown[]；tabs使用const字面量，删除未使用的INTENT_LABELS/renderEntityTag和五个未使用catch参数。DTO只是静态响应类型，不是运行时schema验证。初始化loading由state提供；模型config→models原顺序不变，实体/status/files仍独立启动且status/files并行；Promise完成回调写状态，两组effect各持有AbortController。取消后不继续模型后续请求或写状态，fallback timer在取消/完成时清理；manual refresh自己设置loading，不把click传成signal。POST查询/上传/向量化/删除/清空/实体管理的请求体、确认及结果协议未改；未触碰首页/ChatMessage/indexeddb并发链。

旧39项测试源码前缀精确保留a4e3cbd7fd3f6bf02e648a267ac429f7da07db48d8e2b3b4b56668f8be079f23，尾部新增6项。2026-10-25T08:56:33.359–08:56:34.819Z原实现实际45tests/41pass/4fail、0cancel/status1，stdout8d0d095ca938e65f4c5e3e550164acf98f85b811eec27b1cde82dacae7966ee5；实际红点为effect同步写state、两种cleanup缺失和配置完成后模型结果迟到。首实现8d24ef21…在08:57:54.621–08:57:55.604Z 45/45，但定向lint仍有模型callback的1项set-state-in-effect错误；不把单测绿色折叠成门禁通过。模型改用真实fetch Promise完成回调后，08:59:21.773–08:59:22.762Z最终45/45、0fail/cancel/skip/todo/status0，stdout32829a6047b4f540cdd35baff08a139b15e6a8f57f15a188ee6baf4dce6418c1，各轮stderr空，两文件原规则ESLint0/0，无禁用规则或人为timer延迟绕过。

最终page SHA4d7b9991797d2c9379fe498f84fc59adde68cc8d7354c2f27d8b06454ee21f50、test SHAa4e70ff58ba2e5299ae5555a141aa282db3fa52454a3274e739cf6f3b606d1b1。09:02:52.851–09:02:53.636Z显式1root/3非声明源/107文件读取的strict/noEmit检查0diagnostics/0drift，incremental=false、privateBlocked=0、readDirectory=0、outsideSkipped=10；不调用include发现、不读真实运行态目录，不声称wholeTS。功能/安全只读独立复审均精确双SHA限定APPROVE，确认旧39前缀和POST行为不变；未运行额外测试/服务、未写文件或索引。TS专项因全仓lint红/wholeTS缺失STOP，不记语义批准。合成hooks不证明浏览器/StrictMode、manual refresh在途卸载、所有请求排序或fallback真实到点行为，未据此扩大验收。

09:03:50.261–09:04:06.577Z原canonical全仓ESLint实际798files/67errors/51warnings/0fatal/status1，stdout c661c0e9464baee7d5917c9a1ae34cb8d7878b12b4db464d01a31d263596272a、stderr空；794源和canonical index0ca80a9c…前后冻结。该页原5errors/7warnings已清零；全仓文件数不同于历史791，不以窄检查冒充同一全仓快照。本地package当前MM、SHAf88f362cc9b06fd77e8338a093ca8e6c1fbae474b8d2cc91e06cf998b0882eb7与旧cd74不同，root未修改；只读核查现有10文件脚本及guard自洽，未由hash差异推断测试范围改变或自行重基线。

原当前package10文件组合09:06:00.953–09:06:31.606Z实际107tests/106pass/0fail/1cancel/0skip/todo/status1，stdout e86ca9da4566858233ffa4a07749f6655d65d705f9f8d2ef14e26431ed436a00、stderr空；794源/canonical index冻结。明确是src/lib/rag/non-ui-type-boundaries.test.mjs整文件原30000ms超时，不扩预算、不改断言或把新页面45绿色代替组合。本次原30秒/父90秒/default并发/16MiB/最小env不变。只读定位该文件静态加载真实安装tokenizer；不将fake替换真实tokenizer或切换未公开子路径求绿。一次独立导入计时09:10:14.074–09:10:15.951Z status0，transformers1556.455ms、TypeScript271.4762ms，stdout99bd34231f5b8ae8e8ee04671a6e1f93c402f2aff899d4a5792eb4d2923447eb，不能证明组合超时根因。随后仅一次原文件隔离诊断09:12:37.785–09:12:39.560Z 15/15、1722.4506ms/status0、原30秒/90秒，stdout95a91a9e1c7f34dcf62710358b5bc003126fcb79f2e374801687b0912e2f18ef、stderr空，源SHA8078fd879c3c8a733b8e848fe4f3d060c242e2be86f120fb5aa14cb4fb5c6058前后未变。隔离绿色不是组合恢复或根治；共享负载/导入调度仅推断，实际原因未知。所有root调用已终态drained，未重复派发同一待返回调用。

新证据补充前节三个超时label：本次原Node TAP真实显示Windows相对路径以双反斜杠转义；只用该已观察形式对固定60清单重算hash，精确映射c4d8cedb…→index10 Ask、64ea3647…→index43 native-publication-sources、50d45a59…→index54 production-ask-https-transport。前节未命中的有限路径/字面量匹配记录仍真实保留；这里只解决文件身份，不能推出超时步骤/根因，更不能把容量日志归于原503断言。最新原native60的1221/1222和独立诊断profile1180/1183失败均不变，不blind rerun求绿。

本节前计划de2e59ed8e0110cebecbcb3e3cfdd995eafca34e3b4314019d43d524530f3a0d、报告5019a9f3520644af196fa2f0ac026cdc7455886dd805afb1583a1a158d8bfe95，按前缀追加；原2/13完成/11open、18未勾AC、冻结Contract和未绑定acceptance不变，全部生产/source/IAM/stage/machine/SideEffectPolicy状态仍false。未stage/unstage/reset/commit/push/Compound/学习、访问真实会话/scratch子项、删除数据或生产写入。Goal active，W2-W8余项、W9完整类型/构建/组合测试/本地E2E和真实T16/T17/R18仍需按原范围完成；下一步需对已定位组合超时获取派发/阶段证据，而非反复绿色重跑。
