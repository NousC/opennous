// Your own model (GET-528) — an automation's AI step on the customer's own Claude or ChatGPT key.
//
// Three things, and only these: read the key they connected (encrypted in
// workflow_provider_connections, like every other provider key), list the models that key can
// use, and make the call. The model list comes from the provider, not from us: a hardcoded list
// is wrong the week a model ships or retires, and it is the customer's key that decides what is
// available.
//
// CLAUDE. Current models (Opus 5.5, Sonnet 5.5, Fable) reject `temperature` and cannot turn
// thinking off, so the knob is `effort` — set explicitly, because Opus 5.5 defaults to medium.
// A declined request comes back as stop_reason "refusal", which is checked before any text is
// read; on the models that support it, `fallbacks: "default"` lets Anthropic re-run a declined
// request on its recommended fallback inside the same call.
//
// CHATGPT. Chat Completions with `temperature` and `max_completion_tokens`. Reasoning models
// reject a non-default temperature; that one refusal is retried once without it, and the step
// says so rather than failing.
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { decrypt } from '../providers/crypto.mjs';

export const OWN_MODEL_PROVIDERS = ['anthropic', 'openai'];

/** The default model when a step has not picked one. */
export const DEFAULT_MODEL = { anthropic: 'claude-opus-5-5', openai: null };

/** The key this workspace connected for `provider`, decrypted; null when there is none. */
export async function loadModelKey(supabase, workspaceId, provider) {
  if (!OWN_MODEL_PROVIDERS.includes(provider)) return null;
  const { data } = await supabase
    .from('workflow_provider_connections')
    .select('encrypted_credentials, workflow_providers!inner(name)')
    .eq('workspace_id', workspaceId)
    .eq('workflow_providers.name', provider)
    .limit(1);
  const enc = data?.[0]?.encrypted_credentials;
  const key = enc ? decrypt(enc.api_key || enc.api_token || '') : null;
  return key ? String(key).trim() : null;
}

// Models that are not a chat model: listing them in a "which model writes this" picker only
// invites an error.
const OPENAI_NOT_CHAT = /(audio|realtime|tts|transcribe|whisper|embedding|image|dall-e|moderation|search|instruct|davinci|babbage|computer-use)/i;

/** The models this key can use, newest first: [{ id, label }]. */
export async function listModels(provider, apiKey) {
  if (provider === 'anthropic') {
    const client = new Anthropic({ apiKey });
    const out = [];
    for await (const m of client.models.list()) out.push({ id: m.id, label: m.display_name || m.id, created: m.created_at });
    return out.sort((a, b) => String(b.created).localeCompare(String(a.created))).map(({ id, label }) => ({ id, label }));
  }
  if (provider === 'openai') {
    const client = new OpenAI({ apiKey });
    const out = [];
    for await (const m of client.models.list()) {
      if (/^(gpt|o\d|chatgpt)/i.test(m.id) && !OPENAI_NOT_CHAT.test(m.id)) out.push({ id: m.id, label: m.id, created: m.created });
    }
    return out.sort((a, b) => (b.created ?? 0) - (a.created ?? 0)).map(({ id, label }) => ({ id, label }));
  }
  return [];
}

// Effort is an Opus 4.5+ / Sonnet 4.6+ / 5-family control; Haiku 4.5 and Sonnet 4.5 reject it.
const takesEffort = (model) => !/haiku|sonnet-4-5|claude-3/i.test(model);
// Server-side refusal fallbacks exist on the 5-family and Fable.
const takesFallbacks = (model) => /claude-(opus-5|sonnet-5-5|fable)/i.test(model);

/**
 * One call to the customer's model. Returns
 *   { ok: true, text, model, note? }            — `note` says what was adjusted, e.g. temperature
 *   { ok: false, message }                      — said so a person can act on it
 */
export async function callOwnModel({ provider, apiKey, model, system, prompt, effort = 'medium', temperature = null, maxTokens = 2000 }) {
  const max = Math.max(256, Math.min(Number(maxTokens) || 2000, 16000));
  try {
    if (provider === 'anthropic') {
      const client = new Anthropic({ apiKey });
      const id = model || DEFAULT_MODEL.anthropic;
      const body = {
        model: id,
        max_tokens: max,
        ...(system ? { system } : {}),
        messages: [{ role: 'user', content: prompt }],
        ...(takesEffort(id) ? { output_config: { effort } } : {}),
      };
      let res;
      if (takesFallbacks(id)) {
        try {
          res = await client.beta.messages.create({ ...body, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
        } catch (err) {
          // An account without the fallback beta still gets its answer, just without the net.
          if (!(err instanceof Anthropic.BadRequestError)) throw err;
          res = await client.messages.create(body);
        }
      } else {
        res = await client.messages.create(body);
      }
      if (res.stop_reason === 'refusal') {
        return { ok: false, message: 'Claude declined this request.' };
      }
      const text = (res.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
      return {
        ok: true, text, model: res.model,
        ...(res.stop_reason === 'max_tokens' ? { note: 'Cut off at the length limit. Raise it if the answer needs more room.' } : {}),
      };
    }

    if (provider === 'openai') {
      if (!model) return { ok: false, message: 'Pick a ChatGPT model.' };
      const client = new OpenAI({ apiKey });
      const messages = [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: prompt }];
      const base = { model, messages, max_completion_tokens: max };
      let note;
      let res;
      try {
        res = await client.chat.completions.create(temperature == null ? base : { ...base, temperature: Number(temperature) });
      } catch (err) {
        if (temperature != null && err instanceof OpenAI.BadRequestError && /temperature/i.test(err.message)) {
          res = await client.chat.completions.create(base);
          note = `${model} doesn't take a temperature, so it ran on its default.`;
        } else throw err;
      }
      const choice = res.choices?.[0];
      const text = String(choice?.message?.content ?? '').trim();
      if (!text && choice?.message?.refusal) return { ok: false, message: 'ChatGPT declined this request.' };
      return {
        ok: true, text, model: res.model,
        ...(note ? { note } : choice?.finish_reason === 'length' ? { note: 'Cut off at the length limit. Raise it if the answer needs more room.' } : {}),
      };
    }
    return { ok: false, message: 'Unknown model provider.' };
  } catch (err) {
    return { ok: false, message: describeError(provider, err) };
  }
}

/** A provider error, said as the thing to fix. */
function describeError(provider, err) {
  const name = provider === 'anthropic' ? 'Claude' : 'ChatGPT';
  const status = err?.status;
  if (/credit balance|insufficient_quota|billing/i.test(String(err?.message ?? ''))) return `This ${name} key is out of credit. Top it up with ${provider === 'anthropic' ? 'Anthropic' : 'OpenAI'}.`;
  if (status === 401 || status === 403) return `${name} rejected the key. Reconnect it in Integrations.`;
  if (status === 404) return `That ${name} model isn't available on this key.`;
  if (status === 429) return `${name} is rate-limiting this key, or it is out of credit.`;
  if (status >= 500) return `${name} had a problem on its side. Try again.`;
  return `${name}: ${String(err?.message ?? err).slice(0, 200)}`;
}
