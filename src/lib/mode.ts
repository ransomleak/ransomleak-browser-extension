// Detector modes, shared by the background and the consent content script (one normalisation rule).
export type Mode = 'warn' | 'block' | 'log' | 'off';
const MODES: readonly Mode[] = ['warn', 'block', 'log', 'off'];
/** Unknown or missing values fall back (default 'warn'). */
export const modeOf = (m: unknown, fallback: Mode = 'warn'): Mode => (MODES.includes(m as Mode) ? (m as Mode) : fallback);
