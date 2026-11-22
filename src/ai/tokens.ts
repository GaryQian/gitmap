// The one cheap token estimate, shared by the browser-side digest builder and the server's size
// check, so a digest that fits its budget in the browser also passes on the server. Browser-safe:
// this file must not import the server (which pulls in the provider SDK).

/** Rough characters per token. Deliberately low so the estimate over-counts. */
export const CHARS_PER_TOKEN = 3.5;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}
