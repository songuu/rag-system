/**
 * 模拟 SSE 实时推送
 *
 * GET /api/mirofish/simulation/[id]/stream - SSE事件流
 */

import { NextRequest } from 'next/server';
import { getSimulationRunner,isSimulationSnapshotSourceAuthorized } from '@/lib/mirofish/simulation-runner';
import { simulationApiError } from '@/lib/mirofish/simulation-api-response';
import type { SimulationEvent } from '@/lib/mirofish/simulation-runner';
import { resolveMiroFishRequestScope } from '@/lib/mirofish/request-scope';

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(_request: NextRequest, { params }: RouteParams) {
  try{return await createSimulationStream(_request,{params});}catch(error){return simulationApiError(error,'读取模拟事件失败');}
}

async function createSimulationStream(_request: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const {scope}=await resolveMiroFishRequestScope(_request);
  const runner = getSimulationRunner(scope);
  await runner.ensureLoaded(id);

  const info = runner.get(id);
  if (!info) {
    return new Response(JSON.stringify({ error: '模拟不存在' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  const snapshot=runner.getSnapshot(id)!;
  if(!snapshot.sourceGraphIdentity||!await isSimulationSnapshotSourceAuthorized(snapshot,scope))return new Response(JSON.stringify({success:false,error:'模拟来源图谱不可用'}),{status:409,headers:{'Content-Type':'application/json'}});

  const encoder = new TextEncoder();
  let cleanupFn: (() => void) | null = null;

  const stream = new ReadableStream({
    start(controller) {
      // 监听模拟事件
      const listener = (event: SimulationEvent) => {
        try {
          const eventData = JSON.stringify(event);
          controller.enqueue(encoder.encode(`data: ${eventData}\n\n`));

          // 模拟结束时关闭流
          if (event.type === 'simulation_complete' || event.type === 'simulation_error'||(event.type==='state_changed'&&event.data.status!=='running'&&event.data.status!=='stopping'&&event.data.status!=='finalizing')) {
            cleanupFn?.();
            setTimeout(() => {
              try {
                controller.close();
              } catch {
                // 流可能已关闭
              }
            }, 1000);
          }
        } catch {
          // 忽略写入错误（客户端可能已断开）
        }
      };

      runner.addListener(id, listener);

      // 清理函数（SSE listener 必须在断开时移除，防止泄漏）
      cleanupFn = () => {
        runner.removeListener(id, listener);
        _request.signal.removeEventListener('abort',cleanupFn!);
      };

      // 使用 AbortSignal 监听客户端断开
      _request.signal.addEventListener('abort', cleanupFn);

      // 发送初始状态。listener 先注册，避免运行中模拟在连接窗口丢事件。
      const initData = JSON.stringify({
        type: 'connected',
        data: {
          simulation_id: id,
          status: info.status,
          current_round: info.current_round,
          total_rounds: info.config.round_count,
          snapshot: runner.getSnapshot(id),
        },
      });
      controller.enqueue(encoder.encode(`data: ${initData}\n\n`));
    },
    cancel() {
      // ReadableStream cancel hook — 客户端断开时可靠触发
      cleanupFn?.();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}
