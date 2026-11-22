// .mailmap (gitmailmap(5)): canonical names and addresses for commit authors.
//   Proper Name <commit@email>
//   <proper@email> <commit@email>
//   Proper Name <proper@email> <commit@email>
//   Proper Name <proper@email> Commit Name <commit@email>
// Names and addresses match case-insensitively; an entry that names the commit author wins over one
// that only gives the address.

interface Target { name: string | null; email: string | null }
interface Entry { any: Target | null; byName: Map<string, Target> }

export interface Mailmap {
  /** The canonical identity of a commit author. `nameFixed` is true when the name came from the map. */
  resolve(name: string, email: string): { name: string; email: string; nameFixed: boolean };
}

const LINE = /^([^<]*)<([^>]*)>(?:([^<]*)<([^>]*)>)?/;

/** Parse .mailmap text. Null when it holds no entry. */
export function parseMailmap(text: string): Mailmap | null {
  const byEmail = new Map<string, Entry>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line[0] === '#') continue;
    const m = LINE.exec(line);
    if (!m) continue;
    const name1 = m[1].trim();
    const email1 = m[2].trim();
    let target: Target;
    let commitName = '';
    let commitEmail: string;
    if (m[4] === undefined) {
      // "Proper Name <commit@email>": only the name changes
      if (!name1) continue;
      target = { name: name1, email: null };
      commitEmail = email1;
    } else {
      target = { name: name1 || null, email: email1 || null };
      commitName = m[3].trim();
      commitEmail = m[4].trim();
    }
    const key = commitEmail.toLowerCase();
    let entry = byEmail.get(key);
    if (!entry) byEmail.set(key, (entry = { any: null, byName: new Map() }));
    if (commitName) entry.byName.set(commitName.toLowerCase(), target);
    else entry.any = target; // a later line replaces an earlier one, as in git
  }
  if (byEmail.size === 0) return null;
  return {
    resolve(name, email) {
      const entry = byEmail.get(email.toLowerCase());
      const t = entry ? entry.byName.get(name.toLowerCase()) ?? entry.any : null;
      if (!t) return { name, email, nameFixed: false };
      return { name: t.name ?? name, email: t.email ?? email, nameFixed: t.name !== null };
    },
  };
}
