import { describe, expect, it } from 'vitest';
import { isIos, withoutFocusZoom } from '../src/input-zoom';

describe('focus zoom on iOS', () => {
  it('recognises iPhones, iPads and an iPad asking for the desktop site, and nothing else', () => {
    expect(isIos({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1' })).toBe(true);
    expect(isIos({ userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15' })).toBe(true);
    expect(isIos({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15', platform: 'MacIntel', maxTouchPoints: 5 })).toBe(true);
    expect(isIos({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15', platform: 'MacIntel', maxTouchPoints: 0 })).toBe(false);
    expect(isIos({ userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36', platform: 'Linux armv81', maxTouchPoints: 5 })).toBe(false);
    expect(isIos({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0', platform: 'Win32', maxTouchPoints: 10 })).toBe(false);
  });

  it('adds the zoom limit to the viewport once, keeping everything else', () => {
    const original = 'width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content';
    const locked = withoutFocusZoom(original);
    expect(locked).toBe(`${original}, maximum-scale=1`);
    expect(withoutFocusZoom(locked)).toBe(locked);
    expect(withoutFocusZoom('width=device-width,maximum-scale=5')).toBe('width=device-width, maximum-scale=1');
  });
});
