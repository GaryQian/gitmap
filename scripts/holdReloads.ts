// Dev server plugin: hold back page reloads for a tab that is showing a map.
//
// With agents editing the code, Vite reloaded the page every few seconds, so a map never got to
// finish loading. A tab with a map loading or open tells the server so ('starmap:hold'). While it
// holds, any change that would reload that tab is turned into a 'starmap:held' event instead, and the
// tab shows a "Code changed · Reload" pill (src/app/devreload). Changes that hot-swap in place
// (React components, CSS) still go through. Other tabs reload as usual.
//
// A change reloads the page when Vite sends 'full-reload', or when it reaches one of the modules that
// reload themselves on update (`import.meta.hot.accept(() => location.reload())`: the store, the
// session and the other modules that hold state).
import type { EnvironmentModuleNode, HotPayload, Plugin, WebSocketClient } from 'vite';

const RELOADS_ITSELF = /hot\.accept\(\s*\(\)\s*=>\s*location\.reload\(\)\s*\)/;

/** Whether the update would end in a self-reloading module, walking up to the nearest accepting boundary. */
function reachesReload(changed: readonly EnvironmentModuleNode[]): boolean {
  const seen = new Set<EnvironmentModuleNode>();
  const stack = [...changed];
  while (stack.length > 0) {
    const mod = stack.pop()!;
    if (seen.has(mod)) continue;
    seen.add(mod);
    if (RELOADS_ITSELF.test(mod.transformResult?.code ?? '')) return true;
    if (mod.isSelfAccepting) continue; // a hot-swap boundary: the update stops here
    for (const importer of mod.importers) {
      if (!importer.acceptedHmrDeps.has(mod)) stack.push(importer);
    }
  }
  return false;
}

export function holdReloads(): Plugin {
  const holders = new Set<WebSocketClient>();
  let clients: () => Set<WebSocketClient> = () => new Set();

  /** Send the held notice to holding tabs; returns the tabs that are not holding. */
  function notifyHolders(file: string | null): WebSocketClient[] {
    const others: WebSocketClient[] = [];
    for (const client of clients()) {
      if (holders.has(client)) client.send({ type: 'custom', event: 'starmap:held', data: { file } });
      else others.push(client);
    }
    return others;
  }
  function anyHolder(): boolean {
    const live = clients();
    for (const h of holders) if (!live.has(h)) holders.delete(h);
    return holders.size > 0;
  }

  return {
    name: 'starmap-hold-reloads',
    apply: 'serve',
    configureServer(server) {
      const ws = server.ws;
      clients = () => ws.clients;
      ws.on('starmap:hold', (data: { hold?: boolean }, client: WebSocketClient) => {
        if (data?.hold) holders.add(client); else holders.delete(client);
      });
      // Vite's own full reloads (an update with no boundary, a worker, an HTML file, invalidate)
      const send = ws.send.bind(ws) as (...args: unknown[]) => void;
      ws.send = ((...args: unknown[]) => {
        const payload = args[0] as HotPayload | string;
        if (typeof payload === 'object' && payload.type === 'full-reload' && anyHolder()) {
          for (const c of notifyHolders(payload.path ?? null)) c.send(payload);
          return;
        }
        send(...args);
      }) as typeof ws.send;
    },
    async hotUpdate({ file, modules, read }) {
      if (this.environment.name !== 'client' || !anyHolder()) return;
      // the changed module's own compiled code is already cleared by now: test its source instead
      const changedReloads = modules.length > 0 && RELOADS_ITSELF.test(await read());
      if (!changedReloads && !reachesReload(modules)) return;
      // the tabs that are not holding get the reload they would have had anyway
      for (const c of notifyHolders(file)) c.send({ type: 'full-reload', path: '*' });
      return [];
    },
  };
}
