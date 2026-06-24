import { useCallback, useState } from 'react';

export function useGoalDetection() {
  const [intakeOpen, setIntakeOpen] = useState(false);
  const [detectedMessage, setDetectedMessage] = useState('');
  const [restatedGoal, setRestatedGoal] = useState('');

  const openIntake = useCallback((message: string) => {
    setDetectedMessage(message);
    setRestatedGoal(message);
    setIntakeOpen(true);
  }, []);

  return { intakeOpen, setIntakeOpen, detectedMessage, restatedGoal, openIntake };
}
