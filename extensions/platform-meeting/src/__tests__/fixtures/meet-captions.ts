// Recorded caption fixture — a realistic rolling Google Meet caption stream as
// the scraper observes it: each active line grows in place (last-wins), speakers
// interleave, one correction shortens/rewrites a line, and Meet re-emits a
// finalized line verbatim (the dedup case). Feeding `MEET_CAPTION_FRAGMENTS`
// through the CaptionParser must yield `EXPECTED_TRANSCRIPT`.

import type { TranscriptEntry } from '../../caption-parser';
import type { RawCaptionFragment } from '../../meeting-client';

export const MEET_CAPTION_FRAGMENTS: RawCaptionFragment[] = [
  // Block c1 (Alice) rolls out one word at a time.
  { speaker: 'Alice Chen', text: 'So', blockId: 'c1' },
  { speaker: 'Alice Chen', text: 'So I', blockId: 'c1' },
  { speaker: 'Alice Chen', text: 'So I think', blockId: 'c1' },
  { speaker: 'Alice Chen', text: 'So I think we should ship', blockId: 'c1' },
  { speaker: 'Alice Chen', text: 'So I think we should ship Phase D', blockId: 'c1' },
  // Meet re-emits the finalized line verbatim (dedup target).
  { speaker: 'Alice Chen', text: 'So I think we should ship Phase D', blockId: 'c1' },

  // Block c2 (Bob) — a mid-line correction: the ASR revises "Tuesday" to "Thursday",
  // and the last-wins rule keeps only the corrected final text.
  { speaker: 'Bob Kumar', text: 'Agreed, lets do it', blockId: 'c2' },
  { speaker: 'Bob Kumar', text: 'Agreed, lets do it Tuesday', blockId: 'c2' },
  { speaker: 'Bob Kumar', text: 'Agreed, lets do it Thursday', blockId: 'c2' },

  // Blocks c3 (Alice) and c4 (Bob) are briefly active at the same time — Meet
  // shows two caption lines. Interleaved updates must not cross-contaminate.
  { speaker: 'Alice Chen', text: 'Thursday works', blockId: 'c3' },
  { speaker: 'Bob Kumar', text: 'I will send', blockId: 'c4' },
  { speaker: 'Alice Chen', text: 'Thursday works for me', blockId: 'c3' },
  { speaker: 'Bob Kumar', text: 'I will send the invite', blockId: 'c4' },

  // Empty/whitespace fragments Meet emits between lines — must be ignored.
  { speaker: 'Bob Kumar', text: '   ', blockId: 'c5' },
];

export const EXPECTED_TRANSCRIPT: TranscriptEntry[] = [
  { speaker: 'Alice Chen', text: 'So I think we should ship Phase D' },
  { speaker: 'Bob Kumar', text: 'Agreed, lets do it Thursday' },
  { speaker: 'Alice Chen', text: 'Thursday works for me' },
  { speaker: 'Bob Kumar', text: 'I will send the invite' },
];
