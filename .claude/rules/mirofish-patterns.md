# MiroFish 模块开发规范

## 架构约定

- **服务层**：所有核心逻辑在 `src/lib/mirofish/` 中，每个服务一个文件
- **API 层**：薄包装层在 `src/app/api/mirofish/` 中，只做验证和调用服务
- **UI 层**：步骤组件在 `src/components/mirofish/Step*.tsx`，主页面在 `src/app/mirofish/`
- **类型定义**：统一在 `src/lib/mirofish/types.ts`，不在组件中重复定义
- **单例模式**：所有 Store/Runner/Agent 使用 `getXxx()` 函数返回单例

## API 安全规范

- PUT/POST 端点必须对请求体做字段白名单过滤
- 数值参数必须有上下限约束（如 round_count ≤ 30, profiles ≤ 50）
- Content-Disposition 中的 filename 必须正则消毒
- 异步任务（模拟启动）需要竞态防护（Set 锁）

## SSE 实现规范

- ReadableStream 必须实现 `cancel()` hook 清理 listener
- 同时注册 `_request.signal.abort` 作为备用清理
- 模拟结束事件后延迟 1s 关闭流，确保客户端收到最终事件

## 状态管理规范

- 不可变更新：修改 Map 中的对象时，必须 `map.set(key, { ...old, ...updates })`
- React 回调闭包中需要最新 state 时，直接传参而非读取 state
- `simulateInteractions` 只修改本轮新帖子，不修改已有帖子
