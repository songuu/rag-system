/**
 * 将博客文章同步到 Notion
 * 需配置环境变量: NOTION_TOKEN, NOTION_PARENT_PAGE_ID
 *
 * 使用方式:
 *   NOTION_TOKEN=xxx NOTION_PARENT_PAGE_ID=xxx node scripts/sync-to-notion.mjs
 *   或配置 .env.local 后执行 pnpm run sync:notion
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Client } from '@notionhq/client';
import { markdownToBlocks } from '@tryfabric/martian';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.join(__dirname, '..');

// 加载 .env.local（若存在）
const envPath = path.join(ROOT_DIR, '.env.local');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf-8').split(/\r?\n/)) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) {
      const key = m[1].trim();
      if (!process.env[key]) {
        process.env[key] = m[2].trim().replace(/^["']|["']$/g, '');
      }
    }
  }
}

const NOTION_BLOCK_LIMIT = 100; // Notion API 单次请求最多 100 个 block

// 与 generate-articles 共享的文章配置
const ARTICLE_CONFIG = {
  ADAPTIVE_ENTITY_RAG_GUIDE: { category: 'RAG 架构', icon: '🛤️' },
  AGENTIC_RAG_GUIDE: { category: 'RAG 架构', icon: '🤖' },
  CONTEXT_MANAGEMENT_GUIDE: { category: '系统能力', icon: '📚' },
  CONVERSATION_EXPANSION_GUIDE: { category: '系统能力', icon: '💬' },
  DOMAIN_VECTORS_GUIDE: { category: '向量技术', icon: '🎯' },
  ENV_CONFIG_GUIDE: { category: '配置部署', icon: '⚙️' },
  INTENT_DISTILLATION_GUIDE: { category: '系统能力', icon: '🧠' },
  MILVUS_CONFIG_GUIDE: { category: '配置部署', icon: '🗄️' },
  MILVUS_INTEGRATION_GUIDE: { category: '向量技术', icon: '🔗' },
  MODEL_SWITCHING_IN_SYSTEMINFO_GUIDE: { category: '配置部署', icon: '🔄' },
  NEXTJS_RAG_SYSTEM: { category: '系统概览', icon: '🚀' },
  OLLAMA_MODEL_MANAGEMENT_GUIDE: { category: '配置部署', icon: '🦙' },
  QUERY_EXPANSION_GUIDE: { category: '系统能力', icon: '🔍' },
  REASONING_RAG_GUIDE: { category: 'RAG 架构', icon: '🧩' },
  SELF_CORRECTIVE_RAG_GUIDE: { category: 'RAG 架构', icon: '🔄' },
  SELF_RAG_GUIDE: { category: 'RAG 架构', icon: '🪞' },
  TRACE_TRIE_SYSTEM: { category: '系统能力', icon: '🌲' },
};

function extractTitle(content) {
  const match = content.match(/^#\s+(.+)$/m);
  return match ? match[1].replace(/[🎯🚀📊🧠💬🔍🤖🕸️🛤️📚⚙️🗄️🔗🔄🦙🧩🪞🌲✨]/g, '').trim() : '未命名文章';
}

function slugFromFileName(fileName) {
  return fileName.replace('.md', '').toLowerCase().replace(/_/g, '-');
}

function ensureBlockObject(block) {
  if (block.object !== 'block') {
    return { ...block, object: 'block' };
  }
  return block;
}

function chunkBlocks(blocks, size = NOTION_BLOCK_LIMIT) {
  const result = [];
  for (let i = 0; i < blocks.length; i += size) {
    result.push(blocks.slice(i, i + size));
  }
  return result;
}

async function syncArticle(notion, parentId, article) {
  const { title, content, slug, category, icon } = article;
  const displayTitle = `${icon} ${title}`;

  let blocks;
  try {
    blocks = markdownToBlocks(content, {
      notionLimits: { truncate: true },
      enableEmojiCallouts: true,
    });
  } catch (err) {
    console.error(`  ⚠️ [${ slug }] Markdown 解析失败:`, err.message);
    return null;
  }

  blocks = blocks.map(ensureBlockObject);
  const chunks = chunkBlocks(blocks);

  try {
    const firstChunk = chunks[0] || [];
    const page = await notion.pages.create({
      parent: { page_id: parentId },
      properties: {
        title: {
          title: [{ text: { content: displayTitle } }],
        },
      },
      children: firstChunk,
    });

    for (let i = 1; i < chunks.length; i++) {
      await notion.blocks.children.append({
        block_id: page.id,
        children: chunks[i],
      });
    }

    return page.id;
  } catch (err) {
    console.error(`  ❌ [${ slug }] 创建失败:`, err.message);
    if (err.body) {
      try {
        const body = typeof err.body === 'string' ? JSON.parse(err.body) : err.body;
        if (body.message) console.error('    ', body.message);
      } catch (_) {}
    }
    return null;
  }
}

// 从 Notion URL 或配置中提取有效的 page_id（32 位 hex，可选含 -）
function normalizePageId(id) {
  if (!id || typeof id !== 'string') return null;
  const s = id.trim();
  // 匹配末尾的 32 位 hex（如 rag-30575ad6422580409f56cf86fd99ff98 → 30575ad6422580409f56cf86fd99ff98）
  const m = s.match(/([a-fA-F0-9]{32})$/);
  if (m) return m[1];
  // 若已是 32 位 hex，直接返回
  if (/^[a-fA-F0-9-]{32,36}$/.test(s.replace(/-/g, ''))) return s.replace(/-/g, '');
  return s;
}

async function main() {
  const token = process.env.NOTION_TOKEN;
  let parentId = process.env.NOTION_PARENT_PAGE_ID;

  if (!token || !parentId) {
    console.log('⏭️ 跳过 Notion 同步: 未配置 NOTION_TOKEN 或 NOTION_PARENT_PAGE_ID');
    return;
  }

  // parentId = normalizePageId(parentId);
  if (!parentId) {
    console.error('❌ NOTION_PARENT_PAGE_ID 格式无效，应为 32 位十六进制（可从页面 URL 末尾复制）');
    process.exit(1);
  }

  const notion = new Client({ auth: token });

  const articlesPath = path.join(ROOT_DIR, 'public', 'articles-data.json');
  if (!fs.existsSync(articlesPath)) {
    console.error('❌ 未找到 public/articles-data.json，请先运行: node scripts/generate-articles.mjs');
    process.exit(1);
  }

  const articles = JSON.parse(fs.readFileSync(articlesPath, 'utf-8'));
  console.log(`📤 开始同步 ${ articles.length } ${parentId} 篇文章到 Notion...`);

  let ok = 0;
  let fail = 0;
  for (const a of articles) {
    const id = await syncArticle(notion, parentId, a);
    if (id) {
      ok++;
      console.log(`  ✅ [${ a.slug }] ${ a.icon } ${ a.title }`);
    } else {
      fail++;
    }
  }

  console.log(`\n📊 同步完成: 成功 ${ ok }，失败 ${ fail }`);
}

main().catch((err) => {
  console.error('❌ 同步失败:', err.message);
  process.exit(1);
});
