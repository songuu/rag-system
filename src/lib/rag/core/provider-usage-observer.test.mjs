import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
registerHooks({ resolve(s,c,next) { try { return next(s,c); } catch(e) {
  if(e.code==='ERR_MODULE_NOT_FOUND' && s.startsWith('.') && !s.endsWith('.ts')) return next(s+'.ts',c); throw e;
} } });
const {captureAskProviderUsage,observeProviderInvocation,readAskProviderUsage}=await import('./provider-usage-observer.ts');
test('captures actual invocation counts and provider token metadata only inside the current Ask',async()=>{
  const response=await captureAskProviderUsage(async()=>{
    await observeProviderInvocation('generation',async()=>({usage_metadata:{input_tokens:10,output_tokens:4}}));
    await observeProviderInvocation('embedding',async()=>({prompt_eval_count:20}));
    return Response.json({success:true});
  });
  const usage=readAskProviderUsage(response);assert.equal(usage.tokens.measurement,'provider');
  assert.equal(usage.tokens.inputTokens,10);assert.deepEqual(usage.calls,{generation:1,embedding:1,rerank:0});
  assert.equal(await observeProviderInvocation('generation',async()=>42),42);
  assert.equal(readAskProviderUsage(Response.json({})),undefined);
});
test('partial provider metadata and concurrent requests never become complete totals',async()=>{
  const [a,b]=await Promise.all([
    captureAskProviderUsage(async()=>{await observeProviderInvocation('generation',async()=>({usage_metadata:{input_tokens:7}}));return Response.json({});}),
    captureAskProviderUsage(async()=>{await observeProviderInvocation('generation',async()=>({usage_metadata:{input_tokens:20,output_tokens:3}}));return Response.json({});}),
  ]);
  assert.equal(readAskProviderUsage(a).tokens.measurement,'partial');assert.equal(readAskProviderUsage(a).tokens.inputTokens,7);
  assert.equal(readAskProviderUsage(b).tokens.inputTokens,20);
});

test('preserves original response and result identities without modifying product JSON',async()=>{
  const payload={usage_metadata:{input_tokens:2,output_tokens:1},content:'answer'};
  const expected=Response.json({success:true,answer:'answer'});
  const response=await captureAskProviderUsage(async()=>{
    assert.equal(await observeProviderInvocation('generation',async()=>payload),payload);
    return expected;
  });
  assert.equal(response,expected);assert.deepEqual(await response.json(),{success:true,answer:'answer'});
  const usage=readAskProviderUsage(response);usage.calls.generation=999;
  assert.equal(readAskProviderUsage(response).calls.generation,1);
});

test('unknown metadata, provider errors and malformed metadata never become fabricated zero tokens',async()=>{
  const response=await captureAskProviderUsage(async()=>{
    await observeProviderInvocation('generation',async()=>({usage_metadata:{input_tokens:5,output_tokens:2}}));
    await observeProviderInvocation('generation',async()=>({content:'no usage'}));
    const error=new Error('original provider error');
    await assert.rejects(observeProviderInvocation('generation',async()=>{throw error;}),e=>e===error);
    const opaque={get usage_metadata(){throw Error('opaque metadata');}};
    assert.equal(await observeProviderInvocation('generation',async()=>opaque),opaque);
    return Response.json({});
  });
  const usage=readAskProviderUsage(response);
  assert.equal(usage.tokens.measurement,'partial');assert.equal(usage.tokens.inputTokens,5);
  assert.equal(usage.tokens.outputTokens,2);assert.equal(usage.calls.generation,4);
  const unknown=await captureAskProviderUsage(async()=>{
    await observeProviderInvocation('generation',async()=>({usage_metadata:{input_tokens:-1,output_tokens:Number.NaN}}));
    return Response.json({});
  });
  assert.deepEqual(readAskProviderUsage(unknown).tokens,{measurement:'unavailable'});
  const getter=await captureAskProviderUsage(async()=>{
    await observeProviderInvocation('generation',async()=>({usage_metadata:{input_tokens:7,get output_tokens(){throw Error('opaque output');}}}));
    return Response.json({});
  });
  assert.deepEqual(readAskProviderUsage(getter).tokens,{measurement:'partial',inputTokens:7});
});

test('confirmed no invocation means measured zero, and failed captures preserve original exceptions',async()=>{
  const response=await captureAskProviderUsage(async()=>Response.json({}));
  assert.deepEqual(readAskProviderUsage(response).calls,{generation:0,embedding:0,rerank:0});
  assert.deepEqual(readAskProviderUsage(response).tokens,{measurement:'provider',inputTokens:0,outputTokens:0});
  const error=new Error('original failure');
  await assert.rejects(captureAskProviderUsage(async()=>{throw error;}),e=>e===error);
  await assert.rejects(observeProviderInvocation('generation',async()=>{throw error;}),e=>e===error);
});

test('finished scopes ignore late results and later async provider starts',async()=>{
  let release,late;
  const response=await captureAskProviderUsage(async()=>{
    late=observeProviderInvocation('generation',async()=>new Promise(resolve=>{release=resolve;}));
    return Response.json({});
  });
  assert.equal(readAskProviderUsage(response).tokens.measurement,'unavailable');
  release({usage_metadata:{input_tokens:999,output_tokens:999}});await late;
  assert.equal(readAskProviderUsage(response).tokens.measurement,'unavailable');
  assert.equal(readAskProviderUsage(response).calls.generation,1);
});

test('cancellation closes the observer before noncooperative results arrive',async()=>{
  const controller=new AbortController();let release;
  const pending=captureAskProviderUsage(async()=>{
    await observeProviderInvocation('generation',async()=>new Promise(resolve=>{release=resolve;}));
    return Response.json({});
  },{signal:controller.signal});
  controller.abort();release({usage_metadata:{input_tokens:999,output_tokens:999}});
  assert.equal(readAskProviderUsage(await pending),undefined);
});

test('parallel provider wall time does not exceed the actual Ask wall time',async()=>{
  const response=await captureAskProviderUsage(async()=>{
    await Promise.all([1,2,3].map(()=>observeProviderInvocation('generation',async()=>{
      await new Promise(resolve=>setTimeout(resolve,12));return {usage_metadata:{input_tokens:1,output_tokens:1}};
    })));
    return Response.json({});
  });
  const usage=readAskProviderUsage(response);
  assert.equal(usage.calls.generation,3);assert.equal(usage.tokens.inputTokens,3);
  assert.ok(usage.latencyMs.generation<=usage.latencyMs.total);
  assert.ok(usage.latencyMs.total>=12);
});

test('actual mood reply, conversation classification and semantic candidate paths count fast model calls and raw Ollama tokens',async()=>{
  const {replyToConversation,classifyConversationIntent}=await import('../conversation-chat.ts');
  const {classifyConversationCandidate}=await import('../semantic-conversation-router.ts');
  const previousProvider=process.env.MODEL_PROVIDER, previousRouter=process.env.RAG_SEMANTIC_ROUTER;
  process.env.MODEL_PROVIDER='ollama';delete process.env.RAG_SEMANTIC_ROUTER;
  try {
    let requests=0;
    const response=await captureAskProviderUsage(async()=>{
      const reply=await replyToConversation('我今天很开心',[],{fetch:async()=>{
        requests++;return Response.json({message:{content:JSON.stringify({kind:'chat',answer:'听起来今天过得不错！'})},prompt_eval_count:18,eval_count:6});
      }});
      assert.deepEqual(reply,{answer:'听起来今天过得不错！',modelUsed:true});
      const candidate=await classifyConversationIntent('我是谁',[{role:'user',content:'大家喊我小明'}],{fetch:async()=>{
        requests++;return Response.json({message:{content:JSON.stringify({kind:'session',userTurnIndex:0,quote:'大家喊我小明',answer:''})},prompt_eval_count:10,eval_count:5});
      }});
      assert.equal(candidate.kind,'session');
      const semantic=await classifyConversationCandidate('请告知目前的钟点',{fetch:async()=>{
        requests++;return Response.json({response:JSON.stringify({complete:true,actions:[{intent:'current-time',timeZone:'Asia/Shanghai',dayOffset:0}]}),prompt_eval_count:7,eval_count:4});
      }});
      assert.equal(semantic.actions[0].intent,'current-time');
      return Response.json({success:true,answer:reply.answer});
    });
    assert.equal(requests,3);
    assert.deepEqual(readAskProviderUsage(response).calls,{generation:3,embedding:0,rerank:0});
    assert.deepEqual(readAskProviderUsage(response).tokens,{measurement:'provider',inputTokens:35,outputTokens:15});
  } finally {
    if(previousProvider===undefined)delete process.env.MODEL_PROVIDER;else process.env.MODEL_PROVIDER=previousProvider;
    if(previousRouter===undefined)delete process.env.RAG_SEMANTIC_ROUTER;else process.env.RAG_SEMANTIC_ROUTER=previousRouter;
  }
});

test('raw Ollama usage missing one direction remains partial and its Response body stays readable',async()=>{
  const raw=Response.json({response:'ok',prompt_eval_count:7});
  const response=await captureAskProviderUsage(async()=>{
    assert.equal(await observeProviderInvocation('generation',async()=>raw),raw);
    assert.deepEqual(await raw.json(),{response:'ok',prompt_eval_count:7});
    return Response.json({});
  });
  assert.deepEqual(readAskProviderUsage(response).tokens,{measurement:'partial',inputTokens:7});
});
