// The dim line shown while a tool runs: what the assistant is looking at, in a few words. Pure.
import type { ModelReplica } from '../../contracts/store';
import type { ChatToolCall } from './contract';
import { cleanPath, findArea } from './tools/lookup';

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null);

/** A path short enough for one line: its last three segments. */
function shortPath(raw: string): string {
  const parts = cleanPath(raw).split('/');
  return parts.length <= 3 ? parts.join('/') : `…/${parts.slice(-3).join('/')}`;
}

export function activityLabel(call: ChatToolCall, replica: ModelReplica | null): string {
  const input = call.input ?? {};
  const path = text(input.path);
  switch (call.name) {
    case 'get_repo_overview': return 'Looking over the map…';
    case 'list_area': {
      const area = replica && text(input.area) ? findArea(replica, text(input.area)!) : null;
      return area ? `Looking through ${area.label}…` : 'Looking through an area…';
    }
    case 'search_files': return text(input.query) ? `Searching for “${text(input.query)}”…` : 'Searching…';
    case 'get_file': return path ? `Looking at ${shortPath(path)}…` : 'Looking at a file…';
    case 'get_dependencies': return path ? `Looking up dependencies of ${shortPath(path)}…` : 'Looking up dependencies…';
    case 'read_file': return path ? `Reading ${shortPath(path)}…` : 'Reading a file…';
    case 'get_notes': return 'Reading the AI notes…';
    case 'get_view_state': return 'Checking what is on screen…';
    case 'set_overlay': return 'Changing the overlay…';
    case 'select':
    case 'clear_selection': return 'Changing the selection…';
    case 'focus_on':
    case 'reset_view': return 'Moving the camera…';
    case 'open_file': return path ? `Opening ${shortPath(path)}…` : 'Opening a file…';
    case 'set_filters': return 'Changing the filters…';
    default: return 'Working…';
  }
}
