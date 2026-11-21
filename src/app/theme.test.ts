import { describe, expect, it } from 'vitest';
import { config } from '../config';
import { hexToRgb } from '../shared';
import { contrastRatio, over, pillOpacity, PILL_TEXT_CONTRAST, resolveMode, surfaceColor, themeVariables } from './theme';

describe('theme tokens', () => {
  it('measures contrast the WCAG way', () => {
    expect(contrastRatio([0, 0, 0], [1, 1, 1])).toBeCloseTo(21, 5);
    expect(contrastRatio([0.5, 0.5, 0.5], [0.5, 0.5, 0.5])).toBeCloseTo(1, 5);
  });

  it('keeps pill text readable over the worst backdrop, in both modes', () => {
    for (const mode of ['dark', 'light'] as const) {
      const text = hexToRgb(config.theme[mode].text);
      const pill = over(hexToRgb(surfaceColor(mode)), pillOpacity(mode), text);
      expect(contrastRatio(text, pill)).toBeGreaterThanOrEqual(PILL_TEXT_CONTRAST);
      expect(pillOpacity(mode)).toBeGreaterThanOrEqual(config.theme.pill.opacity);
    }
  });

  it('emits the mode\'s own tokens', () => {
    expect(themeVariables('dark')['--gm-void']).toBe(config.theme.dark.void);
    expect(themeVariables('light')['--gm-text']).toBe(config.theme.light.text);
  });

  it('follows the system only when asked to', () => {
    expect(resolveMode('system', true)).toBe('dark');
    expect(resolveMode('system', false)).toBe('light');
    expect(resolveMode('light', true)).toBe('light');
  });
});
