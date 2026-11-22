// Right edge: the sidebar reader (PLAN.md §9, §17.6). Hidden until a file is opened (a double-click
// on a sphere sets `openFile`); opaque, because it holds code; read-only. Contents are read on
// demand through the session's ContentSource, so a local folder and a demo look the same from here.
import { useMemo } from 'react';
import type { AppMount } from '../../contracts/app';
import { useApp, useReplica, useSession } from '../store';
import { resolveTarget } from './files';
import { Reader } from './Reader';
import './sidebar.css';

function Sidebar() {
  const openFile = useApp((s) => s.openFile);
  const session = useSession();
  const replica = useReplica();
  const rev = replica?.rev ?? 0;
  // `rev` is a dependency on purpose: the replica object stays the same while its tables change
  const target = useMemo(() => (openFile ? resolveTarget(replica, openFile) : null), [replica, rev, openFile]);
  // nothing open, or a city or district (which is not a file)
  if (!openFile || !target) return null;
  return <Reader openFile={openFile} target={target} session={session} meta={replica?.meta ?? null} />;
}

const mount: AppMount = { region: 'rightEdge', order: 0, Component: Sidebar };
export default mount;
