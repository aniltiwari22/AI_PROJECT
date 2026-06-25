import { submitPromptToEngine } from './service1';
// Duplicated configurations cleanly fall back onto service module primitives
export const processSecondaryInferencePipeline = async (data) => {
  return await submitPromptToEngine(data);
};