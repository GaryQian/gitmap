// Digest builder (PLAN.md §11.2, package 5B): deterministic assembly of model context under a token
// budget, from what the two parsing passes kept in memory. Same model in, byte-identical text out:
// the server caches the digest as a prompt prefix and results are stored under its hash.
//
// Runs on the main thread or in a worker; no DOM, no disk, no network.
//
//   buildDigest         the repo digest for the reduce calls, the per-city contexts for the map
//                       calls, the refs the model may cite, and the hash that keys stored results
//   buildDetailContext  the focused context for one detail button
//   poiCount            how many points of interest to ask for
//
// Layout
//   model.ts       the replica in canonical (id) order, with measured aggregates
//   filters.ts     exclusions, test paths, secret paths and the key-shaped-content scan
//   structure.ts   ~35%: cities, districts, edge weights, entry points, build manifests
//   skeletons.ts   ~35%: signatures of a stratified, not-only-hubs sample of files
//   docs.ts        ~30%: README and docs excerpts, labelled as claims
//   assemble.ts    the budget split and its redistribution
//   detail.ts      the detail-button context
//   tunables.ts    values waiting for a config.json entry
//
// Notation: every entity is written as its NodeRef (c:<id>, d:<id>, u:<path>) exactly as the server
// lists it under allowed references, usually at the start of the line that describes it. Only u:
// refs are files. Points of interest and tour steps stand on files (PLAN.md §11.3), so each city
// and district line is followed by "stands for it: u:…" — the file with the most links inside that
// area — next to its entry points and skeleton files, as candidates for an area-level point.
import type { Config } from '../../config';
import type { ModelReplica } from '../../contracts/store';
import type { NodeRef } from '../../model/types';
import { assemble } from './assemble';
import type { DigestTokens } from './assemble';
import { Ctx } from './ctx';
import type { DigestInput } from './ctx';
import { docsSection } from './docs';
import { skeletonSection } from './skeletons';
import { structureSection } from './structure';
import { DIGEST_VERSION, LOCAL } from './tunables';

export type { DigestInput } from './ctx';
export type { DigestTokens } from './assemble';
export { buildDetailContext } from './detail';
export type { DetailContext } from './detail';

/** One city's context for the bulk "map" call (`SummariesRequest`). */
export interface CityContext {
  ref: NodeRef;
  context: string;
  /** Every NodeRef written in `context`, sorted. */
  refs: NodeRef[];
  tokens: DigestTokens;
}

export interface DigestText {
  /** The repo digest (`PoisRequest.digest`, `TourRequest.digest`). */
  digest: string;
  /** Exactly the NodeRefs written in `digest`, sorted (`AiRequestBase.refs`). */
  refs: NodeRef[];
  /** One entry per city, in id order. */
  cities: CityContext[];
  /** Tokens per section and for the whole digest, by the server's estimate. */
  tokens: DigestTokens;
}

export interface Digest extends DigestText {
  /** Hex SHA-256 of the digest text and the model ids (`AiRequestBase.digestHash`). */
  hash: string;
}

/** Everything but the hash, synchronously. */
export function buildDigestText(input: DigestInput): DigestText {
  const ctx = new Ctx(input);
  const { ai } = input.config;
  const repo = assemble(
    { structure: structureSection(ctx, null), skeletons: skeletonSection(ctx, null), docs: docsSection(ctx, null) },
    ai.digestTokens, ai.budgetSplit,
  );
  const shares = ctx.cityShares;
  const cities = ctx.view.cities.map((c): CityContext => {
    // A city sees more than its slice of the repo digest, within a floor and a cap.
    const { scale, floor, cap } = LOCAL.city;
    const budget = Math.round(ai.digestTokens * Math.min(cap, Math.max(floor, scale * shares[c.index])));
    const city = assemble(
      { structure: structureSection(ctx, c.index), skeletons: skeletonSection(ctx, c.index), docs: docsSection(ctx, c.index) },
      budget, ai.budgetSplit,
    );
    return { ref: c.ref, context: city.text, refs: city.refs, tokens: city.tokens };
  });
  return { digest: repo.text, refs: repo.refs, cities, tokens: repo.tokens };
}

/**
 * Hex SHA-256 of the digest text, the model ids and the digest format version: stored results are
 * reused only for the same text sent to the same models.
 */
export async function digestHash(text: string, config: Config): Promise<string> {
  const { synthesis, bulk } = config.ai.models;
  const bytes = new TextEncoder().encode(`starmap-digest/${DIGEST_VERSION}\n${synthesis}\n${bulk}\n${text}`);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  let hex = '';
  for (const b of hash) hex += b.toString(16).padStart(2, '0');
  return hex;
}

export async function buildDigest(input: DigestInput): Promise<Digest> {
  const text = buildDigestText(input);
  return { ...text, hash: await digestHash(text.digest, input.config) };
}

/**
 * How many points of interest to ask for (PLAN.md §11.1): about one per city plus a few repo-wide,
 * capped. 0 for an empty model.
 */
export function poiCount(replica: ModelReplica, config: Config): number {
  const units = replica.table('unit').count;
  if (units === 0) return 0;
  const { perCity, repoWide, max } = config.ai.pois;
  return Math.max(1, Math.min(max, units, Math.round(replica.table('city').count * perCity) + repoWide));
}
