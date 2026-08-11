import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (error?.code === 'ERR_MODULE_NOT_FOUND' && isRelativeImport(specifier)) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
});

const { ReportAgent } = await import('./report-agent.ts');

const SAFE_REPORT = {
  title: '模拟分析报告',
  summary: '报告生成结果无法解析。',
  sections: [{
    index: 0,
    title: '分析内容',
    content: '模型未返回可用的结构化报告。',
    type: 'overview',
  }],
  key_findings: [],
};

const SIMULATION_INFO = {
  simulation_id: 'simulation-1',
  project_id: 'project-1',
  status: 'completed',
  config: {
    simulation_id: 'simulation-1',
    project_id: 'project-1',
    platforms: ['twitter'],
    round_count: 1,
    posts_per_round: 1,
    agents_per_round: 1,
    temperature: 0.8,
    seed_topics: ['topic'],
    time_interval: 1,
  },
  current_round: 1,
  total_posts: 0,
  total_comments: 0,
  total_likes: 0,
  participants: [],
  agent_profiles: [],
  created_at: '2026-08-11T00:00:00.000Z',
  updated_at: '2026-08-11T00:00:00.000Z',
};

test('accepts exact and reasoning-wrapped report objects', async () => {
  const fixtures = [
    {
      response: '{"title":"Exact report","summary":"Exact summary","sections":[{"title":"Overview","content":"Exact content","type":"overview"}],"key_findings":["Exact finding"]}',
      title: 'Exact report',
      summary: 'Exact summary',
    },
    {
      response: '<thinking>discard {"title":"Draft"}</thinking>\n{"title":"Final report","summary":"Final summary","sections":[{"title":"Prediction","content":"Final content","type":"prediction"}],"key_findings":["Final finding"]}',
      title: 'Final report',
      summary: 'Final summary',
    },
  ];

  for (const fixture of fixtures) {
    const report = await createAgent(fixture.response).generateReport(SIMULATION_INFO, [], []);

    assert.equal(report.title, fixture.title);
    assert.equal(report.summary, fixture.summary);
    assert.equal(report.sections.length, 1);
  }
});

test('uses one fixed safe report for rejected responses without retaining raw model text', async () => {
  const secret = 'REPORT-RAW-SECRET-811';
  const rejectedResponses = [
    `{"title":"${secret}"}{"title":"second"}`,
    `[{"title":"${secret}"}]`,
    `{"summary":"${secret}"`,
  ];

  for (const response of rejectedResponses) {
    const report = await createAgent(response).generateReport(SIMULATION_INFO, [], []);

    assert.equal(report.title, SAFE_REPORT.title);
    assert.equal(report.summary, SAFE_REPORT.summary);
    assert.deepEqual(report.sections, SAFE_REPORT.sections);
    assert.deepEqual(report.key_findings, SAFE_REPORT.key_findings);
    assert.doesNotMatch(JSON.stringify(report), new RegExp(secret));
  }
});

test('uses the same safe report for semantically invalid report objects', async () => {
  const secret = 'REPORT-SCHEMA-SECRET-811';
  const invalidResponses = [
    '{}',
    `{"summary":"${secret}","sections":[{"title":"Section","content":"Content","type":"overview"}],"key_findings":[]}`,
    `{"title":"","summary":"${secret}","sections":[{"title":"Section","content":"Content","type":"overview"}],"key_findings":[]}`,
    `{"title":"Title","sections":[{"title":"Section","content":"${secret}","type":"overview"}],"key_findings":[]}`,
    `{"title":"Title","summary":"","sections":[{"title":"Section","content":"${secret}","type":"overview"}],"key_findings":[]}`,
    `{"title":"Title","summary":"${secret}","key_findings":[]}`,
    `{"title":"Title","summary":"${secret}","sections":[],"key_findings":[]}`,
    `{"title":"Title","summary":"${secret}","sections":[null],"key_findings":[]}`,
    `{"title":"Title","summary":"${secret}","sections":["not-an-object"],"key_findings":[]}`,
    `{"title":"Title","summary":"${secret}","sections":[{"title":42,"content":"Content","type":"overview"}],"key_findings":[]}`,
    `{"title":"Title","summary":"${secret}","sections":[{"title":"Section","content":{"private":"${secret}"},"type":"overview"}],"key_findings":[]}`,
    `{"title":"Title","summary":"${secret}","sections":[{"title":"Section","content":"Content","type":"unknown"}],"key_findings":[]}`,
    `{"title":"Title","summary":"${secret}","sections":[{"title":"Section","content":"Content","type":"overview"}]}`,
    `{"title":"Title","summary":"${secret}","sections":[{"title":"Section","content":"Content","type":"overview"}],"key_findings":[{"private":"${secret}"}]}`,
  ];

  for (const response of invalidResponses) {
    const report = await createAgent(response).generateReport(SIMULATION_INFO, [], []);

    assert.equal(report.title, SAFE_REPORT.title);
    assert.equal(report.summary, SAFE_REPORT.summary);
    assert.deepEqual(report.sections, SAFE_REPORT.sections);
    assert.deepEqual(report.key_findings, SAFE_REPORT.key_findings);
    assert.doesNotMatch(JSON.stringify(report), new RegExp(secret));
  }
});

function createAgent(response) {
  const agent = Object.create(ReportAgent.prototype);
  agent.llm = { invoke: async () => ({ content: response }) };
  return agent;
}

function isRelativeImport(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}
