// The worker's handle on the model door. The door itself lives in @nous/core
// (src/llm/modelDoor.mjs) so the API and the worker share one implementation — GET-242.
//
// Importing this module registers the worker's instrumented Anthropic client (useleak tracks
// spend per `feature`) for `claude-*` models. Every worker model call imports from here, so the
// registration can never be skipped by boot order.

import Anthropic from 'useleak';
import { registerAnthropicClient, claudeClientOptions } from '@nous/core';

// Claude goes through OpenRouter when OPENROUTER_API_KEY is set, else Anthropic direct (GET-885).
const claude = claudeClientOptions();
registerAnthropicClient(new Anthropic(claude?.options ?? { apiKey: process.env.ANTHROPIC_API_KEY }), { provider: claude?.provider ?? null });

export {
  createMessage, messageText, parseJsonArray, ModelUnavailableError,
  pipelineModel, pipelineFallbackModel, writingModel, writingFallbackModel, tierModels,
  modelEndpoint, modelRoute, modelSetupStatus,
} from '@nous/core';
