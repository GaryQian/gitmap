// Node implementation of the GitFs abstraction (stand-in for FileReaderSync on File.slice).
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { GitFs } from './core/fs.ts';

export class NodeGitFs implements GitFs {
  private fds = new Map<string, number>();
  constructor(private gitDir: string) {}
  private fd(p: string): number {
    let fd = this.fds.get(p);
    if (fd === undefined) {
      fd = fs.openSync(path.join(this.gitDir, p), 'r');
      this.fds.set(p, fd);
    }
    return fd;
  }
  readAt(p: string, offset: number, length: number): Uint8Array {
    const buf = new Uint8Array(length);
    let got = 0;
    const fd = this.fd(p);
    while (got < length) {
      const n = fs.readSync(fd, buf, got, length - got, offset + got);
      if (n === 0) break;
      got += n;
    }
    if (!p.startsWith('objects/pack/')) {
      // loose objects / refs: don't keep thousands of fds open
      fs.closeSync(fd);
      this.fds.delete(p);
    }
    return got === length ? buf : buf.subarray(0, got);
  }
  size(p: string): number {
    try {
      return fs.statSync(path.join(this.gitDir, p)).size;
    } catch {
      return -1;
    }
  }
  list(dir: string): string[] {
    try {
      return fs.readdirSync(path.join(this.gitDir, dir));
    } catch {
      return [];
    }
  }
}
