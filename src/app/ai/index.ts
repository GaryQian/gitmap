// AI in the chrome (package 5C): the prompt at the bottom centre (consent card, then one pill), the
// failure line, the wiring from the detail buttons to the orchestration, and the settings card's
// "AI notes" row. The prompt and the line are mounted from mount.tsx; this is what other packages
// may call or render.
export { setAiController, getAiConsent, setAiConsent, resetConsent, switchAi } from './state';
export { AiSettingsRow } from './AiSettingsRow';
export type { AiController, AiRunOutcome } from './controller';
