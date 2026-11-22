// The ToolExecutor the chat loop calls: every tool of CHAT_TOOLS, with its arguments checked
// against the tool's schema first. It never throws: whatever goes wrong comes back as
// `{ ok: false, content }`, which the model reads and can correct.
import { CHAT_TOOLS, type ChatToolCall, type ToolExecutor, type ToolOutcome } from '../contract';
import { CHAT_UI } from '../tunables';
import { fail, validateArgs, type Args } from './args';
import type { ToolEnv } from './env';
import { getDependencies, getFile, readFile, searchFiles } from './files';
import { resetView, setFilters } from './filters';
import { setOverlay } from './overlay';
import { getNotes, getRepoOverview, listArea } from './overview';
import { clearSelection, focusOn, openFile, select } from './selection';
import { getViewState } from './view';

type Handler = (args: Args, env: ToolEnv, signal?: AbortSignal) => ToolOutcome | Promise<ToolOutcome>;

export const HANDLERS: Record<string, Handler> = {
  get_repo_overview: getRepoOverview,
  list_area: listArea,
  search_files: searchFiles,
  get_file: getFile,
  get_dependencies: getDependencies,
  read_file: readFile,
  get_notes: getNotes,
  get_view_state: getViewState,
  set_overlay: setOverlay,
  select,
  clear_selection: clearSelection,
  focus_on: focusOn,
  open_file: openFile,
  set_filters: setFilters,
  reset_view: resetView,
};

const CUT = '\n… (cut: the result was too long)';

/**
 * An executor over whatever map `env` returns at the moment of the call (null when none is open),
 * so a conversation never acts on a map that has been closed.
 */
export function createToolExecutor(env: () => ToolEnv | null): ToolExecutor {
  return {
    async execute(call: ChatToolCall, signal?: AbortSignal): Promise<ToolOutcome> {
      try {
        const tool = CHAT_TOOLS.find((t) => t.name === call.name);
        const handler = tool ? HANDLERS[tool.name] : undefined;
        if (!tool || !handler) return fail(`There is no tool called "${call.name}".`, { tools: CHAT_TOOLS.map((t) => t.name) });
        const checked = validateArgs(tool.inputSchema, call.input ?? {});
        if (!checked.ok) return fail(checked.error);
        if (signal?.aborted) return fail('Stopped.');
        const map = env();
        if (!map) return fail('No map is open.');
        const outcome = await handler(checked.args, map, signal);
        if (outcome.content.length <= CHAT_UI.resultChars) return outcome;
        return { ...outcome, content: outcome.content.slice(0, CHAT_UI.resultChars - CUT.length) + CUT };
      } catch (err) {
        console.warn(`starmap: chat tool ${call.name} failed`, err);
        return fail(`${call.name} could not be run on this map.`);
      }
    },
  };
}
