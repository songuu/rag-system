import KnowledgeGraphConsole from '@/components/KnowledgeGraphConsole';
import Link from 'next/link';
import { isKnowledgeGraphConsoleAvailable } from '@/lib/knowledge-graph/http';

export default function KnowledgeGraphPage() {
  if (!isKnowledgeGraphConsoleAvailable({ NODE_ENV: process.env.NODE_ENV })) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-950 px-6 text-slate-100">
        <section className="max-w-xl rounded-2xl border border-slate-800 bg-slate-900 p-8">
          <h1 className="text-xl font-semibold">知识图谱控制台仅限本地使用</h1>
          <p className="mt-3 text-sm leading-6 text-slate-400">
            此 local-only 控制台没有生产用户认证能力，因此生产环境不会渲染客户端查询或管理界面。
          </p>
          <Link href="/" className="mt-5 inline-block text-sm text-cyan-300 hover:text-cyan-200">返回首页</Link>
        </section>
      </main>
    );
  }
  return <KnowledgeGraphConsole />;
}
