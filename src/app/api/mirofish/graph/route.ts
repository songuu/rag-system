/**
 * MiroFish 图谱构建 API
 *
 * POST /api/mirofish/graph - 创建图谱构建任务
 * GET /api/mirofish/graph?action=status&taskId=xxx - 获取任务状态
 * GET /api/mirofish/graph?action=data&graphId=xxx - 获取图谱数据
 * DELETE /api/mirofish/graph?graphId=xxx - 删除图谱
 */

import { NextRequest, NextResponse } from 'next/server';
import { MiroFishGraphBuilder } from '@/lib/mirofish/graph-builder';
import { getTaskManager } from '@/lib/mirofish/task-manager';
import type { GraphBuildRequest } from '@/lib/mirofish/types';

// 存储构建器实例
const builders = new Map<string, MiroFishGraphBuilder>();

export async function POST(request: NextRequest) {
  try {
    const body: GraphBuildRequest = await request.json();

    // 验证必填字段
    if (!body.text) {
      return NextResponse.json(
        {
          success: false,
          error: '缺少必要字段：text',
        },
        { status: 400 }
      );
    }

    // 创建图谱构建器
    const builder = new MiroFishGraphBuilder({
      chunkSize: body.chunkSize,
      chunkOverlap: body.chunkOverlap,
      batchSize: body.batchSize,
    });

    // 异步构建图谱
    const taskId = await builder.buildGraphAsync({
      text: body.text,
      ontology: body.ontology,
      graphName: body.graphName,
      chunkSize: body.chunkSize,
      chunkOverlap: body.chunkOverlap,
      batchSize: body.batchSize,
    });

    // 保存构建器实例
    builders.set(taskId, builder);

    return NextResponse.json({
      success: true,
      taskId,
    });
  } catch (error) {
    console.error('[MiroFish Graph API] 构建失败:', error);

    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : '图谱构建失败',
      },
      { status: 500 }
    );
  }
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const action = searchParams.get('action');
  const taskId = searchParams.get('taskId');
  const graphId = searchParams.get('graphId');

  try {
    // 获取任务状态
    if (action === 'status' && taskId) {
      const taskManager = getTaskManager();
      const task = taskManager.getTask(taskId);

      if (!task) {
        return NextResponse.json(
          {
            success: false,
            error: '任务不存在',
          },
          { status: 404 }
        );
      }

      return NextResponse.json({
        success: true,
        status: task.status,
        progress: task.progress,
        message: task.message,
        graphId: task.result?.graphId,
        error: task.error,
      });
    }

    // 获取图谱数据
    if (action === 'data' && graphId) {
      // 查找对应的构建器
      const taskManager = getTaskManager();
      const tasks = taskManager.getAllTasks();

      let graphData = null;
      for (const task of tasks) {
        if (task.result?.graphId === graphId) {
          graphData = task.result.graphData;
          break;
        }
      }

      if (!graphData) {
        return NextResponse.json(
          {
            success: false,
            error: '图谱不存在',
          },
          { status: 404 }
        );
      }

      return NextResponse.json({
        success: true,
        graph: graphData,
      });
    }

    // 获取所有图谱列表
    if (action === 'list') {
      const taskManager = getTaskManager();
      const tasks = taskManager.getAllTasks();

      const graphs = tasks
        .filter(t => t.result?.graphId)
        .map(t => {
          const result = t.result as Record<string, unknown> | undefined;
          const graphData = result?.graphData as { node_count?: number; edge_count?: number } | undefined;
          return {
            graphId: result?.graphId,
            graphName: t.metadata?.graphName,
            nodeCount: graphData?.node_count || 0,
            edgeCount: graphData?.edge_count || 0,
            createdAt: new Date(t.created_at).toISOString(),
            status: t.status,
          };
        });

      return NextResponse.json({
        success: true,
        graphs,
      });
    }

    return NextResponse.json(
      {
        success: false,
        error: '未指定操作',
      },
      { status: 400 }
    );
  } catch (error) {
    console.error('[MiroFish Graph API] 请求失败:', error);

    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : '请求失败',
      },
      { status: 500 }
    );
  }
}

export async function DELETE(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const graphId = searchParams.get('graphId');

  if (!graphId) {
    return NextResponse.json(
      {
        success: false,
        error: '缺少 graphId 参数',
      },
      { status: 400 }
    );
  }

  try {
    // 查找并删除对应的构建器
    const taskManager = getTaskManager();
    const tasks = taskManager.getAllTasks();

    for (const task of tasks) {
      if (task.result?.graphId === graphId) {
        taskManager.deleteTask(task.task_id);
        break;
      }
    }

    return NextResponse.json({
      success: true,
    });
  } catch (error) {
    console.error('[MiroFish Graph API] 删除失败:', error);

    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : '删除失败',
      },
      { status: 500 }
    );
  }
}
