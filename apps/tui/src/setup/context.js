import { createContext, useContext } from 'react';
export const WizardContext = createContext({
  answers: {},
  accent: '#E8E8E6',
  dispatch: () => {},
});
export function useWizardContext() {
  return useContext(WizardContext);
}
const QUICK_STEPS = [
  'entry',
  'provider',
  'auth',
  'model',
  'personality',
  'messaging',
  'summary',
  'launch',
];
const FULL_STEPS = [
  'entry',
  'provider',
  'provider-chain',
  'auth',
  'key-rotation',
  'model',
  'memory',
  'personality',
  'messaging',
  'daemon',
  'summary',
  'launch',
];
export function getStepOrder(mode) {
  return mode === 'full' ? FULL_STEPS : QUICK_STEPS;
}
export function nextStep(current, mode) {
  const order = getStepOrder(mode);
  const idx = order.indexOf(current);
  return order[idx + 1] ?? null;
}
export function prevStep(current, mode) {
  const order = getStepOrder(mode);
  const idx = order.indexOf(current);
  return idx > 0 ? (order[idx - 1] ?? null) : null;
}
export function isFullOnlyStep(step) {
  return ['provider-chain', 'key-rotation', 'memory', 'daemon'].includes(step);
}
