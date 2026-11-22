// Has the build this tab is running been replaced on the server? A worker that will not start says
// nothing about why; when the reason is a new deployment, "reload" is the whole fix and the viewer
// should be told so.

/** What a response for one of this build's own files says about the build. Pure, for the test. */
export function responseSaysStale(status: number, contentType: string | null): boolean {
  // gone, or a host that answers every unknown path with the app's page
  return status === 404 || status === 410 || (status === 200 && /text\/html/i.test(contentType ?? ''));
}

/**
 * Ask the server for this module's own file. In a production build its name carries the build's
 * hash, so when it is gone the build was replaced. Resolves false when the answer is unclear
 * (offline, a dev server): a wrong "the app was updated" is worse than a general line.
 */
export async function buildIsStale(url: string = import.meta.url): Promise<boolean> {
  try {
    const res = await fetch(url, { method: 'HEAD', cache: 'no-store' });
    return responseSaysStale(res.status, res.headers.get('Content-Type'));
  } catch {
    return false;
  }
}
