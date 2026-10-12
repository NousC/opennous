// The API's handle on the model door. The door itself lives in @nous/core
// (src/llm/modelDoor.mjs) so the API and the worker share one implementation — GET-242.
//
// Importing this module registers the API's instrumented Anthropic client (useleak tracks spend
// per `feature`) for `claude-*` models. Every single-turn API model call imports from here.
// Tool-using agent loops are different: they run through lib/model.mjs, which speaks each
// provider's tool protocol.

import Anthropic from 'useleak';
import { registerAnthropicClient } from '@nous/core';

registerAnthropicClient(new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }));

export {
  createMessage, messageText, parseJsonArray, ModelUnavailableError,
  pipelineModel, pipelineFallbackModel, writingModel, writingFallbackModel, tierModels,
  modelEndpoint, modelRoute, modelSetupStatus,
} from '@nous/core';
