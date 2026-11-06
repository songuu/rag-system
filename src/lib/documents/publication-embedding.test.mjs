import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

registerHooks({resolve(s,c,n){if(s==='../embedding-config')return {shortCircuit:true,url:'data:text/javascript,'+encodeURIComponent('export function getEmbeddingConfigSummary(){return globalThis.publicationEmbeddingConfig;}')};if(s.startsWith('.')&&c.parentURL?.startsWith('file:')){const u=new URL(s+'.ts',c.parentURL);if(existsSync(fileURLToPath(u)))return n(u.href,c);}return n(s,c);}});
const { resolvePublicationEmbedding } = await import('./publication-embedding.ts');
const digest='a'.repeat(64), alias=`rag-publication-${digest}:latest`;
const originalFetch=globalThis.fetch;
test.after(()=>{globalThis.fetch=originalFetch;});
function install({changed=false,hang=false}={}){
  globalThis.publicationEmbeddingConfig={provider:'ollama',model:'test-model',dimension:2,baseUrl:'http://127.0.0.1:11434'};
  let copied=false,embedded=false;const calls=[];
  globalThis.fetch=async(url,options={})=>{const path=new URL(url).pathname;const body=options.body?JSON.parse(options.body):undefined;calls.push({path,body});
    if(path==='/api/tags')return Response.json({models:[{name:'test-model:latest',digest:`sha256:${digest}`},...(copied?[{name:alias,digest:`sha256:${changed&&embedded?'b'.repeat(64):digest}`}]:[])]});
    if(path==='/api/copy'){copied=true;return new Response(null,{status:200});}
    if(path==='/api/version')return Response.json({version:'0.13.0'});
    if(path==='/api/embed'){embedded=true;if(hang)return new Promise((_,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}));return Response.json({model:alias,embeddings:body.input.map(()=>[0.25,0.75])});}
    throw new Error('Unexpected request');};return calls;
}
test('pins mutable tag to content-addressed alias and verifies exact read configuration',async()=>{
  const calls=install();const session=await resolvePublicationEmbedding();
  assert.equal(session.config.model,alias);assert.match(session.config.revision,/^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(await session.embedDocuments(['a','b']),[[0.25,0.75],[0.25,0.75]]);
  assert.equal(calls.find(x=>x.path==='/api/embed').body.model,alias);
  assert.deepEqual(calls.find(x=>x.path==='/api/embed').body.options,{num_ctx:8192});
  const before=calls.filter(x=>x.path==='/api/copy').length;
  const query=await resolvePublicationEmbedding({...session.config});
  assert.deepEqual(await query.embedQuery('a'),[0.25,0.75]);
  assert.equal(calls.filter(x=>x.path==='/api/copy').length,before);
});
test('changed alias digest or revision is rejected without returning vectors',async()=>{
  install({changed:true});const session=await resolvePublicationEmbedding();
  await assert.rejects(session.embedQuery('x'),/model identity changed/);
  install();const first=await resolvePublicationEmbedding();
  await assert.rejects(resolvePublicationEmbedding({...first.config,revision:`sha256:${'0'.repeat(64)}`}),/revision/);
});
test('untrusted providers and remote model endpoints are rejected before network IO',async()=>{
  const calls=install();globalThis.publicationEmbeddingConfig.provider='openai';
  await assert.rejects(resolvePublicationEmbedding(),/local Ollama/);
  globalThis.publicationEmbeddingConfig.provider='ollama';globalThis.publicationEmbeddingConfig.baseUrl='http://remote.example:11434';
  await assert.rejects(resolvePublicationEmbedding(),/loopback/);assert.equal(calls.length,0);
});
test('aborting an in-flight embedding returns cancellation and never returns vectors',async()=>{
  install({hang:true});const session=await resolvePublicationEmbedding();const controller=new AbortController();
  const pending=session.embedQuery('x',controller.signal);setTimeout(()=>controller.abort(),5);
  await assert.rejects(pending);
});

let scopeSequence = 0;
const freshScope = () => ({ tenantId: `cache-tenant-${++scopeSequence}`, corpusId: 'corpus-a',
  allowedTrustLevels: ['external'], enforceIsolation: true });
function installCacheFixture() {
  const state = { digest, version: '0.13.0', dimension: 2, beforeTags: undefined, beforeVersion: undefined, beforeEmbed: undefined };
  const calls = [];
  globalThis.publicationEmbeddingConfig = { provider: 'ollama', model: 'test-model', dimension: 2, baseUrl: 'http://127.0.0.1:11434' };
  globalThis.fetch = async (url, options = {}) => {
    const path = new URL(url).pathname;
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ path, body });
    if (path === '/api/tags') {
      await state.beforeTags?.();
      return Response.json({ models: [{ name: 'test-model:latest', digest: state.digest },
        { name: `rag-publication-${state.digest}:latest`, digest: state.digest }] });
    }
    if (path === '/api/version') { await state.beforeVersion?.(); return Response.json({ version: state.version }); }
    if (path === '/api/embed') {
      await state.beforeEmbed?.(options.signal);
      return Response.json({ model: body.model, embeddings: body.input.map(() => Array(state.dimension).fill(0.5)) });
    }
    throw new Error('Unexpected cached embedding request');
  };
  return { state, calls, embeddings: () => calls.filter(call => call.path === '/api/embed').length };
}

test('completed queries reuse only vectors and repeat every before/after identity probe', async () => {
  const f = installCacheFixture(); const scope = freshScope();
  const first = await resolvePublicationEmbedding({ scope });
  const vector = await first.embedQuery('same query'); vector[0] = 99;
  const second = await resolvePublicationEmbedding({ ...first.config, scope });
  assert.deepEqual(await second.embedQuery('same query'), [0.5, 0.5]);
  assert.equal(f.embeddings(), 1);
  assert.equal(f.calls.filter(call => call.path === '/api/tags').length, 6);
  assert.equal(f.calls.filter(call => call.path === '/api/version').length, 6);
});

test('query cache separates scope, endpoint, digest, runtime, dimension and exact input', async () => {
  const f = installCacheFixture(); const scope = freshScope();
  const embed = async (options = {}, text = 'Ａ') => (await resolvePublicationEmbedding({ scope, ...options })).embedQuery(text);
  await embed(); await embed({}, 'A');
  await embed({ scope: { ...scope, tenantId: `${scope.tenantId}-other` } });
  await embed({ scope: { ...scope, corpusId: 'other' } });
  await embed({ scope: { ...scope, allowedTrustLevels: ['trusted'] } });
  globalThis.publicationEmbeddingConfig.baseUrl = 'http://127.0.0.1:11435'; await embed();
  f.state.version = '0.14.0'; await embed();
  f.state.digest = 'b'.repeat(64); await embed();
  f.state.dimension = 3; await embed({ dimension: 3 });
  assert.equal(f.embeddings(), 9);
});

test('cache hits still reject changed alias/runtime and do not cache failed or cancelled work', async () => {
  const f = installCacheFixture(); const scope = freshScope();
  const session = await resolvePublicationEmbedding({ scope });
  await session.embedQuery('same');
  f.state.version = '0.14.0';
  await assert.rejects(session.embedQuery('same'), /runtime changed/);
  f.state.version = '0.13.0'; f.state.digest = 'b'.repeat(64);
  await assert.rejects(session.embedQuery('same'), /unavailable|identity changed/);
  f.state.digest = digest;
  f.state.beforeEmbed = async () => { throw new Error('provider unavailable'); };
  await assert.rejects(session.embedQuery('retry'), /provider unavailable/);
  f.state.beforeEmbed = undefined;
  assert.deepEqual(await session.embedQuery('retry'), [0.5, 0.5]);
  const cancelled = new AbortController();
  f.state.beforeEmbed = async () => { cancelled.abort(); };
  await assert.rejects(session.embedQuery('cancelled', cancelled.signal));
  f.state.beforeEmbed = undefined;
  assert.deepEqual(await session.embedQuery('cancelled'), [0.5, 0.5]);
  assert.equal(f.embeddings(), 5);
});

test('model inventory and runtime probes start together', async () => {
  const f = installCacheFixture(); let release;
  f.state.beforeTags = () => new Promise(resolve => { release = resolve; });
  const pending = resolvePublicationEmbedding({ scope: freshScope() });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.calls.filter(call => call.path === '/api/version').length, 1);
  } finally { release?.(); }
  await pending;
});

test('a failed identity probe waits for its already-started sibling', async () => {
  const f = installCacheFixture(); let release;
  f.state.beforeTags = () => new Promise(resolve => { release = resolve; });
  f.state.beforeVersion = async () => { throw new Error('runtime probe failed'); };
  let settled = false;
  const pending = resolvePublicationEmbedding({ scope: freshScope() });
  const checked = assert.rejects(pending, /runtime probe failed/).then(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false); release(); await checked;
});

test('a post-read identity change rejects a cache hit and discards the cached vector', async () => {
  const f = installCacheFixture(); const session = await resolvePublicationEmbedding({ scope: freshScope() });
  await session.embedQuery('same'); let reads = 0;
  f.state.beforeTags = async () => { if (++reads === 2) f.state.digest = 'b'.repeat(64); };
  await assert.rejects(session.embedQuery('same'), /unavailable|identity changed/);
  assert.equal(f.embeddings(), 1);
  f.state.beforeTags = undefined; f.state.digest = digest;
  await session.embedQuery('same'); assert.equal(f.embeddings(), 2);
});

test('two in-flight callers keep independent cancellation and never share pending vectors', async () => {
  const f = installCacheFixture(); const scope = freshScope();
  const first = await resolvePublicationEmbedding({ scope }); const second = await resolvePublicationEmbedding({ scope });
  const cancelled = new AbortController();
  let started; const entered = new Promise(resolve => { started = resolve; });
  let calls = 0;
  f.state.beforeEmbed = async signal => {
    if (++calls === 1) { started(); await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); }
  };
  const firstPending = first.embedQuery('same', cancelled.signal);
  const rejected = assert.rejects(firstPending);
  await entered;
  const secondPending = second.embedQuery('same');
  cancelled.abort(); await rejected;
  assert.deepEqual(await secondPending, [0.5, 0.5]); assert.equal(f.embeddings(), 2);
});

test('calls without a trusted isolated scope never populate the publication query cache', async () => {
  const f = installCacheFixture();
  const session = await resolvePublicationEmbedding();
  await session.embedQuery('same'); await session.embedQuery('same');
  assert.equal(f.embeddings(), 2);
  await assert.rejects(resolvePublicationEmbedding({ scope: { ...freshScope(), enforceIsolation: false } }), /isolat/i);
});
