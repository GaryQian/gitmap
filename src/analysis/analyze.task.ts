// Pool task: the whole analysis in one call (it is pure and synchronous).
import { defineTask } from '../contracts/compute';
import type { AnalysisInput, AnalysisResult } from '../contracts/pipeline';
import { analyze } from './index';

export default defineTask<AnalysisInput, AnalysisResult>({
  type: 'analysis.analyze',
  run: (input, ctx) => analyze(input, ctx.config),
});
