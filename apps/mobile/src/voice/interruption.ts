// What a call does when iOS takes the audio session away — an incoming phone
// call, Siri, an alarm — and when it gives it back. Pure: inputs in, the next
// state and a list of effects out. `engine.ts` performs the effects.
//
// Three inputs, because iOS is not reliable about the third:
//
//   began       AVAudioSession interruption began. Playout must stop now (the
//               hardware is gone and a queued timeline would burst out when it
//               returns) and the uplink must go quiet (the recorder stalls, and
//               whatever it hands over mid-teardown is not the user talking).
//   ended       Interruption ended. `shouldResume` is iOS saying "resuming is
//               appropriate" — false when, for instance, the user started other
//               audio. A call resumes only when it is set.
//   app-active  AppState returned to `active`. iOS does not guarantee an
//               `ended` event at all (a declined call, a call answered on
//               another device), so coming back to the app re-arms a held call
//               whatever `ended` did or did not say.

export type InterruptionState = 'idle' | 'live' | 'held';

export type InterruptionInput =
  | { type: 'call-start' }
  | { type: 'call-end' }
  | { type: 'began' }
  | { type: 'ended'; shouldResume: boolean }
  | { type: 'app-active' };

export type InterruptionEffect =
  | 'stop-playout'
  | 'mute-uplink'
  | 'emit-held'
  | 'reactivate-session'
  | 'restart-recorder'
  | 'unmute-uplink'
  | 'emit-resumed';

export interface InterruptionStep {
  state: InterruptionState;
  effects: InterruptionEffect[];
}

const HOLD: InterruptionEffect[] = ['stop-playout', 'mute-uplink', 'emit-held'];
// Order matters: the session must be active before the recorder can start,
// and the uplink opens only once the recorder is delivering again.
const RESUME: InterruptionEffect[] = [
  'reactivate-session',
  'restart-recorder',
  'unmute-uplink',
  'emit-resumed',
];

export function interruptionStep(
  state: InterruptionState,
  input: InterruptionInput,
): InterruptionStep {
  switch (input.type) {
    case 'call-start':
      return { state: 'live', effects: [] };
    case 'call-end':
      return { state: 'idle', effects: [] };
    case 'began':
      return state === 'live' ? { state: 'held', effects: HOLD } : { state, effects: [] };
    case 'ended':
      return state === 'held' && input.shouldResume
        ? { state: 'live', effects: RESUME }
        : { state, effects: [] };
    case 'app-active':
      return state === 'held' ? { state: 'live', effects: RESUME } : { state, effects: [] };
  }
}
