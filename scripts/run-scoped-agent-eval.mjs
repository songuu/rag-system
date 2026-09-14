#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && /^\.\.?\//.test(specifier) && !path.extname(specifier)) {
      return next(specifier + '.ts', context);
    }
    throw error;
  }
}});
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function parseArguments(args) {
  const options = { numPredict: 700, think: undefined, decisionMode: 'structured', provider: 'fake', model: 'llama3.1', variants: [], trials: 1, maxDurationMs: 120_000,
    fixture: path.join(projectRoot, 'src/lib/rag/eval/fixtures/scoped-agent-v1.json'), output: undefined, gate: false, help: false };
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--help' || flag === '-h') { options.help = true; continue; }
    if (flag === '--gate') { options.gate = true; continue; }
    if (!['--provider', '--model', '--variant', '--trials', '--fixture', '--output', '--max-duration-ms', '--decision-mode', '--think', '--num-predict'].includes(flag)) {
      throw new Error('unknown argument: ' + flag);
    }
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error(flag + ' requires a value');
    if (flag === '--think') {
      if (!['on', 'off'].includes(value)) throw new Error('--think must be on or off');
      options.think = value;
    } else if (flag === '--num-predict') {
      if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 8192) throw new Error('--num-predict must be 1 through 8192');
      options.numPredict = Number(value);
    } else if (flag === '--decision-mode') {
      if (!['native-tools', 'structured'].includes(value)) throw new Error('--decision-mode must be native-tools or structured');
      options.decisionMode = value;
    } else if (flag === '--provider') {
      if (!['fake', 'ollama'].includes(value)) throw new Error('--provider must be fake or ollama');
      options.provider = value;
    } else if (flag === '--model') {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(value)) throw new Error('--model must be a model identifier');
      options.model = value;
    } else if (flag === '--variant') {
      if (!['snapshot', 'rerank', 'iterative'].includes(value)) throw new Error('--variant must be snapshot, rerank or iterative');
      if (!options.variants.includes(value)) options.variants.push(value);
    } else if (flag === '--trials') {
      if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 10) throw new Error('--trials must be 1 through 10');
      options.trials = Number(value);
    } else if (flag === '--max-duration-ms') {
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1 || Number(value) > 3_600_000) {
        throw new Error('--max-duration-ms must be 1 through 3600000');
      }
      options.maxDurationMs = Number(value);
    } else if (flag === '--fixture') options.fixture = path.resolve(value);
    else if (flag === '--output') options.output = path.resolve(value);
  }
  if (!options.variants.length) options.variants = ['snapshot', 'rerank', 'iterative'];
  return options;
}

export async function main(args = process.argv.slice(2)) {
  let timer;
  try {
    const options = parseArguments(args);
    if (options.help) {
      console.log('Usage: node scripts/run-scoped-agent-eval.mjs [--provider fake|ollama] [--decision-mode native-tools|structured] [--model llama3.1] [--think on|off] [--num-predict 1..8192] [--variant snapshot|rerank|iterative] [--trials 1..10] [--fixture path] [--output path] [--max-duration-ms 120000] [--gate]\nDefault: hermetic fake, all three variants; iterative uses structured decisions, --decision-mode native-tools retains the native control. --variant may repeat. Duration is a total run deadline. --gate adds strict e1b quality checks; security and budget checks always apply. Ollama uses http://127.0.0.1:11434, retries disabled, no fake fallback. num-predict defaults to 700; think defaults to off for Qwen3 and otherwise the provider default. Thinking remains private; only provider usage totals are reported.');
      return 0;
    }
    const [{ parseRagEvalDataset }, { runRagEval }, { evaluateRagEvalGate }, { createScopedAgentEvalTarget }, fixtureProvider] = await Promise.all([
      import('../src/lib/rag/eval/dataset.ts'), import('../src/lib/rag/eval/runner.ts'), import('../src/lib/rag/eval/gate.ts'),
      import('../src/lib/rag/eval/scoped-agent-target.ts'), import('../src/lib/rag/eval/scoped-agent-fixture-provider.ts'),
    ]);
    const runtime = await import('../src/lib/rag/agents/scoped-retrieval-agent.ts');
    const dataset = parseRagEvalDataset(JSON.parse(await readFile(options.fixture, 'utf8')));
    const ChatOllama = options.provider === 'ollama' ? (await import('@langchain/ollama')).ChatOllama : undefined;
    const modelParameters = ChatOllama ? { temperature: 0, numPredict: options.numPredict,
      ...(options.think ? { think: options.think === 'on' } : options.model.startsWith('qwen3') ? { think: false } : {}) } : {};
    const controller = new AbortController();
    timer = setTimeout(() => controller.abort(new Error('[scoped-agent eval] total CLI deadline exceeded')), options.maxDurationMs);
    const runId = 'scoped-agent-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8);
    const output = options.output ?? path.join(projectRoot, '.codex-tmp/rag-eval/scoped-agent', runId + '.json');
    const reports = [];
    let stoppedOnFailure = false;
    outer: for (const variant of options.variants) {
      for (let trial = 1; trial <= options.trials; trial++) {
        const target = createScopedAgentEvalTarget({
          id: 'scoped-agent-' + variant, mode: variant, decisionMode: options.decisionMode, signal: controller.signal, providerRetries: 0,
          retrieve: fixtureProvider.createScopedFixtureRetriever(),
          rerank: fixtureProvider.rerankScopedFixtureEvidence,
          modelFactory: ({ signal }) => ChatOllama
            ? new ChatOllama({ model: options.model, baseUrl: 'http://127.0.0.1:11434',
              ...modelParameters, maxRetries: 0,
              fetch: (input, init) => fetch(input, { ...init,
                signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal }) })
            : fixtureProvider.createScopedFixtureModel(),
          budget: { maxDurationMs: options.maxDurationMs, maxContextTokens: 2_000, maxEvidence: 6, maxSearches: 2 },
        });
        const report = await runRagEval(dataset, target, {
          topK: 2, runId: runId + '-' + variant + '-' + trial,
          metadata: {
            runtime: runtime.SCOPED_RETRIEVAL_AGENT_RUNTIME,
            promptVersion: variant === 'iterative'
              ? options.decisionMode === 'structured' ? runtime.SCOPED_STRUCTURED_AGENT_PROMPT_VERSION : runtime.SCOPED_ITERATIVE_AGENT_PROMPT_VERSION
              : runtime.SCOPED_RETRIEVAL_AGENT_PROMPT_VERSION,
            decisionMode: variant === 'iterative' ? options.decisionMode : 'native-tools',
            modelParameters,
            provider: options.provider, model: ChatOllama ? options.model : 'extractive-tool-fake', variant, trial,
            retrieval: 'deterministic-scoped-lexical-fixture', rerank: variant === 'snapshot' ? 'disabled' : 'fixture-trust-lexical',
            productionQualityMeasured: false, citationValidation: 'reference-only',
            abstentionMeasurement: variant === 'iterative' && options.decisionMode === 'structured'
              ? 'empty-context-or-structured-decision' : 'empty-context-or-explicit-text-rule', providerRetries: 0,
          },
        });
        const measured = Boolean(ChatOllama && report.cases.some(item => item.trajectory?.modelResponseCount > 0));
        report.metadata.realModelMeasured = measured;
        const securityViolations = Object.values(report.summary.security).reduce((sum, value) => sum + value, 0);
        const budgetViolations = report.cases.flatMap(item => item.trajectory?.budgetViolations ?? []);
        const qualityGate = evaluateRagEvalGate(report, 'e1b');
        const gate = {
          securityPassed: securityViolations === 0, budgetPassed: budgetViolations.length === 0, budgetViolations,
          executionPassed: report.summary.failedCases === 0 && report.summary.completedCases > 0,
          quality: qualityGate, strictQualityRequired: options.gate,
        };
        gate.passed = gate.securityPassed && gate.budgetPassed && gate.executionPassed && (!options.gate || qualityGate.passed);
        const artifact = { ...report, gate };
        reports.push(artifact);
        await writeJson(path.join(path.dirname(output), path.basename(output, path.extname(output)) + '-' + variant + '-' + trial + '.json'), artifact);
        console.log('[scoped-agent eval] variant=' + variant + ' trial=' + trial
          + ' completed=' + report.summary.completedCases + '/' + report.summary.totalCases
          + ' factCoverage=' + report.summary.meanRequiredFactCoverage
          + ' citationValidity=' + report.summary.citation.meanValidity
          + ' qualityPassed=' + qualityGate.passed + ' securityPassed=' + gate.securityPassed + ' budgetPassed=' + gate.budgetPassed);
        // After any failed execution no new model/provider is constructed. A
        // non-cooperative timed-out promise therefore cannot accumulate in parallel.
        if (!gate.executionPassed || controller.signal.aborted) { stoppedOnFailure = true; break outer; }
      }
    }
    const summary = {
      requestedRuns: options.variants.length * options.trials, completedRuns: reports.length, stoppedOnFailure,
      realModelMeasured: reports.some(report => report.metadata.realModelMeasured), productionQualityMeasured: false,
      fixtureRetrieval: true, provider: options.provider, model: ChatOllama ? options.model : 'extractive-tool-fake',
      securityPassed: reports.every(report => report.gate.securityPassed),
      budgetPassed: reports.every(report => report.gate.budgetPassed),
      qualityPassed: reports.every(report => report.gate.quality.passed),
      passed: reports.length > 0 && reports.every(report => report.gate.passed) && !stoppedOnFailure,
    };
    await writeJson(output, { schemaVersion: 'scoped-agent-eval/v1', runId, summary, reports });
    console.log('[scoped-agent eval] report=' + output);
    return stoppedOnFailure ? 1 : summary.passed ? 0 : 2;
  } catch (error) {
    // Do not emit provider errors or full stack traces, which may contain payloads.
    console.error('[scoped-agent eval] ' + (error instanceof Error && !timer ? error.message : 'execution failed; no fake fallback was used'));
    return 1;
  } finally { clearTimeout(timer); }
}

async function writeJson(output, value) {
  await mkdir(path.dirname(output), { recursive: true });
  const temporary = output + '.' + randomUUID() + '.tmp';
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', 'utf8');
  await rename(temporary, output);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
