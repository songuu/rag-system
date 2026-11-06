import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React, { act, useState } from 'react';
const require = createRequire(import.meta.url);
const translate = (zh, en) => zh;
async function component(file) {
  const source = (await build({ entryPoints: [fileURLToPath(new URL(file, import.meta.url))], bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false, logLevel: 'silent',
    plugins: [{ name: 'locale-boundary', setup(build) { build.onResolve({ filter: /MiroFishLocaleProvider$/ }, args => ({ path: args.path, external: true })); } }],
  })).outputFiles[0].text;
  const isolated = { exports: {} };
  vm.runInNewContext(source, { module: isolated, exports: isolated.exports,
    require: id => id.endsWith('MiroFishLocaleProvider') ? { useMiroFishLocale: () => ({ locale: 'zh', t: translate }) } : id === 'react-markdown' ? ({ children }) => React.createElement('div', null, children) : require(id),
    fetch: (...args) => globalThis.fetch(...args), AbortController, URLSearchParams, setTimeout, clearTimeout, Error,
  });
  return isolated.exports.default;
}
const Step4 = await component('./Step4Report.tsx');
const Step5 = await component('./Step5Interaction.tsx');
const report = { report_id: 'report-a', simulation_id: 'sim-a', project_id: 'project-a', status: 'completed', stage: 'completed', progress: 100,
 title: 'Saved analysis', summary: 'Evidence summary', outline: { sections: [{ title: 'Chapter' }] }, sections: [{ index: 0, title: 'Chapter', content: 'Verified chapter' }], events: [], key_findings: [], sentiment_trend: [] };
const profiles = ['Alice', 'Bob'].map(name => ({ entity_id: name, entity_name: name, entity_type: 'Person', full_name: name }));
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
async function mount(fetchMock, element, run) {
 const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' }); const before = new Map();
 for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true, fetch: fetchMock })) {
   before.set(key, Object.getOwnPropertyDescriptor(globalThis,key)); Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});
 }
 const { createRoot } = await import('react-dom/client'); const container=dom.window.document.getElementById('root'); const root=createRoot(container);
 const click = async text => { const button=[...container.querySelectorAll('button')].find(v=>v.textContent.includes(text)); assert(button,'Missing '+text); await act(async()=>button.dispatchEvent(new dom.window.MouseEvent('click',{bubbles:true}))); };
 try { await act(async()=>root.render(element)); await run({container,click,dom}); }
 finally { await act(async()=>root.unmount()); dom.window.close(); for(const[key,value]of before){if(value)Object.defineProperty(globalThis,key,value);else delete globalThis[key];} }
}
test('Step4 recovers by simulation and awaits project save before unlocking interaction', async () => {
 let release; const saving = new Promise(resolve=>{release=resolve;}); let saves=0; let complete=0;
 function Harness(){const[id,setId]=useState(null);return React.createElement(Step4,{simulationId:'sim-a',projectId:'project-a',reportId:id,
   async onReportGenerated(value){saves++;await saving;setId(value);},onComplete(){complete++;}});}
 await mount(async()=>json({success:true,report}),React.createElement(Harness),async({container,click})=>{
   assert.equal(saves,1);assert.match(container.textContent,/Verified chapter/);assert.doesNotMatch(container.textContent,/下一步：深度交互/);
   await act(async()=>{release();await saving;});
   assert.match(container.textContent,/下一步：深度交互/); await click('下一步：深度交互'); assert.equal(complete,1);
 });
});
test('Step4 surfaces failed readback and reload only unlocks authoritative completed report', async()=>{
 let valid=false;
 await mount(async()=>valid?json({success:true,report}):json({success:false,error:'source changed'},409),React.createElement(Step4,{simulationId:'sim-a',projectId:'project-a',reportId:'report-a',onReportGenerated(){},onComplete(){}}),async({container,click})=>{
   assert.match(container.textContent,/source changed/);assert.doesNotMatch(container.textContent,/下一步：深度交互/);
   valid=true;await click('重新读取');assert.match(container.textContent,/下一步：深度交互/);
 });
});
test('Step5 loads each object history independently and restores report provenance',async()=>{
 const calls=[];
 await mount(async url=>{calls.push(String(url)); const value=String(url);
   if(value.includes('/report/'))return json({success:true,report});
   if(value.includes('/chat?'))return json({success:true,messages:[{role:'assistant',content:'Report history retained',sources:[{kind:'edge',id:'edge-a',label:'Policy',graphId:'graph-a'}]}]});
   if(value.includes('action=history'))return json({success:true,messages:[{role:'assistant',content:value.includes('Alice')?'Alice private history':'Bob private history'}]});
   return json({success:true,profiles});
 },React.createElement(Step5,{simulationId:'sim-a',reportId:'report-a',agents:profiles}),async({container,dom})=>{
   assert.match(container.textContent,/Report history retained/);assert.match(container.textContent,/查看来源/);
   const selector=container.querySelector('select');
   await act(async()=>{selector.value='Alice';selector.dispatchEvent(new dom.window.Event('change',{bubbles:true}));});
   assert.match(container.textContent,/Alice private history/);assert.doesNotMatch(container.textContent,/Report history retained/);
   await act(async()=>{selector.value='Bob';selector.dispatchEvent(new dom.window.Event('change',{bubbles:true}));});
   assert.match(container.textContent,/Bob private history/);assert.doesNotMatch(container.textContent,/Alice private history/);
   assert(calls.some(value=>value.includes('agent_id=Alice')));assert.match(container.textContent,/报告侧栏/);
 });
});
test('Step4 save failure stays recoverable and retrying save clears the next-step barrier',async()=>{
 let failing=true;let saves=0;
 await mount(async()=>json({success:true,report}),React.createElement(Step4,{simulationId:'sim-a',projectId:'project-a',reportId:null,async onReportGenerated(){saves++;if(failing)throw new Error('Project save failed');},onComplete(){}}),async({container,click})=>{
  assert.match(container.textContent,/Project save failed/);assert.doesNotMatch(container.textContent,/下一步：深度交互/);
  failing=false;await click('重试保存报告');assert.equal(saves,2);assert.match(container.textContent,/下一步：深度交互/);
 });
});
test('Step4 discovery errors can be retried without a saved report ID',async()=>{
 let failing=true;
 await mount(async()=>failing?json({success:false,error:'Discovery unavailable'},503):json({success:true,report}),React.createElement(Step4,{simulationId:'sim-a',projectId:'project-a',reportId:null,onReportGenerated(){},onComplete(){}}),async({container,click})=>{
  assert.match(container.textContent,/Discovery unavailable/);failing=false;await click('重新读取');assert.match(container.textContent,/Verified chapter/);assert.match(container.textContent,/下一步：深度交互/);
 });
});
