---
type: implementation-evidence
date: 2026-10-10
status: local-increment-reviewed-regression-open
task: W5
production_authorized: false
---

# W5 native sources 私有构造绑定与 UNKNOWN 传播

本报告记录本地增量的真实 TDD、精确独立审查和扩大回归的未通过项，不作为完整W5或生产完成凭据，不缩减完整 Goal。三库原生业务回读的先行证据和安全修复历史另见 `2026-10-10-rag-neo4j-milvus-publication-readback.md`。

## 已确认的既有合同

统一 reader 的成功次序为 PG-before → Neo-before → Milvus scan1 → Milvus scan2 → Neo-after → PG-after → completion clock。每次 source call 前都读 fresh clock；若两次扫描页数分别为 p₁/p₂，source proofs 共 4+p₁+p₂，clock readings 共 5+p₁+p₂。每页最多 128 行时，65,536 短行的两遍扫描是 1,024 页、1,028 source proofs。它不证明任意长正文均能满足 canonical/page/proof/期限预算。

本地 factory 的最小方案是模块内部直接构造三类 native adapter，捕获导入类的方法和内部实例 receiver，只向 native 传自有 `{}`。scope 来自绑定，collection 来自冻结 selector；不接受任意带 marker 的成功 callbacks，也不把 public class marker 当企业来源认证。raw clients 仍可为 fake，因此保持 `local-reference`、`productionCapable=false`、`productionSourceAuthenticated=false`。

Milvus 每次合法 `cursor:null` 必须重新执行实际 native bulk read；只在单次 scan 内分页，完成后清除缓存。消费型 opaque cursor、nonce、context、actor、authorization、窗口和时间单调性必须在任何业务读取前核对。大 bulk 不做整体 256KiB snapshot；逐行有界打包且每个完整 proof envelope 核验大小，超限明确失败而非完成前缀。

## 真实 RED

- 新 factory 的完整入口合同 0/11，UTC 08:33:16.782–08:33:17.080，265.3064ms，stdout SHA-256 `493ed0c2b9e9339d8d2536f1683209b3baceae61420a8e0d801ce1d13fd5a403`。先记录真实失败，不以入口脚本错误代替完整 RED。
- 首轮全 11 单元随后 11/11，UTC 08:35:31.153–08:35:48.254，17068.7826ms，stdout SHA-256 `8b9caf5001749e1101926f92cb96d694da00e7bc41ca410f0073ce5082c21492`，保持 30s 测试预算。65K 核心案例有两次 required scan，并单列之前用于获取实际 schema/index manifest 的独立 warm scan，不能把 warm scan 算成所需两次之一。首轮绿色不作为最终放行。
- 自查 proof.ref 可变的真实 RED 0/1，UTC 08:37:07.481–08:37:07.766，253.6523ms，stdout SHA-256 `c5515703a5a7e607023aa18611ca69eda078f904f16260cedba1fbd98b335755`。已最小冻结复制后的引用。
- 统一 reader 首次 UNKNOWN 传播的独立纯内存 RED 0/1，UTC 08:35:19.252–08:35:19.343，10.637ms，exit1，stdout SHA-256 `4a98e23b18d691fa01c615bb524706dce5d648c7f169c02e2ee8b1b8f328131c`。来源真实抛出当前模块构造器创建的 `PublicationIdentityError('operation-timeout', 'postgres', true)`；第一次却得到 `operation-failed / pendingCompletionUnknown=false`，再次调用也同样失败且 sourceCalls=2，而不是 halt 后保持一次调用。未使用数据库、实际故障注入或凭据。Node 的 MODULE_TYPELESS_PACKAGE_JSON 告警保留。

## 根因与最小修复

已验证代码与实际 RED 一致：boundedProviderCall 的 rejected observation 丢弃 rejection reason，reader 将所有 rejection 折叠为普通 operation-failed。仅让 factory 抛出携带 UNKNOWN 的自有错误仍不足以保留第一次状态；不得通过人为返回永不 settle 的 Promise 伪造 timeout。

先行冻结 Neo+core 切片双审闭环后，已建立持久单测并实现该窄修复。原 boundedProviderCall 默认仍只返回 `{status:'rejected'}`；新增 `boundedProviderCallWithRejection` 共用原 deadline/drain/descriptor 内核，仅自有 observation wrapper 保留 reason 引用，不访问、字符串化、记录或 async-adopt raw reason。reader 的私有 WeakSet 只辨认本模块构造器登记的冻结错误；pending own-data 严格等于 true 时重建静态 code、当前实际 phase 的脱敏 failure，第一次 UNKNOWN 就共享永久 halt，第二次调用在任何 clock/native IO 前拒绝。仅保留 operation-timeout，其他 UNKNOWN 统一 provider-contract-invalid，公共 JS 构造器的任意 code/phase 文本不能流入 outward error。普通和未登记/伪造/Proxy 错误维持原 operation-failed，零 raw getter/trap。

错误对象的模块登记只能证明本地构造器路径，且只可保守停止工作，不是企业来源、授权或生产成功认证；不授予同进程恶意代码隔离、不证明后台取消成功。

新增六个 opt-in 单元真实 RED：0/6，UTC 09:03:50.487–09:03:50.590，72.2592ms，stdout `baa5e1420203a60f32049cb46f6d58a4fd173010df52f47531c43b654225181f`；新增 reader 四项真实 1/4，UTC 09:03:50.592–09:03:50.915，292.0461ms，stdout `74d21a95cc3cc895968bf22631525bbea9bf5835785c8776ab9a162701c71522`，三项失败分别为各 phase owned UNKNOWN、非法构造器参数脱敏和实际 native factory→PG invalid SDK carrier→reader。普通/伪造负测原本通过，仍保持其约束。

最小修复后定向 6/6（UTC 09:04:28.308–09:04:28.440，98.7315ms，stdout `31c55548af45d0a754625abc659ab8fdd6492be60198c86d628b9833ac3860c6`）和 4/4（09:04:28.442–09:04:28.767，291.7028ms，stdout `9f89af8cf7f0c42a43977848f170091d2f6b7a599155992d53b433ae48379e1f`）均原预算、无失败/取消/跳过/todo。native factory 负测首次 UNKNOWN=true、第二次 halt、native IO=1、危险 then getter=0。

最初独立纯内存 RED 同脚本实测 GREEN 1/1，UTC 09:13:36.866–09:13:36.955，9.5114ms，stdout `d80e9a23a4ce5c7b244bd7952cb1212d7f8e3cc4304ddabb5f1ccc2dd6dd6748`：firstCode=operation-timeout、firstUnknown=true，secondCode=halted，sourceCalls=1。stderr 仍有 MODULE_TYPELESS_PACKAGE_JSON 告警，未隐藏或更改 module 配置。

## 待完成验证

当前 factory source `95a6cfd0fd6cca3302c31d62db461defe4ead8fed74abe0323099533b4289fa5`、unit `73c959322ded02624e2a82be0e46052878976c3f59bc149783640cc291ebaf0b` 已冻结交审。14/14，UTC 08:40:30.926–08:40:47.991，17032.5589ms，stdout SHA-256 `012dda4fd9e7b70740746fb25a07b7b0105d1ad06ac3bc7991d44b1e10aa2de5`；strict/lint exit0、stdout/stderr 空、审前验证和单测后二 SHA 无漂移。新增 captured prototype 替换、完整额外版本/quarantined 透传、invalid SDK carrier UNKNOWN 共享 halt 等直接 source 负测已通过；不等于 reader 首次 UNKNOWN 已闭合。

中间 13/14（stdout `30742412c6e898c91d0ce7a799f95cca1f15e6614111055880c6a292f207d6d1`）是 null-prototype 与普通对象在 deepStrictEqual 下不同，Oracle 按合同 canonical 等价修正；保留该失败，不降低数据验证标准。完整覆盖程度与额外 deadline/迟到完成/并发边界由独立审查核对，不以 14 的数值代替安全证明。

该冻结 factory 两文件功能独立终审 bounded APPROVE：原预算 14/14、17109.3139ms，失败/取消/跳过/todo 为零；已有未完成 Milvus cursor 后实际 Neo 原生 UNKNOWN 触发全来源共享 halt，迟到兑现后额外 IO=0、native query 一次，额外 PoC exit0。审前后二 SHA drift=[]。

随后串行 TypeScript 独立终审 bounded APPROVE：strict source / lint2 均 exit0，原预算 14/14、17164.5256ms，失败/跳过为零，两 SHA 审前后一致；核对私有实例的方法捕获、冻结 context/proof、跨源 nonce、一次性 cursor、128KiB 自适应页面和 UNKNOWN shared halt。两轮结论均只限当前 factory，不关闭统一 reader 的 reason 遗失、不认证 raw SDK 来源或企业 IAM，不替代实际三库组合和完整 W5。

修复后首次扩大验证保留两项非通过：内存 runner 漏一个 tuple 结束括号导致 SyntaxError，未执行测试；修正编排后 strict25 通过但 lint22 因新增 fixture 未使用变量告警 exit1（UTC 09:05:26.533–09:05:28.474，stdout `21b82f97f8a7a4a8eeb2525d7e4d4e8d2894243964397456bddbc6d5ba40e017`）。同一轮窄测131/131和累积44的841/841、99文件drift=[]只作为中间绿色，不把该轮总体 exit1 当最终通过。去除未使用变量不改变 fixture 数据/Oracle/任何期限。

最终该四文件新身份的 strict25（UTC 09:07:21.508–09:07:23.772）/lint22（09:07:23.773–09:07:25.569）均 exit0、stdout/stderr 空；组合 **131/131**（09:07:25.570–09:07:42.793，17177.29ms，stdout `522b8f8212274b3844901bf961770e2acd2476bf046ed0d86c4c018b9c273b6d`）；原预算完整 **44 文件841/841**（09:07:42.793–09:08:08.545，25712.4964ms，stdout `820f09228be80027c0f1aa33440c6fa3983792c9b9bfba40652d3324521f9d1d`），均无失败/取消/跳过/todo、stderr 空，99文件drift=[]。原43和所有原35均保留，只增加 factory 单元，不改环境/并发/内部等待或 30s 单测预算。原 Ask 503 和取消 fixture 2s 失败仍未定位原因，后续绿色不视为修复；详情保留先行报告。

第一候选六文件审查身份如下；后续截止边界 MEDIUM 尚未关闭时，这些身份不作为最终 UNKNOWN 闭环批准。下一修复的四个新身份另列，不沿用旧 core 或 primitive 的批准。

| 文件 | SHA-256 |
|---|---|
| bounded-provider-call.ts | `cd9e5bfd23604bcbce77cdb7364f7d49a81a697d6f6df45ecd06d67c18e26e48` |
| bounded-provider-call.test.mjs | `86c6a598d251d6e349bf8696303fa1d5c453082a2df37e424ef7803aea7e1f64` |
| publication-identity.ts | `520be34099e8e7949f87e063bd99ec6fee6def4427f7ac61c8c07451428bf6b1` |
| publication-identity.test.mjs | `ab82f7ed56beca248d779ad625c7ccc37c650d2a5101413f5a3df16160baccc7` |
| native-publication-sources.ts | `95a6cfd0fd6cca3302c31d62db461defe4ead8fed74abe0323099533b4289fa5` |
| native-publication-sources.test.mjs | `73c959322ded02624e2a82be0e46052878976c3f59bc149783640cc291ebaf0b` |

该第一候选 exact6 的独立功能审查实际69/69、16881.9917ms、exit0、六 SHA drift=[]，仍复现截止边界 MEDIUM：native PG query同步占用80ms后返回非法carrier，内层冻结错误明确provider-contract-invalid/postgres/UNKNOWN=true，但reader20ms外层预算使首次变为operation-timeout/UNKNOWN=false；实际另一个pending Promise尚未完成，release后才完成。第二次已halt、queryCalls=1，因此不是旧HIGH的重入，仍是错误事实降级，未批准完整UNKNOWN闭环。未用任意全局intrinsic篡改推测新finding。

新增两个真实 RED：opt-in截止引用0/1（UTC09:19:05.430–09:19:05.533，70.1462ms，stdout`698407925a001b07605abed960b800bdbdc7f0197c110c6d123b599e36c05d13`）；native→factory→reader同步超时0/1（09:19:05.534–09:19:05.916，350.3059ms，stdout`3182f1eca921e6a5218b5948533abe4c17e6d9c7316ac3bb1573f091d12fd9e1`）。原80ms/20ms和30s测试预算未改。

最小修复为opt-in在已settle的截止拒绝自有timeout wrapper中也保留reason引用，默认API仍原脱敏形状；reader仅合并ownedUNKNOWN，不让“回调已经拒绝”覆盖“内层业务完成未知”。首次仍operation-timeout且UNKNOWN=true，halt与零重入保持；非owned reason不执行getter/trap。修后两项实际1/1（UTC09:20:06.915–09:20:07.016，68.6207ms，stdout`b8aef87265e8fa0493e4bf7af0f56ee7df1071821c656ba9d76d932ab3811c84`）和1/1（09:20:07.017–09:20:07.395，347.3583ms，stdout`686460f118782956c62ce97c7c1ba15d01eca1971b5b98dcb4844b3c57592079`），exit0、无fail/cancel/skip/todo、stderr空。新四文件仍须冻结扩大验证与串行双审，不用第一候选69/841绿色代替。

截止修复后的冻结候选再次执行：strict25（UTC09:21:03.134–09:21:05.072）/lint22（09:21:05.072–09:21:06.892）exit0、输出空；组合132/132（09:21:06.893–09:21:24.132，17198.1386ms，stdout`444b8df37826e34373a14b4ee368872e1d0f9ea1b34d7ff219b19d4d75b38f0f`）；44文件累积842/842（09:21:24.133–09:21:50.364，26191.5931ms，stdout`b3eaceed03b3603a1b0bded70d34e7558c43a9f3acc1ae89446c5efc3e3f5c57`）。均原预算、无失败/取消/跳过/todo、stderr空，99文件drift=[]；这是已列44文件的累积，不是尚未执行的全仓W9验收。

新四身份：bounded source`dfac5f20bf071ced1ae104a12e61931de8f85bf451af5ae1b417fb31b2478463`、unit`5ef6cf38038110b16ac424c61b0497fe9845a2aa30fb659e870a4e200fd230a4`；core source`eaeeca339caffd66761372a251233442b44b03b69377590ee8bc83eb49675639`、unit`3e378eb0ad49d7b8e59ac4b638e8e6101ec40e26fb0b633c26426cf36e4367a9`。factory两SHA保持原值，新exact6功能复审正在执行；旧69/841不作为新身份批准。

新exact6独立功能复审 bounded APPROVE：原预算70/70、17303.3607ms、exit0、fail/cancel/skip/todo为0，六SHA审前后一致。原native20ms/80ms实际PoC首次operation-timeout/UNKNOWN=true、第二次halted、queryCalls1；首次后台未完成，release后完成且无新增IO；晚拒绝getter/Proxy、四phase owned UNKNOWN、非owned reason均符合预期，hooks0/default不持reason。截止MEDIUM按新身份关闭，串行TS终审仍在执行；不把同进程隔离/enterprise能力填入结论。

随后同一 exact6 TypeScript 独立终审 bounded APPROVE：strict3/lint6 exit0，原预算23+33+14=70/70、17311.6479ms、0fail/skip，额外20ms/80ms迟到getter/Proxy拒绝4/4、hooks0；六SHA审前后一致。原“4TS”是计数笔误，实际只有3个TS入口，不能扩大为4个。审查期间PG/Neo依赖稳定，但Mil source从`98157b52b340b44cd7fe3431c5824272ae26b97dea681ce3e6f49aa31fb0899a`变为下述`cabc76…`；该依赖漂移明确不在exact6批准范围，另行精确审查。两轮批准只关闭本地UNKNOWN传播切片，不认证enterprise/IAM，也不关闭完整W5。

当前 core/primitive 修复后分别重新验证实际 PG3/3（UTC 09:10:16.480–09:10:16.819，298.6384ms，stdout `dc357f9e8f88b2702826f4eee4566e31fb00de7c1ce353260ffb8efa11117e6f`）、Neo4j4/4（09:10:16.415–09:10:16.849，401.1213ms，stdout `bd4b810056435fa3d87ba426b903a19c347d0079c4f45ea79d40484f3ad820be`）、Milvus2/2（09:10:16.678–09:10:23.007，6282.7916ms，stdout `8161bab08b93494c9ffcc291d32d478affd0a6d64079c689a93c5f3df672dc46`）；exit0、无失败/取消/跳过/todo、stderr 空。全部使用先行隔离规则，保留 PG MODULE_TYPELESS 告警；三份独立集成相加不是同一 identity 的三库组合证明。

截止修复后的上述新四身份再次分别实际PG3/3（UTC09:22:50.110–09:22:50.379，231.5331ms，stdout`ea7f0e0d69115d5f094721266cce95af09fa9911e7f590025ad58300a30a70cc`）、Neo4j4/4（09:22:48.634–09:22:48.984，316.7332ms，stdout`6e10dbd5299eabc9202a1b444ec55330663d90fabd9d520e652c95207ca31c37`）、Milvus2/2（09:22:50.831–09:22:58.019，7154.4983ms，stdout`58dbe8d8265396c5039c6c7fd6544f0185eb2ea8113d11e71ea2d36768dff933`），exit0、无fail/cancel/skip/todo、stderr空，PG原告警保留。依然不是实际三库组合证明。

## 实际三库组合（保留原失败与修后完整实测）

新增唯一文件native-publication-sources.integration.test.mjs第一候选SHA`019aba13a6af265698a5c9e5cec4d338314003dbcac598598caee98b1d2df620`。语法/lint exit0；ES2022导入8根/35非声明TS source严格检查diagnostics0，仅MJS syntax/lint，不宣称checkJs覆盖。沿项目ES2017目标的实际strict发现唯一TS2737，milvus-publication-readback.ts:65:86的BigInt literal（UTC09:26:47.010–09:26:48.423，1412.4045ms，exit1）；这是本地实现的项目编译兼容缺口，不用ES2022绿色隐去，另做数值等价最小修复，不改tsconfig。

首次真实三库组合2项 **1/2，exit1**，UTC09:26:42.850–09:26:52.929，10045.9873ms，stdout`c887e5e5318cfd932e4d374b3d14b87cc87f834708a1cb76b32cda79a06e5ccc`，无cancel/skip/todo，stderr空，文件SHA前后无漂移；MODULE_TYPELESS告警保留。实际same-scope额外版本/trust负测通过，完整枚举后identity-mismatch明确拒绝；该用例的实际cleanup为PG六项count0、Neo0、owned新Mil集合不存在。正向失败只有ERR_ASSERTION，不宣称两项通过。

原预算仅正向诊断0/1，UTC09:29:50.111–09:29:56.929，6784.7775ms，stdout`86d04125978b0032b024793314320529e7a4e10e293a1eff9d4e1225a022abad`，文件无漂移；安全提取断言位于新文件236:14，strictly deep-equal与null-prototype信号，无PublicationIdentityError。协议对象原型不是身份语义，fixture Oracle将按精确canonical编码比较ref/context/selector，保留所有数据/proof/observation哈希、scope/nonce、枚举次数与cleanup强断言；该诊断不能替代原整2项验收，修复后重新实际运行。

Oracle最小修复的新文件SHA为`f14b81427f045118f1511f8edc66e71b3983b247fb1b247914f03f69571316ba`：只导入canonicalJson，将ref/context/selector三项改为精确规范编码相等，并解释WHY；所有data/proof/decision完整哈希、枚举次数、scope/nonce、seed/cleanup和期限不变。新身份语法/lint exit0、内存5case边界检查通过，不能把内存结果当真实三库绿色。该内存检查stderr保留MODULE_TYPELESS告警。

主流程按新SHA原完整实际2项重跑 **2/2，exit0**，UTC09:40:34.105–09:40:44.289，10150.2519ms，stdout`a5b921c3e642af59b892a2754476ebc651d73315cb3d5704a9a8eea9b3f30385`，0fail/cancel/skip/todo，stderr空，TAP中的MODULE_TYPELESS告警保留，文件前后无漂移。正向4行、2required完整fresh scans（另列1独立warm）、4新鲜PG/Neo屏障、8source proofs、9clock readings/17唯一nonce；全context/selector/ref及data/proof/decision哈希通过。负向实际same-scope额外版本/trust不被filter隐藏，完整读出后identity-mismatch拒绝。两例finally后均实际读回PG六项count0、Neo0、唯一owned新Mil集合不存在，不把cleanup代码存在当执行证明。

实际PG/Bolt分别处于不提交事务，Neo公开awaited transaction共享的executeRead是本地测试seam，不是managed-driver来源、独立IAM或跨库原子证明。Mil仅唯一新隔离集合；客户端固定loopback，不声称容器publish binding网络隔离。凭据只有父进程内存转子进程环境，不写argv/文件/日志。productionAuthorized/sourceAuthenticated/linearizableSnapshotProven/stageAcceptanceComplete/productionCapable全部保持false。新实际测试仍待独立精确增量终审，不能用初019身份或诊断1项替代。

## 项目目标兼容修复与验证

针对原项目ES2017 TS2737，唯一实现变化为Milvus MAX_INT64 `9223372036854775807n` → 等值`BigInt('9223372036854775807')`；数值边界、Oracle、容量及tsconfig未改。source新SHA`cabc76e67af0e2077c22ce0f92a45a919bf030fa5723b521f3aa8d3ec001ba72`，unit仍`3e168ca045d60408572f3b039afdc175ee336c815534dd7638883f2b3f98b0a1`。18/18、4496.1421ms（UTC09:31:56.051–09:32:00.579，stdout`8ba959e416461d0d66418981e678d9113be92573a34c3f3dd6b54d0cae2c1e18`）；单根9非声明源项目strict diagnostics0、lint2 exit0，验证前后二SHA无漂移。该单根结果不冒充原35源编译。

随后主流程以原exact8入口/35非声明源及真实tsconfig options strict重新验证，UTC09:40:23.576–09:40:25.006，diagnostics0、exit0，target=ES2017、libs=dom/dom.iterable/esnext，未overrideES2022或改tsconfig。MJS明示只syntax/lint，不宣称checkJs。

按新Mil source身份原实际SDK整2项通过2/2，UTC09:42:01.255–09:42:07.711，6422.9475ms，stdout`05fd0db0680327ff51b9e14b5801e1bdc0589ec6d90b138f829a4948eb1a38c5`，exit0、0fail/cancel/skip/todo、stderr空。实际65,536元素/每ID256UTF8-byte的query template参数检查保持`provesStored65536Rows=false`，不冒充65K行实际库存测试。新source与组合联测三文件仍待功能/TS精确终审；新100文件快照扩大回归正在执行。

上述新exact3随后完成两项独立终审，均bounded APPROVE且审前后二SHA及新integration SHA一致、drift=[]：功能原预算Mil18/18、4414.8351ms；Int64精确保留/非法值拒绝、raw then hook0及无后续IO；直接执行联测三处canonical判定的8个组合，不接受任一对象额外字段。TS以真实ES2017 tsconfig检查Mil单入口9非声明依赖diagnostics0，MJS两份node --check、lint3 exit0，原Mil18/18、4520.526ms、0fail/cancel/skip，保留MODULE_TYPELESS告警，未宣称checkJs。两review均未执行真实DB/Docker/network IO；root的actual2不混入独立单测统计。scope隔离、公开SDK事务、嵌套finally、fresh全扫描和完整Oracle均核对，无可操作finding。结论仅限下列新精确增量，不复用旧981/019批准，也不证明企业来源。

| exact3文件 | SHA-256 |
|---|---|
| milvus-publication-readback.ts | `cabc76e67af0e2077c22ce0f92a45a919bf030fa5723b521f3aa8d3ec001ba72` |
| milvus-publication-readback.test.mjs | `3e168ca045d60408572f3b039afdc175ee336c815534dd7638883f2b3f98b0a1` |
| native-publication-sources.integration.test.mjs | `f14b81427f045118f1511f8edc66e71b3983b247fb1b247914f03f69571316ba` |

## 最新扩大回归（明确未通过）

主流程在该新身份下执行projectTargetStrict25（UTC09:42:32.240–09:42:34.274，ES2017+esnext/dom/dom.iterable）与lint23（09:42:34.275–09:42:36.104），均exit0、stdout/stderr空。原预算窄测132/132（09:42:36.104–09:42:53.861，17716.0776ms，stdout`67e51502861f85649bd8b1f9ea9ebcafcb94aec06239fe7ff2b4ea8706ac2041`），无fail/cancel/skip/todo、stderr空。

完整保留原35+后续新增的44文件累积 **841/842、exit1**（UTC09:42:53.861–09:43:20.513，26610.31ms，stdout`97574a02c1250ffb5e095011c10de500cee56d773611aa2adebb28ddab51e7a2`），1fail、0cancel/skip/todo、stderr空，100个监测文件前后drift=[]。失败为原Ask `POST preserves nested durable result integrity failures instead of reporting pause`（route.test.mjs:1993，断言2002:10），首次正常POST **500!==200**、81.6473ms，尚未进行有意tamper；该失败不是新native fixture的1/2 Oracle失败，也不能归因于随后全局日志的静态错误码。早先同fixture首次503和cancel fixture 2s信号失败及这次500均保留；原因未知，不用任何后续隔离绿色或累计842绿色宣称根治。继续只读诊断失败路径的status/白名单静态code，不泄露原response，不修改等待/断言/预算/并发。

新combined integration只增加snapshot和lint，不并入无credentials的44单测，真实2/2另行执行且无skip。100文件无漂移不等于git工作树洁净，不把未tracked文件的空git diff当无变更，也不把这次局部双审/actual2当W9全仓构建、安全集成或完整W5验收。

只读精确Ask诊断确认首POST在reservation定位/篡改之前；已知durable persistence cause最多8层映射，RESULT_INTEGRITY等映射503，不识别的异常才可能走通用500，不能据此确定本次真实500的原异常。fixture使用唯一mkdtemp根，失败t.after会恢复环境并清理临时现场。纯内存白名单探针只采目标idempotency key的status/static code chain，无body/message/stack/URL；两轮完整Ask75（instrumented75/75、7160.2702ms、stdout`510dccfb4d364ecd0a34eb72a11c23433548598f98ce711ec1f365efc34ecd5b`；原命令75/75、6561.4982ms、stdout`ef89e301aaaf3d292d9659557136d4f4b04e88948e4db8dde78ef56b753be159`）未复现initial500。当时未采集UTC，不补造时间或重复追绿。

随后仅一轮原44文件/原并发/原预算的安全内存诊断，UTC09:55:58.381–09:56:24.761，**842/842**、26339.0325ms、exit0、0fail/skip，stdout232314bytes/SHA`70ccfc8caa6e7e5eb1818611e753913ca929008ea1678120db67de72ddcf507e`、stderr空、failureBlocks=[]。探针已加载，唯一目标记录仍为篡改后预期503/DURABLE_ASK_RESULT_INTEGRITY；没有initial caught-error500或returned-response500。原841/842真实500仍未复现、根因unknown，不将这轮诊断绿色记为修复或覆盖失败。六Ask代码SHA前后稳定：route.test`11f0b9763b2d17dae0edbdf648f3bafc433ff0770fa26e739984588da42a066f`、route`648a322b3dbe4be849f489f1e7284566ea80bd0b5258461b6d2b9fb31455c825`、runtime`2309d3a282dc7fa8256d5854f9473c665c087db092f6191fdc2f62868dd2de3a`、durable-ask-workflow`90d0b94311186fdd81ed30318787b6fa33b0ff177401234cdf2cf0cd15c7a3b7`、durable-result-artifact-store`f77ce9302e9f1e59e54d6fd0c564e20c9d476410ba669a33585ea10ae8fac190`、durable-workflow-runtime`9fc6bae8e7a7f6920a5aa432f4dfcd6123fced1c29902545065954d4b92430d4`；未编辑Ask任何文件或放宽等待/Oracle/预算/并发。

artifact/registry/evidence/runner/conformance 绑定仍未完成。不能把这次本地 factory、UNKNOWN传播及实际三库增量当完整W5。

计划仍为 2/13、11 open、18 项端到端 AC 未勾选；W5 整项保持 open。生产数据、批准阈值、目标环境/scope、窗口、负责人和有效验收对象仍须真实输入；本地授权不替代它们。没有 commit、push、生产切流或历史 Store 清理。
