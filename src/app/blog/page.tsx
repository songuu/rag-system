import { getAllArticles, getCategories } from '@/lib/articles';
import type { Metadata } from 'next';
import BlogContent from './BlogContent';

export const metadata: Metadata = {
  title: 'RAG 系统技术博客 - 文章列表',
  description: '深入了解 RAG（检索增强生成）系统的各种架构、技术实现与最佳实践',
};

const categoryOrder = ['系统概览', 'RAG 架构', '向量技术', '系统能力', '配置部署'];

export default function BlogPage() {
  const articles = getAllArticles();
  const categories = getCategories().sort(
    (a, b) => categoryOrder.indexOf(a) - categoryOrder.indexOf(b),
  );

  return (
    <div className="min-h-screen bg-white">
      <BlogContent articles={articles} categories={categories} />
    </div>
  );
}
