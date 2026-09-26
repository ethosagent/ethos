import type { ReactNode } from 'react';
import { StyleSheet, Text, type TextStyle, View, type ViewStyle } from 'react-native';
import { type MarkedStyles, Renderer, useMarkdown } from 'react-native-marked';
import { color, radius, type } from '../../theme/tokens';

/**
 * The kit's type roles for markdown (R4d): headings at h4, body text at body,
 * code spans and blocks in mono. Everything else is the library's default
 * layout on the kit's colours.
 */
class KitRenderer extends Renderer {
  override codespan(text: string, styles?: TextStyle): ReactNode {
    return (
      <Text key={this.getKey()} style={[styles, type.mono, s.codespan]}>
        {text}
      </Text>
    );
  }

  override code(
    text: string,
    _language?: string,
    _containerStyle?: ViewStyle,
    _textStyle?: TextStyle,
  ): ReactNode {
    return (
      <View key={this.getKey()} style={s.codeBlock}>
        <Text style={type.mono}>{text}</Text>
      </View>
    );
  }
}

const renderer = new KitRenderer();

const heading: TextStyle = { ...StyleSheet.flatten(type.h4), marginTop: 12, marginBottom: 4 };
const styles: MarkedStyles = {
  text: StyleSheet.flatten(type.body),
  paragraph: { marginVertical: 4 },
  h1: heading,
  h2: heading,
  h3: heading,
  h4: heading,
  h5: StyleSheet.flatten(type.body),
  h6: StyleSheet.flatten(type.body),
  li: StyleSheet.flatten(type.body),
  link: { color: color.chrome },
  strong: { fontWeight: '600' },
  hr: { backgroundColor: color.borderSubtle, height: 1 },
};

const theme = {
  colors: {
    text: color.textPrimary,
    link: color.chrome,
    code: color.bgOverlay,
    border: color.borderSubtle,
  },
};

/** Renders into its parent (no inner list), so it sits inside a ScrollView. */
export function MarkdownView({ value }: { value: string }) {
  const nodes = useMarkdown(value, { renderer, styles, theme, colorScheme: 'dark' });
  return <View>{nodes}</View>;
}

const s = StyleSheet.create({
  codespan: { backgroundColor: color.bgOverlay },
  codeBlock: {
    marginVertical: 6,
    padding: 10,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: color.borderSubtle,
    backgroundColor: color.bgElevated,
  },
});
