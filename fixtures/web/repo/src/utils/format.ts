export interface Person {
  first: string;
  last: string;
}

export function formatName(p: Person): string {
  return `${p.first} ${p.last}`;
}
