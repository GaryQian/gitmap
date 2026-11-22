// When the chat exists at all: AI can run on this map and the viewer has allowed it for this
// repository (PLAN.md §11.5, "Consent"). The same facts and the same rule as the AI prompt at the
// bottom centre, which is why the chat button and the "Add AI notes" prompt never show together.
//
// A demo is the exception (plan/DEMO-MODE.md §4): its notes are in the package and are never written
// here, but the chat is offered, with no consent step. The code is published open source and
// nothing of the viewer's is sent but the questions they type.
import { aiCanRun } from '../ai/rules';
import { useAiFacts } from '../ai/useAiFacts';
import { usePhase } from '../store';
import { usePanel } from './panel';

/** Pure: the rule itself. */
export function chatAllowed(facts: Parameters<typeof aiCanRun>[0] & { consent: string | null }): boolean {
  if (facts.config.ai.enabled && facts.meta?.source === 'demo') return true;
  return facts.consent === 'granted' && aiCanRun(facts);
}

export function useChatAvailable(): boolean {
  const { session, controller, meta, consent } = useAiFacts();
  const phase = usePhase();
  return phase === 'map' && session !== null && chatAllowed({ config: session.config, meta, available: controller.available, consent });
}

/** For the side panel: whether it has a Chat tab, and whether that tab is the one showing. */
export function useChatTab(): { available: boolean; active: boolean } {
  const available = useChatAvailable();
  const tab = usePanel((s) => s.tab);
  return { available, active: available && tab === 'chat' };
}
