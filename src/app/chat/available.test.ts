import { describe, expect, it } from 'vitest';
import { config, withConfig } from '../../config';
import { chatAllowed } from './available';

describe('chatAllowed', () => {
  const local = { config, meta: { id: 'git:example', source: 'git' as const }, available: true };

  it('needs the viewer to have allowed AI for a local repo', () => {
    expect(chatAllowed({ ...local, consent: 'granted' })).toBe(true);
    expect(chatAllowed({ ...local, consent: null })).toBe(false);
    expect(chatAllowed({ ...local, consent: 'declined' })).toBe(false);
    expect(chatAllowed({ ...local, available: false, consent: 'granted' })).toBe(false);
  });

  it('is offered in a demo with no consent step, though a demo writes no notes', () => {
    const demo = { config, meta: { id: 'demo:react', source: 'demo' as const }, available: false, consent: null };
    expect(chatAllowed(demo)).toBe(true);
    expect(chatAllowed({ ...demo, config: withConfig({ ai: { enabled: false } }) })).toBe(false);
  });
});
