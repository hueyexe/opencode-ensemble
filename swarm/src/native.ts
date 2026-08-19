import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Native JSON-schema structured output via the provider's DIRECT REST API.
// One request per call (native `response_format`), vs opencode's serve-based
// `json_schema` which may use a tool-calling round-trip (2+ requests). This is
// the lever for working within a provider's per-minute request budget.

export interface NativeModel {
  providerID: string;
  id: string;
}

interface CloudflareAuth {
  accountId: string;
  token: string;
}

interface OpenRouterAuth {
  key: string;
}

interface ProviderAuth {
  cloudflare?: CloudflareAuth;
  openrouter?: OpenRouterAuth;
}

let cachedAuth: ProviderAuth | undefined;

function loadAuth(): ProviderAuth {
  if (cachedAuth) return cachedAuth;
  cachedAuth = {};
  try {
    const p = join(homedir(), '.local', 'share', 'opencode', 'auth.json');
    const raw = JSON.parse(readFileSync(p, 'utf8'));
    const cf = raw['cloudflare-workers-ai'];
    if (cf?.key && cf?.metadata?.accountId) {
      cachedAuth.cloudflare = { accountId: cf.metadata.accountId, token: cf.key };
    }
    const or = raw['openrouter'];
    if (or?.key) {
      cachedAuth.openrouter = { key: or.key };
    }
  } catch {
    // auth file absent/unreadable — native mode unavailable for these providers
  }
  return cachedAuth;
}

export function supportsNative(providerID: string): boolean {
  const auth = loadAuth();
  if (providerID === 'cloudflare-workers-ai') return Boolean(auth.cloudflare);
  if (providerID === 'openrouter') return Boolean(auth.openrouter);
  return false;
}

export async function nativeStructured(
  model: NativeModel,
  prompt: string,
  schema: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const auth = loadAuth();
  let content: string;

  if (model.providerID === 'cloudflare-workers-ai' && auth.cloudflare) {
    content = await cloudflare(auth.cloudflare, model.id, prompt, schema);
  } else if (model.providerID === 'openrouter' && auth.openrouter) {
    content = await openrouter(auth.openrouter, model.id, prompt, schema);
  } else {
    throw new Error(`native structured output not supported for provider "${model.providerID}"`);
  }

  return parseJson(content);
}

async function cloudflare(
  auth: CloudflareAuth,
  model: string,
  prompt: string,
  schema: Record<string, unknown>,
): Promise<string> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${auth.accountId}/ai/run/${model}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_schema', json_schema: { name: 'output', schema } },
    }),
    signal: AbortSignal.timeout(120_000),
  });
  const data = (await res.json()) as any;
  if (!res.ok) {
    throw new Error(`cloudflare ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
  }
  const content = data?.result?.choices?.[0]?.message?.content as string | undefined;
  if (!content) throw new Error(`cloudflare empty content: ${JSON.stringify(data).slice(0, 300)}`);
  return content;
}

async function openrouter(
  auth: OpenRouterAuth,
  model: string,
  prompt: string,
  schema: Record<string, unknown>,
): Promise<string> {
  const url = 'https://openrouter.ai/api/v1/chat/completions';
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${auth.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_schema', json_schema: { name: 'output', schema } },
    }),
    signal: AbortSignal.timeout(120_000),
  });
  const data = (await res.json()) as any;
  if (!res.ok) {
    throw new Error(`openrouter ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
  }
  const content = data?.choices?.[0]?.message?.content as string | undefined;
  if (!content) throw new Error(`openrouter empty content: ${JSON.stringify(data).slice(0, 300)}`);
  return content;
}

// Parse JSON from a model's content string, tolerating code fences and stray
// prose around the object. Native json_schema output is already pure JSON, so
// the direct parse almost always succeeds; the fallbacks are defensive.
function parseJson(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    // fall through
  }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1]) as Record<string, unknown>;
    } catch {
      // fall through
    }
  }
  // Extract the first balanced {…} or […] block by scanning bracket depth.
  const start = trimmed.search(/[[{]/);
  if (start >= 0) {
    const open = trimmed[start];
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    let inString = false;
    let esc = false;
    for (let i = start; i < trimmed.length; i++) {
      const c = trimmed[i];
      if (inString) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') inString = true;
      else if (c === open) depth++;
      else if (c === close) {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(trimmed.slice(start, i + 1)) as Record<string, unknown>;
          } catch {
            break;
          }
        }
      }
    }
  }
  throw new Error(`could not parse JSON from model output: ${text.slice(0, 120)}`);
}