const DIAGRAM_PATH = '/diagrams/knowledge-retrieval-flow.svg';

export default function KnowledgeRetrievalFlow() {
  return (
    <a
      href={DIAGRAM_PATH}
      target="_blank"
      rel="noopener noreferrer"
      aria-label="在新标签页查看知识库检索流程图"
      title="在新标签页查看知识库检索流程图"
      className="inline-flex items-center gap-1 rounded-lg p-2 text-xs font-medium text-sky-600 transition-colors hover:bg-sky-50 hover:text-sky-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:ring-offset-2"
    >
      <i className="fas fa-project-diagram" aria-hidden="true"></i>
      <span className="hidden xl:inline">检索流程</span>
    </a>
  );
}
