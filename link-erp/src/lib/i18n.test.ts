import { beforeEach, describe, expect, test } from 'vitest';
import { applyLang, coverage, readLang, translate, writeLang } from './i18n';

beforeEach(() => localStorage.clear());

describe('translation fallback', () => {
  test('a missing translation remains readable English', () => {
    expect(translate('hi', 'A new operational label')).toBe('A new operational label');
  });

  test('known portal terms have both first-pass catalogs', () => {
    expect(translate('hi', 'Process House Portal')).toBe('प्रोसेस हाउस पोर्टल');
    expect(translate('gu', 'Process House Portal')).toBe('પ્રોસેસ હાઉસ પોર્ટલ');
    expect(coverage('hi')).toBeGreaterThan(35);
    expect(coverage('gu')).toBe(coverage('hi'));
  });

  test('the chosen language survives reload and updates the document language', () => {
    writeLang('gu');
    expect(readLang()).toBe('gu');
    expect(document.documentElement.lang).toBe('gu');
    applyLang('en');
    expect(document.documentElement.lang).toBe('en');
  });
});
