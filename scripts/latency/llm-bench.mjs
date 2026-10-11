#!/usr/bin/env node
/**
 * LLM latency bench — times thinking / tool-input / multi-round gaps via
 * POST /api/parametric-chat. Stubs CAD tool outputs in Supabase (no Pyodide).
 *
 * Usage:
 *   node scripts/latency/llm-bench.mjs --out llm-latency.json
 *
 * Auth: LATENCY_ACCESS_TOKEN, or LATENCY_EMAIL + LATENCY_PASSWORD.
 * Reads VITE_SUPABASE_* from env or .env.local.
 */

import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const text = fs.readFileSync(filePath, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile(path.join(ROOT, '.env.local'));
loadEnvFile(path.join(ROOT, '.env'));

function parseArgs(argv) {
  const out = {
    prompt: 'a 40mm cube',
    model: process.env.LATENCY_MODEL || 'anthropic/claude-sonnet-5',
    maxRounds: 6,
    appUrl: process.env.LATENCY_APP_URL || 'http://localhost:3000',
    outPath: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--prompt' && next) {
      out.prompt = next;
      i++;
    } else if (arg === '--model' && next) {
      out.model = next;
      i++;
    } else if (arg === '--max-rounds' && next) {
      out.maxRounds = Number(next);
      i++;
    } else if (arg === '--app-url' && next) {
      out.appUrl = next.replace(/\/$/, '');
      i++;
    } else if (arg === '--out' && next) {
      out.outPath = next;
      i++;
    } else if (arg === '--help' || arg === '-h') {
      console.log(`Usage: node scripts/latency/llm-bench.mjs [options]
  --prompt <text>       User prompt (default: "a 40mm cube")
  --model <id>          Model id (default: LATENCY_MODEL or anthropic/claude-sonnet-5)
  --max-rounds <n>      Max LLM rounds (default: 6)
  --app-url <url>       App origin (default: LATENCY_APP_URL or http://localhost:3000)
  --out <file>          Write JSON report`);
      process.exit(0);
    }
  }
  return out;
}

function nowMs() {
  return performance.now();
}

async function resolveAccessToken(supabaseUrl, anonKey) {
  if (process.env.LATENCY_ACCESS_TOKEN) {
    return process.env.LATENCY_ACCESS_TOKEN;
  }
  const email = process.env.LATENCY_EMAIL;
  const password = process.env.LATENCY_PASSWORD;
  if (!email || !password) {
    throw new Error(
      'Set LATENCY_ACCESS_TOKEN or LATENCY_EMAIL + LATENCY_PASSWORD',
    );
  }
  const supabase = createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });
  if (error || !data.session?.access_token) {
    throw new Error(
      `Supabase sign-in failed: ${error?.message ?? 'no access_token'}`,
    );
  }
  return data.session.access_token;
}

/**
 * Parse AI SDK UI-message SSE and collect timing markers for one POST.
 */
async function consumeUiMessageStream(response) {
  if (!response.body) throw new Error('Empty response body');

  const tPost = nowMs();
  let ttfbMs = null;
  let thinkingStart = null;
  let thinkingEnd = null;
  let buildStart = null;
  let buildEnd = null;
  let answerStart = null;
  let answerEnd = null;
  let messageId = null;
  /** @type {'build_parametric_model' | 'answer_user' | null} */
  let terminalTool = null;
  /** @type {object | null} */
  let buildInput = null;
  /** @type {object | null} */
  let answerInput = null;
  let buildToolCallId = null;
  let answerToolCallId = null;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const handleEvent = (raw) => {
    const line = raw.trim();
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') return;

    let event;
    try {
      event = JSON.parse(payload);
    } catch {
      return;
    }
    if (!event || typeof event !== 'object') return;

    if (ttfbMs == null) ttfbMs = Math.round(nowMs() - tPost);

    const type = event.type;
    if (
      (type === 'start' || type === 'message-start') &&
      (event.messageId || event.id)
    ) {
      messageId = event.messageId || event.id;
    }

    if (type === 'reasoning-start') {
      if (thinkingStart == null) thinkingStart = nowMs();
    } else if (type === 'reasoning-end') {
      if (thinkingStart != null && thinkingEnd == null) {
        thinkingEnd = nowMs();
      }
    } else if (type === 'tool-input-start') {
      if (thinkingStart != null && thinkingEnd == null) {
        thinkingEnd = nowMs();
      }
      if (event.toolName === 'build_parametric_model') {
        if (buildStart == null) buildStart = nowMs();
        buildToolCallId = event.toolCallId ?? buildToolCallId;
      } else if (event.toolName === 'answer_user') {
        if (answerStart == null) answerStart = nowMs();
        answerToolCallId = event.toolCallId ?? answerToolCallId;
      }
    } else if (type === 'tool-input-available') {
      if (event.toolName === 'build_parametric_model') {
        if (buildStart == null) buildStart = tPost;
        buildEnd = nowMs();
        terminalTool = 'build_parametric_model';
        buildInput = event.input ?? null;
        buildToolCallId = event.toolCallId ?? buildToolCallId;
      } else if (event.toolName === 'answer_user') {
        if (answerStart == null) answerStart = tPost;
        answerEnd = nowMs();
        terminalTool = 'answer_user';
        answerInput = event.input ?? null;
        answerToolCallId = event.toolCallId ?? answerToolCallId;
      }
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // SSE events are separated by blank lines.
    let splitAt;
    while ((splitAt = buffer.indexOf('\n\n')) >= 0) {
      const chunk = buffer.slice(0, splitAt);
      buffer = buffer.slice(splitAt + 2);
      for (const line of chunk.split(/\r?\n/)) {
        handleEvent(line);
      }
    }
  }
  if (buffer.trim()) {
    for (const line of buffer.split(/\r?\n/)) handleEvent(line);
  }

  const roundEnd = nowMs();
  if (thinkingStart != null && thinkingEnd == null) {
    thinkingEnd = buildStart ?? answerStart ?? roundEnd;
  }

  /** @type {{ name: string, ms: number }[]} */
  const stages = [];
  if (ttfbMs != null) stages.push({ name: 'ttfb', ms: ttfbMs });
  if (thinkingStart != null && thinkingEnd != null) {
    stages.push({
      name: 'thinking',
      ms: Math.max(0, Math.round(thinkingEnd - thinkingStart)),
    });
  }
  if (buildStart != null && buildEnd != null) {
    stages.push({
      name: 'tool_input_build_parametric_model',
      ms: Math.max(0, Math.round(buildEnd - buildStart)),
    });
  }
  if (answerStart != null && answerEnd != null) {
    stages.push({
      name: 'answer_user',
      ms: Math.max(0, Math.round(answerEnd - answerStart)),
    });
  }
  stages.push({
    name: 'llm_round_total',
    ms: Math.max(0, Math.round(roundEnd - tPost)),
  });

  return {
    stages,
    messageId,
    terminalTool,
    buildInput,
    answerInput,
    buildToolCallId,
    answerToolCallId,
    roundMs: Math.round(roundEnd - tPost),
  };
}

function stubBuildOutput() {
  return {
    status: 'success',
    message:
      'STUB: SimpleCADAPI compile skipped (llm-bench). shapes=["result"].',
    shapes: ['result'],
    inspection: {
      views: ['ISO', 'FRONT', 'BACK', 'LEFT', 'RIGHT', 'TOP', 'BOTTOM'],
      imageAttached: false,
    },
  };
}

function stubAnswerOutput(input) {
  return {
    message:
      typeof input?.message === 'string' && input.message.trim()
        ? input.message
        : 'STUB: latency bench complete.',
  };
}

async function waitForAssistantRow(supabase, conversationId, messageId) {
  const MAX_ATTEMPTS = 8;
  const DELAY_MS = 300;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (messageId) {
      const { data, error } = await supabase
        .from('messages')
        .select('id, parts, role')
        .eq('conversation_id', conversationId)
        .eq('id', messageId)
        .maybeSingle();
      if (!error && data) return data;
    } else {
      const { data, error } = await supabase
        .from('messages')
        .select('id, parts, role')
        .eq('conversation_id', conversationId)
        .eq('role', 'assistant')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!error && data) return data;
    }
    await new Promise((r) => setTimeout(r, DELAY_MS));
  }

  const { data: conv } = await supabase
    .from('conversations')
    .select('current_message_leaf_id')
    .eq('id', conversationId)
    .single();
  if (!conv?.current_message_leaf_id) {
    throw new Error('Assistant row not found after stream (no leaf)');
  }
  const { data: leaf, error: leafError } = await supabase
    .from('messages')
    .select('id, parts, role')
    .eq('id', conv.current_message_leaf_id)
    .single();
  if (leafError || !leaf) {
    throw new Error(
      `Assistant row not found: ${leafError?.message ?? 'missing'}`,
    );
  }
  return leaf;
}

function applyStubToParts(parts, terminalTool, toolCallId, output) {
  const next = Array.isArray(parts) ? structuredClone(parts) : [];
  const type =
    terminalTool === 'answer_user'
      ? 'tool-answer_user'
      : 'tool-build_parametric_model';
  let patched = false;
  for (let i = 0; i < next.length; i++) {
    const part = next[i];
    if (part?.type !== type) continue;
    if (toolCallId && part.toolCallId && part.toolCallId !== toolCallId) {
      continue;
    }
    if (
      part.state === 'input-available' ||
      part.state === 'input-streaming' ||
      part.state === 'output-available'
    ) {
      next[i] = {
        ...part,
        state: 'output-available',
        output,
      };
      patched = true;
      break;
    }
  }
  if (!patched) {
    next.push({
      type,
      toolCallId: toolCallId || randomUUID(),
      state: 'output-available',
      input:
        terminalTool === 'answer_user'
          ? { message: output.message }
          : {
              title: 'Latency Bench Stub',
              version: 'v1',
              code:
                'import simplecadapi as scad\nresult = scad.make_box_rsolid(40,40,40, bottom_face_center=(0,0,0))\n',
            },
      output,
    });
  }
  return next;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const supabaseUrl = process.env.VITE_SUPABASE_URL;
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) {
    throw new Error('Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY');
  }

  const accessToken = await resolveAccessToken(supabaseUrl, anonKey);
  const supabase = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser(accessToken);
  if (userError || !user) {
    throw new Error(`auth.getUser failed: ${userError?.message ?? 'no user'}`);
  }

  const conversationId = randomUUID();
  const { error: convError } = await supabase.from('conversations').insert({
    id: conversationId,
    user_id: user.id,
    title: 'Latency Bench',
    type: 'parametric',
    settings: { model: args.model },
  });
  if (convError) {
    throw new Error(`create conversation: ${convError.message}`);
  }

  const userMessageId = randomUUID();
  const { error: msgError } = await supabase.from('messages').insert({
    id: userMessageId,
    conversation_id: conversationId,
    role: 'user',
    parts: [{ type: 'text', text: args.prompt }],
    metadata: { model: args.model },
    parent_message_id: null,
  });
  if (msgError) {
    throw new Error(`create user message: ${msgError.message}`);
  }

  console.log(`conversation=${conversationId}`);
  console.log(`model=${args.model}`);
  console.log(`prompt=${JSON.stringify(args.prompt)}`);
  console.log(`app=${args.appUrl}`);

  /** @type {{ name: string, ms: number, round?: number }[]} */
  const allStages = [];
  const suiteStart = nowMs();
  let lastStubAt = null;
  let finished = false;

  for (let round = 1; round <= args.maxRounds; round++) {
    console.log(`\n--- round ${round} ---`);
    const postStarted = nowMs();
    if (lastStubAt != null) {
      // round_gap measured after response TTFB below
    }

    const response = await fetch(`${args.appUrl}/api/parametric-chat`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({
        conversationId,
        model: args.model,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `parametric-chat HTTP ${response.status}: ${text.slice(0, 500)}`,
      );
    }

    const roundResult = await consumeUiMessageStream(response);

    if (lastStubAt != null) {
      const ttfb = roundResult.stages.find((s) => s.name === 'ttfb');
      const gap = Math.max(
        0,
        Math.round(postStarted + (ttfb?.ms ?? 0) - lastStubAt),
      );
      allStages.push({ name: 'round_gap', ms: gap, round });
    }

    for (const stage of roundResult.stages) {
      allStages.push({ ...stage, round });
      console.log(`  ${stage.name}: ${stage.ms}ms`);
    }

    if (!roundResult.terminalTool) {
      console.log('  (no client tool — stopping)');
      finished = true;
      break;
    }

    const row = await waitForAssistantRow(
      supabase,
      conversationId,
      roundResult.messageId,
    );

    if (roundResult.terminalTool === 'answer_user') {
      const parts = applyStubToParts(
        row.parts,
        'answer_user',
        roundResult.answerToolCallId,
        stubAnswerOutput(roundResult.answerInput),
      );
      const { error } = await supabase
        .from('messages')
        .update({ parts })
        .eq('id', row.id)
        .eq('conversation_id', conversationId);
      if (error) throw new Error(`stub answer_user: ${error.message}`);
      lastStubAt = nowMs();
      finished = true;
      console.log('  stubbed answer_user — done');
      break;
    }

    // build_parametric_model stub
    const stubInput =
      roundResult.buildInput &&
      typeof roundResult.buildInput === 'object' &&
      typeof roundResult.buildInput.code === 'string'
        ? roundResult.buildInput
        : {
            title: 'Latency Bench Cube',
            version: 'v1',
            code: 'import simplecadapi as scad\nresult = scad.make_box_rsolid(40.0, 40.0, 40.0, bottom_face_center=(0.0, 0.0, 0.0))\n',
          };

    let parts = Array.isArray(row.parts) ? structuredClone(row.parts) : [];
    // Ensure input is present on the tool part before stubbing output.
    parts = parts.map((part) => {
      if (
        part?.type === 'tool-build_parametric_model' &&
        (!roundResult.buildToolCallId ||
          part.toolCallId === roundResult.buildToolCallId)
      ) {
        return { ...part, input: part.input ?? stubInput };
      }
      return part;
    });
    parts = applyStubToParts(
      parts,
      'build_parametric_model',
      roundResult.buildToolCallId,
      stubBuildOutput(),
    );

    const { error: stubError } = await supabase
      .from('messages')
      .update({ parts })
      .eq('id', row.id)
      .eq('conversation_id', conversationId);
    if (stubError) {
      throw new Error(`stub build_parametric_model: ${stubError.message}`);
    }
    lastStubAt = nowMs();
    console.log('  stubbed build_parametric_model — continuing');
  }

  if (!finished) {
    console.warn(
      `Stopped after max-rounds=${args.maxRounds} without answer_user`,
    );
  }

  const report = {
    suite: 'llm',
    warm: true,
    total_ms: Math.round(nowMs() - suiteStart),
    conversationId,
    model: args.model,
    prompt: args.prompt,
    finished,
    stages: allStages,
  };

  console.log('\n=== LLM latency report ===');
  console.table(
    allStages.map(({ name, ms, round }) => ({ round, name, ms })),
  );
  console.log(`total_ms=${report.total_ms}`);

  if (args.outPath) {
    const abs = path.isAbsolute(args.outPath)
      ? args.outPath
      : path.join(process.cwd(), args.outPath);
    fs.writeFileSync(abs, JSON.stringify(report, null, 2));
    console.log(`wrote ${abs}`);
  }

  return report;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
