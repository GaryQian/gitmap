// The "no counts in the prose" rule, as a check (the prompts in prompts.ts state it; a prompt is not
// a guarantee). Tour steps, city summaries and point-of-interest summaries say what the code does.
// A sentence such as "This entry point has eight outgoing links, leading into the map workflow."
// narrates a measurement instead, and is what this finds and removes.
//
// The trigger is a count of links or dependencies, not any number: "handles two kinds of request"
// and "retries three times" are ordinary prose and are left alone. Pure functions, no I/O.

/**
 * Digits, or a number word. "one", "a" and "no" are left out: they are too often not a count; so
 * is a number that names something ("version 2", "step 3").
 */
const NUM = String.raw`(?<!(?:version|step|phase|part|stage|layer|level|tier|port)\s)(?:\d[\d,.]*|zero|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|dozens?|hundreds|thousands|several|many|numerous|multiple|countless)(?:[- ](?:one|two|three|four|five|six|seven|eight|nine|hundred|thousand))*`;
/**
 * What is being counted: the plural nouns, and the verbs when their object is a pronoun ("twelve
 * files import it"). A singular after a number is some other noun phrase ("three import formats",
 * "two edge cases", "two dependency containers") and is not a link count.
 */
const LINKS = String.raw`(?:links|imports|dependencies|dependents|dependants|callers|importers|references(?!\s+implementations?)|edges|(?:import|reference)(?=\s+(?:it|this|them|from\s+(?:it|this|them|here))\b)|link(?=\s+(?:to|into|back|here)\b))`;
/** Up to this many words may sit between the number and what it counts: "eight outgoing links", "twelve other files import". */
const GAP = String.raw`(?:\s+[\w'-]+){0,3}?`;
/** Things that arrive or leave and are not links: "two incoming requests" is about behaviour. */
const TRAFFIC = String.raw`(?:requests?|messages?|events?|calls?|data|traffic|packets?|jobs?|tasks?|streams?|payloads?|responses?)`;

const PATTERNS: readonly RegExp[] = [
  // "eight outgoing links", "12 imports", "three other dependencies"
  new RegExp(String.raw`\b${NUM}${GAP}\s+${LINKS}\b`, 'i'),
  // "twelve files depend on it", "30 modules rely on this"
  new RegExp(String.raw`\b${NUM}${GAP}\s+(?:depends?|rel(?:y|ies))\s+(?:up)?on\b`, 'i'),
  // "imported by 14 files", "referenced from twenty places", "depended on by six"
  new RegExp(String.raw`\b(?:imported|referenced|linked(?:\s+to)?|depended\s+(?:up)?on|relied\s+(?:up)?on)\s+(?:by|from|in)\s+(?:[\w'-]+\s+){0,2}?${NUM}\b`, 'i'),
  // "eight outgoing", "5 incoming" (but not "two incoming requests")
  new RegExp(String.raw`\b${NUM}\s+(?:[\w'-]+\s+)?(?:incoming|outgoing|inbound|outbound)\b(?!\s+${TRAFFIC}\b)`, 'i'),
  // "fan-in of 12", "a fan-out as high as forty", "12 fan-in"
  new RegExp(String.raw`\bfan[- ]?(?:in|out)\b(?:\s+[\w'-]+){0,3}?\s+${NUM}\b`, 'i'),
  new RegExp(String.raw`\b${NUM}${GAP}\s+fan[- ]?(?:in|out)\b`, 'i'),
  // "links to 9 files", "links: 14"
  new RegExp(String.raw`\b${LINKS}\s*(?::|of|to|from|into)\s+(?:[\w'-]+\s+){0,1}?${NUM}\b(?=\s+(?:other\s+)?(?:files?|modules?|units?|places?|parts?|districts?|cities|areas?)\b|\s*[.,;)]|\s*$)`, 'i'),
];

/** Sentences of a short text. A full stop inside a file name ("main.ts") does not end one. */
export function sentences(text: string): string[] {
  return text.trim().split(/(?<=[.!?]["')\]]?)\s+(?=["'(\[]?[A-Z0-9])/).map((s) => s.trim()).filter(Boolean);
}

/** True when the sentence states how many links, imports, dependencies or dependents something has. */
export function statesLinkCount(sentence: string): boolean {
  return PATTERNS.some((p) => p.test(sentence));
}

export interface ProseCheck {
  /** The text without the offending sentences; the text itself when there were none. */
  text: string;
  /** The sentences that state a count of links or dependencies, in order. */
  removed: string[];
}

/** Find the sentences that narrate link or dependency counts, and the text that is left without them. */
export function withoutLinkCounts(text: string): ProseCheck {
  const all = sentences(text);
  const removed = all.filter(statesLinkCount);
  if (removed.length === 0) return { text: text.trim(), removed };
  return { text: all.filter((s) => !statesLinkCount(s)).join(' '), removed };
}

/** What the model is told on the retry: which sentence broke the rule, and what to write instead. */
export function linkCountProblem(where: string, removed: readonly string[]): string {
  const quoted = removed.map((s) => `"${s}"`).join(' and ');
  return `${where} states a count of links or dependencies (${quoted}). Say what the code there does and what it hands on to; never say how many links, imports, dependencies or dependents something has.`;
}
