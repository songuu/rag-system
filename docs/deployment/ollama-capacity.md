# Ollama 跨进程容量配置

最后更新：2026-11-06。决策：使用同一 Ollama 服务的原生调度作为推理容量边界，保留应用进程内队列作为前置背压。仓库默认仍是保守的 `1 / 1 / 16`；本机采用 `NUM_PARALLEL=1 / MAX_LOADED_MODELS=2 / MAX_QUEUE=16`、Ollama `0.40.15`，已验证两个所选模型完整驻留 GPU 的能力，15:20 的闲置检查中模型已卸载。第五批最新 20 个顺序开发环境请求的总耗时 P50/P95 为 1112/3591 ms，22 条响应有 13 条引用 available、9 条 missing；第四批历史数据、已撤回的 C 盘副本和验收边界见下文。这不代表其他宿主适合相同设置或已完成配置。

## 部署契约

本项目 Next.js、独立 graph-control-worker、评测脚本可能同时访问一个 Ollama。PM2 即使 `instances: 1`，reload 交接也会短暂存在两个应用进程。`globalThis` 内的 `provider-admission.ts` 队列只能约束一个 Node 进程。当前 MiroFish 模型调用也走 TypeScript `model-override.ts` → `model-config.ts`；仓库内 Python 文件属于部署工具，不能据此排除机器上其他应用直接调用 Ollama。

同一 GPU 的这些调用必须指向同一个受管 Ollama daemon。宿主 `127.0.0.1:11434` 与容器的 `host.docker.internal:11434` 可以是这个 daemon 的两个访问地址。应用并发数不是服务端容量；不要在同一 GPU 上另起一个 Ollama 进程来绕过等待。

| 变量 | 保守默认 | 作用 |
| --- | --- | --- |
| `OLLAMA_NUM_PARALLEL` | `1` | 每个已加载模型的并行执行数 |
| `OLLAMA_MAX_LOADED_MODELS` | `1` | 同时加载的模型数量；仅限制前一项不能防止不同模型竞争 GPU |
| `OLLAMA_MAX_QUEUE` | `16` | 收紧 Ollama 调度器等待队列，过载可以返回 503 |

这些值必须配置到 **Ollama 服务进程**。只写入 `.env.container`、Next.js 或 PM2 环境，不能改变已经运行的宿主服务。Ollama 环境变量与并发设置见[官方 FAQ](https://docs.ollama.com/faq#how-does-ollama-handle-concurrent-requests)。

`OLLAMA_NUM_PARALLEL=1` 约束的是**每个模型**，不能在允许加载两个模型时称为“全局 GPU 单并发”。官方文档区分同时加载的模型数与每个模型的请求并行数，并要求 GPU 并发加载的模型完整放入可用显存。提高驻留上限前应按实际模型、上下文和运行时占用测量，不能只把模型文件大小相加。参见[官方并发语义](https://github.com/ollama/ollama/blob/main/docs/faq.mdx#how-does-ollama-handle-concurrent-requests)。

`MAX_QUEUE=16` 不等于整个 daemon 只允许 16 个未完成 HTTP 请求。已加载模型可能绕过模型加载等待队列，进入 runner 自己的等待路径；具体行为随版本变化。以本次检查的 [Ollama v0.40.14 调度源码](https://github.com/ollama/ollama/blob/v0.40.14/server/sched.go) 为例，`getRunner` 会直接复用已加载 runner。它也不提供本项目 interactive/background 的全局公平性保证。

单模型上限的代价是 embedding 与生成切换时可能重新加载模型。可先用这个保守配置建立基线，再依据显存、模型大小、上下文和真实请求决定驻留上限。本机已观察到 HDD 上反复加载的明显成本，并验证双模型驻留；该实测配置不替换其他机器的保守默认。未经测量不要把 `MAX_LOADED_MODELS=0`（自动）当作单模型配置。

## 本地启动器

`pnpm dev` / `pnpm dev:infra` 检测 `GET /api/version`。模型列表慢不再触发重复启动。这个探测只证明 HTTP 服务可用，不证明模型已热身、GPU 正常或容量配置符合要求。

- 已有服务：复用并提示无法核验服务端容量，不重启、不覆盖其配置。
- 需要启动服务：把上述三个默认值直接传给新 `ollama serve` 子进程，不修改父环境或用户的系统环境。
- 启动 shell 显式设置的正整数保留；本地启动器允许并行数与模型数各 1–16、等待队列 1–512。值 0、负数、小数及其他非法值会在 spawn 前报错。这些是本项目启动器的支持范围，不是 Ollama 的通用取值上限。
- 并行数或模型数大于 1 时明确提示“此服务不再是单执行槽”。`.env.container` 不参与这个独立服务的环境合并。

Windows 托盘版通常早于 `pnpm dev` 启动。按[官方环境配置说明](https://docs.ollama.com/faq#setting-environment-variables-on-windows)，先在计划好的维护窗口退出 Ollama，配置用户环境变量，再重新打开 Ollama。以下 PowerShell 示例是未完成专门测量的机器采用的保守默认；本机经过验证的最终 `1 / 2 / 16` 见执行记录，不能直接用此示例覆盖：

```powershell
[Environment]::SetEnvironmentVariable('OLLAMA_NUM_PARALLEL', '1', 'User')
[Environment]::SetEnvironmentVariable('OLLAMA_MAX_LOADED_MODELS', '1', 'User')
[Environment]::SetEnvironmentVariable('OLLAMA_MAX_QUEUE', '16', 'User')
```

这些命令仅供运维执行；启动器不会替用户修改注册表或退出托盘进程。重启前确认原 daemon 及其 runner 子进程已退出。随后从新启动的 Ollama 进程日志核验配置，不能以当前 PowerShell 的 `$env:` 值代替服务进程证据。

## Linux 宿主服务

仓库模板位于 [`deploy/ollama/capacity.conf`](../../deploy/ollama/capacity.conf)，适用于已有 `ollama.service`。在推理宿主的维护窗口部署：

```sh
sudo install -d /etc/systemd/system/ollama.service.d
sudo install -m 0644 deploy/ollama/capacity.conf /etc/systemd/system/ollama.service.d/capacity.conf
sudo systemctl daemon-reload
sudo systemctl restart ollama.service
```

模板设置 `KillMode=control-group`，让服务替换时连同旧 runner 结束，避免只杀父进程后留下占用 GPU 的子进程。部署前保存已有同名 drop-in；部署后检查 `systemctl cat ollama.service`、新服务的启动日志和 runner 状态。系统中的其他 drop-in 或服务启动脚本可能覆盖环境，文件存在不等于运行配置已生效。回滚时恢复原 drop-in，在维护窗口 reload/restart，并再次核验实际服务配置。

现有 Compose 使用宿主服务，仓库不自动再启动第二个 GPU 容器。如果另行运维容器化 Ollama，应把这三个值配置在 Ollama 容器并保证单实例，所有 app/worker 指向它。不要把它们仅配置到应用容器。

## 故障、取消与公平性边界

应用取消、应用崩溃、数据库连接中断，都不能证明 GPU 已结束执行。这里不新增 Postgres semaphore 或 TTL 容量租约：锁断开或租约过期可能早于推理结束，自动释放会让另一个进程过早进入。已有任务租约仍用于任务归属及幂等，不承担 GPU 占用证明。

客户端不合作或断开后，实际执行槽仍由同一个 Ollama/runner 调度；不会由于某个应用进程的租约超时而新增物理执行槽。推理服务本身重启时，必须先确认旧 runner 全部结束，再启动替代实例。若无法确认，停止接收新推理，检查进程及 GPU 占用，不能把等待固定 TTL 当成清理成功。

进程内队列继续限制长度和等待时间，排队取消会移除尚未发送的请求，interactive/background 按已有策略分配机会。请求发送到服务后，本地取消不代表远端已完成；服务端的实际运行状态仍是容量依据。原生调度不提供跨进程的租户配额、全局优先级或严格总等待人数上限。

如果后续确实需要全局公平队列，再部署一个所有客户端必经的 HTTP 网关：复用当前有界队列和取消处理，在网关统一调度，Ollama 原生容量继续兜底；通过网络配置禁止绕过。网关重启不能靠 TTL 判断旧任务结束。当前没有引入这个额外服务或 Redis。

## 验证与验收

仓库内回归只使用注入的 spawn/readiness 依赖，不启动真实模型：

```sh
node --test scripts/start-local-dev.test.mjs
```

它覆盖新进程默认值、显式覆盖、非法值拒绝、父环境不变、已运行进程不被重复启动和探活使用版本端点。它不能证明宿主配置已生效或性能已经改善。

完成服务配置后，再在专用环境做真实验收：

1. 从新的服务启动日志确认三个值；记录 Ollama 版本、模型 digest、GPU/显存、实际 `num_ctx`，确认没有第二个 daemon 或遗留 runner。
2. 两个独立 Node 进程同时提交短生成/embedding 请求，观察同模型并发和跨模型切换；客户端并发不应突破服务端设置的执行槽。
3. 覆盖排队取消、流响应中断和客户端进程退出；另一个请求的启动必须受仍存活的 runner 调度约束。
4. 观察过载是否快速返回、错误是否保留 503、客户端取消是否撤销等待，并分别记录排队、模型加载、首 token、总耗时。额外验证 background 请求是否被持续 interactive 流量饿死；原生配置本身不保证跨进程公平。
5. 比较同一模型和输入的冷/热请求及并发 P50/P95；若单模型配置导致频繁冷热切换，先评估专用 embedding 服务或已测量的更高容量，不直接扩大所有并行参数。

## 第四批本机执行记录（2026-11-06）

第三批仅做只读运行检查和启动契约测试；第四批在用户明确回复“允许短暂中断并重启 Ollama”后，实际配置并重启了本机 Windows Ollama，先测 `1 / 1 / 16`，最终验证并采用 `1 / 2 / 16`。这些动作不由 `pnpm dev` 自动执行，也未部署 Linux systemd 模板或修改项目的真实环境文件。

### 第一次保守基线：`1 / 1 / 16`

| 项目 | 已核验事实 |
| --- | --- |
| 变更前环境 | 三个变量在 User、Machine 及操作进程的 Process 作用域均未设置；旧 daemon 日志有效值为 `1 / 0 / 512` |
| 备份 | 本机 `.codex-tmp/ollama-capacity-backup-20261106T040938139.json` 保存原始值，属于本次本地操作记录 |
| 当时设置 | User 作用域依次设为 `OLLAMA_NUM_PARALLEL=1`、`OLLAMA_MAX_LOADED_MODELS=1`、`OLLAMA_MAX_QUEUE=16`；该次启动进程显式继承相同配置 |
| 该次服务证据 | 托盘 PID 32044、daemon PID 32460；`server.log` 的 `2026-11-06T12:10:49.535+08:00` 启动记录确认三项为 `1 / 1 / 16`；负载验收前备份中记录的旧进程残留为 0。它们不是最终进程 |
| 可用性 | 新服务 `/api/version` 返回 200，版本 `0.40.14` |
| 正常请求验证 | 两组共四个独立 Node 子进程请求全部 HTTP 200、exit 0；覆盖同模型并发与生成/embedding 混合请求 |
| 真实 RAG 基线 | `llama3.1` + `qwen3-embedding:latest` 在 `0.40.14` 下单次问答 200，首正文 71438 ms、总耗时 71865 ms；后补 `0.40.15` 同问题总耗时 96318 ms。两次均 5 条证据及 available 引用，非严格 A/B |
| 尚待验收 | 排队取消、客户端故障、过载、公平性及正式 RAG 冷/热和并发延迟；配置生效不等于性能已改善 |

电脑控制工具因 Windows sandbox 的 `helper_unknown_error` 未能启动，实际采用原生进程管理。在操作前核对可执行文件路径、父子进程树与 11434 监听归属；首次 guard 发现 conhost 后停止且未动服务。随后确认它属于原 Ollama 进程树，停止时遇到子进程已自行退出的竞态，再从备份恢复流程继续，核验剩余旧进程和端口后完成启动。该记录不是通用的强制结束进程操作范例。

如需撤销本轮全部容量变更，在另一个维护窗口按最初备份恢复三个 User 值；本轮开始前原值均为空，即移除这三项用户变量。退出当前 daemon 及其 runner 后，从恢复后的环境重新启动，并核验新的服务日志。还应清除操作 shell 中为本次启动显式设置的三个 Process 值，避免其覆盖恢复后的 User 配置。原有效值 `1 / 0 / 512` 是变更前快照，最终以恢复后的服务日志为准。只回退双驻留时应使用后续试验备份恢复 `1 / 1 / 16`，不要混淆这两种回退目标。

本机 `.codex-tmp/latency-capacity-results.json` 记录了以下两组请求，执行时间为本机 2026-11-06 12:41:09–12:41:20。每组由两个独立 Node 进程同时发送，四个子进程全部 exit 0，无超时、失败或取消：

| 请求 | 首个正文 | 客户端总耗时 | provider 加载 | 结果 |
| --- | ---: | ---: | ---: | --- |
| 同模型 `qwen2.5:0.5b` A | 4186 ms | 4288 ms | 4038 ms | 200，64 tokens，`length` |
| 同模型 `qwen2.5:0.5b` B | 4293 ms | 4383 ms | 4038 ms | 200，64 tokens，`length` |
| 跨模型 `qwen2.5:0.5b` 生成 | 5543 ms | 5637 ms | 5447 ms | 200，64 tokens，`length` |
| 跨模型 `nomic-embed-text` embedding | 不适用 | 3813 ms | 3678 ms | 200，768 维 |

三个生成请求都以 64 tokens 限制负载并以 `length` 结束，是直接 provider 的容量 smoke，不是应用完整答案验收。22 次 `/api/ps` 采样全部成功，最多观察一个模型，但只捕捉到 qwen 驻留。该抽样和客户端完成顺序不能证明任意时刻只有一个模型或物理 GPU 严格单并发；`MAX_QUEUE=16` 也不是全部 HTTP 请求的总上限。两个跨模型样本都包含明显模型加载成本，不能当作配置改善前后的对照或真实 RAG P95。截至第四批，取消、故障、过载及公平性尚未做真实验证；第五批的取消、客户端退出及突发恢复结果见下文，外部开发请求未隔离的测量边界仍保留。代码、测试与真实请求证据汇总见[实施记录](../reports/2026-11-05-request-ai-latency-implementation.md)。

单模型驻留下的真实 RAG 样本还记录到约 29.10 秒 embedding 加载和 32.60 秒 llama 加载。本机模型盘为 WDC WD20EZAZ HDD，GPU 为 RTX 5070 Ti、16303 MiB。`MAX_LOADED_MODELS=1` 提供保守加载上限，但需要在这两个大模型之间切换，不能将它表述为已降低问答延迟。因此继续验证下述双模型驻留配置；本轮没有移动模型文件。

### 最终本机配置：`1 / 2 / 16`

前两次尝试分别受托盘自动升级、升级后 GUI 进程身份/退出保护影响，均未执行模型预热；它们不构成显存不足或双驻留失败证据。Ollama 自动更新至 `0.40.15` 后先恢复并验证 `1 / 1 / 16`，补采同版本 RAG 基线，再对固定路径、Microsoft 有效签名且属于 Ollama 后代的 WebView 做精确兼容，继续保留 runner 退出、端口释放、身份、版本和回退校验。

最终有界试验成功，未触发自动回退。事务及备份位于本机前缀 `.codex-tmp/latency-residency-20261106T053413491`；最终事务报告为同前缀的 `-report.json`，预热记录为 `.codex-tmp/latency-residency-warm-results.json`。

| 项目 | 最终已核验状态 |
| --- | --- |
| 当前容量与版本 | `OLLAMA_NUM_PARALLEL=1`、`OLLAMA_MAX_LOADED_MODELS=2`、`OLLAMA_MAX_QUEUE=16`；试验前后均为 `0.40.15` |
| 当前进程与日志 | 托盘 PID 22676 → daemon PID 34088；`2026-11-06T13:34:38.147+08:00` 启动记录确认 `1 / 2 / 16` |
| 预热时间与请求 | 本机 13:34:40–13:35:39；`keep_alive=15m`；embedding 空输入 200、26815 ms，llama 空生成 200、30663 ms、终态 `load` |
| 预热 timing 边界 | 两接口未返回 provider timing；上述为客户端耗时，预热记录未采集 `expires_at`，收尾实测另见下文 |
| `llama3.1` 驻留 | `size=size_vram=5951214059 B`，实测 context 8192，日志 GPU 层 33/33 |
| `qwen3-embedding:latest` 驻留 | `size=size_vram=6348645334 B`，实测 context 8192，日志 GPU 层 37/37 |
| GPU 与采样 | total 16303、reserved 396、used 14327、free 1581 MiB；57 次采样无错误，最低 free 1581 MiB，未观察到 OOM |

本机 User 作用域已持久化 `1 / 2 / 16`，但已打开的 Windows 终端或 Codex 父进程可能仍持有旧环境。以后从这些进程重启服务时，应重新打开终端或显式把 `1 / 2 / 16` 传给新 daemon，并核验其新启动日志。通用启动器和部署模板仍使用保守的 `1 / 1 / 16`，不能把旧进程环境或默认值误认为本机最终配置；本轮未修改 `.env.local`。

`/api/ps` 与加载日志共同支持两模型完整 GPU 驻留。显存余量仍有限，不能从本次结果推导更长上下文、更多模型或更高并发也适用。`NUM_PARALLEL=1` 是每模型上限，当前双驻留不保证全局 GPU 单并发；进程内队列也不会自动变成跨进程公平队列。

### 最终配置的真实 RAG 延迟与质量边界

在上述模型预热后，本机时间 13:36:45.026–13:37:04.280，对既有开发 HTTP 服务执行 20 个顺序请求及一组 2 请求并发，22 个请求均 HTTP 200，每条取得 5 条证据，运行 exit 0。6 个检查点确认 Ollama 版本一致且两个模型仍在场；外部负载未隔离。证据为本机 `.codex-tmp/latency-rag-residency-results.json`。

| 样本 | 首个答案正文 | 客户端总耗时 |
| --- | --- | --- |
| 20 个顺序热请求，最近秩分位数 | P50 470 ms；P95 539 ms | P50 846 ms；P95 1565 ms |
| 一组 2 并发请求，单独观测值 | 498、883 ms | 994、1060 ms |

两条并发请求不构成并发 P95。全部 22 条请求的服务端预热 P50/P95 为 2.8/4.6 ms，范围 0.5–27.6 ms；检索为 173.3/257.1 ms、embedding 为 20.6/28.6 ms、生成为 555.3/1045 ms。阶段存在嵌套，不能相加为客户端总耗时。

29/29 个源文档派生字面检查匹配，但并非人工审核 gold；引用状态为 **9 个 `available`、13 个 `missing`**，其中顺序样本为 8/12、并发样本为 1/1。9 个 `available` 样本含 1 个并发请求，最大首正文 925 ms、最大总耗时 1727 ms，不另报这个混合小组的 P95。这组结果支持本机保留双模型驻留，未证明完整引用质量、生产负载 SLO、更多问题类型或更长输出的性能。截至第四批，正式冷启动、取消、故障、过载与公平性也未完成验收；第五批的取消、客户端退出及突发恢复另列下文。重启、模型过期或被其他模型挤出后仍可能重新从 HDD 加载，第四批未迁移模型文件，不能把热请求数据当成冷启动结果。

只读代码核对确认，legacy `missing` 表示最终答案没有解析器可识别的编号引用；解析器只认正文 ASCII `[n]` / `[n,m]`，忽略代码、链接和转义内容，不等同于文本完全没有类似标记。第四批当时 `ChatMessage` 没有 `missing` 专用提示，第五批已新增；可追溯引用覆盖不足仍应单列，不能称为质量通过，也未排除所有回归。

第四批提出的 HDD 冷加载后续步骤为保留旧库、准备 SSD 副本并核验身份，再切换目录。第五批确认此机 GUI 模型路径优先于 `OLLAMA_MODELS`，不能仅修改 User 环境变量完成切换，具体更新见下文。双驻留仍不能消除服务重启、15 分钟驻留期到期或模型被挤出后的冷启动。

13:43:11+08 的最终只读检查保存于 `.codex-tmp/latency-residency-final-check.json`：版本仍为 `0.40.15`，User 与启动日志容量均为 `1 / 2 / 16`，两个模型仍完整驻留 GPU、context 均 8192，runner PID 28272/19328 与预热时一致。覆盖真实 RAG 窗口的追加日志中模型重载标记为 0、OOM 为 0；GPU total 16303、reserved 396、used 14347、free 1561 MiB。本次实际读取的 `expires_at` 为 llama 约 13:52:04+08、embedding 约 13:52:03+08；这是当时的有限驻留窗口，正常过期卸载不等于配置失效，也不能称为永久常驻。本轮容量/驻留/RAG 辅助脚本活跃数为 0，正常 app PID 22676 和 daemon PID 34088 保留。

## 第五批：按需预热、迁移约束与异常验收

`/api/model-warmup` 现只预热所选 embedding 和 LLM，去掉默认第三个 classifier，避免额外模型挤占双驻留。隐藏页面不发起初次或每 5 分钟的新预热；回到前台的可见性/focus 事件合并，隐藏不取消已有共享 job，Retry/换选择/卸载隔离旧响应。GET `ready` 只是历史预热 job 已完成，不能代替当前 `/api/ps` 驻留证据。真实端点 202 → ready 耗时 36.664 秒，最终所选两个模型均为 context 8192、完整 GPU 驻留。

v11 引用契约和缺失提示已落实，但温度仍为 0.7，不自动补引用或增加 LLM 重试。相同 3 个问题的新一轮 20 顺序 + 2 并发全部 HTTP 200，字面检查 29/29；顺序首正文 P50/P95 为 518/2882 ms、总耗时为 1112/3591 ms，两并发首正文 535/762 ms、总耗时 689/1193 ms。引用 **13 条 available、9 条 missing，7 个 ISBN 样本全部 missing**；首个样本接收确认含 4614 ms 开发编译等待。这不是受控 A/B、生产 SLO 或完整质量验收。完整 349 项延迟回归为 348 通过、1 真实集成跳过，完整生产构建通过；详情见[第五批实施记录](../reports/2026-11-05-request-ai-latency-implementation.md#第五批引用提示按需预热与冷启动准备)。

### 已撤回的 C 盘副本与非 C 盘约束

本轮曾从 `E:\project\ai\models` 向独立目录 `C:\Users\Administrator\.ollama\models-ssd-20261106` 创建副本。本机 15:02:23–15:11:29 完成 65 个文件、73806023717 B（约 68.74 GiB）的复制，65/65 通过 SHA-256 重读校验；源与目标均为 16 个 manifest、58 个 descriptor 的完整依赖闭包，源清单未变化。报告 `.codex-tmp/latency-fifth-model-copy-results.json` 为 `copy-verified-not-activated`，`serviceChanged=false`、`originalStorePreserved=true`。

**用户随后要求相关数据不得放 C 盘，该副本方案已撤回，临时副本已删除。** 原 E: 运行库从未切换，不再要求用户选择 C 盘目录。本机 15:20:46.074–15:20:46.304 仅删除本轮创建的上述固定目录，exit 0、目标不再存在；删除前后 E: 原库仍为 65 个文件、73806023717 B，size/mtime 未变，其他 C 盘目录未改，`serviceChanged=false`。证据 `.codex-tmp/latency-fifth-model-copy-rollback.json` 的状态为 `created-copy-removed-original-preserved`；SSD 从未生效，冷启动收益未验证。

磁盘清点确认 `GIGABYTE AG470E1TB` NVMe 仅有 C:；E: 和 F: 均位于同一块 `WDC WD20EZAZ` SATA HDD，没有可用非 C 盘 SSD。继续使用 `E:\project\ai\models`，迁到 F: 不能获得 SSD 读取收益，当前没有待执行的目录切换；待用户提供非 C 盘 SSD 后再评估迁移。

本机路径由 GUI `db.models` 设置提供。`0.40.15` 的 store 仅在该值为空时读取 `OLLAMA_MODELS`，托盘启动 daemon 时又以非空且可访问的 GUI 路径覆盖同名环境变量；直接修改 User 变量不足以迁移本机。参见[设置读取逻辑](https://github.com/ollama/ollama/blob/v0.40.15/app/store/store.go#L374)和[daemon 环境合并逻辑](https://github.com/ollama/ollama/blob/v0.40.15/app/server/server.go#L240)。

若以后准备了符合用户要求的非 C 盘目标，完成副本和 digest 校验后，受支持的切换入口是 **Settings → Model location → Browse**；该设置变更会重启 daemon，但不会自动搬运模型文件。参见[目录选择界面](https://github.com/ollama/ollama/blob/v0.40.15/app/ui/app/src/components/Settings.tsx#L664)及[设置变更处理](https://github.com/ollama/ollama/blob/v0.40.15/app/ui/ui.go#L1601)。本轮桌面工具仍因 `helper_unknown_error` 无法初始化，设置 API 无会话 cookie 返回 403；没有读取 cookie/token 或直接修改私有 SQLite。当前不执行 C 盘切换；非 C 盘方案如继续实施，再核验界面选择后的 daemon 实际路径、版本、容量、模型 digest、冷加载与 RAG 响应。

### 有界异常场景验收

本机 14:59:39.907–14:59:55.544 共执行 25 次有界请求，覆盖客户端取消、结束本轮所属客户端子进程、20 请求突发三组。取消在首正文后发生，得到 `AbortError`、没有观察到业务终态；所属子进程已 close，退出信号为 `SIGKILL`。三组恢复请求均成功，首正文分别 617/299/310 ms、总耗时 985/1123/1199 ms。

20 并发全部 settled：17 个成功、3 个 SSE 终态过载拒绝，均为 `PROVIDER_QUEUE_FULL`。三个拒绝的 raw HTTP 为 200，SSE 业务状态为 503，总耗时 742/718/706 ms，成功请求最长 10591 ms；这验证应用准入背压，不能表述为三个 HTTP 503 或 Ollama 原生队列上限已测。报告 `executionCompletedSafely`、`allRequestedCoverage` 均为 true，主进程 exit 0；15:02:30 的独立进程检查确认本轮故障辅助进程残留为 0。

证据为 `.codex-tmp/latency-fifth-fault-results.json` 与 `.codex-tmp/latency-fifth-fault-final-check.json`。此次未另采终末 GPU/驻留状态，恢复成功不证明客户端退出瞬间远端 GPU 已停止；全局 GPU 并行、公平性、服务端故障和生产 SLO 仍未验证。

15:20:04+08 的独立只读检查记录于 `.codex-tmp/latency-fifth-e-store-check.json`：版本仍为 `0.40.15`，E: 库两目标模型 digest 匹配，`/api/ps` 在 15 分钟闲置驻留期到期后为空。没有为这次检查另发推理或预热；容量 `1 / 2 / 16` 未变，但双驻留能力不等于此刻或永久 GPU 常驻，下一次冷请求仍可能从 HDD 加载。
