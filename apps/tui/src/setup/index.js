import { render } from 'ink';
import { createElement } from 'react';
import { Wizard } from './Wizard';
export function runSetupWizard(opts) {
  return new Promise((resolve) => {
    const { unmount } = render(
      createElement(Wizard, {
        existing: opts.existing,
        startAtStep: opts.startAtStep,
        singleStep: opts.singleStep,
        onComplete: (result) => {
          unmount();
          resolve(result);
        },
      }),
    );
  });
}
