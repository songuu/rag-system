import { readFile } from 'node:fs/promises';
const root = new URL('../../../../', import.meta.url);
const { readSandboxConfig } = await import(new URL('deploy/publication-sandbox/sandbox.mjs',root));
const { isolatedBaseEnvironment } = await import(new URL('scripts/publication-local-app.mjs',root));

/** Resolve current ports from the owned sandbox; saved app.env can be stale after restart. */
export async function applySandboxEnvironment() {
  const config = readSandboxConfig('372b94728dedfdab252e037f');
  const c = config.credentials, p = config.ports;
  const env = { ...isolatedBaseEnvironment(), NODE_ENV:'development',
    RAG_PUBLICATION_ISOLATED_APP:'true', RAG_UNIFIED_PUBLICATION_MODE:'active',
    RAG_ACCESS_MODE:'local-dev', RAG_PERSISTENCE_BACKEND:'postgres', POSTGRES_SSL_MODE:'disable',
    RAG_DEFAULT_TENANT_ID:'publication-demo-tenant', RAG_DEFAULT_CORPUS_ID:'publication-demo-corpus',
    MODEL_PROVIDER:'ollama', EMBEDDING_PROVIDER:'ollama', OLLAMA_BASE_URL:'http://127.0.0.1:11434',
    OLLAMA_LLM_MODEL:'llama3.1:latest', FAST_LLM_MODEL:'qwen2.5:0.5b', OLLAMA_EMBEDDING_MODEL:'nomic-embed-text',
    DATABASE_URL:`postgresql://pub_app:${encodeURIComponent(c.dbApp)}@127.0.0.1:${p.postgres}/${config.database}`,
    ELASTICSEARCH_URL:`https://127.0.0.1:${p.elasticsearch}`, ELASTICSEARCH_USERNAME:'pub_reader',
    ELASTICSEARCH_PASSWORD:c.esReader, ELASTICSEARCH_CA_CERT_PATH:config.path+'/tls.crt',
    MILVUS_PROVIDER:'local', MILVUS_DEFAULT_DATABASE:'default', MILVUS_LOCAL_USERNAME:'pub_reader',
    MILVUS_LOCAL_PASSWORD:c.milvusReader, MILVUS_LOCAL_ADDRESS:`127.0.0.1:${p.milvus}`,
    MILVUS_TOKEN:`pub_reader:${c.milvusReader}`,
    RAG_CITATION_KEYS:await readFile(config.path+'/citation-keys.json','utf8'), RAG_CITATION_ACTIVE_KEY_ID:'local',
    RAG_CITATION_ISSUER:'publication-local', RAG_CITATION_ENVIRONMENT:'isolated-'+config.id,
    RAG_CITATION_KEY_RETIREMENTS:'{}', RAG_CITATION_REVOKED_KEY_IDS:'',
    RAG_CITATION_TTL_SECONDS:'86400', RAG_CITATION_MAX_TTL_SECONDS:'604800' };
  env.POSTGRES_URL = env.DATABASE_URL;
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env,env);
  return {root,sandboxId:config.id};
}
