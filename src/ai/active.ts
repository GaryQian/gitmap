// Which AI provider is in use, and its three model tiers. Browser-safe: the page needs the answer
// for the digest hash and the reduce timing, the server for choosing its adapter and the model of
// each call, and both must agree. This file must not import ./server (which pulls in the provider SDK).
import type { Config } from '../config';
import type { ModelRole } from '../contracts/ai';

export type AiEnv = Record<string, string | undefined>;

/** One model id per tier (see `ModelRole`): summaries → bulk, tour → tour, the rest → synthesis. */
export type TierModels = Record<ModelRole, string>;

export interface ActiveAi {
  /** Lower-case provider id: 'anthropic', 'openai', or whatever was configured. */
  provider: 'anthropic' | 'openai' | (string & {});
  /** How the provider is written in a sentence: "Anthropic", "OpenAI". For logs and scripts; the chrome does not name it. */
  name: string;
  models: TierModels;
}

/**
 * The selected provider id: `VITE_AI_PROVIDER`, then `AI_PROVIDER`, then `config.ai.provider`,
 * trimmed and lower-cased. A variable that is set but blank counts as not set.
 */
export function resolveProviderId(env: AiEnv, config: Config): string {
  const pick = (v: string | undefined) => v?.trim() || undefined;
  return (pick(env.VITE_AI_PROVIDER) ?? pick(env.AI_PROVIDER) ?? config.ai.provider).trim().toLowerCase();
}

/**
 * The model id of each tier from one provider's block in config.json (`ai.models`,
 * `ai.openaiModels`). A block written before the tour had its own tier has no `tour` key: the tour
 * then stays on the synthesis model, as it was.
 */
export function tierModels(block: { synthesis: string; bulk: string; tour?: string }): TierModels {
  return { synthesis: block.synthesis, tour: block.tour?.trim() || block.synthesis, bulk: block.bulk };
}

/** Vite defines `import.meta.env` in the page and its workers; plain Node has none. */
function pageEnv(): AiEnv {
  const env: AiEnv | undefined = import.meta.env;
  return env ?? {};
}

/**
 * The provider in use and its models. Without `env` this reads what the page was built with
 * (`import.meta.env.VITE_AI_PROVIDER`), falling back to `config.ai.provider`; the server passes its
 * own environment. Each provider's model ids have their own block in config.json.
 */
export function activeAi(config: Config, env: AiEnv = pageEnv()): ActiveAi {
  const provider = resolveProviderId(env, config);
  switch (provider) {
    case 'anthropic':
      return { provider, name: 'Anthropic', models: tierModels(config.ai.models) };
    case 'openai':
      return { provider, name: 'OpenAI', models: tierModels(config.ai.openaiModels) };
    default:
      // Not a provider the server has an adapter for; it answers with its own error. The name is
      // still worth writing properly, and the default models keep the hash defined.
      return {
        provider,
        name: provider ? provider[0].toUpperCase() + provider.slice(1) : 'the AI provider',
        models: tierModels(config.ai.models),
      };
  }
}
