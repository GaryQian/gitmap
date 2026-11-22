import { describe, expect, it } from 'vitest';
import { config } from '../config';
import { hexToRgb } from '../shared';
import {
  cardOpacity, contrastChecks, contrastRatio, over, pillOpacity, PILL_TEXT_CONTRAST, sceneFadeFloor, strongOpacity, surfaceColor,
  themeVariables, worstBackdrop,
} from './theme';

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

  it('reaches the required contrast for every pairing of text, mark and material, in both modes', () => {
    for (const mode of ['dark', 'light'] as const) {
      const short = contrastChecks(mode).filter((c) => c.ratio < c.min).map((c) => `${mode}: ${c.what} is ${c.ratio.toFixed(2)}, needs ${c.min}`);
      expect(short).toEqual([]);
      // more opaque at each step: pill, card, the strong material
      expect(cardOpacity(mode)).toBeGreaterThanOrEqual(pillOpacity(mode));
      expect(strongOpacity(mode)).toBeGreaterThanOrEqual(cardOpacity(mode));
      expect(sceneFadeFloor(mode)).toBeLessThanOrEqual(1);
    }
  });

  it('writes the colours it measured into the CSS variables', () => {
    // "rgb(r, g, b)" or "rgba(r, g, b, a)" as themeVariables emits them
    const parse = (css: string) => {
      const n = css.match(/[\d.]+/g)!.map(Number);
      return { rgb: [n[0]! / 255, n[1]! / 255, n[2]! / 255] as [number, number, number], alpha: n[3] ?? 1 };
    };
    for (const mode of ['dark', 'light'] as const) {
      const vars = themeVariables(mode);
      const card = parse(vars['--gm-card-bg']!);
      const cardOverWorst = over(card.rgb, card.alpha, worstBackdrop(mode));
      // 8-bit rounding of the emitted colours costs a few hundredths
      expect(contrastRatio(parse(vars['--gm-text-dim']!).rgb, cardOverWorst)).toBeGreaterThan(PILL_TEXT_CONTRAST - 0.05);
      expect(contrastRatio(parse(vars['--gm-link']!).rgb, cardOverWorst)).toBeGreaterThan(PILL_TEXT_CONTRAST - 0.05);
      const pill = parse(vars['--gm-pill-bg']!);
      expect(contrastRatio(hexToRgb(config.theme[mode].text), over(pill.rgb, pill.alpha, worstBackdrop(mode)))).toBeGreaterThanOrEqual(PILL_TEXT_CONTRAST);
      expect(contrastRatio(parse(vars['--gm-text-quiet']!).rgb, hexToRgb(config.theme[mode].sidebar))).toBeGreaterThan(PILL_TEXT_CONTRAST - 0.05);
    }
  });

  it('emits the mode\'s own tokens', () => {
    expect(themeVariables('dark')['--gm-void']).toBe(config.theme.dark.void);
    expect(themeVariables('light')['--gm-text']).toBe(config.theme.light.text);
  });
});
