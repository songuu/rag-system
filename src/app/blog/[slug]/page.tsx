import Link from 'next/link';
import type { Metadata } from 'next';
import { getAllArticles, getArticleBySlug, getAllArticleSlugs } from '@/lib/articles';
import MarkdownRenderer from '@/components/MarkdownRenderer';
import { ArticleTOCSidebar, ArticleTOCMobile } from '@/components/ArticleTOC';

// 分类颜色
const categoryColors: Record<string, { badge: string }> = {
  '系统概览': { badge: 'bg-blue-100 text-blue-800' },
  'RAG 架构': { badge: 'bg-purple-100 text-purple-800' },
  '向量技术': { badge: 'bg-emerald-100 text-emerald-800' },
  '系统能力': { badge: 'bg-amber-100 text-amber-800' },
  '配置部署': { badge: 'bg-rose-100 text-rose-800' },
};

// 静态参数生成（静态导出必须）
export function generateStaticParams() {
  return getAllArticleSlugs().map((slug) => ({ slug }));
}

// 动态生成元数据
export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const article = getArticleBySlug(slug);
  if (!article) {
    return { title: '文章未找到' };
  }
  return {
    title: `${article.title} - RAG 技术博客`,
    description: article.description,
  };
}

/**
 * 从 Markdown 内容中提取目录
 */
function extractTOC(content: string): { id: string; text: string; level: number }[] {
  const headings: { id: string; text: string; level: number }[] = [];
  const lines = content.split('\n');
  for (const line of lines) {
    const match = line.match(/^(#{2,4})\s+(.+)$/);
    if (match) {
      const level = match[1].length;
      const rawText = match[2];
      const text = rawText.replace(/[🎯🚀📊🧠💬🔍🤖🕸️🛤️📚⚙️🗄️🔗🔄🦙🧩🪞🌲✨]/g, '').replace(/\*\*/g, '').trim();
      const id = text
        .toLowerCase()
        .replace(/\s+/g, '-')
        .replace(/[^\w\u4e00-\u9fff-]/g, '');
      headings.push({ id, text, level });
    }
  }
  return headings;
}

export default async function ArticlePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const article = getArticleBySlug(slug);

  if (!article) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-center">
          <div className="text-6xl mb-4">📄</div>
          <h1 className="text-2xl font-bold text-gray-900 mb-2">文章未找到</h1>
          <p className="text-gray-500 mb-6">您访问的文章不存在或已被移除</p>
          <Link
            href="/blog"
            className="inline-flex items-center px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
          >
            ← 返回文章列表
          </Link>
        </div>
      </div>
    );
  }

  const allArticles = getAllArticles();
  const toc = extractTOC(article.content);
  const currentIndex = allArticles.findIndex((a) => a.slug === article.slug);
  const prevArticle = currentIndex > 0 ? allArticles[currentIndex - 1] : null;
  const nextArticle = currentIndex < allArticles.length - 1 ? allArticles[currentIndex + 1] : null;
  const colors = categoryColors[article.category] || categoryColors['系统概览'];

  return (
    <div className="min-h-screen bg-white">
      {/* Top Navigation Bar */}
      <nav className="sticky top-0 z-50 bg-white/80 backdrop-blur-md border-b">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-14">
            <Link
              href="/blog"
              className="flex items-center gap-2 text-sm text-gray-600 hover:text-blue-600 transition-colors"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
              文章列表
            </Link>
            <div className="flex items-center gap-3">
              <span className={`text-xs font-medium px-2 py-0.5 rounded ${colors.badge}`}>
                {article.category}
              </span>
              <ArticleTOCMobile toc={toc} />
            </div>
          </div>
        </div>
      </nav>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="flex gap-8">
          {/* Desktop TOC Sidebar */}
          <ArticleTOCSidebar toc={toc} />

          {/* Article Content */}
          <article className="flex-1 min-w-0 max-w-4xl">
            {/* Article Header */}
            <header className="mb-10">
              <div className="flex items-center gap-3 mb-4">
                <span className="text-4xl">{article.icon}</span>
                <div>
                  <span className={`text-xs font-medium px-2 py-0.5 rounded ${colors.badge}`}>
                    {article.category}
                  </span>
                  <span className="text-xs text-gray-500 ml-2">约 {article.readingTime} 分钟阅读</span>
                </div>
              </div>
              <h1 className="text-3xl sm:text-4xl font-bold text-gray-900 leading-tight mb-3">
                {article.title}
              </h1>
              <p className="text-lg text-gray-500 leading-relaxed">{article.description}</p>
            </header>

            {/* Markdown Content */}
            <MarkdownRenderer content={article.content} />

            {/* Prev/Next Navigation */}
            <div className="mt-16 pt-8 border-t">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {prevArticle ? (
                  <Link
                    href={`/blog/${prevArticle.slug}`}
                    className="group flex flex-col p-4 rounded-xl border hover:border-blue-300 hover:bg-blue-50 transition-all"
                  >
                    <span className="text-xs text-gray-400 mb-1">← 上一篇</span>
                    <span className="text-sm font-medium text-gray-700 group-hover:text-blue-600 line-clamp-1">
                      {prevArticle.icon} {prevArticle.title}
                    </span>
                  </Link>
                ) : (
                  <div></div>
                )}
                {nextArticle ? (
                  <Link
                    href={`/blog/${nextArticle.slug}`}
                    className="group flex flex-col items-end p-4 rounded-xl border hover:border-blue-300 hover:bg-blue-50 transition-all"
                  >
                    <span className="text-xs text-gray-400 mb-1">下一篇 →</span>
                    <span className="text-sm font-medium text-gray-700 group-hover:text-blue-600 line-clamp-1">
                      {nextArticle.icon} {nextArticle.title}
                    </span>
                  </Link>
                ) : (
                  <div></div>
                )}
              </div>
            </div>
          </article>
        </div>
      </div>

      {/* Footer */}
      <footer className="border-t bg-gray-50 mt-16">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <div className="text-center text-sm text-gray-500">
            <p>RAG System Technical Blog · 基于 Next.js + LangChain + Milvus 构建</p>
            <p className="mt-1">
              <Link href="/blog" className="text-blue-500 hover:text-blue-700 transition-colors">
                ← 返回文章列表
              </Link>
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
}
