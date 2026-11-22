// What the AI chrome knows about the open map: who to ask (the controller) and the viewer's stored
// answer for its repository. The prompt at the bottom centre and the settings row both read it here.
import { useMemo } from 'react';
import type { Consent } from '../../ai';
import type { Session } from '../../contracts/pipeline';
import type { ModelReplica } from '../../contracts/store';
import type { RepoMeta } from '../../model/types';
import { useReplica, useSession } from '../store';
import { sessionController } from './controller';
import type { AiController } from './controller';
import { getAiConsent, useAiUi } from './state';

export interface AiFacts {
  session: Session | null;
  /** Re-read as the model changes: meta arriving, annotations stored. */
  replica: ModelReplica | null;
  controller: AiController;
  meta: RepoMeta | null;
  /** The stored answer for this map's repository; null while unanswered or before the model arrives. */
  consent: Consent | null;
  /** Changes with every answer and whenever a run starts or ends. */
  rev: number;
}

export function useAiFacts(): AiFacts {
  const session = useSession();
  const replica = useReplica();
  const explicit = useAiUi((s) => s.controller);
  const rev = useAiUi((s) => s.rev);
  const controller = useMemo(() => explicit ?? sessionController(session), [explicit, session]);
  const meta = replica?.meta ?? null;
  const repoId = meta?.id ?? null;
  // `rev` is the change signal for the stored answer
  const consent = useMemo(() => (repoId === null ? null : getAiConsent(repoId)), [repoId, rev]);
  return { session, replica, controller, meta, consent, rev };
}
