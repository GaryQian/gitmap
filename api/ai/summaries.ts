// POST /api/ai/summaries — Vercel Function (Node.js runtime, Web fetch handler). The logic is in src/ai/server.
import { createDeps, handlers } from '../../src/ai/server/index';

const deps = createDeps(process.env);

export default {
  fetch: (request: Request): Promise<Response> => handlers.summaries(request, deps),
};
