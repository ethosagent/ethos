import { useCallback, useState } from 'react';
import { rpc } from '../../rpc';

export function useGoalDetection() {
  const [intakeOpen, setIntakeOpen] = useState(false);
  const [detectedMessage, setDetectedMessage] = useState('');
  const [restatedGoal, setRestatedGoal] = useState('');

  const detectGoal = useCallback(async (message: string) => {
    try {
      const result = await rpc.goals.classify({ message });
      if (result.isGoal && result.confidence > 0.5) {
        setDetectedMessage(message);
        setRestatedGoal(result.restatedGoal ?? message);
        setIntakeOpen(true);
        return true;
      }
    } catch {
      // Classification failed — fall through to normal send
    }
    return false;
  }, []);

  const openIntake = useCallback((message: string) => {
    setDetectedMessage(message);
    setRestatedGoal(message);
    setIntakeOpen(true);
  }, []);

  return { intakeOpen, setIntakeOpen, detectedMessage, restatedGoal, detectGoal, openIntake };
}
