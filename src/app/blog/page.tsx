import Link from 'next/link';
import { getAllArticles } from '@/lib/articles';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'RAG 系统技术博客 - 文章列表',
  description: '深入了解 RAG（检索增强生成）系统的各种架构、技术实现与最佳实践',
};

// 分类对应的颜色
const categoryColors: Record<string, { bg: string; text: string; border: string; badge: string }> = {
  '系统概览': { bg: 'bg-blue-50', text: 'text-blue-700', border: 'border-blue-200', badge: 'bg-blue-100 text-blue-800' },
  'RAG 架构': { bg: 'bg-purple-50', text: 'text-purple-700', border: 'border-purple-200', badge: 'bg-purple-100 text-purple-800' },
  '向量技术': { bg: 'bg-emerald-50', text: 'text-emerald-700', border: 'border-emerald-200', badge: 'bg-emerald-100 text-emerald-800' },
  '系统能力': { bg: 'bg-amber-50', text: 'text-amber-700', border: 'border-amber-200', badge: 'bg-amber-100 text-amber-800' },
  '配置部署': { bg: 'bg-rose-50', text: 'text-rose-700', border: 'border-rose-200', badge: 'bg-rose-100 text-rose-800' },
};

export default function BlogPage() {
  const articles = getAllArticles();
  const categories = [...new Set(articles.map((a) => a.category))];

  // 按分类分组
  const grouped = categories.map((cat) => ({
    name: cat,
    articles: articles.filter((a) => a.category === cat),
  }));

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-blue-50">
      {/* Hero Section */}
      <header className="relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-r from-blue-600 via-purple-600 to-indigo-700"></div>
        <div className="absolute inset-0 opacity-10" style={{
          backgroundImage: `url("data:image/svg+xml,%3Csvg width='60' height='60' xmlns='http://www.w3.org/2000/svg'%3E%3Cdefs%3E%3Cpattern id='grid' width='60' height='60' patternUnits='userSpaceOnUse'%3E%3Cpath d='M 10 0 L 0 0 0 10' fill='none' stroke='white' stroke-width='1'/%3E%3C/pattern%3E%3C/defs%3E%3Crect width='100%25' height='100%25' fill='url(%23grid)'/%3E%3C/svg%3E")`,
        }}></div>
        <div className="relative max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-16 sm:py-24">
          <div className="text-center">
            <div className="inline-flex items-center px-4 py-1.5 rounded-full bg-white/10 backdrop-blur-sm border border-white/20 text-white/90 text-sm mb-6">
              <span className="mr-2">📖</span>
              {articles.length} 篇技术文章
            </div>
            <h1 className="text-4xl sm:text-5xl font-bold text-white mb-4 tracking-tight">
              RAG 系统技术博客
            </h1>
            <p className="text-lg sm:text-xl text-blue-100 max-w-2xl mx-auto leading-relaxed">
              深入探索检索增强生成（RAG）系统的架构设计、核心技术与实践经验
            </p>
            <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
              {categories.map((cat) => {
                const count = articles.filter(a => a.category === cat).length;
                return (
                  <a
                    key={cat}
                    href={`#${encodeURIComponent(cat)}`}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-white/10 backdrop-blur-sm hover:bg-white/20 border border-white/20 text-white text-sm rounded-lg transition-all"
                  >
                    {cat}
                    <span className="text-xs bg-white/20 px-1.5 py-0.5 rounded-full">{count}</span>
                  </a>
                );
              })}
            </div>
          </div>
        </div>
      </header>

      {/* Articles by Category */}
      <main className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <div className="space-y-16">
          {grouped.map(({ name, articles: catArticles }) => {
            const colors = categoryColors[name] || categoryColors['系统概览'];
            return (
              <section key={name} id={encodeURIComponent(name)}>
                <div className="flex items-center gap-3 mb-8">
                  <h2 className="text-2xl font-bold text-gray-900">{name}</h2>
                  <span className={`px-2.5 py-0.5 text-xs font-medium rounded-full ${colors.badge}`}>
                    {catArticles.length} 篇
                  </span>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                  {catArticles.map((article) => (
                    <Link
                      key={article.slug}
                      href={`/blog/${article.slug}`}
                      className={`group relative flex flex-col rounded-xl border ${colors.border} ${colors.bg} hover:shadow-lg hover:-translate-y-1 transition-all duration-300 overflow-hidden`}
                    >
                      {/* Card Top Accent */}
                      <div className="h-1 bg-gradient-to-r from-blue-500 via-purple-500 to-pink-500 opacity-0 group-hover:opacity-100 transition-opacity"></div>

                      <div className="flex-1 p-6">
                        <div className="flex items-start justify-between mb-3">
                          <span className="text-3xl">{article.icon}</span>
                          <span className="text-xs text-gray-500 font-mono">
                            {article.readingTime} min
                          </span>
                        </div>
                        <h3 className={`text-lg font-semibold ${colors.text} group-hover:underline decoration-2 underline-offset-4 mb-2 leading-snug line-clamp-2`}>
                          {article.title}
                        </h3>
                        <p className="text-sm text-gray-600 leading-relaxed line-clamp-3">
                          {article.description}
                        </p>
                      </div>

                      {/* Card Footer */}
                      <div className="px-6 py-3 border-t border-gray-100 bg-white/50 flex items-center justify-between">
                        <span className={`text-xs font-medium px-2 py-0.5 rounded ${colors.badge}`}>
                          {article.category}
                        </span>
                        <span className="text-xs text-gray-400 group-hover:text-blue-500 transition-colors flex items-center gap-1">
                          阅读全文
                          <svg className="w-3 h-3 transform group-hover:translate-x-0.5 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                          </svg>
                        </span>
                      </div>
                    </Link>
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t bg-gray-50 mt-16">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <div className="text-center text-sm text-gray-500">
            <p>RAG System Technical Blog · 基于 Next.js + LangChain + Milvus 构建</p>
          </div>
        </div>
      </footer>
    </div>
  );
}
