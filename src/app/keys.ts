// Keyboard shortcuts of the map (Escape, Home) are window listeners; they must leave text fields alone.

const TEXT_INPUTS = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number', '']);

/** True when a key press belongs to a field the user is typing in, not to the map. */
export function isTyping(target: EventTarget | null): boolean {
  if (typeof HTMLElement === 'undefined' || !(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') return true;
  return target.tagName === 'INPUT' && TEXT_INPUTS.has((target.getAttribute('type') ?? '').toLowerCase());
}
