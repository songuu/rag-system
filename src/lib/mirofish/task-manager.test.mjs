import assert from 'node:assert/strict';
import test from 'node:test';

test('graph task progress and completion survive module reloads in the same server process', async () => {
  const moduleUrl = new URL('./task-manager.ts', import.meta.url).href;
  const first = await import(`${moduleUrl}?reload=before`);
  const second = await import(`${moduleUrl}?reload=after`);
  const beforeReload = first.getTaskManager();
  const taskId = beforeReload.createTask('graph_build', { tenantId: 'reload-test', corpusId: 'private' });
  try {
    beforeReload.updateTask(taskId, { status: 'processing', progress: 37, message: 'extracting' });
    const afterReload = second.getTaskManager();
    assert.equal(afterReload.getTask(taskId)?.progress, 37);
    assert.deepEqual(afterReload.getTask(taskId)?.metadata, { tenantId: 'reload-test', corpusId: 'private' });
    assert.equal(afterReload.completeTask(taskId, { graphId: 'graph-reload' }), true);
    assert.equal(beforeReload.getTask(taskId)?.status, 'completed');
    assert.deepEqual(beforeReload.getTask(taskId)?.result, { graphId: 'graph-reload' });
  } finally { beforeReload.deleteTask(taskId); }
});
