// Is this a phone? On one the chrome is folded behind a menu (shell.css, PLAN.md §17.6); a desktop
// window, however small, and a tablet keep the full chrome.
import { useEffect, useState } from 'react';

/** A viewport with one side this short, in CSS pixels, is phone-sized. A tablet is wider both ways. */
export const PHONE_MAX_SIDE = 600;

export interface PhoneSignals {
  width: number;
  height: number;
  /** The main pointer is a finger: the `(pointer: coarse)` media query. */
  coarsePointer: boolean;
  /** The browser calls itself a mobile one (user-agent client hints, or "Mobi" in the user-agent string). */
  mobileAgent: boolean;
}

/**
 * A phone is a small viewport on a device that is used by touch. Size alone is not enough (a desktop
 * window can be made that small) and touch alone is not either (laptops and tablets have it).
 */
export function isPhone(s: PhoneSignals): boolean {
  return Math.min(s.width, s.height) <= PHONE_MAX_SIDE && (s.coarsePointer || s.mobileAgent);
}

export function readSignals(): PhoneSignals {
  const nav = typeof navigator === 'undefined' ? undefined : (navigator as Navigator & { userAgentData?: { mobile?: boolean } });
  return {
    width: typeof window === 'undefined' ? Infinity : window.innerWidth,
    height: typeof window === 'undefined' ? Infinity : window.innerHeight,
    coarsePointer: typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches,
    mobileAgent: nav?.userAgentData?.mobile ?? /Mobi|Android/i.test(nav?.userAgent ?? ''),
  };
}

/** True on a phone; follows the window as it is resized or turned. */
export function usePhone(): boolean {
  const [phone, setPhone] = useState(() => isPhone(readSignals()));
  useEffect(() => {
    const check = () => setPhone(isPhone(readSignals()));
    check();
    window.addEventListener('resize', check);
    const query = typeof matchMedia === 'function' ? matchMedia('(pointer: coarse)') : null;
    query?.addEventListener('change', check);
    return () => {
      window.removeEventListener('resize', check);
      query?.removeEventListener('change', check);
    };
  }, []);
  return phone;
}
