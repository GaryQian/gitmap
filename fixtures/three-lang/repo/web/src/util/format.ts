import type { User } from '../api/types';

/** Display name of a user. */
export function formatUser(user: User): string {
  return user.name + ' #' + user.id;
}

export function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
