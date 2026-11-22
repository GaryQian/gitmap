// Pool task 'history.plan': one page of the commit walk (see plan.ts). The first page also reports
// what the driver needs once: the start commit, `.mailmap`, and whether there is history at all.
import { defineTask, type TaskContext } from '../contracts/compute';
import { decodeText } from '../git';
import { mailmapHash } from './mailmap';
import { planPage } from './plan';
import { historyRepoFor, isUnavailable } from './repo';
import { HISTORY_PLAN_TASK, type PlanInput, type PlanPage } from './types';

/** The set of queued commits goes back to the driver without a copy. */
function handBack(page: PlanPage, ctx: TaskContext): PlanPage {
  if (page.frontier) ctx.transfer(page.frontier.seen);
  return page;
}

export default defineTask<PlanInput, PlanPage>({
  type: HISTORY_PLAN_TASK,
  async run(input, ctx) {
    const startedAt = Date.now();
    const repo = await historyRepoFor(ctx);
    if (isUnavailable(repo)) {
      return {
        unavailable: repo, headOid: null, shallow: false, commits: [], authors: [], frontier: null, stop: 'none',
        missingParents: 0, usedCommitGraph: false, startedAt, endedAt: Date.now(),
      };
    }
    const budgetMs = input.budgetMs ?? ctx.config.scheduler.taskTargetMs;
    if (input.frontier) return handBack(planPage(repo, input, budgetMs), ctx);

    const bytes = await repo.access.tree.read('.mailmap').catch(() => null);
    const mailmap = bytes ? decodeText(bytes) : null;
    const hash = mailmapHash(mailmap);
    // a saved result made under another mailmap cannot be extended: plan a full walk instead
    const stale = !!input.stopAt && input.sinceMailmap !== undefined && input.sinceMailmap !== hash;
    const page = planPage(repo, stale ? { ...input, stopAt: null } : input, budgetMs);
    if (stale && !page.unavailable) page.stop = 'abandoned';
    page.mailmap = mailmap;
    page.mailmapHash = hash;
    page.startedAt = startedAt;
    page.endedAt = Date.now();
    return handBack(page, ctx);
  },
});
