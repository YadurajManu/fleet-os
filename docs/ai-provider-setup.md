# AI provider setup and recovery

Fleet uses one OpenAI-compatible chat-completions client for Groq, OpenRouter,
and other compatible providers. Choose one active provider with these server
settings; its API key must match its API root and model ID:

| Provider | AI_BASE_URL | AI_MODEL |
| --- | --- | --- |
| Groq | https://api.groq.com/openai/v1 | Exact accessible ID from Groq's model list |
| OpenRouter | https://openrouter.ai/api/v1 | Exact accessible OpenRouter model ID |

Set `AI_API_KEY` in the private control-plane environment file. Never paste keys
in chat, manifests or command arguments. No SDK or client-side key is required.
An enabled provider now requires an explicit `AI_MODEL`: Fleet will not guess a
model from a different provider. Keep `AI_DAILY_LIMIT` at your chosen budget.

From the control-plane directory, with those variables loaded:

```sh
npm run ai:check
```

This requests only `/models`, never a completion. A listed model does not prove
completion permissions, remaining credits, or schema support. Some gateways do
not expose discovery; that is reported as unverified rather than as an invalid
model. A real completion is needed for final activation testing.

On 2026-11-12 a single bounded production check reproduced OpenRouter HTTP 404:
`nvidia/nemotron-3-super-120b-a12b:free` was no longer available for free. The
provider suggested the paid slug. No model, credentials or production settings
were changed. Recent application logs did not contain that historical failure;
the new request reproduced it directly. Choose an accessible free model or
explicitly accept a paid model before changing the environment.

Model and credential errors stop with recovery advice. Schema degradation is
not retried for a known model rejection. Rate-limit retries remain bounded;
existing caching and daily limits remain in effect. Supporting both providers
does not pool their quotas, reduce the tokens required for a prompt, or enable
automatic paid failover. To activate Groq, the operator must supply its key in
the server environment and choose a model. Existing OpenRouter credentials may
be retained if an accessible OpenRouter model is selected.

Official references:
- https://console.groq.com/docs/openai
- https://openrouter.ai/docs/api/reference/errors-and-debugging
