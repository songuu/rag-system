/**
 * 构建时生成文章数据 JSON 文件
 * 在 next build 之前运行，将 markdown 文件转换为可供前端使用的 JSON 数据
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.join(__dirname, '..');

// 文章配置
const ARTICLE_CONFIG = {
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

const EXCLUDED_FILES = ['README.md'];

function extractTitle(content) {
  const match = content.match(/^#\s+(.+)$/m);
  return match ? match[1].replace(/[🎯🚀📊🧠💬🔍🤖🕸️🛤️📚⚙️🗄️🔗🔄🦙🧩🪞🌲✨]/g, '').trim() : '未命名文章';
}

function estimateReadingTime(content) {
  const textOnly = content.replace(/```[\s\S]*?```/g, '').replace(/`[^`]+`/g, '');
  return Math.max(1, Math.ceil(textOnly.length / 400));
}

function fileNameToSlug(fileName) {
  return fileName.replace('.md', '').toLowerCase().replace(/_/g, '-');
}

// 主逻辑
const files = fs.readdirSync(ROOT_DIR).filter(
  (file) => file.endsWith('.md') && !EXCLUDED_FILES.includes(file) && ARTICLE_CONFIG[file]
);

const articles = files.map((fileName) => {
  const filePath = path.join(ROOT_DIR, fileName);
  const content = fs.readFileSync(filePath, 'utf-8');
  const config = ARTICLE_CONFIG[fileName] || { category: '其他', icon: '📄' };

  return {
    slug: fileNameToSlug(fileName),
    title: extractTitle(content),
    description: config.description,
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

// 输出到 public 目录
const publicDir = path.join(ROOT_DIR, 'public');
if (!fs.existsSync(publicDir)) {
  fs.mkdirSync(publicDir, { recursive: true });
}

const outputPath = path.join(publicDir, 'articles-data.json');
fs.writeFileSync(outputPath, JSON.stringify(articles, null, 2), 'utf-8');

console.log(`✅ Generated ${articles.length} articles → public/articles-data.json`);
articles.forEach((a) => {
  console.log(`  ${a.icon} [${a.category}] ${a.title} (${a.readingTime} min)`);
});
