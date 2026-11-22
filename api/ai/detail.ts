// POST /api/ai/detail — Vercel Function (Node.js runtime, Web fetch handler). The logic is in src/ai/server.
import { createDeps, handlers } from '../_lib/server.mjs';

const deps = createDeps(process.env);

export default {
  fetch: (request: Request): Promise<Response> => handlers.detail(request, deps),
};
