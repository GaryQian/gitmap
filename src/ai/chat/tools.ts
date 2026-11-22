// The tool catalogue of the chat assistant: what it may look up and what it may do to the
// visualization. Definitions only; the app executes them (src/app/chat). The server sends exactly
// this list to the model and refuses calls to anything else. Nothing here can change the repo.
//
// Conventions for arguments and results:
//   - a file is named by its repo-relative path ("src/app/store.ts");
//   - a city or district is named by its ref ("c:<id>", "d:<id>") as returned by other tools;
//   - results are JSON text with short keys the descriptions spell out.
import type { ToolDefinition } from './types';

const obj = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({
  type: 'object', properties, required, additionalProperties: false,
});
const str = (description: string) => ({ type: 'string', description });
const int = (description: string) => ({ type: 'integer', description });

export const OVERLAY_NAMES = ['recency', 'ownership', 'reach', 'knowledgeRisk', 'tests', 'none'] as const;
export const DIRECTIONS = ['depends_on', 'depended_on_by'] as const;

export const CHAT_TOOLS: readonly ToolDefinition[] = [
  // ---- looking things up ----
  {
    name: 'get_repo_overview', kind: 'read',
    description: 'The map at a glance: repo name, file and line counts, languages, and every city with its ref, name (and folderName, the name it had before AI notes titled it, when that differs), size, districts and (when written) its summary. Call this first if the context does not already answer the question.',
    inputSchema: obj({}),
  },
  {
    name: 'list_area', kind: 'read',
    description: 'What is inside a city or district. For a city: its districts. For a district: its files with path, language, lines and importance (0 to 1: its rank among the files that other files depend on, 1 the most depended on; 0 means nothing depends on it). Most important first.',
    inputSchema: obj({ area: str('A city or district ref, such as "c:3" or "d:12".'), limit: int('Maximum rows, default 40.') }, ['area']),
  },
  {
    name: 'search_files', kind: 'read',
    description: 'Find files by name or path fragment (fuzzy). Returns paths with their city and district.',
    inputSchema: obj({ query: str('Part of a file name or path.'), limit: int('Maximum results, default 15.') }, ['query']),
  },
  {
    name: 'get_file', kind: 'read',
    description: 'Facts about one file: language, lines, city and district, importance, how many files depend on it and it depends on, its strongest dependencies and dependents with the symbols involved, history when known (last changed, commits, main authors), and any AI notes attached to it.',
    inputSchema: obj({ path: str('Repo-relative file path.') }, ['path']),
  },
  {
    name: 'get_dependencies', kind: 'read',
    description: 'Follow dependency links from a file: what it depends on, or what depends on it, out to a few hops.',
    inputSchema: obj({
      path: str('Repo-relative file path.'),
      direction: { type: 'string', enum: DIRECTIONS, description: '"depends_on": files this file uses. "depended_on_by": files that use it.' },
      depth: int('Hops to follow, 1 to 3. Default 1.'),
      limit: int('Maximum files, default 40.'),
    }, ['path', 'direction']),
  },
  {
    name: 'read_file', kind: 'read',
    description: 'The text of a file, or a range of its lines. Use it when a question needs the actual code. Long files are cut; ask for a line range to see more.',
    inputSchema: obj({ path: str('Repo-relative file path.'), start_line: int('First line, 1-based. Default 1.'), end_line: int('Last line, inclusive.') }, ['path']),
  },
  {
    name: 'get_notes', kind: 'read',
    description: 'The AI notes already on the map: city summaries, points of interest and the tour steps.',
    inputSchema: obj({}),
  },
  {
    name: 'get_view_state', kind: 'read',
    description: 'What the user is looking at now: the active overlay and its settings, the selected files and areas, the language filter, the size filter and the open file.',
    inputSchema: obj({}),
  },

  // ---- changing what the map shows ----
  {
    name: 'set_overlay', kind: 'act',
    description: 'Recolour the map by an overlay, or turn overlays off with "none". recency: how recently files changed. ownership: one contributor\'s share of the work (name them with `contributor`). reach: what the selected files depend on or are depended on by (`direction`; select files first). knowledgeRisk: files mostly written by one person. tests: test files, tested and untested source.',
    inputSchema: obj({
      overlay: { type: 'string', enum: OVERLAY_NAMES },
      contributor: str('For ownership: a contributor name, as get_file or get_repo_overview spell it.'),
      direction: { type: 'string', enum: DIRECTIONS, description: 'For reach.' },
    }, ['overlay']),
  },
  {
    name: 'select', kind: 'act',
    description: 'Select files so the user can see them: by explicit paths, or everything in a city or district, optionally narrowed to one language. Replaces the current selection unless mode is "add". Selecting also frames what was selected.',
    inputSchema: obj({
      paths: { type: 'array', items: { type: 'string' }, description: 'Repo-relative file paths.' },
      area: str('A city or district ref: select every file in it.'),
      language: str('Keep only files of this language id, such as "ts" or "python".'),
      mode: { type: 'string', enum: ['replace', 'add'] },
    }),
  },
  {
    name: 'clear_selection', kind: 'act',
    description: 'Deselect everything.',
    inputSchema: obj({}),
  },
  {
    name: 'focus_on', kind: 'act',
    description: 'Fly the camera to a file, a district or a city without changing the selection.',
    inputSchema: obj({ target: str('A file path, or a city or district ref.') }, ['target']),
  },
  {
    name: 'open_file', kind: 'act',
    description: 'Open a file in the side panel so the user can read it.',
    inputSchema: obj({ path: str('Repo-relative file path.') }, ['path']),
  },
  {
    name: 'set_filters', kind: 'act',
    description: 'Dim everything except some languages, and hide small files. Pass an empty languages list to show all languages again, and min_lines 0 to show files of every size.',
    inputSchema: obj({
      languages: { type: 'array', items: { type: 'string' }, description: 'Language ids to keep at full strength.' },
      min_lines: int('Hide files with fewer lines than this.'),
    }),
  },
  {
    name: 'reset_view', kind: 'act',
    description: 'Fly back to the whole map and put cities and districts back where they settled.',
    inputSchema: obj({}),
  },
];

export const CHAT_TOOL_NAMES: ReadonlySet<string> = new Set(CHAT_TOOLS.map((t) => t.name));
