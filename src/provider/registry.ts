import { XAI } from "./xai.ts";

/** Later the TUI picks from this map. Until then the agent always uses xAI. */
export const providers = {
  xai: XAI,
} as const;

export const activeProvider = providers.xai;
