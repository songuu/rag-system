# 系统信息中的模型切换功能

## 🎯 功能概述

模型切换功能现在集成在**系统信息**面板中，提供一个集中的、直观的界面来管理 LLM 和 Embedding 模型。

## 🎨 界面设计

### 系统信息面板

```
┌─────────────────────────────┐
│ 系统信息                    │
├─────────────────────────────┤
│ 文档数量: 27                │
│ 向量维度: 768               │
│ 系统状态: 运行中       ✅   │
│                             │
│ ─────────────────────       │
│ LLM 模型: llama3.1          │
│ 嵌入模型: nomic-embed       │
│                             │
│ [🔄 切换模型]               │
│ [🔄 重新初始化]             │
└─────────────────────────────┘
```

### 模型选择模态框

```
┌─────────────────────────────────────────┐
│ 选择模型                          ✕    │
├─────────────────────────────────────────┤
│                                         │
│ 🤖 LLM 模型 (3)                        │
│ ┌──────────┐ ┌──────────┐              │
│ │Llama 3.1 │ │Qwen 2.5  │  ...         │
│ │4.7GB  ✓  │ │4.4GB     │              │
│ └──────────┘ └──────────┘              │
│                                         │
│ 🧬 Embedding 模型 (2)                  │
│ ┌───────────┐ ┌───────────┐            │
│ │Nomic Embed│ │MxBAI Large│            │
│ │274 MB  ✓  │ │669 MB     │            │
│ └───────────┘ └───────────┘            │
│                                         │
├─────────────────────────────────────────┤
│ ⚠️ 应用后将重新初始化系统               │
│                     [取消] [应用更改]   │
└─────────────────────────────────────────┘
```

## 📝 使用步骤

### 步骤 1: 打开模型选择器

1. 在主页面右侧找到"系统信息"面板
2. 点击 **"切换模型"** 按钮
3. 模态框弹出，自动加载可用模型

### 步骤 2: 选择新模型

1. **LLM 模型选择**
   - 查看所有已安装的 LLM 模型
   - 点击想要使用的模型卡片
   - 当前选中的模型会显示 ✓ 标记

2. **Embedding 模型选择**
   - 查看所有已安装的 Embedding 模型
   - 点击想要使用的模型卡片
   - 当前选中的模型会显示 ✓ 标记

### 步骤 3: 应用更改

1. 确认选择后，点击 **"应用更改"** 按钮
2. 系统会显示提示: "正在切换模型..."
3. 系统状态变为: "重新初始化中..."
4. 等待初始化完成（通常 1-3 秒）
5. 显示成功提示: "模型切换成功: qwen2.5"

## 🔄 完整流程

```
用户点击"切换模型"
    ↓
加载可用模型列表 (从 /api/ollama/models)
    ↓
用户选择新的 LLM 和 Embedding 模型
    ↓
点击"应用更改"
    ↓
调用 handleModelChange(newLlmModel, newEmbeddingModel)
    ↓
更新状态: setLlmModel, setEmbeddingModel
    ↓
调用 /api/reinitialize (POST)
  Body: { llmModel, embeddingModel }
    ↓
后端重新初始化 RAG 系统
  - 清除旧实例
  - 创建新实例（使用新模型）
  - 重新加载所有文档
    ↓
返回成功
    ↓
更新 UI: "模型切换成功"
系统信息显示新模型
    ↓
后续对话使用新模型
```

## 🎨 状态提示

### Toast 通知

| 阶段 | 提示 | 类型 |
|------|------|------|
| 开始切换 | "正在切换模型..." | info |
| 切换成功 | "模型切换成功: qwen2.5" | success |
| 切换失败 | "模型切换时发生错误" | error |
| 未做更改 | "模型未做任何更改" | info |

### 系统状态

| 状态 | 颜色 | 说明 |
|------|------|------|
| 运行中 | 绿色 | 系统正常工作 |
| 重新初始化中... | 黄色 | 正在切换模型 |
| 错误 | 灰色 | 系统异常 |

## 💡 特性亮点

### 1. 集中管理
- ✅ 所有模型设置集中在系统信息面板
- ✅ 不分散在参数设置中
- ✅ 符合"系统配置"的语义

### 2. 自动检测
- ✅ 打开模态框时自动加载可用模型
- ✅ 实时读取 Ollama 安装的所有模型
- ✅ 智能分类 LLM vs Embedding

### 3. 视觉反馈
- ✅ 当前选中模型高亮显示
- ✅ 勾选标记 (✓) 指示
- ✅ 不同类型模型用不同颜色（紫色/蓝色）
- ✅ Toast 提示用户操作进度

### 4. 安全提示
- ✅ 底部显示警告: "⚠️ 应用后将重新初始化系统"
- ✅ 未做更改时禁用"应用更改"按钮
- ✅ 清晰的取消和应用按钮

### 5. 错误处理
- ✅ Ollama 离线时显示友好错误
- ✅ 无可用模型时显示提示
- ✅ 提供"重试"按钮

## 🔧 技术实现

### SystemInfo 组件增强

**新增 Props**:
```typescript
interface SystemInfoProps {
  llmModel: string;           // 当前 LLM 模型
  embeddingModel: string;     // 当前 Embedding 模型
  onModelChange: (llm: string, embedding: string) => void; // 模型变更回调
  // ... 其他 props
}
```

**新增 State**:
```typescript
const [showModelSelector, setShowModelSelector] = useState(false);  // 模态框显示
const [availableModels, setAvailableModels] = useState<any>(null);  // 可用模型
const [selectedLLM, setSelectedLLM] = useState(llmModel);           // 选中的 LLM
const [selectedEmbedding, setSelectedEmbedding] = useState(embeddingModel); // 选中的 Embedding
```

### 模型变更处理

**page.tsx**:
```typescript
const handleModelChange = async (newLlmModel: string, newEmbeddingModel: string) => {
  // 显示提示
  showToast('正在切换模型...', 'info');
  setSystemStatus('重新初始化中...');
  
  // 更新状态
  setLlmModel(newLlmModel);
  setEmbeddingModel(newEmbeddingModel);
  
  // 调用重新初始化 API（使用新模型）
  const response = await fetch('/api/reinitialize', { 
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      llmModel: newLlmModel,
      embeddingModel: newEmbeddingModel
    })
  });
  
  // 显示结果
  if (data.success) {
    showToast(`模型切换成功: ${newLlmModel.split(':')[0]}`, 'success');
  }
};
```

## 📊 数据流

```
SystemInfo 组件
    │
    ├─ "切换模型" 按钮点击
    │     ↓
    ├─ setShowModelSelector(true)
    │     ↓
    ├─ useEffect 触发
    │     ↓
    ├─ loadModels() → fetch('/api/ollama/models')
    │     ↓
    ├─ 显示模型列表
    │     ↓
    ├─ 用户选择模型
    │     ↓
    ├─ setSelectedLLM / setSelectedEmbedding
    │     ↓
    ├─ 点击"应用更改"
    │     ↓
    └─ onModelChange(selectedLLM, selectedEmbedding)
            ↓
    page.tsx handleModelChange
            ↓
    POST /api/reinitialize
            ↓
    后端重新初始化（使用新模型）
            ↓
    成功 → Toast 提示
```

## 🧪 测试场景

### 场景 1: 正常切换

1. 打开"切换模型"
2. 选择 `qwen2.5`
3. 选择 `mxbai-embed-large`
4. 点击"应用更改"
5. 看到 Toast: "正在切换模型..."
6. 系统状态: "重新初始化中..."
7. Toast: "模型切换成功: qwen2.5"
8. 系统信息更新显示新模型

### 场景 2: 未做更改

1. 打开"切换模型"
2. 不选择任何模型（保持当前）
3. "应用更改"按钮为禁用状态
4. 点击"取消"关闭

### 场景 3: Ollama 离线

1. 停止 Ollama 服务
2. 打开"切换模型"
3. 看到错误提示
4. 点击"重试"

### 场景 4: 无可用模型

1. 确保 Ollama 没有安装任何模型
2. 打开"切换模型"
3. 看到提示: "未检测到 LLM 模型，请先安装模型"

## 🎯 优势总结

| 优势 | 说明 |
|------|------|
| 🎨 **集中化** | 所有模型设置在一个地方 |
| 🔍 **可见性** | 系统信息清晰显示当前模型 |
| ⚡ **便捷性** | 一键打开，快速切换 |
| 🛡️ **安全性** | 明确提示会重新初始化 |
| 📊 **反馈** | 完整的状态提示和错误处理 |
| 🔄 **自动化** | 切换后自动重新初始化 |

## 📝 使用建议

1. **切换前确认**: 确保 Ollama 服务正在运行
2. **了解影响**: 切换模型会重新初始化系统
3. **选择合适模型**: 
   - 中文任务: qwen2.5
   - 英文任务: llama3.1
   - 大型文档: 大参数量模型
4. **验证切换**: 切换后提一个测试问题确认生效

---

**版本**: v1.0  
**最后更新**: 2026-01-14  
**状态**: ✅ 生产就绪
