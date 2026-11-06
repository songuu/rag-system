import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import test from 'node:test';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';

const require = createRequire(import.meta.url);
const source = (await build({ entryPoints: ['src/components/mirofish/Step2EnvSetup.tsx'], bundle: true,
  platform: 'node', format: 'cjs', packages: 'external', write: false, logLevel: 'silent' })).outputFiles[0].text;
const fixtureModule = { exports: {} };
vm.runInNewContext(source, { module: fixtureModule, exports: fixtureModule.exports, require,
  fetch: (...args) => globalThis.fetch(...args), AbortController, setTimeout, clearTimeout });
const Step2 = fixtureModule.exports.default;
const profile = { entity_id: 'Student', entity_name: 'Student', full_name: '学生', entity_type: 'Person',
  personality_traits: [], typical_posts: [], viewpoints: {}, background: '已保存的人设',
  speaking_style: '简洁', social_media_style: '简洁', generated_at: '2026-11-05' };
const config = { platforms: ['twitter', 'reddit'], round_count: 10, posts_per_round: 5,
  agents_per_round: 1, temperature: .8, seed_topics: ['agent'], time_interval: 2,
  policy: { agents: { Student: { active_hours: [9], activity_level: .8, posts_per_hour: 1, comments_per_hour: 1, influence_weight: 1 } },
    events: [{ id: 'event-a', round: 0, agent_id: 'Student', content: '保留开场事件', topics: [] }] } };

async function mount(run, overrides = {}) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/mirofish' });
  const previous = new Map();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true, fetch: overrides.fetch ?? (async () => Response.json({ success: true })) })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(dom.window.document.getElementById('root'));
  const props = { projectId: 'project-a', simulationRequirement: 'test', graphNodes: [{ uuid: 'node-student', name: 'Student', labels: ['Person'], summary: 'Student' }],
    profiles: [profile], initialSelectedEntityIds: ['node-student'], initialPrepareId: 'prepare-old', initialConfig: structuredClone(config),
    onProfilesGenerated() {}, onSimulationCreated() {}, onComplete() {}, ...overrides };
  try {
    await act(async () => root.render(React.createElement(Step2, props)));
    const container = dom.window.document.getElementById('root');
    const button = [...container.querySelectorAll('button')].find(button => button.textContent.includes('创建模拟并进入下一步'));
    await run({ container, button, async click() { await act(async () => button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))); } });
  } finally {
    await act(async () => root.unmount()); dom.window.close();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
  }
}

test('a legacy name-based persona can create a simulation for its unique selected graph entity', async () => {
  let payload, created;
  await mount(async ui => {
    assert.equal(ui.button.disabled, false, 'saved Student persona must bind to the selected graph UUID');
    await ui.click();
    assert.equal(payload.profiles[0].entity_id, 'node-student');
    assert.equal(payload.profiles[0].background, profile.background);
    assert.equal(payload.config.policy.events[0].agent_id, 'node-student');
    assert.equal(payload.config.policy.agents['node-student'].activity_level, .8);
    assert.equal(payload.config.round_count, 10);
    assert.equal(created, 'simulation-a');
  }, { async fetch(_url, init) { payload = JSON.parse(init.body); return Response.json({ success: true, simulation: { simulation_id: 'simulation-a' } }); },
    onSimulationCreated(id) { created = id; } });
});

test('unmatched personas keep creation blocked with an accessible explanation', async () => {
  await mount(async ui => {
    assert.equal(ui.button.disabled, true);
    const hint = ui.container.querySelector('#' + ui.button.getAttribute('aria-describedby'));
    assert.ok(hint, 'a disabled create button must explain how to continue');
    assert.match(hint.textContent, /重新准备/);
  }, { profiles: [{ ...profile, entity_id: 'unknown-uuid' }] });
});
