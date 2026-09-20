import type { ErrorBoundaryProps } from 'expo-router';
import { View } from 'react-native';
import { color } from '../../theme/tokens';
import { Row } from './Row';

/** Every route's `ErrorBoundary` (R15): a render crash is a resolved row in the
 *  screen body — the tab bar and header stay; no white screen, no toast. */
export function RouteError({ error, retry }: ErrorBoundaryProps) {
  return (
    <View style={{ flex: 1, backgroundColor: color.bgBase, paddingTop: 16 }}>
      <Row
        wrap
        row={{ glyph: '✗', word: 'screen', subject: error.message, result: 'Retry' }}
        onPress={() => void retry()}
      />
    </View>
  );
}
