import { ApiClient } from './api/client';
import { formatUser, formatDate } from '@util/format';
import type { User } from './api/types';

const text = "import { fake } from './fake'";

export function startApp(root: HTMLElement): void {
  const client = new ApiClient('/api');
  client.fetchUser(1).then((user: User) => {
    root.textContent = formatUser(user) + ' ' + formatDate(new Date()) + text.length;
  });
}
