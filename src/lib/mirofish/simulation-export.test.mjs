import assert from 'node:assert/strict';import {registerHooks} from 'node:module';import test from 'node:test';
registerHooks({resolve(s,c,n){try{return n(s,c);}catch(e){if(e.code==='ERR_MODULE_NOT_FOUND'&&s.startsWith('.')&&!s.endsWith('.ts'))return n(`${s}.ts`,c);throw e;}}});
const {exportSimulation}=await import('./simulation-export.ts');
const profile={entity_id:'uuid-same-name',entity_name:'=formula',full_name:'=formula',background:'quoted "facts"',personality_traits:['careful'],speaking_style:'brief',viewpoints:{policy:'support'},generated_at:'2026-11-05'};
const snapshot={info:{agent_profiles:[profile]},actions:[{sequence:1,round:1,platform:'twitter',agentId:'uuid-same-name',action:'post',success:true,content:'=malicious'}]};
test('Twitter CSV uses stable zero-based platform ids, quotes fields and protects spreadsheet cells',()=>{const out=exportSimulation(snapshot,'twitter-csv');assert.equal(out.extension,'csv');assert.match(out.content,/"0","'=formula","agent_0"/);assert.match(out.content,/quoted ""facts""/);});
test('Reddit export preserves original UUID alongside required user_id and complete persona',()=>{const rows=JSON.parse(exportSimulation(snapshot,'reddit-json').content);assert.equal(rows[0].entity_id,'uuid-same-name');assert.equal(rows[0].user_id,0);assert.match(rows[0].persona,/policy: support/);});
test('action CSV exports real outcomes rather than fabricated content posts',()=>{const out=exportSimulation(snapshot,'actions-csv');assert.match(out.content,/"success"/);assert.match(out.content,/"'=malicious"/);});
