import fs from 'fs';
import path from 'path';

export interface Article {
  slug: string;
  title: string;
  description: string;
  content: string;
  fileName: string;
  category: string;
  icon: string;
  readingTime: number;
}

// Markdown 文件到文章的映射配置
const ARTICLE_CONFIG: Record<string, { category: string; icon: string; description?: string }> = {
  'ADAPTIVE_ENTITY_RAG_GUIDE.md': {
    category: 'RAG 架构',
    icon: '🛤️',
    description: '基于 LangGraph 设计理念的自适应实体路由智能检索增强生成系统',
  },
  'AGENTIC_RAG_GUIDE.md': {
    category: 'RAG 架构',
    icon: '🤖',
    description: 'Agentic RAG 代理化工作流系统，实现智能查询分析与自省修正',
  },
  'CONTEXT_MANAGEMENT_GUIDE.md': {
    category: '系统能力',
    icon: '📚',
    description: '上下文管理系统指南，优化多轮对话中的上下文窗口管理',
  },
  'CONTEXTUAL_RETRIEVAL_GUIDE.md': {
    category: 'RAG 架构',
    icon: '🔮',
    description: '上下文检索增强系统，在 Embedding 前注入全文语境提升检索相关性',
  },
  'CONVERSATION_EXPANSION_GUIDE.md': {
    category: '系统能力',
    icon: '💬',
    description: '对话延伸引擎，基于锚点分析的智能推荐问题生成系统',
  },
  'DOMAIN_VECTORS_GUIDE.md': {
    category: '向量技术',
    icon: '🎯',
    description: '领域向量空间分析与可视化，理解文档的语义分布',
  },
  'ENV_CONFIG_GUIDE.md': {
    category: '配置部署',
    icon: '⚙️',
    description: '环境配置指南，涵盖所有系统环境变量与部署选项',
  },
  'INTENT_DISTILLATION_GUIDE.md': {
    category: '系统能力',
    icon: '🧠',
    description: '意图蒸馏系统，将模糊的用户查询转化为精准的检索意图',
  },
  'LANGCHAIN_LANGGRAPH_GUIDE.md': {
    category: '系统概览',
    icon: '🔗',
    description: 'LangChain 与 LangGraph 最新特性在本项目 RAG 架构中的融入指南',
  },
  'MILVUS_CONFIG_GUIDE.md': {
    category: '配置部署',
    icon: '🗄️',
    description: 'Milvus 向量数据库配置指南，生产环境部署方案',
  },
  'MILVUS_INTEGRATION_GUIDE.md': {
    category: '向量技术',
    icon: '🔗',
    description: 'Milvus 向量数据库集成指南，实现高性能向量检索',
  },
  'MODEL_SWITCHING_IN_SYSTEMINFO_GUIDE.md': {
    category: '配置部署',
    icon: '🔄',
    description: '模型热切换系统，支持在运行时动态更换 LLM 和嵌入模型',
  },
  'NEXTJS_RAG_SYSTEM.md': {
    category: '系统概览',
    icon: '🚀',
    description: 'Next.js 版本的智能 RAG 系统完整技术文档与架构说明',
  },
  'OLLAMA_MODEL_MANAGEMENT_GUIDE.md': {
    category: '配置部署',
    icon: '🦙',
    description: 'Ollama 模型管理指南，本地 LLM 的安装、配置与优化',
  },
  'QUERY_EXPANSION_GUIDE.md': {
    category: '系统能力',
    icon: '🔍',
    description: '查询扩展系统，通过多种策略提升检索召回率',
  },
  'REASONING_RAG_GUIDE.md': {
    category: 'RAG 架构',
    icon: '🧩',
    description: '推理增强 RAG 系统，结合链式思考提升复杂问题的回答质量',
  },
  'SELF_CORRECTIVE_RAG_GUIDE.md': {
    category: 'RAG 架构',
    icon: '🔄',
    description: '自省修正 RAG 系统，自动检测与纠正检索和生成中的错误',
  },
  'SELF_RAG_GUIDE.md': {
    category: 'RAG 架构',
    icon: '🪞',
    description: '自反思 RAG 系统，通过反思令牌实现智能检索决策',
  },
  'TRACE_TRIE_SYSTEM.md': {
    category: '系统能力',
    icon: '🌲',
    description: 'Trace-Trie 全路径监测系统，BPE 分词决策可视化与追踪',
  },
};

/**
 * 从 Markdown 内容中提取标题（第一个 # 标题）
 */
function extractTitle(content: string): string {
  const match = content.match(/^#\s+(.+)$/m);
  return match ? match[1].replace(/[🎯🚀📊🧠💬🔍🤖🕸️🛤️📚⚙️🗄️🔗🔄🦙🧩🪞🌲✨🔮]/g, '').trim() : '未命名文章';
}

/**
 * 从 Markdown 内容中提取描述（第一段非标题文本）
 */
function extractDescription(content: string): string {
  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('```') && !trimmed.startsWith('|') && !trimmed.startsWith('-') && !trimmed.startsWith('*')) {
      return trimmed.substring(0, 200);
    }
  }
  return '';
}

/**
 * 估算阅读时间（按中文每分钟 400 字计算）
 */
function estimateReadingTime(content: string): number {
  // 去除代码块
  const textOnly = content.replace(/```[\s\S]*?```/g, '').replace(/`[^`]+`/g, '');
  const charCount = textOnly.length;
  return Math.max(1, Math.ceil(charCount / 400));
}

/**
 * 文件名转 slug
 */
function fileNameToSlug(fileName: string): string {
  return fileName
    .replace('.md', '')
    .toLowerCase()
    .replace(/_/g, '-');
}

/**
 * 获取所有文章列表
 */
export function getAllArticles(): Article[] {
  const files = Object.keys(ARTICLE_CONFIG).filter((file) =>
    fs.existsSync(path.join(/*turbopackIgnore: true*/ process.cwd(), file))
  );

  const articles: Article[] = files.map((fileName) => {
    const filePath = path.join(/*turbopackIgnore: true*/ process.cwd(), fileName);
    const content = fs.readFileSync(filePath, 'utf-8');
    const config = ARTICLE_CONFIG[fileName] || { category: '其他', icon: '📄' };

    return {
      slug: fileNameToSlug(fileName),
      title: extractTitle(content),
      description: config.description || extractDescription(content),
      content,
      fileName,
      category: config.category,
      icon: config.icon,
      readingTime: estimateReadingTime(content),
    };
  });

  // 按分类排序
  const categoryOrder = ['系统概览', 'RAG 架构', '向量技术', '系统能力', '配置部署'];
  articles.sort((a, b) => {
    const aOrder = categoryOrder.indexOf(a.category);
    const bOrder = categoryOrder.indexOf(b.category);
    if (aOrder !== bOrder) return aOrder - bOrder;
    return a.title.localeCompare(b.title, 'zh-CN');
  });

  return articles;
}

/**
 * 根据 slug 获取单篇文章
 */
export function getArticleBySlug(slug: string): Article | null {
  const articles = getAllArticles();
  return articles.find((article) => article.slug === slug) || null;
}

/**
 * 获取所有文章的 slug（用于 generateStaticParams）
 */
export function getAllArticleSlugs(): string[] {
  return getAllArticles().map((article) => article.slug);
}

/**
 * 获取文章分类列表
 */
export function getCategories(): string[] {
  const articles = getAllArticles();
  return [...new Set(articles.map((a) => a.category))];
}
