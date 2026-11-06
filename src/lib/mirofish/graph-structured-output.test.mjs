import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context); } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !specifier.endsWith('.ts')) return nextResolve(`${specifier}.ts`, context);
    throw error;
  }
} });

test('durable graph extraction sends a schema only on extraction calls', async () => {
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body || '{}');
    requests.push({ url: request.url, payload });
    response.setHeader('content-type', 'application/json');
    if (request.url === '/api/embed' || request.url === '/api/embeddings') {
      const input = Array.isArray(payload.input) ? payload.input : [payload.input ?? payload.prompt];
      response.end(JSON.stringify({ model: payload.model, embeddings: input.map(() => [1, 0]), embedding: [1, 0] }));
      return;
    }
    if (request.url === '/api/chat') {
      const extraction = payload.format && typeof payload.format === 'object';
      const content = extraction
        ? JSON.stringify({ entities: [{ name: 'Alice', type: 'PERSON', description: 'A person' }], relations: [] })
        : JSON.stringify({ name: 'Community', summary: 'Summary', keywords: [] });
      response.end(`${JSON.stringify({ model: payload.model, created_at: new Date().toISOString(), message: { role: 'assistant', content }, done: true, done_reason: 'stop' })}\n`);
      return;
    }
    response.statusCode = 404;
    response.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const previous = { ...process.env };
  try {
    process.env.MODEL_PROVIDER = 'ollama';
    process.env.EMBEDDING_PROVIDER = 'ollama';
    process.env.OLLAMA_BASE_URL = `http://127.0.0.1:${server.address().port}`;
    process.env.OLLAMA_LLM_MODEL = 'graph-test-model';
    process.env.OLLAMA_EMBEDDING_MODEL = 'graph-test-embedding';
    const { extractMiroFishGraphData } = await import('./graph-builder.ts');
    const records = new Map();
    const graph = await extractMiroFishGraphData({ text: 'Alice appears in this document.', documentId: 'doc', checkpoint: {
      async load(segment) { return records.get(segment.key) ?? null; },
      async save(segment, value) { records.set(segment.key, value); },
    } });
    assert.equal(graph.nodes.length, 1);
    assert.equal(graph.nodes[0].name, 'Alice');
    assert.equal(graph.passages.length, 1);
    const extraction = requests.find(item => item.url === '/api/chat' && typeof item.payload.format === 'object');
    assert.ok(extraction, 'the extraction request must carry a JSON schema');
    assert.deepEqual(extraction.payload.format.required, ['entities', 'relations']);
    assert.equal(extraction.payload.options.num_predict, 8192);
    assert.equal(records.size, 1);
    for (const request of requests.filter(item => item.url === '/api/chat' && item !== extraction)) {
      assert.equal(request.payload.format, 'json');
    }
  } finally {
    process.env = previous;
    await new Promise(resolve => server.close(resolve));
  }
});

for (const failure of ['truncated', 'malformed']) {
  test(`ordinary graph extraction recovers ${failure} output by splitting without a checkpoint`, async () => {
    const source = `ALPHA_START ${'abcdefghij '.repeat(100)} OMEGA_END`;
    const extractionInputs = [];
    const server = createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += chunk;
      const payload = JSON.parse(body || '{}');
      response.setHeader('content-type', 'application/json');
      if (request.url === '/api/embed' || request.url === '/api/embeddings') {
        const input = Array.isArray(payload.input) ? payload.input : [payload.input ?? payload.prompt];
        response.end(JSON.stringify({ model: payload.model, embeddings: input.map((_, index) => index % 2 === 0 ? [1, 0] : [0, 1]), embedding: [1, 0] }));
        return;
      }
      if (request.url === '/api/chat') {
        const extraction = typeof payload.format === 'object';
        let content;
        let doneReason = 'stop';
        if (extraction) {
          const prompt = payload.messages.map(message => message.content).join('\n');
          const input = /## 输入文本\s*"""\s*([\s\S]*?)\s*"""/u.exec(prompt)?.[1];
          extractionInputs.push(input);
          if (input === source) {
            content = '{"entities":[';
            doneReason = failure === 'truncated' ? 'length' : 'stop';
          } else {
            const name = input.startsWith('ALPHA_START') ? 'Alice' : 'Bob';
            content = JSON.stringify({ entities: [{ name, type: 'PERSON', description: name }], relations: [] });
          }
        } else {
          content = JSON.stringify({ name: 'Community', summary: 'Summary', keywords: [] });
        }
        response.end(`${JSON.stringify({ model: payload.model, message: { role: 'assistant', content }, done: true, done_reason: doneReason })}\n`);
        return;
      }
      response.statusCode = 404;
      response.end('{}');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const previous = { ...process.env };
    const { getModelFactory } = await import('../model-config.ts');
    const { getEmbeddingFactory } = await import('../embedding-config.ts');
    try {
      process.env.MODEL_PROVIDER = 'ollama';
      process.env.EMBEDDING_PROVIDER = 'ollama';
      process.env.OLLAMA_BASE_URL = `http://127.0.0.1:${server.address().port}`;
      process.env.OLLAMA_LLM_MODEL = 'graph-split-model';
      process.env.OLLAMA_EMBEDDING_MODEL = 'graph-split-embedding';
      getModelFactory().reloadConfig();
      getEmbeddingFactory().reloadConfig();
      const { extractMiroFishGraphData } = await import('./graph-builder.ts');
      const graph = await extractMiroFishGraphData({ text: source, documentId: `doc-${failure}` });
      assert.equal(extractionInputs.length, 3, 'one failed parent is replaced by two successful children');
      assert.equal(extractionInputs[0], source);
      assert(source.startsWith(extractionInputs[1]));
      assert(source.endsWith(extractionInputs[2]));
      assert(extractionInputs[1].length + extractionInputs[2].length > source.length, 'split children retain overlap');
      assert.deepEqual(graph.nodes.map(node => node.name).sort(), ['Alice', 'Bob']);
      assert.equal(graph.passages.length, 1);
      assert.equal(graph.passages[0].content, source, 'the original source evidence remains exact');
      for (const node of graph.nodes) assert.deepEqual(node.attributes.sourceChunks, [`doc-${failure}_chunk_0`]);
    } finally {
      process.env = previous;
      getModelFactory().reloadConfig();
      getEmbeddingFactory().reloadConfig();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  });
}
