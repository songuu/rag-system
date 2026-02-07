# Trace-Trie 全路径监测系统

## 概述

Trace-Trie 全路径监测系统是一个用于分析和可视化 BPE（Byte-Pair Encoding）分词过程的工具。它将传统的"黑盒"分词过程改造为"透明"决策，提供完整的决策路径追踪和可视化。

## 核心功能

### 1. 增强型 Trie 树结构

- **节点属性**：每个节点包含 `TokenID`、`MergeRank`（合并优先级）、以及词元在语料库中的出现频率
- **Trace 锚点**：在 Trie 树的每个"分叉路口"和"终止点"记录当前状态
- **决策追踪**：记录为什么选择 A+B 而不是 B+C，包括 Rank 差异和匹配长度

### 2. 逻辑瀑布流（Logic Waterfall）

展示从 **Raw Bytes → Characters → Subwords → Full Words** 的完整塌缩过程：

- **输入捕获**：文本进入后，启动"观察者"记录分词指针的跳跃
- **决策下沉**：展示每一层的合并过程
- **竞争机制**：展示多种合并可能，并说明为什么某个选择被选中

### 3. 向量加权可视化

- **权重提取**：从模型的 `word_embeddings` 权重矩阵中提取向量
- **模长分析**：计算每个 Token 对应向量的 L2 范数
- **语义独特性**：模长越大，代表该词元在空间中的位置越偏离原点，具有更强的语义独特性

### 4. 词元密度热力图

- **密度公式**：`密度 = tokenLength / byteLength`
- **高密度区（深色）**：一个 Token 代表了多个字节，模型在该领域的知识压缩率极高
- **低密度区（浅色）**：一个字符被拆成了多个字节 Token，模型在该语言/领域存在"知识盲区"

### 5. 多模型对比（A/B Test）

支持对比多个模型的分词效果：

- **碎片化率**：文本长度 / Token 数量
- **语义对齐度**：向量权重的方差分布
- **OOV 鲁棒性**：Byte-fallback 发生的频率

### 6. 交互式可视化

- **瀑布流视图**：展示文本被逐层剥离、合并的动态过程
- **热力对比带**：并排展示多个模型的分词结果
- **分布象限图**：横轴为 Token 频率，纵轴为向量权重

## 使用方法

### 访问系统

1. 启动 Next.js 开发服务器：
   ```bash
   npm run dev
   ```

2. 访问 Trace-Trie 分析页面：
   ```
   http://localhost:3000/trace-trie
   ```

### 基本操作

1. **输入文本**：在文本框中输入要分析的文本（支持中英文）
2. **选择模型**：选择一个或多个模型进行对比分析
3. **开始分析**：点击"开始分析"按钮
4. **查看结果**：
   - 顶层：瀑布流视图，展示分词过程
   - 中层：热力对比带，展示不同模型的分词结果
   - 底层：分布象限图，分析模型对高频词的权重分配

### 交互功能

- **切换阶段**：点击瀑布流视图中的阶段按钮（bytes、characters、subwords、fullwords）
- **点击 Token**：点击任意 Token 查看其在 Trie 树中的决策路径
- **查看合并操作**：在 subwords 阶段查看 BPE 合并操作
- **模型对比**：选择多个模型后，点击"显示对比"查看并排对比

## API 接口

### POST /api/trace-trie

分析文本的 Trace-Trie 分词过程。

**请求体：**
```json
{
  "text": "深入理解神经网络的工作原理",
  "modelNames": [
    "Xenova/bert-base-multilingual-cased",
    "Xenova/bge-small-zh-v1.5"
  ]
}
```

**响应：**
```json
{
  "success": true,
  "data": {
    "waterfall": {
      "input": "...",
      "stages": [...],
      "totalTime": 123
    },
    "vectorWeights": [...],
    "densityInfos": [...],
    "modelComparisons": [...],
    "trieStats": {
      "vocabSize": 119547,
      "nodeCount": 234567,
      "maxDepth": 45
    }
  }
}
```

## 技术架构

### 核心模块

1. **trace-trie.ts**：增强型 Trie 树和逻辑瀑布流生成器
2. **token-analyzer.ts**：向量加权分析、密度分析、多模型对比
3. **TraceTrieVisualization.tsx**：可视化组件
4. **trace-trie/page.tsx**：主页面

### 依赖

- `@xenova/transformers`：用于加载和使用 Transformer 模型
- `echarts-for-react`：用于图表可视化
- `next`：Next.js 框架

## 评估维度

### 分词效能评分卡

| 评估维度 | 观测点 | 意义 |
| --- | --- | --- |
| **碎片化率** | 文本长度 / Token 数量 | 评估模型上下文窗口的利用率 |
| **语义对齐度** | 向量权重的方差分布 | 权重分布越均匀，说明模型对各类词元一视同仁 |
| **OOV 鲁棒性** | Byte-fallback 发生的频率 | 检查模型在面对特殊符号或生僻字时的回退逻辑 |

## 示例场景

### 场景 1：分析中文专业术语

输入："深入理解神经网络的工作原理"

- **观察点**：查看"神经网络"是否被正确识别为一个完整的词元
- **分析**：检查密度热力图，看是否出现高密度区（深色）
- **对比**：对比 `bge-small-zh` 和 `all-MiniLM` 在处理中文时的差异

### 场景 2：分析混合语言文本

输入："I love 人工智能 and 机器学习"

- **观察点**：查看中英文混合时的分词策略
- **分析**：检查向量权重，看不同语言的词元是否有不同的权重分布
- **对比**：对比多语言模型和单语言模型的表现

## 注意事项

1. **模型加载**：首次使用某个模型时，需要下载模型文件，可能需要一些时间
2. **性能**：分析长文本时，处理时间可能较长
3. **内存**：加载多个模型进行对比时，会占用较多内存
4. **网络**：模型文件需要从 Hugging Face 下载，确保网络连接正常

## 未来改进

- [ ] 支持更多模型类型（GPT、T5 等）
- [ ] 添加实时分词过程动画
- [ ] 支持导出分析报告
- [ ] 添加更多可视化维度
- [ ] 支持批量文本分析

## 参考资料

- [BPE 算法原理](https://huggingface.co/docs/tokenizers/pipeline)
- [Transformer 模型架构](https://huggingface.co/docs/transformers)
- [@xenova/transformers 文档](https://huggingface.co/docs/transformers.js)
