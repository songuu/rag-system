import Link from 'next/link';
import {
  BookOpenText,
  BrainCircuit,
  Files,
  MessageSquareText,
  Network,
  Search,
} from 'lucide-react';
import styles from './documents/KnowledgeWorkspace.module.css';

type WorkspacePage = 'documents' | 'search' | 'answer' | 'graph';

const items = [
  { id: 'documents', href: '/documents', label: '文档管理', icon: Files },
  { id: 'search', href: '/document-search', label: '文档搜索', icon: Search },
  { id: 'answer', href: '/', label: '智能问答', icon: MessageSquareText },
  { id: 'graph', href: '/knowledge-graph', label: '知识图谱', icon: Network },
] as const;

export default function KnowledgeWorkspaceNav({ active }: { active: WorkspacePage }) {
  return (
    <header className={styles.topbar}>
      <div className={styles.topbarInner}>
        <Link className={styles.brand} href="/" aria-label="返回 RAG 知识库首页">
          <span className={styles.brandMark}><BrainCircuit size={20} strokeWidth={1.8} /></span>
          <span>
            <strong>RAG 知识库</strong>
            <small>KNOWLEDGE OPERATIONS</small>
          </span>
        </Link>
        <nav className={styles.workspaceNav} aria-label="知识库工作区">
          {items.map(({ id, href, label, icon: Icon }) => (
            <Link
              key={id}
              href={href}
              className={`${styles.workspaceNavLink} ${active === id ? styles.workspaceNavLinkActive : ''}`}
              aria-current={active === id ? 'page' : undefined}
            >
              <Icon size={17} strokeWidth={1.8} />
              <span>{label}</span>
            </Link>
          ))}
        </nav>
        <Link className={styles.referenceLink} href="/blog">
          <BookOpenText size={16} />
          技术文档
        </Link>
      </div>
    </header>
  );
}
