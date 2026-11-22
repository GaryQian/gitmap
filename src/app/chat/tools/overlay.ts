// set_overlay: turn an overlay on or off, with its one parameter, the way the overlay pills and
// their card do (the active overlay in the app store; the contributor and the direction in the
// overlay feature's own store).
import { OVERLAYS, ownershipContributors, type HistoryContributor, type ReachDirection } from '../../../overlays';
import { filterContributors, sortContributors } from '../../overlays/logic';
import type { ToolOutcome } from '../contract';
import { CHAT_UI } from '../tunables';
import { fail, ok, type Args } from './args';
import type { ToolEnv } from './env';
import { likeness } from './lookup';
import { overlaysOnOffer } from './overview';

export type ContributorMatch =
  | { kind: 'found'; contributor: HistoryContributor; others: HistoryContributor[] }
  | { kind: 'none'; close: HistoryContributor[] };

const fold = (text: string): string => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

/**
 * A contributor from a name as someone would say it: the exact name in any case and without its
 * accents, else the names that contain every word (a first name alone will do), else one typo away.
 * Several matches go to the one with the most commits, and the others are reported. With no match,
 * the names that look most like it are offered.
 */
export function resolveContributor(list: readonly HistoryContributor[], name: string): ContributorMatch {
  const wanted = fold(name);
  const sorted = sortContributors(list);
  const exact = sorted.filter((c) => fold(c.name) === wanted);
  const found = exact.length > 0 ? exact : wanted === '' ? [] : filterContributors(list, name);
  if (found.length > 0) return { kind: 'found', contributor: found[0]!, others: found.slice(1, CHAT_UI.suggestions) };
  const close = sorted
    .map((c) => ({ c, score: likeness(wanted, fold(c.name)) }))
    .filter((x) => x.score >= 0.25)
    .sort((a, b) => b.score - a.score || b.c.commits - a.c.commits)
    .slice(0, CHAT_UI.suggestions)
    .map((x) => x.c);
  // nothing looks alike: the people who did most of the work are the likeliest to have been meant
  return { kind: 'none', close: close.length > 0 ? close : sorted.slice(0, CHAT_UI.suggestions) };
}

const DIRECTION: Record<string, ReachDirection> = { depends_on: 'dependsOn', depended_on_by: 'dependedOnBy' };
const DIRECTION_WORDS: Record<ReachDirection, string> = { dependsOn: 'what the selection depends on', dependedOnBy: 'what depends on the selection' };

export function setOverlay(args: Args, env: ToolEnv): ToolOutcome {
  const { replica } = env;
  const view = env.view();
  const wanted = args.overlay as string;
  const labelOf = (id: string): string => OVERLAYS.find((o) => o.id === id)?.label ?? id;

  if (wanted === 'none') {
    if (view.activeOverlay === null) return ok({ overlay: null, note: 'No overlay was on.' });
    env.act.setActiveOverlay(null);
    return ok({ overlay: null }, `Turned off the ${labelOf(view.activeOverlay)} overlay`);
  }

  const offered = overlaysOnOffer(env);
  const overlay = offered.find((o) => o.id === wanted);
  if (!overlay) {
    const known = OVERLAYS.some((o) => o.id === wanted);
    return fail(
      known ? `The ${labelOf(wanted)} overlay needs git history, which this map does not have.` : `The ${wanted} overlay is not available.`,
      { available: offered.map((o) => o.id) },
    );
  }

  const result: Record<string, unknown> = { overlay: overlay.id };
  const notes: string[] = [];
  if (!overlay.ready) notes.push('Its data has not arrived yet; the map fills in as it does.');
  const already = view.activeOverlay === overlay.id;
  let action = already ? null : `Turned on the ${overlay.label} overlay`;

  if (overlay.id === 'ownership') {
    const contributors = ownershipContributors(replica.layers.get('ownership'));
    const asked = args.contributor as string | undefined;
    const current = contributors.find((c) => c.id === view.contributorId) ?? contributors[0] ?? null;
    let shown = current;
    if (asked !== undefined && asked.trim() !== '') {
      if (contributors.length === 0) {
        notes.push(`No contributor is known yet, so "${asked}" could not be looked up; the overlay shows whoever made the most commits.`);
      } else {
        const match = resolveContributor(contributors, asked);
        if (match.kind === 'none') {
          return fail(`No contributor matches "${asked}". The overlay was not changed.`, { closest: match.close.map((c) => c.name) });
        }
        shown = match.contributor;
        if (match.others.length > 0) result.alsoMatched = match.others.map((c) => c.name);
        env.act.setContributor(shown.id);
      }
    }
    if (shown) {
      result.contributor = shown.name;
      result.commits = shown.commits;
      if (!already) action = `Turned on the Ownership overlay for ${shown.name}`;
      else if (shown.id !== current?.id) action = `Showing ${shown.name} in the Ownership overlay`;
    }
  } else if (args.contributor !== undefined) {
    notes.push('"contributor" applies to the ownership overlay only and was ignored.');
  }

  if (overlay.id === 'reach') {
    const direction = args.direction === undefined ? view.direction : DIRECTION[args.direction as string]!;
    if (direction !== view.direction) env.act.setDirection(direction);
    result.direction = direction === 'dependsOn' ? 'depends_on' : 'depended_on_by';
    result.selected = view.selection.length;
    if (!already) action = `Turned on the Dependency reach overlay: ${DIRECTION_WORDS[direction]}`;
    else if (direction !== view.direction) action = `Dependency reach now shows ${DIRECTION_WORDS[direction]}`;
    if (view.selection.length === 0) notes.push('Nothing is selected, so the overlay has nothing to start from. Select one or more files and it will show their reach.');
  } else if (args.direction !== undefined) {
    notes.push('"direction" applies to the reach overlay only and was ignored.');
  }

  if (!already) env.act.setActiveOverlay(overlay.id);
  if (notes.length > 0) result.note = notes.join(' ');
  if (action === null) return ok({ ...result, unchanged: `The ${overlay.label} overlay was already on.` });
  return ok(result, action);
}
