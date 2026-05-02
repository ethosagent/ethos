import { render } from 'ink';
import { createElement } from 'react';
import type { WizardAnswers, WizardStepId } from './context';
import { Wizard } from './Wizard';

export type { WizardAnswers, WizardStepId };

export interface RunSetupWizardOpts {
  existing: WizardAnswers | null;
  startAtStep?: WizardStepId;
}

export interface RunSetupWizardResult {
  answers: WizardAnswers;
  launchChat: boolean;
}

export function runSetupWizard(opts: RunSetupWizardOpts): Promise<RunSetupWizardResult | null> {
  return new Promise((resolve) => {
    const { unmount } = render(
      createElement(Wizard, {
        existing: opts.existing,
        startAtStep: opts.startAtStep,
        onComplete: (result) => {
          unmount();
          resolve(result);
        },
      }),
    );
  });
}
