import type { User } from './types';
import { formatDate } from '../util/format';

export class ApiClient {
  constructor(private base: string) {}

  /** Fetch one user by id. */
  async fetchUser(id: number): Promise<User> {
    const res = await fetch(this.base + '/users/' + id + '?t=' + formatDate(new Date()));
    return (await res.json()) as User;
  }
}
