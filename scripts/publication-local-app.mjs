import { execFile, spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { pathToFileURL } from 'node:url';
import { readSandboxConfig } from '../deploy/publication-sandbox/sandbox.mjs';

/** Next loads repository env files itself. Reserve their keys as empty so an
 * isolated reader never inherits the legacy application's administrator keys. */
export function isolatedBaseEnvironment(inherited=process.env, directory=process.cwd()) {
  const env={};
  for(const key of ['PATH','Path','PATHEXT','SystemRoot','SYSTEMROOT','WINDIR','ComSpec','COMSPEC','TEMP','TMP',
    'USERPROFILE','APPDATA','LOCALAPPDATA','HOMEDRIVE','HOMEPATH','ProgramFiles','ProgramFiles(x86)','PROGRAMDATA']) {
    if(inherited[key]!==undefined)env[key]=inherited[key];
  }
  for(const name of ['.env','.env.local','.env.development','.env.development.local']) {
    const file=join(directory,name);
    if(existsSync(file))for(const key of Object.keys(parseEnv(readFileSync(file,'utf8')))) {
      if(!(key in env))env[key]='';
    }
  }
  return env;
}

function main() {
const id=process.argv[2];
const port=process.argv[3]??'43107';
if(process.argv.length<3||process.argv.length>4||!id||!/^\d{4,5}$/.test(port)||Number(port)<1024||Number(port)>65535)
  throw new Error('Usage: node scripts/publication-local-app.mjs <sandbox-id> [port:1024-65535]');
const c=readSandboxConfig(id);
const citationFile=join(c.path,'citation-keys.json');
if(!existsSync(citationFile))writeFileSync(citationFile,JSON.stringify({local:randomBytes(32).toString('base64')}),{flag:'wx',mode:0o600});
const env={...isolatedBaseEnvironment(),NODE_ENV:'development',NODE_OPTIONS:'--max-old-space-size=4096',RAG_PUBLICATION_ISOLATED_APP:'true',
  RAG_UNIFIED_PUBLICATION_MODE:'active',RAG_UNIFIED_PUBLICATION_ACCEPT_REQUESTS:'true',RAG_ACCESS_MODE:'local-dev',
  RAG_PERSISTENCE_BACKEND:'postgres',POSTGRES_SSL_MODE:'disable',
  RAG_CITATION_KEYS:readFileSync(citationFile,'utf8'),RAG_CITATION_ACTIVE_KEY_ID:'local',
  RAG_CITATION_ISSUER:'publication-local',RAG_CITATION_ENVIRONMENT:`isolated-${id}`,
  RAG_CITATION_TTL_SECONDS:'86400',RAG_CITATION_MAX_TTL_SECONDS:'604800',
  RAG_CITATION_KEY_RETIREMENTS:'{}',RAG_CITATION_REVOKED_KEY_IDS:'',
  DATABASE_URL:`postgresql://pub_app:${c.credentials.dbApp}@127.0.0.1:${c.ports.postgres}/${c.database}`,
  RAG_DEFAULT_TENANT_ID:'publication-demo-tenant',RAG_DEFAULT_CORPUS_ID:'publication-demo-corpus',
  EMBEDDING_PROVIDER:'ollama',OLLAMA_BASE_URL:'http://127.0.0.1:11434',OLLAMA_EMBEDDING_MODEL:'nomic-embed-text',
  MODEL_PROVIDER:'ollama',REASONING_PROVIDER:'ollama',OLLAMA_LLM_MODEL:'llama3.1:latest',FAST_LLM_MODEL:'qwen2.5:0.5b',
  ELASTICSEARCH_URL:`https://127.0.0.1:${c.ports.elasticsearch}`,ELASTICSEARCH_USERNAME:'pub_reader',ELASTICSEARCH_PASSWORD:c.credentials.esReader,
  ELASTICSEARCH_CA_CERT_PATH:`${c.path}/tls.crt`,MILVUS_PROVIDER:'local',MILVUS_DEFAULT_DATABASE:'default',
  MILVUS_LOCAL_USERNAME:'pub_reader',MILVUS_LOCAL_PASSWORD:c.credentials.milvusReader,
  MILVUS_LOCAL_ADDRESS:`127.0.0.1:${c.ports.milvus}`,MILVUS_TOKEN:`pub_reader:${c.credentials.milvusReader}`};
env.POSTGRES_URL=env.DATABASE_URL;
env.ELASTICSEARCH_API_KEY='';
const child=spawn(process.execPath,['node_modules/next/dist/bin/next','dev','-H','127.0.0.1','-p',port],{env,stdio:'inherit',windowsHide:true});
// Next's CLI owns another Node worker on Windows. Stop this owned tree so a
// restart cannot silently leave a previous reader process listening.
let stopping=false;
for(const event of ['SIGINT','SIGTERM'])process.once(event,()=>{
  if(stopping)return;stopping=true;
  if(process.platform==='win32'&&child.pid)execFile('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true},()=>{});
  else child.kill();
});
child.once('exit',code=>{process.exitCode=code??1;});
child.once('error',()=>{process.stderr.write('Isolated application failed to start.\n');process.exitCode=1;});
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main();
