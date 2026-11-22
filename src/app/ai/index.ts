// AI in the chrome (package 5C): the consent prompt, the failure line, and the wiring from the
// detail buttons to the orchestration. The prompt and the line are mounted from mount.tsx; this is
// what other packages may call.
export { setAiController, getAiConsent, setAiConsent, resetConsent } from './state';
export type { AiController, AiRunOutcome } from './controller';
