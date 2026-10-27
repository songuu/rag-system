import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../', import.meta.url));
const enabled = process.env.RAG_CHAT_BROWSER_E2E === '1';
const evidenceDirectory = path.join(root, 'docs/reports/.diagnostics/neo4j-chat-browser');
const entry = `
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import ChatMessage from './src/components/ChatMessage';
const partition='a'.repeat(64);
let configure;
function App(){
  const [state,setState]=useState({id:1,partition,expiresAt:Date.now()+60000,content:'张三负责项目甲[1]。项目甲属于 Acme[2]。'});
  configure=options=>setState(previous=>({...previous,...options,id:previous.id+1}));
  const citations={version:'rag-citations/v1',status:'available',partition,
    items:[1,2].map(number=>({number,locator:'synthetic-opaque-'+number,expiresAt:state.expiresAt,source:'合成来源'+number})),
    diagnostics:{reason:'ready',citationCount:2,invalidCitationCount:0,unavailableCitationCount:0}};
  const message={id:'synthetic-answer-'+state.id,type:'assistant',timestamp:new Date(0),content:state.content,citations,
    retrievalDetails:{searchResults:[{document:{content:'CACHED_SOURCE_MUST_NEVER_AUTHORIZE',metadata:{source:'缓存来源'}}}]}};
  return <main><header><h1>知识图谱引用浏览器验证</h1><p>实际 ChatMessage 组件 · 合成 API · 非生产资料</p></header>
    <ChatMessage message={message} currentQuery='' highlightMatchingText={value=>value}
      citationPartition={state.partition} citationAccessStatus='ready' citationClockOffsetMs={0}/></main>;
}
window.citationFixture={configure:options=>configure(options)};
createRoot(document.getElementById('root')).render(<App/>);
`;

const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Neo4j citation component browser fixture</title>
<style>
body{margin:0;background:#f6f7fa;color:#172033;font:16px system-ui,sans-serif}main{max-width:900px;margin:36px auto;padding:24px}header{margin-bottom:28px}h1{font-size:24px}header p{color:#5d697a;font-size:14px}button{font:inherit;cursor:pointer;border:1px solid #cdd4df;background:#fff;border-radius:6px;padding:5px 9px;margin:2px}button[aria-label^="查看引用"]{color:#1847a2;background:#e9f0ff;border-color:#b6cdf7}.fixed{position:fixed}.inset-0{inset:0}.z-50{z-index:50}.flex{display:flex}.items-center{align-items:center}.justify-center{justify-content:center}.justify-between{justify-content:space-between}.bg-black\\/50{background:#0008}.p-4{padding:16px}.p-5{padding:20px}.bg-white{background:#fff}.w-full{width:100%}.max-w-2xl{max-width:672px}.rounded-xl{border-radius:12px}.overflow-y-auto{overflow-y:auto}.whitespace-pre-wrap{white-space:pre-wrap}.border-t{border-top:1px solid #d4dae3}.mt-4{margin-top:16px}.mb-4{margin-bottom:16px}.pt-3{padding-top:12px}[role=dialog]{max-height:85vh;box-sizing:border-box;box-shadow:0 10px 40px #13203340}[role=alert]{color:#8c4307}[role=status]{color:#52647a}li{margin:12px 0}svg{max-width:24px;max-height:24px}
</style><div id="root"></div><script src="/bundle.js"></script></html>`;

function playwrightModule() {
  const candidates = [process.env.RAG_BROWSER_PLAYWRIGHT_MODULE, 'playwright', 'playwright-core'];
  if (process.platform === 'win32') candidates.push('C:/App/nvm4w/nodejs/node_modules/agent-browser/node_modules/playwright-core');
  for (const candidate of candidates.filter(Boolean)) {
    try { return require(candidate); } catch { /* Try another installed runtime; never install implicitly. */ }
  }
  throw new Error('Browser E2E requires an installed Playwright runtime; set RAG_BROWSER_PLAYWRIGHT_MODULE.');
}

async function sourceHashes() {
  const paths = ['src/components/ChatMessage.tsx', 'src/components/AnswerProcessingPanel.tsx', 'src/lib/rag/citations/reference-parser.ts'];
  return Object.fromEntries(await Promise.all(paths.map(async file => [file, createHash('sha256').update(await readFile(path.join(root,file))).digest('hex')])));
}

test('actual ChatMessage citation journeys in an isolated Chromium component fixture', {skip: !enabled, timeout:90_000}, async t => {
  const before = await sourceHashes();
  const bundle = await build({stdin:{contents:entry,resolveDir:root,sourcefile:'neo4j-chat-browser-fixture.tsx',loader:'tsx'},bundle:true,write:false,format:'iife',platform:'browser',jsx:'automatic',define:{'process.env.NODE_ENV':'"test"'},logLevel:'silent'});
  const requests = [];
  const checks = [];
  let mode = 'success';
  let pendingFirst;
  let firstReady = () => {};
  const reply = (response,body,status=200) => {
    if (!response.destroyed) {response.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});response.end(JSON.stringify(body));}
  };
  const server=createServer(async(request,response)=>{
    if (request.method==='GET' && request.url==='/') {response.writeHead(200,{'content-type':'text/html; charset=utf-8'});response.end(html);return;}
    if (request.method==='GET' && request.url==='/bundle.js') {response.writeHead(200,{'content-type':'application/javascript; charset=utf-8'});response.end(bundle.outputFiles[0].contents);return;}
    if (request.method==='POST' && request.url==='/rag-api/ask/citations/preview') {
      let raw='';
      for await (const chunk of request) {raw+=chunk;if(raw.length>4096){reply(response,{success:false},413);return;}}
      const body=JSON.parse(raw);
      requests.push({method:request.method,path:request.url,keys:Object.keys(body),locator:body.locator,mode});
      if(mode==='denied'){reply(response,{success:false,error:'INTERNAL_SECRET_MUST_NOT_RENDER'},403);return;}
      if(mode==='late' && body.locator==='synthetic-opaque-1'){pendingFirst=()=>reply(response,{success:true,content:'LATE_SOURCE_ONE',contentTruncated:false});firstReady();return;}
      reply(response,{success:true,source:'合成项目资料.pdf',page:3,content:body.locator.endsWith('2')?'CURRENT_SOURCE_TWO':'服务端重新授权后的合成原文：张三负责项目甲。',contentTruncated:false,relations:[{source:'张三',predicate:'负责',target:'项目甲',fact:'张三负责项目甲'}]});
      return;
    }
    response.writeHead(404);response.end();
  });
  let browser;
  let context;
  const cleanup=async()=>{
    pendingFirst?.();
    await context?.close();context=undefined;
    await browser?.close();browser=undefined;
    if(server.listening) await new Promise(resolve=>server.close(resolve));
  };
  // Also clean up when the optional installed browser cannot launch, before
  // the journey try/finally below has been entered.
  t.after(cleanup);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();
  const url='http://127.0.0.1:'+address.port;
  const {chromium}=playwrightModule();
  browser=await chromium.launch({headless:true,...(process.env.RAG_BROWSER_EXECUTABLE_PATH?{executablePath:process.env.RAG_BROWSER_EXECUTABLE_PATH}:{})});
  context=await browser.newContext({viewport:{width:1100,height:800},serviceWorkers:'block'});
  const page=await context.newPage();
  const pageErrors=[];
  page.on('pageerror',error=>pageErrors.push(error.message));
  const byCitation=number=>page.getByRole('button',{name:'查看引用 '+number,exact:true});
  const dialog=()=>page.getByRole('dialog');
  const open=async options=>{
    await page.goto(url,{waitUntil:'load'});
    await byCitation(1).waitFor({state:'visible'});
    if(options) await page.evaluate(value=>window.citationFixture.configure(value),options);
  };
  try {
    await mkdir(evidenceDirectory,{recursive:true});
    await t.test('on-demand source fetch and relation direction render in the real component',async()=>{
      mode='success';await open();
      assert.equal(requests.length,0);
      await byCitation(1).click();
      await dialog().getByText('服务端重新授权后的合成原文：张三负责项目甲。',{exact:true}).waitFor();
      assert.match(await dialog().innerText(),/张三 → 负责 → 项目甲/);
      assert.equal((await dialog().innerText()).includes('CACHED_SOURCE_MUST_NEVER_AUTHORIZE'),false);
      assert.deepEqual(requests[0].keys,['locator']);
      await page.screenshot({path:path.join(evidenceDirectory,'authorized-source.png'),fullPage:true});
      await page.keyboard.press('Escape');
      await dialog().waitFor({state:'detached'});
      checks.push('authorized source and directed relation');
    });
    await t.test('Markdown code, links and unknown numbers remain inert text',async()=>{
      await open({content:'事实[1]，重复[1]，组合[1,2]，未知[9]。`[1]`\n```text\n[2]\n```\n[1](https://example.test)'});
      await page.waitForFunction(()=>document.querySelectorAll('button[aria-label="查看引用 1"]').length===3);
      assert.equal(await byCitation(1).count(),3);
      assert.equal(await byCitation(2).count(),1);
      assert.equal(await byCitation(9).count(),0);
      assert.equal(await page.locator('a[href="https://example.test"]').count(),0);
      checks.push('Markdown and invalid-number exclusion');
    });
    await t.test('authorization failure never exposes cached source or internal error',async()=>{
      mode='denied';await open();await byCitation(1).click();
      await dialog().getByRole('alert').waitFor();
      const text=await dialog().innerText();
      assert.match(text,/当前无权访问/);
      assert.equal(text.includes('CACHED_SOURCE_MUST_NEVER_AUTHORIZE'),false);
      assert.equal(text.includes('INTERNAL_SECRET_MUST_NOT_RENDER'),false);
      await page.screenshot({path:path.join(evidenceDirectory,'denied-source.png'),fullPage:true});
      checks.push('authorization failure and no cached fallback');
    });
    await t.test('expiry removes actionable citations without a network request',async()=>{
      mode='success';const count=requests.length;
      await open({expiresAt:Date.now()+2000});
      assert.equal(await byCitation(1).count(),1);
      await page.waitForFunction(()=>document.querySelectorAll('button[aria-label="查看引用 1"]').length===0);
      assert.equal(requests.length,count);
      checks.push('live TTL expiry');
    });
    await t.test('account/corpus partition switch closes visible original and disables old handles',async()=>{
      mode='success';await open();await byCitation(1).click();
      await dialog().getByText('服务端重新授权后的合成原文：张三负责项目甲。',{exact:true}).waitFor();
      await page.evaluate(()=>window.citationFixture.configure({partition:'b'.repeat(64)}));
      await dialog().waitFor({state:'detached'});
      assert.equal(await byCitation(1).count(),0);
      assert.equal((await page.locator('body').innerText()).includes('服务端重新授权后的合成原文'),false);
      checks.push('partition switch clearing');
    });
    await t.test('cancelled first reference cannot overwrite a newer source with a late reply',async()=>{
      mode='late';pendingFirst=undefined;await open();
      const ready=new Promise(resolve=>{firstReady=resolve;});
      await byCitation(1).click();
      // The loading state proves the component is waiting; the server may not yet
      // have parsed the POST, so wait on its actual request event, not a timer.
      await dialog().getByRole('status').waitFor();
      let deadline;
      try {await Promise.race([ready,new Promise((_,reject)=>{deadline=setTimeout(()=>reject(new Error('Synthetic preview request did not reach the loopback server.')),5000);})]);}
      finally {clearTimeout(deadline);}
      await page.keyboard.press('Escape');await dialog().waitFor({state:'detached'});
      await byCitation(2).click();await dialog().getByText('CURRENT_SOURCE_TWO',{exact:true}).waitFor();
      pendingFirst();
      assert.equal((await dialog().innerText()).includes('LATE_SOURCE_ONE'),false);
      await page.screenshot({path:path.join(evidenceDirectory,'latest-source.png'),fullPage:true});
      checks.push('cancelled preview and late response isolation');
    });
    assert.deepEqual(pageErrors,[]);
    assert.deepEqual(await sourceHashes(),before,'production component sources changed while the browser fixture ran');
    await writeFile(path.join(evidenceDirectory,'result.json'),JSON.stringify({kind:'synthetic-component-browser-e2e',browser:browser.version(),checks,requests,sourceHashes:before,pageErrors,realNeo4j:false},null,2)+'\n');
  } finally {
    await cleanup();
  }
});
