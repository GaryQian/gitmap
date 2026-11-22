const out = document.getElementById('out')!;
const log = (s: string) => { out.textContent += '\n' + s; console.log(s); };
(window as any).__walk = { done: false, result: null as any };
document.getElementById('go')!.onclick = async () => {
  out.textContent = `crossOriginIsolated=${crossOriginIsolated} ua=${navigator.userAgent}`;
  const root: FileSystemDirectoryHandle = await (window as any).showDirectoryPicker();
  const maxCommits = Number((document.getElementById('max') as HTMLInputElement).value) || undefined;
  const w = new Worker(new URL('./walk-worker.ts', import.meta.url), { type: 'module' });
  w.onmessage = e => {
    const m = e.data;
    if (m.type === 'progress') log(`${m.commits} commits ${(m.ms / 1000).toFixed(1)} s`);
    else if (m.type === 'setup') log(`setup: listed ${m.files} .git files in ${m.ms.toFixed(0)} ms`);
    else if (m.type === 'error') { log('ERROR ' + m.message); (window as any).__walk = { done: true, error: m.message }; }
    else if (m.type === 'done') { log(JSON.stringify(m.summary, null, 2)); (window as any).__walk = { done: true, result: m.summary }; w.terminate(); }
  };
  w.postMessage({ root, maxCommits });
};
