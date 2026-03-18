# llm-stream-adapter
A lightweight adapter that bridges streaming clients with non-streaming LLM backends using OpenAI-compatible APIs.
一个“零或极少外部依赖”的 Node.js HTTP 代理：

- 对外提供 OpenAI 兼容接口：`POST /v1/chat/completions`
- 无论客户端是否传入 `stream: true`，都强制向上游发送 `stream: false`
- 等待上游完整 JSON 后，再转换为 OpenAI SSE streaming chunk 输出
- 支持 `messages`、`tools`、`tool_calls`、function calling 的流式转换

## 运行要求

- Node.js 18+

## 启动

```bash
PORT=3000 \\
UPSTREAM_BASE_URL=http://127.0.0.1:8000 \\
API_KEY=your_upstream_key \\
ROUTE_PREFIX= \\
CHUNK_SIZE=16 \\
CHUNK_DELAY_MS=20 \\
node index.js
```

## 环境变量

- `PORT`：服务端口，默认 `3000`
- `UPSTREAM_BASE_URL`：上游基地址（例如 `http://127.0.0.1:8000`）
- `API_KEY`：上游鉴权 token（可选）
- `ROUTE_PREFIX`：对外路由前缀（可选），例如设为 `/deepseek` 后可接收 `POST /deepseek/v1/chat/completions` 与 `GET /deepseek/healthz`
- `CHUNK_SIZE`：拆分粒度，默认 `16`
- `CHUNK_DELAY_MS`：每个 chunk 的延迟（毫秒），默认 `20`

> 路由兼容说明：
>
> - 未设置 `ROUTE_PREFIX` 时，默认可接收 `/v1/chat/completions`，并兼容带前缀的 `/xxx/v1/chat/completions`。
> - 设置 `ROUTE_PREFIX=/deepseek` 时，将严格匹配 `/deepseek/v1/chat/completions`（避免多路由混淆）。

## 示例请求

```bash
curl -N http://127.0.0.1:3000/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "your-model",
    "stream": true,
    "messages": [{"role": "user", "content": "帮我查纽约天气"}],
    "tools": [
      {
        "type": "function",
        "function": {
          "name": "get_weather",
          "description": "Get weather by city",
          "parameters": {
            "type": "object",
            "properties": {
              "city": {"type": "string"}
            },
            "required": ["city"]
          }
        }
      }
    ]
  }'
```

## SSE 输出格式

返回头：

- `Content-Type: text/event-stream`
- `Cache-Control: no-cache`
- `Connection: keep-alive`

每帧：

```text
data: {json}

```

结束：

```text
data: [DONE]

```

## tool_calls 转换说明

若上游返回非流式：

```json
{
  "tool_calls": [
    {
      "id": "call_xxx",
      "type": "function",
      "function": {
        "name": "get_weather",
        "arguments": "{\"city\":\"NY\"}"
      }
    }
  ]
}
```

代理会将 `arguments` 按 `CHUNK_SIZE` 切分并分多帧发送，类似：

- 第一帧带 `id` + `name` + arguments 片段
- 后续帧持续发送 `arguments` 片段
- `index` 全程一致

## 健康检查

- `GET /healthz` -> `{ "ok": true }`
