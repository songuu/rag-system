

## 技术沉淀（通用经验）

### 解决方案索引

<!-- BEGIN TECH_PERSISTENCE_SOLUTIONS_INDEX -->
> Generated from `docs/solutions/*.md`; do not edit this block manually.
> Refresh with `node scripts/sync-solution-index.js --all`.

- [2026-07-16] [rag/production-activation/recovery] RAG E3-E7 生产激活与有界恢复闭环 — E2b-E7 的纯合同和 library seam 已存在，但 E3、E5、E6、E7 仍有真实 caller、持久化生命周期或生产回退缺口；仅凭 hermetic 测试会把“可注入”误报为“可运行”。 → `docs/solutions/2026-07-16-rag-live-activation.md`
- [2026-07-15] [rag/evaluation/security] RAG 演进采用 Evaluation-Gated Control Plane — RAG 演进采用 Evaluation-Gated Control Plane → `docs/solutions/2026-07-15-rag-trends-next-options.md`
- [2026-07-15] [openmaic/maic/classroom] OpenMAIC classroom fixed-viewport chat layout — Long multi-agent discussions made the full OpenMAIC classroom page scroll. The message composer moved below the viewport instead of remaining available at the bottom of the discussion panel. → `docs/solutions/2026-07-15-openmaic-classroom-fixed-chat-scroll.md`
- [2026-07-15] [mirofish/ontology/cache] MiroFish ontology cache tolerates incomplete model fields — Building a graph after ontology generation could fail with Cannot read properties of undefined (reading 'replace'). → `docs/solutions/2026-07-15-mirofish-ontology-cache-normalization.md`
- [2026-07-14] [mirofish/openmaic/maic] MiroFish and OpenMAIC latest sync with reasoning-safe JSON — Official MiroFish had no delta from the project's tracked 96096ea anchor, while OpenMAIC moved 72 commits from a88ee3d to 40ff80a after release v0.3.0. The local MAIC read, plan and manager paths each had a separate reg… → `docs/solutions/2026-07-14-mirofish-openmaic-latest-sync.md`

<!-- END TECH_PERSISTENCE_SOLUTIONS_INDEX -->