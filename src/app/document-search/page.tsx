import type { Metadata } from 'next';
import KnowledgeWorkspaceNav from '@/components/KnowledgeWorkspaceNav';
import DocumentSearchWorkspace from '@/components/documents/DocumentSearchWorkspace';
import styles from '@/components/documents/KnowledgeWorkspace.module.css';

export const metadata: Metadata = {
  title: '文档搜索 · RAG 知识库',
  description: '使用 Milvus 语义向量与 Elasticsearch 关键词索引搜索文档证据。',
};

export default async function DocumentSearchPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const initialQuery = firstValue(params.q);
  const initialDocumentId = firstValue(params.documentId);
  return (
    <div className={styles.page}>
      <KnowledgeWorkspaceNav active="search" />
      <DocumentSearchWorkspace
        initialQuery={initialQuery}
        initialDocumentId={initialDocumentId}
      />
    </div>
  );
}

function firstValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}
