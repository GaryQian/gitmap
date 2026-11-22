// Values of the chat assistant that have no config.json entry yet (PLAN.md §11.5, "Limits"). They
// sit here, in one place, until the lead adds them to the `ai` block. Browser-safe: the loop and the
// server handler both read them.
export const CHAT_TUNABLES = {
  /** Requests to the model per user message. Each one may end in tool calls; the last one's are still run. */
  maxSteps: 8,
  /** Characters of one tool result the model is shown; the rest is cut with a marker. */
  resultChars: 12_000,
  /**
   * Estimated tokens of context plus conversation that the loop sends. Above it the oldest turns
   * are dropped. Kept well under `config.ai.maxInputTokens`, which the server enforces.
   */
  historyTokens: 60_000,
  /** Estimated tokens the map overview (`ChatRequest.context`) may take. */
  contextTokens: 4_000,
  /** Output budget of one step. It includes the model's thinking, so it is far above a typical answer. */
  maxOutputTokens: 16_000,
  /**
   * How hard the model thinks before answering: `output_config.effort` on Anthropic,
   * `reasoning.effort` on OpenAI. Low keeps the first words quick, which is what a chat needs.
   * `null` leaves the field out, for a model that does not accept it.
   */
  effort: 'low' as 'low' | 'medium' | 'high' | null,
} as const;
