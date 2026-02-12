import Link from 'next/link';
import { getAllArticles, getCategories } from '@/lib/articles';
import type { Article } from '@/lib/articles';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'RAG 系统技术博客 - 文章列表',
  description: '深入了解 RAG（检索增强生成）系统的各种架构、技术实现与最佳实践',
};

// 分类对应的渐变色（用于卡片占位图）
const categoryGradients: Record<string, string> = {
  '系统概览': 'from-blue-500 via-indigo-500 to-violet-600',
  'RAG 架构': 'from-purple-500 via-fuchsia-500 to-pink-600',
  '向量技术': 'from-emerald-500 via-teal-500 to-cyan-600',
  '系统能力': 'from-amber-500 via-orange-500 to-rose-600',
  '配置部署': 'from-rose-500 via-pink-500 to-red-600',
};

// 分类 Tab 徽章
const categoryBadgeStyles: Record<string, string> = {
  '系统概览': 'bg-blue-50 text-blue-700 hover:bg-blue-100',
  'RAG 架构': 'bg-purple-50 text-purple-700 hover:bg-purple-100',
  '向量技术': 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100',
  '系统能力': 'bg-amber-50 text-amber-700 hover:bg-amber-100',
  '配置部署': 'bg-rose-50 text-rose-700 hover:bg-rose-100',
};

function ArticleCard({
  article,
  variant = 'default',
}: {
  article: Article;
  variant?: 'featured' | 'default';
}) {
  const gradient = categoryGradients[article.category] || categoryGradients['系统概览'];
  const badgeStyle = categoryBadgeStyles[article.category] || categoryBadgeStyles['系统概览'];

  if (variant === 'featured') {
    return (
      <Link
        href={`/blog/${article.slug}`}
        className="group block rounded-2xl overflow-hidden border border-gray-200 bg-white hover:border-gray-300 hover:shadow-xl transition-all duration-300"
      >
        <div className="grid md:grid-cols-2 gap-0">
          {/* 占位图 */}
          <div
            className={`aspect-[4/3] md:aspect-auto md:min-h-[280px] bg-gradient-to-br ${gradient} flex items-center justify-center`}
          >
            <span className="text-6xl md:text-7xl opacity-80 group-hover:scale-110 transition-transform duration-300">
              {article.icon}
            </span>
          </div>
          <div className="flex flex-col justify-center p-6 md:p-8">
            <span className={`inline-flex w-fit text-xs font-medium px-2.5 py-1 rounded-md ${badgeStyle} mb-3`}>
              {article.category}
            </span>
            <h2 className="text-xl md:text-2xl font-bold text-gray-900 group-hover:text-blue-600 transition-colors mb-2 line-clamp-2">
              {article.title}
            </h2>
            <p className="text-gray-600 text-sm md:text-base leading-relaxed line-clamp-3 mb-4">
              {article.description}
            </p>
            <div className="flex items-center gap-3 text-sm text-gray-500">
              <span className="flex items-center gap-1.5">
                <span className="w-6 h-6 rounded-full bg-gray-200 flex items-center justify-center text-xs font-medium text-gray-600">
                  RAG
                </span>
                RAG 系统
              </span>
              <span>·</span>
              <span>{article.readingTime} 分钟阅读</span>
            </div>
          </div>
        </div>
      </Link>
    );
  }

  return (
    <Link
      href={`/blog/${article.slug}`}
      className="group block rounded-xl overflow-hidden border border-gray-200 bg-white hover:border-gray-300 hover:shadow-lg transition-all duration-300"
    >
      {/* 卡片顶部占位图 */}
      <div
        className={`aspect-video bg-gradient-to-br ${gradient} flex items-center justify-center`}
      >
        <span className="text-4xl opacity-80 group-hover:scale-110 transition-transform duration-300">
          {article.icon}
        </span>
      </div>
      <div className="p-5">
        <span className={`inline-flex text-xs font-medium px-2 py-0.5 rounded ${badgeStyle} mb-2`}>
          {article.category}
        </span>
        <h3 className="text-base font-semibold text-gray-900 group-hover:text-blue-600 transition-colors line-clamp-2 mb-2">
          {article.title}
        </h3>
        <p className="text-sm text-gray-600 leading-relaxed line-clamp-2 mb-3">
          {article.description}
        </p>
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <span className="w-5 h-5 rounded-full bg-gray-200 flex items-center justify-center text-[10px] font-medium text-gray-600">
            RAG
          </span>
          <span>{article.readingTime} 分钟阅读</span>
        </div>
      </div>
    </Link>
  );
}

export default async function BlogPage({
  searchParams,
}: {
  searchParams: Promise<{ category?: string }>;
}) {
  const params = await searchParams;
  const selectedCategory = params.category || 'all';

  const allArticles = getAllArticles();
  const categoryOrder = ['系统概览', 'RAG 架构', '向量技术', '系统能力', '配置部署'];
  const categories = getCategories().sort(
    (a, b) => categoryOrder.indexOf(a) - categoryOrder.indexOf(b),
  );

  const filteredArticles =
    selectedCategory === 'all'
      ? allArticles
      : allArticles.filter((a) => a.category === selectedCategory);

  const featuredArticle = filteredArticles[0];
  const remainingArticles = filteredArticles.slice(1);

  return (
    <div className="min-h-screen bg-white">
      {/* 顶部导航区 - LobeHub 风格 */}
      <header className="sticky top-0 z-40 bg-white/95 backdrop-blur supports-[backdrop-filter]:bg-white/80 border-b border-gray-200">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 py-6">
            <h1 className="text-2xl font-bold text-gray-900">全部文章</h1>
            {/* 分类 Tab */}
            <nav className="flex flex-wrap gap-2">
              <Link
                href="/blog"
                className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                  selectedCategory === 'all'
                    ? 'bg-gray-900 text-white'
                    : 'text-gray-600 hover:bg-gray-100'
                }`}
              >
                全部
              </Link>
              {categories.map((cat) => (
                <Link
                  key={cat}
                  href={`/blog?category=${encodeURIComponent(cat)}`}
                  className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                    selectedCategory === cat
                      ? 'bg-gray-900 text-white'
                      : 'text-gray-600 hover:bg-gray-100'
                  }`}
                >
                  {cat}
                </Link>
              ))}
            </nav>
          </div>
        </div>
      </header>

      {/* 文章列表 */}
      <main className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
        {filteredArticles.length === 0 ? (
          <div className="text-center py-20">
            <p className="text-gray-500">该分类下暂无文章</p>
          </div>
        ) : (
          <div className="space-y-12">
            {/* Featured / Latest 首篇大卡 */}
            <section>
              <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-4">
                最新
              </h2>
              <ArticleCard article={featuredArticle} variant="featured" />
            </section>

            {/* 其余文章网格 */}
            {remainingArticles.length > 0 && (
              <section>
                <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-4">
                  更多文章
                </h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
                  {remainingArticles.map((article) => (
                    <ArticleCard key={article.slug} article={article} />
                  ))}
                </div>
              </section>
            )}
          </div>
        )}
      </main>

      {/* Footer - LobeHub 风格简洁 */}
      <footer className="border-t border-gray-200 mt-20">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
            <p className="text-sm text-gray-500">
              RAG System Technical Blog · 基于 Next.js + LangChain + Milvus 构建
            </p>
            <Link
              href="/"
              className="text-sm text-gray-500 hover:text-gray-900 transition-colors"
            >
              返回首页
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
