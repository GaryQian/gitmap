// The set of commits the planner has queued so far, as one transferable buffer. Planner pages are
// stateless tasks that may run on different workers, so the set travels with the frontier: 16 bytes
// per commit at most, instead of a 40-character string each.

const MIN_SLOTS = 1024;

/**
 * Open-addressing hash set keyed by the first 64 bits of an object id (two commits of one repository
 * sharing those is not a practical concern). A slot is two uint32s; (0, 0) means empty.
 */
export class SeenSet {
  private table: Uint32Array;
  private mask: number;
  count: number;

  constructor(buffer?: ArrayBuffer | null, count = 0) {
    this.table = buffer && buffer.byteLength >= 8 ? new Uint32Array(buffer) : new Uint32Array(MIN_SLOTS * 2);
    this.mask = this.table.length / 2 - 1;
    this.count = count;
  }

  /** The backing buffer, to hand to the next page. The set must not be used after it is transferred. */
  get buffer(): ArrayBuffer {
    return this.table.buffer as ArrayBuffer;
  }

  private slot(a: number, b: number): number {
    const t = this.table;
    let i = ((a ^ Math.imul(b, 0x9e3779b1)) >>> 0) & this.mask;
    for (;;) {
      const x = t[2 * i], y = t[2 * i + 1];
      if ((x === a && y === b) || (x === 0 && y === 0)) return i;
      i = (i + 1) & this.mask;
    }
  }

  has(oid: string): boolean {
    const a = parseInt(oid.slice(0, 8), 16);
    const b = parseInt(oid.slice(8, 16), 16) || (a === 0 ? 1 : 0);
    const i = this.slot(a, b);
    return this.table[2 * i] === a && this.table[2 * i + 1] === b;
  }

  /** Add a commit. False when it was already there. */
  add(oid: string): boolean {
    const a = parseInt(oid.slice(0, 8), 16);
    const b = parseInt(oid.slice(8, 16), 16) || (a === 0 ? 1 : 0);
    const i = this.slot(a, b);
    const t = this.table;
    if (t[2 * i] === a && t[2 * i + 1] === b) return false;
    t[2 * i] = a;
    t[2 * i + 1] = b;
    if (++this.count * 2 > this.mask + 1) this.grow();
    return true;
  }

  private grow(): void {
    const old = this.table;
    this.table = new Uint32Array(old.length * 2);
    this.mask = this.table.length / 2 - 1;
    for (let k = 0; k < old.length; k += 2) {
      if (old[k] === 0 && old[k + 1] === 0) continue;
      const i = this.slot(old[k], old[k + 1]);
      this.table[2 * i] = old[k];
      this.table[2 * i + 1] = old[k + 1];
    }
  }
}
