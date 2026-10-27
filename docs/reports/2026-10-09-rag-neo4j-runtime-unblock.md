# RAG / Neo4j Sprint 解除运行时阻塞

## 已验证

- Goal 私有 generation 的父目录持久化修复已落盘；四条新回归先红后绿，Goal layout 18/18。
- pre-commit 模块导出与双运行时投影校验闭环；smoke 37/37，投影夹具通过，正式 build / plugin validator 通过。
- 独立有界终审 APPROVE，无遗留实际 P0/P1。
- 完整离线套件运行 142 个文件：默认 Windows 8.3 TEMP 下 130 通过、12 失败；12 个失败文件使用已核实的真实长路径 TEMP/TMP 分三次复跑，分别 1/1、2/2、9/9 通过。没有修改或放宽安全校验。模型 canary 41 项通过。
- 用户级安装事务提交；validate-codex-install --user 通过，唯一 owner、source/cache 版本与内容 hash 一致，保留用户 direct/shared skills。
- 2026-10-09T01:41:16.830Z，由已安装 CLI 事务化 supersede；权威 readback 为后续计划 think/active、v1、0/13。
- 旧计划保持 16/18 未完成；全部 W0-W9、T16/T17/R18 已保留，未生成虚假 completion。

迁移凭据：`../plans/.handoff/active-sprint.migration-receipt-4f342b83fa5e7d9b0e24c5ef2bf07487bd13b010b33060cea78850412c0c7089.json`。
批准来源：真实用户消息“直接授权”的本地主机观察与 UTF-8 hash；不是密码学身份或生产变更授权。

## Think 验收

- 要做：按既有依赖实现 provider-neutral 门禁、三层验收凭据、只读 PublicationIdentity、受限恢复与引用授权链，复用现有 RagEval / Graph CAS / Evidence。
- 不做：制造真实企业 provider、虚构 roster/阈值/窗口、共享环境故障注入、历史 Store 删除、提交或推送。
- 成功标准：缺字段/坏摘要/无效授权在副作用前 fail-closed；阶段凭据无环且精确回读；恢复仅允许冻结的降风险动作；引用点击由当前主体重新授权；生产完成仅依赖有效真实 acceptanceBundle。
- 路由：architectural-like。跨安全端口、事务与 API/UI 消费者接口；进入 Plan，继续采用已绑定计划的依赖和风险等级。

## 未验证 / 外部前置

- 当前进程无 OPENAI_BASE_URL / OPENAI_API_KEY / OPENAI_MODEL，真实 broker qualification 未执行。
- 持久化测试验证 syscall 顺序与故障恢复；未执行真实 POSIX 断电实验。
- 冷审计证据默认保留，长期生产容量治理仍需非破坏性封存/容量门禁，不进行自动删除。
- T16/T17/R18 的真实 roster/gold、阈值、provider conformance、独立审批、目标身份、维护窗口和可信经过时间仍需外部提供；本地开发可继续，生产验收不得冒充完成。
