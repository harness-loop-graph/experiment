// Unit tests for the runner's --harness-config wiring (T6). Uses glm's own
// fixture MCP server + skill fixtures rather than talking to a real model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { McpToolProvider } from '../../glm/dist/index.js';
import { loadHarnessExtras, buildHarness } from './run-experiment.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GLM_TESTS_DIR = path.resolve(__dirname, '..', '..', 'glm', 'tests');
const FIXTURE_MCP_SERVER = path.join(GLM_TESTS_DIR, 'fixtures', 'mcp-fixture-server.mjs');
const FIXTURE_SKILLS_DIR = path.join(GLM_TESTS_DIR, 'fixtures', 'skills');

async function writeHarnessConfigFile(dir, { skillsDirs } = {}) {
  const file = path.join(dir, 'harness-config.json');
  await fs.writeFile(
    file,
    JSON.stringify({
      mcpServers: {
        fixture: { command: 'node', args: [FIXTURE_MCP_SERVER] },
      },
      skillsDirs: skillsDirs ?? [FIXTURE_SKILLS_DIR],
    }),
  );
  return file;
}

test('loadHarnessExtras() reports MCP tools + skill metadata for run-report.json', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-config-'));
  let extras;
  try {
    const configPath = await writeHarnessConfigFile(workspace);
    extras = await loadHarnessExtras(configPath);

    assert.deepEqual(extras.metadata.mcpServers, ['fixture']);
    assert.deepEqual(
      [...extras.metadata.toolNames].sort(),
      ['load_skill', 'mcp__fixture__echo', 'mcp__fixture__fail'].sort(),
    );
    assert.deepEqual(extras.metadata.skillNames, ['writing-tests']);
    assert.equal(extras.metadata.path, configPath);
    assert.equal(typeof extras.metadata.sha256, 'string');
  } finally {
    await extras?.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test('buildHarness() registers MCP tools + load_skill and extends the guardrail allowlist', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-harness-'));
  let extras;
  try {
    const configPath = await writeHarnessConfigFile(workspace);
    extras = await loadHarnessExtras(configPath);

    const { tools, guardrails } = buildHarness(workspace, {}, 5, path.join(workspace, 'audit.jsonl'), extras);

    const names = tools.getSpecs().map((s) => s.name).sort();
    assert.deepEqual(names, [
      'load_skill',
      'mcp__fixture__echo',
      'mcp__fixture__fail',
      'read_file',
      'run_command',
      'write_file',
    ]);

    for (const tool of ['mcp__fixture__echo', 'mcp__fixture__fail', 'load_skill']) {
      const decision = await guardrails.evaluate({ kind: 'tool', tool, args: {} });
      assert.equal(decision.decision, 'allowed', `${tool} should be allowed by the extended guardrail policy`);
    }
  } finally {
    await extras?.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test('buildHarness() without a --harness-config builds the same tool set as before', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-no-config-'));
  try {
    const { tools, guardrails } = buildHarness(workspace, {}, 5, path.join(workspace, 'audit.jsonl'), null);

    const names = tools.getSpecs().map((s) => s.name).sort();
    assert.deepEqual(names, ['read_file', 'run_command', 'write_file']);

    const decision = await guardrails.evaluate({ kind: 'tool', tool: 'mcp__fixture__echo', args: {} });
    assert.equal(decision.decision, 'denied');
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test('loadHarnessExtras() closes the MCP provider when the skills load fails', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-skills-fail-'));
  const closeCalls = [];
  const originalClose = McpToolProvider.prototype.close;
  McpToolProvider.prototype.close = function patchedClose(...args) {
    closeCalls.push(this);
    return originalClose.apply(this, args);
  };
  try {
    const configPath = await writeHarnessConfigFile(workspace, {
      skillsDirs: [path.join(workspace, 'no-such-skills-dir')],
    });

    await assert.rejects(() => loadHarnessExtras(configPath), /Cannot read skills directory/);
    assert.equal(closeCalls.length, 1, 'the MCP provider must be closed when SkillCatalog.load() fails');
  } finally {
    McpToolProvider.prototype.close = originalClose;
    await fs.rm(workspace, { recursive: true, force: true });
  }
});
