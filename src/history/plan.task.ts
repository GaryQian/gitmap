// Pool task 'history.plan': one page of the commit walk (see plan.ts). The first page also reports
// what the driver needs once: the start commit, `.mailmap`, and whether there is history at all.
import { defineTask } from '../contracts/compute';
import { decodeText } from '../git';
import { planPage } from './plan';
import { historyRepoFor, isUnavailable } from './repo';
import { HISTORY_PLAN_TASK, type PlanInput, type PlanPage } from './types';

export default defineTask<PlanInput, PlanPage>({
  type: HISTORY_PLAN_TASK,
  async run(input, ctx) {
    const now = Date.now();
    const repo = await historyRepoFor(ctx);
    if (isUnavailable(repo)) {
      return {
        unavailable: repo, headOid: null, shallow: false, commits: [], authors: [], frontier: null, stop: 'none',
        missingParents: 0, usedCommitGraph: false, startedAt: now, endedAt: Date.now(),
      };
    }
    const page = planPage(repo, input, input.budgetMs ?? ctx.config.scheduler.taskTargetMs);
    if (!input.frontier && !page.unavailable) {
      const bytes = await repo.access.tree.read('.mailmap').catch(() => null);
      page.mailmap = bytes ? decodeText(bytes) : null;
      page.endedAt = Date.now();
    }
    if (page.frontier) ctx.transfer(page.frontier.seen);
    return page;
  },
});
