// The one place the digest learns how tokens are counted: the server's own estimate, so a digest
// that fits its budget here also passes the server's size check.
import { estimateTokens } from '../server';

export { estimateTokens };

/**
 * Cost of one block of lines as an item of a section. The sum of these never undercounts the joined
 * text, for any estimate that grows with length, so "sum of costs ≤ budget" keeps a section in budget.
 */
export function costOf(text: string): number {
  return estimateTokens(text + '\n');
}
