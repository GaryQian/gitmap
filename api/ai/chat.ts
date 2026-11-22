// POST /api/ai/chat — Vercel Function (Node.js runtime, Web fetch handler). The answer is a
// server-sent event stream; the logic is in src/ai/server/chat.ts.
import { createDeps, handlers } from '../_lib/server.mjs';

const deps = createDeps(process.env);

export default {
  fetch: (request: Request): Promise<Response> => handlers.chat(request, deps),
};
