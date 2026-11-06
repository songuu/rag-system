import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { registerHooks } from 'node:module';
registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context); }
  catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !specifier.endsWith('.ts')) return nextResolve(specifier + '.ts', context);
    throw error;
  }
} });
const { createProviderAdmissionFetch, resolveProviderAdmissionPolicy } = await import('./provider-admission.ts');

let endpoint = 0;
const options = (extra = {}) => ({ provider: 'ollama', baseUrl: `http://127.0.0.1:${20000 + endpoint++}`,
  policy: { concurrency: 1, maxQueue: 16, waitTimeoutMs: 1000 }, ...extra });
function deferred() { let resolve, reject; const promise = new Promise((a,b) => { resolve=a;reject=b; }); return { promise,resolve,reject }; }
const turn = () => new Promise(resolve => setImmediate(resolve));

test('policy bounds capacity, queue length, and queue deadline', () => {
  assert.deepEqual(resolveProviderAdmissionPolicy('ollama', {}), { concurrency: 1, maxQueue: 16, waitTimeoutMs: 30000 });
  assert.deepEqual(resolveProviderAdmissionPolicy('ollama', { PROVIDER_ADMISSION_OLLAMA_CONCURRENCY:'2',
    PROVIDER_ADMISSION_MAX_QUEUE:'8', PROVIDER_ADMISSION_WAIT_MS:'1500' }), { concurrency:2,maxQueue:8,waitTimeoutMs:1500 });
  assert.throws(() => resolveProviderAdmissionPolicy('ollama', { PROVIDER_ADMISSION_OLLAMA_CONCURRENCY:'0' }));
});

test('headers do not release a slot, consuming the body releases it', async () => {
  let starts = 0;
  const wrapped = createProviderAdmissionFetch(async () => { starts++; return new Response('answer'); }, options());
  const first = await wrapped('http://unused');
  const pending = wrapped('http://unused');
  await turn(); assert.equal(starts,1);
  assert.equal(await first.text(), 'answer');
  const second = await pending; assert.equal(starts,2); await second.text();
});

test('same endpoint shares capacity across model wrappers and aliases', async () => {
  const config = options(); let starts=0;
  const fetch = async () => { starts++; return new Response('ok'); };
  const a=createProviderAdmissionFetch(fetch,config);
  const b=createProviderAdmissionFetch(fetch,{ ...config, baseUrl:config.baseUrl+'/' });
  const first=await a('http://unused'); const pending=b('http://unused');
  await turn(); assert.equal(starts,1); await first.text(); await (await pending).text(); assert.equal(starts,2);
  assert.equal(createProviderAdmissionFetch(a,config),a);
});

test('a terminal stream frame releases on actual EOF even when SDK does not read done again', async () => {
  let starts=0;
  const wrapped=createProviderAdmissionFetch(async()=>{starts++; return new Response('terminal');}, options());
  const response=await wrapped('http://unused');const reader=response.body.getReader();
  assert.equal((await reader.read()).done,false);
  reader.releaseLock();
  const next=await wrapped('http://unused');assert.equal(starts,2);await next.text();
});

test('network terminal frame followed by asynchronous EOF releases without another SDK read', async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/x-ndjson' });
    response.write('{"done":true}\n');
    setTimeout(() => response.end(), 10);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const wrapped = createProviderAdmissionFetch(fetch, options({ baseUrl, policy: { concurrency: 1, maxQueue: 2, waitTimeoutMs: 200 } }));
  try {
    const first = await wrapped(baseUrl);
    const reader = first.body.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value), /done/);
    reader.releaseLock(); // Ollama stops at its terminal frame instead of consuming EOF.
    assert.equal(await (await wrapped(baseUrl)).text(), '{"done":true}\n');
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('Ollama terminal frames cancel trailing network chunks before releasing provider capacity', async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/x-ndjson' });
    response.write('{"done":true}\n');
    setTimeout(() => response.write('\n'), 15);
    setTimeout(() => response.end('\n'), 30);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const wrapped = createProviderAdmissionFetch(fetch, options({ baseUrl, policy: { concurrency: 1, maxQueue: 2, waitTimeoutMs: 200 } }));
  try {
    const first = await wrapped(baseUrl + '/api/chat');
    const reader = first.body.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value), /done/);
    reader.releaseLock();
    assert.match(await (await wrapped(baseUrl + '/api/chat')).text(), /done/);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('localhost and loopback share one Ollama capacity limit', async () => {
  const config=options();let starts=0;const native=async()=>{starts++;return new Response('ok');};
  const loopback=createProviderAdmissionFetch(native,config);
  const localhost=createProviderAdmissionFetch(native,{...config,baseUrl:config.baseUrl.replace('127.0.0.1','localhost')});
  const held=await loopback('http://unused');const queued=localhost('http://unused');
  await turn();assert.equal(starts,1);await held.text();await(await queued).text();assert.equal(starts,2);
});

test('waiting cancellation and deadline never dispatch queued work', async () => {
  let starts=0; const config=options({policy:{ concurrency:1,maxQueue:3,waitTimeoutMs:20 }});
  const wrapped=createProviderAdmissionFetch(async()=>{starts++;return new Response('ok');},config);
  const first=await wrapped('http://unused'); const controller=new AbortController();
  const cancelled=wrapped('http://unused',{signal:controller.signal}); controller.abort();
  await assert.rejects(cancelled,e=>e.name==='AbortError');
  await assert.rejects(wrapped('http://unused'),e=>e.code==='PROVIDER_QUEUE_TIMEOUT');
  assert.equal(starts,1); await first.text();
});

test('a full queue rejects immediately and frees cancelled positions', async () => {
  const wrapped=createProviderAdmissionFetch(async()=>new Response('ok'),options({policy:{concurrency:1,maxQueue:1,waitTimeoutMs:1000}}));
  const first=await wrapped('http://unused'); const controller=new AbortController();
  const second=wrapped('http://unused',{signal:controller.signal});
  await assert.rejects(wrapped('http://unused'),e=>e.code==='PROVIDER_QUEUE_FULL'&&e.status===503);
  controller.abort(); await assert.rejects(second); await first.text(); await (await wrapped('http://unused')).text();
});

test('interactive requests get priority but background work cannot starve', async () => {
  const config=options(); const order=[];
  const native=async url=>{order.push(url);return new Response('ok');};
  const interactive=createProviderAdmissionFetch(native,config);
  const background=createProviderAdmissionFetch(native,{...config,priority:'background'});
  const held=await interactive('held');
  const bg=background('background').then(response=>response.text());
  const jobs=Array.from({length:7},(_,i)=>interactive('interactive-'+i).then(response=>response.text()));
  await held.text(); await Promise.all([bg,...jobs]);
  assert.ok(order.indexOf('background')>1);
  assert.ok(order.indexOf('background')<=4,order.join(','));
  assert.deepEqual(order.filter(x=>x.startsWith('interactive')),Array.from({length:7},(_,i)=>'interactive-'+i));
});

test('non-cooperative fetch abort retains capacity until transport settles', async () => {
  const gate=deferred();let starts=0;const controller=new AbortController();
  const wrapped=createProviderAdmissionFetch(async()=>{starts++; if(starts===1)return gate.promise;return new Response('next');},options());
  const first=wrapped('http://unused',{signal:controller.signal}); await turn(); controller.abort();
  const next=wrapped('http://unused'); await turn();assert.equal(starts,1);
  gate.reject(new DOMException('Aborted','AbortError')); await assert.rejects(first);
  await(await next).text();assert.equal(starts,2);
});

test('body cancellation retains capacity until underlying cancellation completes', async () => {
  const cancellation=deferred();let starts=0;
  const wrapped=createProviderAdmissionFetch(async()=>{starts++; return starts===1
    ? new Response(new ReadableStream({cancel:()=>cancellation.promise})) : new Response('next');},options());
  const first=await wrapped('http://unused'); const pending=wrapped('http://unused');
  const cancelled=first.body.cancel();await turn();assert.equal(starts,1);
  cancellation.resolve();await cancelled;await(await pending).text();assert.equal(starts,2);
});

test('abort during a pending body read cannot release before underlying cancellation settles', async () => {
  const cancellation=deferred();let starts=0;const controller=new AbortController();
  const wrapped=createProviderAdmissionFetch(async()=>{starts++;return starts===1
    ? new Response(new ReadableStream({cancel:()=>cancellation.promise})) : new Response('next');},options());
  const first=await wrapped('http://unused',{signal:controller.signal});const reading=first.text();
  const pending=wrapped('http://unused');controller.abort();await assert.rejects(reading);await turn();assert.equal(starts,1);
  cancellation.resolve();await(await pending).text();assert.equal(starts,2);
});

test('transport and body failures release capacity, cancellation never affects another endpoint', async () => {
  let starts=0;const wrapped=createProviderAdmissionFetch(async()=>{starts++;if(starts===1)throw new Error('offline');
    if(starts===2)return new Response(new ReadableStream({pull(controller){controller.error(new Error('broken'));}}));
    return new Response('ok');},options());
  await assert.rejects(wrapped('http://unused'),/offline/);
  await assert.rejects((await wrapped('http://unused')).text(),/broken/);
  assert.equal(await(await wrapped('http://unused')).text(),'ok');
  const a=createProviderAdmissionFetch(async()=>new Response('held'),options());await a('http://unused');
  const b=createProviderAdmissionFetch(async()=>new Response('independent'),options());
  assert.equal(await(await b('http://unused')).text(),'independent');
});
