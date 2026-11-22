// Which licence a repo is under, from the text of its licence file. A package republishes the repo's
// files, so its manifest names the licence (plan/DEMO-MODE.md §2).
import { LICENSE_CANDIDATES, type WritePackageOptions } from './package';

/** What a licence text that is not recognised is reported as. */
export const UNKNOWN_LICENSE = 'unknown';

/**
 * The SPDX id of a licence text, or 'unknown'. Matches the common permissive licences (MIT,
 * Apache-2.0, MPL-2.0, ISC, BSD-2-Clause, BSD-3-Clause), by title and then by wording.
 */
export function detectLicense(text: string): string {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const title = lines.slice(0, 3).join(' ').replace(/\s+/g, ' ');
  const whole = lines.join(' ').replace(/\s+/g, ' ');
  if (/\bMIT License\b/i.test(title)) return 'MIT';
  if (/\bApache License\b/i.test(title) && /\bVersion 2\.0\b/i.test(title)) return 'Apache-2.0';
  if (/\bMozilla Public License,? Version 2\.0\b/i.test(title)) return 'MPL-2.0';
  if (/\bISC License\b/i.test(title)) return 'ISC';
  if (/\bBSD 3-Clause\b/i.test(title)) return 'BSD-3-Clause';
  if (/\bBSD 2-Clause\b/i.test(title)) return 'BSD-2-Clause';
  // Many licence files start with the copyright line instead of a title: go by the operative sentence.
  if (/Permission is hereby granted, free of charge, to any person obtaining a copy of this software/i.test(whole)
    && /THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND/i.test(whole)) return 'MIT';
  if (/Permission to use, copy, modify, and(\/or)? distribute this software for any purpose with or without fee is hereby granted/i.test(whole)) return 'ISC';
  if (/Redistribution and use in source and binary forms, with or without modification, are permitted/i.test(whole)) {
    if (/must display the following acknowledge?ment/i.test(whole)) return UNKNOWN_LICENSE; // 4-clause
    return /Neither the name of .{1,200} nor the names of|may not be used to endorse or promote products/i.test(whole) ? 'BSD-3-Clause' : 'BSD-2-Clause';
  }
  return UNKNOWN_LICENSE;
}

/** The main licence file first: LICENSE, LICENSE.md / .txt, other LICENSE*, COPYING*, then the rest. */
function rank(name: string): number {
  if (/^LICEN[CS]E$/i.test(name)) return 0;
  if (/^LICEN[CS]E\.(md|txt)$/i.test(name)) return 1;
  if (/^LICEN[CS]E/i.test(name)) return 2;
  if (/^COPYING/i.test(name)) return 3;
  return 4;
}

/**
 * The repo's licence, read from its root files: the first of LICENSE_CANDIDATES (LICENSE* before
 * COPYING* before the others) whose text is recognised. 'unknown' when none is.
 * `read` is the same reader writePackage takes.
 */
export async function licenseOf(read: WritePackageOptions['read']): Promise<string> {
  const names = LICENSE_CANDIDATES.map((name, at) => ({ name, at }))
    .sort((a, b) => rank(a.name) - rank(b.name) || a.at - b.at)
    .map((c) => c.name);
  const files = await read(names);
  const decoder = new TextDecoder();
  for (const bytes of files) {
    if (!bytes) continue;
    const license = detectLicense(decoder.decode(bytes));
    if (license !== UNKNOWN_LICENSE) return license;
  }
  return UNKNOWN_LICENSE;
}
