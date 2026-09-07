import type { ReactNode } from 'react';
import KnowledgeRetrievalFlow from '@/components/KnowledgeRetrievalFlow';

interface AppTemplateProps {
  children: ReactNode;
}

export default function AppTemplate({ children }: AppTemplateProps) {
  return (
    <>
      {children}
      <div className="fixed right-0 top-1/2 z-40 -translate-y-1/2 rounded-l-xl border border-r-0 border-sky-200 bg-white shadow-lg" aria-label="知识库检索帮助">
        <KnowledgeRetrievalFlow />
      </div>
    </>
  );
}
