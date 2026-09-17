#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

import {
  Harness,
  AgentLoop,
  GraphEngine,
  GlmModelAdapter,
  FsContextManager,
  LocalExecutionManager,
  PolicyGuardrails,
  RegistryToolManager,
  registerBuiltinTools,
  RecordingVerificationManager,
  DEFAULT_ALLOWED_COMMAND_PREFIXES,
} from '../../glm/dist/index.js';

const DEFAULT_TASK =
  'Read SPEC.md in the workspace root and implement the complete system it describes, ' +
  'following every requirement (RF-01..RF-27), the endpoint catalog, the screens and the delivery contract. ' +
  'Work only inside the workspace.';

const CHAIN = ['architect', 'data', 'backend', 'frontend', 'reviewer'];

function parseArgs(argv) {
  const args = argv.slice(2);
  const parsed = {
    config: null,
    runsDir: path.resolve(__dirname, '..', 'runs'),
    spec: path.resolve(__dirname, '..', 'SPEC.md'),
    taskFile: null,
    maxTurns: 8,
    maxSteps: 12,
    toolRounds: null,
    verifyCmd: 'docker compose up -d --build && curl -sf http://localhost:3000/health',
    withBatteries: false,
    keep: false,
    dryRun: false,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--config') parsed.config = args[++i];
    else if (a === '--runs-dir') parsed.runsDir = path.resolve(args[++i]);
    else if (a === '--spec') parsed.spec = path.resolve(args[++i]);
    else if (a === '--task-file') parsed.taskFile = path.resolve(args[++i]);
    else if (a === '--max-turns') parsed.maxTurns = parseInt(args[++i], 10);
    else if (a === '--max-steps') parsed.maxSteps = parseInt(args[++i], 10);
    else if (a === '--tool-rounds') parsed.toolRounds = parseInt(args[++i], 10);
    else if (a === '--verify-cmd') parsed.verifyCmd = args[++i];
    else if (a === '--with-batteries') parsed.withBatteries = true;
    else if (a === '--keep') parsed.keep = true;
    else if (a === '--dry-run') parsed.dryRun = true;
  }
  if (!parsed.config || !['c1', 'c2', 'c3'].includes(parsed.config)) {
    console.error('Usage: node run-experiment.mjs --config c1|c2|c3 [options]');
    process.exit(1);
  }
  if (parsed.toolRounds == null) {
    parsed.toolRounds = parsed.config === 'c1' ? 80 : 30;
  }
  return parsed;
}

async function loadCredentials() {
  let apiKey = process.env.MODEL_API_KEY;
  let modelId = process.env.MODEL_ID;
  if (!apiKey || !modelId) {
    try {
      const envPath = path.resolve(__dirname, '..', '..', 'glm', '.env');
      const text = await fs.readFile(envPath, 'utf-8');
      for (const line of text.split('\n')) {
        const idx = line.indexOf('=');
        if (idx === -1) continue;
        const key = line.slice(0, idx).trim();
        const value = line.slice(idx + 1).trim();
        if (key === 'MODEL_API_KEY' && !apiKey) apiKey = value;
        if (key === 'MODEL_ID' && !modelId) modelId = value;
      }
    } catch { /* ignore */ }
  }
  if (!apiKey || !modelId) {
    console.error('Missing MODEL_API_KEY and/or MODEL_ID. Set in environment or glm/.env.');
    process.exit(1);
  }
  return { apiKey, modelId };
}

async function createWorkspace(runsDir, config, specPath, { dryRun = false } = {}) {
  const ts = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
  const ws = path.join(runsDir, `${config}-${ts}`);
  if (dryRun) return ws;
  await fs.mkdir(ws, { recursive: true });
  await fs.copyFile(specPath, path.join(ws, 'SPEC.md'));
  return ws;
}

function spawnCommand(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timeout;
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} ${args.join(' ')} exited ${code}. stderr: ${stderr.slice(0, 500)}`));
    });
    child.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    if (opts.timeoutMs) {
      timeout = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error(`${cmd} ${args.join(' ')} timed out after ${opts.timeoutMs}ms`));
      }, opts.timeoutMs);
    }
  });
}

async function runBatteries(ws, keep) {
  let batteryReport = null;
  let batteryError = null;
  try {
    await spawnCommand('docker', ['compose', 'up', '-d', '--build'], { cwd: ws, timeoutMs: 600_000 });
    let healthy = false;
    for (let i = 0; i < 120; i++) {
      try {
        const res = await fetch('http://localhost:3000/health');
        if (res.ok) { healthy = true; break; }
      } catch { /* ignore */ }
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (!healthy) throw new Error('Health check did not pass within 120s');

    const acceptanceDir = path.resolve(__dirname, '..', 'acceptance');
    const result = await spawnCommand('node', ['run-all.mjs'], {
      cwd: acceptanceDir,
      env: {
        BACKEND_URL: 'http://localhost:3000',
        FRONTEND_URL: 'http://localhost:8080',
        DB_URL: 'postgres://medapp:medapp@localhost:5432/medapp',
        WORKSPACE: ws,
      },
      timeoutMs: 600_000,
    });
    try {
      const lines = result.stdout.trim().split('\n');
      batteryReport = JSON.parse(lines.pop() || '{}');
    } catch {
      batteryReport = { parseError: true, raw: result.stdout.slice(0, 5000) };
    }
    await fs.writeFile(path.join(ws, 'batteries-report.json'), JSON.stringify(batteryReport, null, 2));
  } catch (err) {
    batteryError = err.message;
  } finally {
    if (!keep) {
      try {
        await spawnCommand('docker', ['compose', 'down', '-v'], { cwd: ws, timeoutMs: 120_000 });
      } catch (downErr) {
        if (!batteryError) batteryError = `docker compose down failed: ${downErr.message}`;
      }
    }
  }
  return { batteryReport, batteryError };
}

function buildHarness(ws, model, toolRounds, auditFile) {
  const execution = new LocalExecutionManager({ workspaceRoot: ws, timeoutMs: 600_000 });
  const guardrails = new PolicyGuardrails(
    {
      workspaceRoot: ws,
      allowedTools: ['write_file', 'read_file', 'run_command'],
      allowedCommandPrefixes: DEFAULT_ALLOWED_COMMAND_PREFIXES,
      maxFileBytes: 10 * 1024 * 1024,
    },
    auditFile,
  );
  const tools = new RegistryToolManager(guardrails);
  const availTools = registerBuiltinTools(tools, { execution, workspaceRoot: ws });
  const verification = new RecordingVerificationManager();
  const harness = new Harness(
    { context: new FsContextManager(), model, tools, execution, verification, guardrails },
    {
      workspaceRoot: ws,
      availTools,
      instructions:
        "You are an agent inside a controlled harness. Use the provided tools to complete your task. " +
        "Stay inside the workspace. Finish with a final answer once your task is complete.",
      maxToolRounds: toolRounds,
    },
  );
  return { harness, execution, verification };
}

function buildRouter(ws) {
  return (nodeId, loopResult, state) => {
    const idx = CHAIN.indexOf(nodeId);

    if (nodeId !== 'reviewer') {
      if (loopResult.status === 'SUCCESS') {
        if (idx >= 0 && idx < CHAIN.length - 1) {
          return { action: 'NEXT', node: CHAIN[idx + 1], reason: `${nodeId} succeeded -> NEXT ${CHAIN[idx + 1]}` };
        }
        return { action: 'FINISH', reason: `${nodeId} succeeded at end of chain` };
      }
      const visits = state.visits[nodeId] ?? 0;
      if (visits < 2) {
        return { action: 'NEXT', node: nodeId, reason: `${nodeId} FAILED; retrying (${visits} visits)` };
      }
      return { action: 'FAIL', reason: `${nodeId} FAILED after max retries` };
    }

    if (loopResult.status === 'FAILED') {
      const visits = state.visits['reviewer'] ?? 0;
      if (visits < 2) {
        return { action: 'NEXT', node: 'reviewer', reason: 'reviewer loop FAILED; retrying' };
      }
      return { action: 'FAIL', reason: 'reviewer FAILED after max retries' };
    }

    try {
      const verdictPath = path.join(ws, 'review-verdict.json');
      const verdictText = readFileSync(verdictPath, 'utf-8');
      const verdict = JSON.parse(verdictText);
      if (verdict.acceptable === true) {
        return { action: 'FINISH', reason: 'reviewer accepted the system' };
      }
      const responsible = verdict.responsible;
      if (['data', 'backend', 'frontend'].includes(responsible)) {
        return { action: 'NEXT', node: responsible, reason: `reviewer rejected; responsible=${responsible}` };
      }
      const visits = state.visits['reviewer'] ?? 0;
      if (visits < 2) {
        return { action: 'NEXT', node: 'reviewer', reason: 'reviewer returned unacceptable/none; retrying' };
      }
      return { action: 'FAIL', reason: 'reviewer returned unacceptable after max retries' };
    } catch (err) {
      const visits = state.visits['reviewer'] ?? 0;
      if (visits < 2) {
        return { action: 'NEXT', node: 'reviewer', reason: `reviewer verdict unreadable (${err.message}); retrying` };
      }
      return { action: 'FAIL', reason: 'reviewer verdict unreadable after max retries' };
    }
  };
}

function buildNodes(parsed) {
  return [
    {
      id: 'architect',
      role: 'architect',
      task: 'Write docs/architecture.md: entity model, endpoint-to-screen contract mapping, repo layout. Consult SPEC.md.',
      verification: { command: 'test -f docs/architecture.md' },
      maxTurns: parsed.maxTurns,
      toolRoundsPerTurn: parsed.toolRounds,
    },
    {
      id: 'data',
      role: 'data',
      task: 'Implement the data layer per SPEC: migrations + deterministic seed. Consult SPEC.md.',
      maxTurns: parsed.maxTurns,
      toolRoundsPerTurn: parsed.toolRounds,
    },
    {
      id: 'backend',
      role: 'backend',
      task: 'Implement the NestJS backend per SPEC (endpoint catalog EP-01..EP-20). Consult SPEC.md.',
      maxTurns: parsed.maxTurns,
      toolRoundsPerTurn: parsed.toolRounds,
    },
    {
      id: 'frontend',
      role: 'frontend',
      task: 'Implement the React SPA per SPEC (SCR-01..SCR-08, testability contract). Consult SPEC.md.',
      maxTurns: parsed.maxTurns,
      toolRoundsPerTurn: parsed.toolRounds,
    },
    {
      id: 'reviewer',
      role: 'reviewer',
      task:
        'Review the whole system against SPEC.md and write review-verdict.json with EXACTLY ' +
        '{ "acceptable": boolean, "responsible": "data"|"backend"|"frontend"|"none", "notes": string } ' +
        '— acceptable=true only if the delivery contract holds. Consult SPEC.md.',
      verification: { command: 'test -f review-verdict.json' },
      maxTurns: 2,
      toolRoundsPerTurn: parsed.toolRounds,
    },
  ];
}

function compactTraceC1(result) {
  return result.turns.map((t, i) => ({
    round: i + 1,
    type: t.response.type,
    tool: t.response.type === 'tool_call' ? t.response.tool : undefined,
    verification: t.verification ? { passed: t.verification.passed } : undefined,
  }));
}

function compactTraceC2(loopResult) {
  return loopResult.trace.map((t) => ({
    turn: t.turn,
    phases: t.phases,
    decision: t.decision.action,
    responseType: t.response.type,
    verificationPassed: t.verification?.passed,
  }));
}

function compactTraceC3(graphResult) {
  return graphResult.trace.map((s) => ({
    step: s.step,
    nodeId: s.nodeId,
    loopStatus: s.loopStatus,
    decision: s.decision.action,
    nextNode: s.decision.node,
  }));
}

function truncate(s, n) {
  if (!s || s.length <= n) return s;
  return s.slice(0, n) + ' …';
}

async function main() {
  const parsed = parseArgs(process.argv);
  const { apiKey, modelId } = await loadCredentials();
  const sessionId = randomUUID();
  const ws = await createWorkspace(parsed.runsDir, parsed.config, parsed.spec, { dryRun: parsed.dryRun });

  let task = DEFAULT_TASK;
  if (parsed.taskFile) {
    task = await fs.readFile(parsed.taskFile, 'utf-8');
  }

  if (parsed.dryRun) {
    const plan = {
      workspace: ws,
      config: parsed.config,
      wiring: {
        model: modelId,
        sessionId,
        maxTurns: parsed.maxTurns,
        maxSteps: parsed.maxSteps,
        toolRoundsPerTurn: parsed.toolRounds,
      },
      batteryPhase: parsed.withBatteries,
    };
    if (parsed.config === 'c3') {
      plan.nodes = buildNodes(parsed).map((n) => ({
        id: n.id,
        role: n.role,
        task: n.task,
        verification: n.verification,
        maxTurns: n.maxTurns,
        toolRoundsPerTurn: n.toolRoundsPerTurn,
      }));
      plan.budgets = { maxSteps: parsed.maxSteps, maxTurns: parsed.maxTurns, toolRoundsPerTurn: parsed.toolRounds };
    } else {
      plan.budgets = { maxToolRounds: parsed.toolRounds, maxTurns: parsed.maxTurns };
    }
    console.log(JSON.stringify(plan, null, 2));
    process.exit(0);
  }

  const startedAt = new Date().toISOString();
  const t0 = Date.now();

  let report = {
    config: parsed.config,
    model: modelId,
    startedAt,
    finishedAt: null,
    durationMs: 0,
    status: 'FAILED',
    usage: null,
    turns: 0,
  };

  if (parsed.config === 'c1') {
    const model = new GlmModelAdapter({ apiKey, model: modelId, sessionId });
    const { harness } = buildHarness(ws, model, parsed.toolRounds, path.join(ws, 'audit.jsonl'));
    const result = await harness.run(task, { maxToolRounds: parsed.toolRounds });
    report.status = result.finalResponse.type === 'finish' ? 'SUCCESS' : 'FAILED';
    report.usage = model.getUsage();
    report.turns = result.turns.length;
    report.trace = compactTraceC1(result);
    if (result.finalResponse.type === 'finish') {
      report.finalResponse = truncate(result.finalResponse.content, 2000);
    } else if (result.finalResponse.type === 'error') {
      report.failure = `${result.finalResponse.code}: ${result.finalResponse.message}`;
    }
  } else if (parsed.config === 'c2') {
    const model = new GlmModelAdapter({ apiKey, model: modelId, sessionId });
    const { harness, execution, verification } = buildHarness(ws, model, parsed.toolRounds, path.join(ws, 'audit.jsonl'));
    const loop = new AgentLoop({ harness, execution, verification, workspaceRoot: ws });
    const loopResult = await loop.run({
      task,
      maxTurns: parsed.maxTurns,
      verification: { command: parsed.verifyCmd },
      toolRoundsPerTurn: parsed.toolRounds,
    });
    report.status = loopResult.status;
    report.usage = model.getUsage();
    report.turns = loopResult.turns;
    report.decision = loopResult.decision;
    report.failure = loopResult.failure;
    report.trace = compactTraceC2(loopResult);
    if (loopResult.finalResponse?.type === 'finish') {
      report.finalResponse = truncate(loopResult.finalResponse.content, 2000);
    }
  } else if (parsed.config === 'c3') {
    const model = new GlmModelAdapter({ apiKey, model: modelId, sessionId });
    const factory = (node) => {
      const { harness, execution, verification } = buildHarness(ws, model, node.toolRoundsPerTurn ?? parsed.toolRounds, path.join(ws, `audit-${node.id}.jsonl`));
      return new AgentLoop({ harness, execution, verification, workspaceRoot: ws });
    };
    const nodes = buildNodes(parsed);
    const engine = new GraphEngine(factory, {
      task: 'Implement the complete system described in SPEC.md',
      initialNode: 'architect',
      nodes,
      edges: [],
      maxSteps: parsed.maxSteps,
    }, buildRouter(ws));
    const graphResult = await engine.run();
    report.status = graphResult.status;
    report.usage = model.getUsage();
    report.steps = graphResult.steps;
    report.totalLoopTurns = graphResult.totalLoopTurns;
    report.decision = graphResult.decision;
    report.failure = graphResult.failure;
    report.trace = compactTraceC3(graphResult);
  }

  let batteryInfo = null;
  if (parsed.withBatteries) {
    batteryInfo = await runBatteries(ws, parsed.keep);
    report.batteryPhase = {
      ran: true,
      passed: !batteryInfo.batteryError && (batteryInfo.batteryReport?.passed ?? false),
      error: batteryInfo.batteryError || undefined,
    };
  }

  const finishedAt = new Date().toISOString();
  report.finishedAt = finishedAt;
  report.durationMs = Date.now() - t0;

  const reportPath = path.join(ws, 'run-report.json');
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2));

  console.error(`Run complete`);
  console.error(`  Config:     ${report.config}`);
  console.error(`  Model:      ${report.model}`);
  console.error(`  Workspace:  ${ws}`);
  console.error(`  Status:     ${report.status}`);
  console.error(`  Duration:   ${report.durationMs}ms`);
  if (report.turns != null) console.error(`  Turns:      ${report.turns}`);
  if (report.steps != null) console.error(`  Steps:      ${report.steps}`);
  if (report.totalLoopTurns != null) console.error(`  Loop turns: ${report.totalLoopTurns}`);
  if (report.usage) console.error(`  Usage:      ${report.usage.totalTokens} tokens (${report.usage.calls} calls)`);
  if (parsed.withBatteries) {
    const bp = report.batteryPhase;
    console.error(`  Batteries:  ${bp.passed ? 'passed' : bp.error ? `failed (${bp.error})` : 'failed'}`);
  }
  console.log(reportPath);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
