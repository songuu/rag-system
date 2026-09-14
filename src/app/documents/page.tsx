import type { Metadata } from 'next';
import KnowledgeWorkspaceNav from '@/components/KnowledgeWorkspaceNav';
import DocumentManagementWorkspace from '@/components/documents/DocumentManagementWorkspace';
import styles from '@/components/documents/KnowledgeWorkspace.module.css';

export const metadata: Metadata = {
  title: '文档管理 · RAG 知识库',
  description: '统一上传、索引并管理 RAG 知识库中的文档资产。',
};

export default function DocumentsPage() {
  return (
    <div className={styles.page}>
      <KnowledgeWorkspaceNav active="documents" />
      <DocumentManagementWorkspace />
    </div>
  );
}
