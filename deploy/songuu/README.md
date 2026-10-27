# songuu RAG 网关访问策略

自 2026-10-11 起，共享 Deploy Console 登录仅用于 `/pipeline/` 及其部署控制接口。RAG 页面和浏览器 API 支持新设备直接访问，不再检查 `dm_session`。

- `/rag-system`、`/rag-system/`：公开页面，匿名访问返回 200。
- `/rag-api/`：公开的 RAG API 入口，Nginx 从服务器私有环境注入 `RAG_SINGLE_TENANT_TOKEN`；浏览器提交的 Authorization 会被替换。
- `/rag-api/health/live`：存活检查，匿名访问返回 200。
- `/rag-system/api/`：继续返回 404，禁止绕过专用 API 入口。
- Pipeline 的共享登录规则和控制 API 的认证保持原有保护。

`patch-nginx.py` 首次安装生成上述公开规则。已有完整 RAG location 的网关可通过 `apply-nginx.sh patch-nginx.py --public-access` 移除三个 RAG 代理中的已知共享登录规则；它拒绝重复 location 和未识别的共享登录规则，保留其他应用与 Pipeline 的配置。`apply-nginx.sh` 先备份、执行 `nginx -t` 再 reload，校验或 reload 失败会恢复准确备份。

`--refresh-token` 保持仅更新 `/rag-api/` 的单一 Authorization header，不修改访问策略；它与 `--public-access` 互斥，继续拒绝不完整 location、重复 header 和不安全 token。生产令牌保留在服务器环境和 Nginx 配置中。

`post-release-gate.sh` 对已有规则先迁移公开访问，再刷新私有 bearer。正式验收不带 Cookie，要求页面和 `/rag-api/health` 返回 200，原始 Next API 路由返回 404。发布前保存旧网关的页面/API访问状态；若发布回滚，恢复并验证准确配置快照后按原状态验收，首次安装没有旧 RAG 路由时验证其仍不存在。

定向回归：

```sh
python3 deploy/songuu/patch-nginx.test.py
node deploy/songuu/github-deploy-artifact.test.mjs
bash -n deploy/songuu/apply-nginx.sh
bash -n deploy/songuu/post-release-gate.sh
```

Python 测试在 Windows 从已安装 Git 的位置选择 Git Bash，也可通过 `RAG_TEST_BASH` 指定，不调用系统 WSL Bash。发布契约测试会执行这些 Python 回归，现有 `test:model-runtime` 包含该契约入口。
