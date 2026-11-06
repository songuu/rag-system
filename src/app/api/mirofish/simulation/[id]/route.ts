/**
 * 单个模拟 API
 *
 * GET /api/mirofish/simulation/[id] - 获取模拟详情
 * POST /api/mirofish/simulation/[id] - 控制模拟 (start/stop)
 * DELETE /api/mirofish/simulation/[id] - 删除模拟
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSimulationRunner,isSimulationSnapshotSourceAuthorized } from '@/lib/mirofish/simulation-runner';
import { exportSimulation } from '@/lib/mirofish/simulation-export';
import { resolveMiroFishRequestScope } from '@/lib/mirofish/request-scope';
import { simulationApiError } from '@/lib/mirofish/simulation-api-response';
import { withMiroFishProjectLock } from '@/lib/mirofish/project-lifecycle';
import { readJsonObjectWithLimit } from '@/lib/security/request-validation';

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const { searchParams } = new URL(request.url);
  const action = searchParams.get('action');

  try {
    const {scope}=await resolveMiroFishRequestScope(request);
    const runner = getSimulationRunner(scope);
    if(!await runner.ensureLoaded(id))return NextResponse.json({success:false,error:'模拟不存在'},{status:404});
    const snapshot=runner.getSnapshot(id)!;
    if(!snapshot.sourceGraphIdentity||!await isSimulationSnapshotSourceAuthorized(snapshot,scope))return NextResponse.json({success:false,error:'模拟来源图谱不可用，请重新准备环境'},{status:409});

    if(action==='export'){
      const format=searchParams.get('format')||'snapshot';
      if(!['snapshot','config','profiles','twitter-csv','reddit-json','actions-csv'].includes(format))return NextResponse.json({success:false,error:'不支持的导出格式'},{status:400});
      const exported=exportSimulation(snapshot,format);
      return new NextResponse(exported.content,{headers:{'Content-Type':exported.contentType,'Content-Disposition':`attachment; filename="${format}-${id.replace(/[^A-Za-z0-9_.-]/g,'')}.${exported.extension}"`}});
    }

    if(action==='actions')return NextResponse.json({success:true,actions:runner.getActions(id,{platform:searchParams.get('platform')||undefined,agentId:searchParams.get('agentId')||undefined,round:searchParams.has('round')?Number(searchParams.get('round')):undefined,offset:Number(searchParams.get('offset')||0),limit:Number(searchParams.get('limit')||100)})});
    if(action==='memory'||action==='env-status'){const snapshot=runner.getSnapshot(id)!;return NextResponse.json({success:true,engine:'local-native',status:snapshot.info.status,memory:snapshot.memory,events:snapshot.actions.filter(event=>event.success).slice(-100),projection:snapshot.projection,recoverable:snapshot.recoverable,evidenceScope:'simulation'});}
    if(action==='config'||action==='profiles'){
      const info=runner.get(id)!;const payload=action==='config'?info.config:info.agent_profiles;
      if(searchParams.get('download')==='1')return new NextResponse(JSON.stringify(payload,null,2),{headers:{'Content-Type':'application/json','Content-Disposition':`attachment; filename="${action}-${id.replace(/[^A-Za-z0-9_.-]/g,'')}.json"`}});
      return NextResponse.json({success:true,[action]:payload});
    }

    // 获取帖子列表
    if (action === 'posts') {
      const platform = searchParams.get('platform') || undefined;
      const limit = parseInt(searchParams.get('limit') || '50');
      const posts = runner.getPosts(id, platform, limit);
      return NextResponse.json({ success: true, posts });
    }

    // 获取时间线
    if (action === 'timeline') {
      const timeline = runner.getTimeline(id);
      return NextResponse.json({ success: true, timeline });
    }

    // 获取 Agent 统计
    if (action === 'agent-stats') {
      const stats = runner.getAgentStats(id);
      return NextResponse.json({ success: true, stats });
    }

    if (action === 'snapshot') {
      const snapshot = runner.getSnapshot(id);
      if (!snapshot) {
        return NextResponse.json(
          { success: false, error: '模拟不存在' },
          { status: 404 }
        );
      }
      return NextResponse.json({ success: true, snapshot });
    }

    // 默认返回模拟详情
    const info = runner.get(id);
    if (!info) {
      return NextResponse.json(
        { success: false, error: '模拟不存在' },
        { status: 404 }
      );
    }

    return NextResponse.json({ success: true, simulation: info });
  } catch (error) {
    return simulationApiError(error,'获取模拟信息失败');
  }
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  try {
    const {scope}=await resolveMiroFishRequestScope(request,'ingest');
    const body = await readJsonObjectWithLimit(request,64*1024);
    const { action } = body as { action: 'start' | 'resume' | 'restart' | 'pause' | 'stop' | 'close-env' };
    const runner = getSimulationRunner(scope);
    if(!await runner.ensureLoaded(id))return NextResponse.json({success:false,error:'模拟不存在'},{status:404});

    if (action === 'start'||action==='resume'||action==='restart') {
      return await withMiroFishProjectLock(scope,runner.get(id)!.project_id,async()=>{
      const snapshot=runner.getSnapshot(id)!;
      if(!snapshot.sourceGraphIdentity||!await isSimulationSnapshotSourceAuthorized(snapshot,scope))return NextResponse.json({success:false,error:'模拟来源图谱不可用，请重新准备环境'},{status:409});
      const simulation=await runner.launch(id,action==='restart'?'restart':'resume');
      return NextResponse.json({ success: true, simulation, message: '模拟已启动' });
      });
    }

    if (action === 'stop'||action==='pause'||action==='close-env') {
      const simulation=action==='pause'?await runner.pause(id):await runner.stop(id);
      return NextResponse.json({ success: true, simulation, message: simulation?.status==='stopping'?'模拟正在停止':'模拟已停止' });
    }

    return NextResponse.json(
      { success: false, error: '未知操作，支持: start, stop' },
      { status: 400 }
    );
  } catch (error) {
    return simulationApiError(error,'操作失败');
  }
}

export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  try {
    const {scope}=await resolveMiroFishRequestScope(_request,'ingest');
    const runner = getSimulationRunner(scope);
    await runner.delete(id);
    return NextResponse.json({ success: true });
  } catch (error) {
    return simulationApiError(error,'删除模拟失败');
  }
}
