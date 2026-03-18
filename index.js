'use strict';

const http = require('http');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 3000);
const UPSTREAM_BASE_URL = process.env.UPSTREAM_BASE_URL || 'http://127.0.0.1:8000';
const API_KEY = process.env.API_KEY || '';
const CHUNK_SIZE = Math.max(1, Number(process.env.CHUNK_SIZE || 16));
const CHUNK_DELAY_MS = Math.max(0, Number(process.env.CHUNK_DELAY_MS || 20));

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function unixTs() {
  return Math.floor(Date.now() / 1000);
}

function genId(prefix = 'chatcmpl') {
  return `${prefix}-${crypto.randomBytes(12).toString('hex')}`;
}

function chunkString(str, size) {
  if (!str || typeof str !== 'string') return [];
  const out = [];
  for (let i = 0; i < str.length; i += size) {
    out.push(str.slice(i, i + size));
  }
  return out;
}

function setSSEHeaders(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
}

function writeSSE(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

function writeDone(res) {
  res.write('data: [DONE]\n\n');
}

function buildChunk({ id, model, created, choiceIndex, delta, finishReason = null }) {
  return {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [
      {
        index: choiceIndex,
        delta,
        finish_reason: finishReason,
      },
    ],
  };
}

function writeJsonError(res, statusCode, message, type = 'proxy_error') {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(
    JSON.stringify({
      error: {
        message,
        type,
      },
    })
  );
}

function readJsonBody(req, limitBytes = 10 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;

    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > limitBytes) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch (err) {
        reject(new Error(`Invalid JSON: ${err.message}`));
      }
    });

    req.on('error', reject);
  });
}

async function streamChoiceAsSSE(res, { id, model, created, choice, choiceIndex }) {
  const message = choice?.message || {};
  const role = message.role || 'assistant';

  writeSSE(
    res,
    buildChunk({
      id,
      model,
      created,
      choiceIndex,
      delta: { role },
    })
  );
  await sleep(CHUNK_DELAY_MS);

  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  for (let i = 0; i < toolCalls.length; i++) {
    const call = toolCalls[i] || {};
    const fn = call.function || {};
    const name = fn.name || '';
    const argString =
      typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? '');

    const argParts = chunkString(argString, CHUNK_SIZE);
    if (argParts.length === 0) {
      writeSSE(
        res,
        buildChunk({
          id,
          model,
          created,
          choiceIndex,
          delta: {
            tool_calls: [
              {
                index: i,
                id: call.id || genId('call'),
                type: 'function',
                function: {
                  name,
                  arguments: '',
                },
              },
            ],
          },
        })
      );
      await sleep(CHUNK_DELAY_MS);
      continue;
    }

    for (let p = 0; p < argParts.length; p++) {
      const payload = {
        index: i,
        type: 'function',
        function: {
          arguments: argParts[p],
        },
      };

      if (p === 0) {
        payload.id = call.id || genId('call');
        payload.function.name = name;
      }

      writeSSE(
        res,
        buildChunk({
          id,
          model,
          created,
          choiceIndex,
          delta: {
            tool_calls: [payload],
          },
        })
      );
      await sleep(CHUNK_DELAY_MS);
    }
  }

  const content = typeof message.content === 'string' ? message.content : '';
  const textParts = chunkString(content, CHUNK_SIZE);
  for (const part of textParts) {
    writeSSE(
      res,
      buildChunk({
        id,
        model,
        created,
        choiceIndex,
        delta: { content: part },
      })
    );
    await sleep(CHUNK_DELAY_MS);
  }

  writeSSE(
    res,
    buildChunk({
      id,
      model,
      created,
      choiceIndex,
      delta: {},
      finishReason: choice?.finish_reason || 'stop',
    })
  );
  await sleep(CHUNK_DELAY_MS);
}

async function forwardToUpstream(body, reqId) {
  const upstreamPayload = {
    ...body,
    stream: false,
  };

  const headers = {
    'Content-Type': 'application/json',
  };
  if (API_KEY) headers.Authorization = `Bearer ${API_KEY}`;

  const url = `${UPSTREAM_BASE_URL.replace(/\/+$/, '')}/v1/chat/completions`;

  let upstreamResp;
  try {
    upstreamResp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(upstreamPayload),
    });
  } catch (err) {
    throw new Error(`Upstream request failed: ${err.message}`);
  }

  const text = await upstreamResp.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch (err) {
    console.error(`[${reqId}] upstream json parse error`, err, text.slice(0, 500));
    throw new Error(`Invalid upstream JSON: ${err.message}`);
  }

  if (!upstreamResp.ok) {
    const msg = json?.error?.message || `Upstream HTTP ${upstreamResp.status}`;
    const e = new Error(msg);
    e.statusCode = upstreamResp.status;
    throw e;
  }

  return json;
}

async function handleChatCompletions(req, res, reqId) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return writeJsonError(res, 400, err.message, 'invalid_request_error');
  }

  if (!Array.isArray(body.messages)) {
    return writeJsonError(res, 400, '`messages` is required and must be an array', 'invalid_request_error');
  }

  let upstreamJson;
  try {
    upstreamJson = await forwardToUpstream(body, reqId);
  } catch (err) {
    return writeJsonError(res, err.statusCode || 502, err.message, 'proxy_error');
  }

  setSSEHeaders(res);
  res.flushHeaders?.();

  const id = upstreamJson.id || genId('chatcmpl');
  const model = upstreamJson.model || body.model || 'unknown-model';
  const created = upstreamJson.created || unixTs();
  const choices = Array.isArray(upstreamJson.choices) ? upstreamJson.choices : [];

  if (choices.length === 0) {
    writeSSE(
      res,
      buildChunk({
        id,
        model,
        created,
        choiceIndex: 0,
        delta: {},
        finishReason: 'stop',
      })
    );
    writeDone(res);
    res.end();
    return;
  }

  for (let i = 0; i < choices.length; i++) {
    await streamChoiceAsSSE(res, {
      id,
      model,
      created,
      choice: choices[i],
      choiceIndex: i,
    });
  }

  writeDone(res);
  res.end();
}

const server = http.createServer(async (req, res) => {
  const reqId = req.headers['x-request-id'] || genId('req');
  const start = Date.now();

  req.socket.setKeepAlive(true, 60_000);

  console.log(`[${reqId}] ${req.method} ${req.url}`);

  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    await handleChatCompletions(req, res, reqId);
    console.log(`[${reqId}] done ${Date.now() - start}ms`);
    return;
  }

  if (req.method === 'GET' && req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  writeJsonError(res, 404, 'Not found', 'invalid_request_error');
});

server.keepAliveTimeout = 75_000;
server.headersTimeout = 80_000;

server.listen(PORT, () => {
  console.log(
    `[startup] listening on :${PORT} upstream=${UPSTREAM_BASE_URL} chunk_size=${CHUNK_SIZE} chunk_delay_ms=${CHUNK_DELAY_MS}`
  );
});
