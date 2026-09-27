import { personalityAccent } from '@ethosagent/design-tokens';
import { useQuery } from '@tanstack/react-query';
import Constants from 'expo-constants';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, type ScrollViewProps, StyleSheet, Text, View } from 'react-native';
import { KeyboardChatScrollView, KeyboardStickyView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { streams } from '../../api/client';
import { errorRow } from '../../api/errors';
import { modelName, usePersonalities, useRpc } from '../../api/queries';
import {
  abortTurn,
  adoptSession,
  decideApproval,
  loadOlder,
  openSession,
  sendMessage,
} from '../../features/chat/session';
import { callAvailable } from '../../features/voice/gating';
import { clock } from '../../lib/row';
import { tabBarBottomInset } from '../../lib/tab-bar-inset';
import { useCallMode } from '../../state/call-mode';
import { useChatStore } from '../../state/chat-store';
import { useConnection } from '../../state/connection';
import { color, TAB_BAR_PILL_HEIGHT, type } from '../../theme/tokens';
import { ApprovalPanel } from '../ui/ApprovalPanel';
import {
  ClarifyCard,
  Composer,
  MessageItem,
  PersonalityBar,
  StatusLine,
  TrailFooter,
} from '../ui/ChatParts';
import { Mark } from '../ui/Mark';
import { Row } from '../ui/Row';
import { Skeleton } from '../ui/Skeleton';
import { CallStrip } from '../voice/CallStrip';

const STALL_MS = 20_000;

/**
 * chat-empty · chat-live · chat-done · chat-approval · chat-clarify — one
 * surface, states from the shared reducer. `new` is a session not started yet:
 * the first send creates it, `onStarted` hands the id to the route, and the
 * surface follows it without a reset. Rendered by the Chat tab's
 * `[sessionId]` route and by Agents › New agent (the architect chat, §5).
 *
 * There is one chat store, so the session is (re)opened on FOCUS: a surface
 * returning to the front after another one took the store over reloads its
 * own session instead of showing the other one's.
 */
export function ChatSurface(props: {
  sessionId: string;
  personalityId?: string;
  onStarted: (sessionId: string) => void;
  /** The Chat tab hides the native header and pads for the status bar. */
  topInset: number;
  /** Team chat (§6): the bar's `<team> · coordinator` and `Ask <team>…`. */
  barContext?: string;
  placeholder?: string;
}) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const rpc = useRpc();
  const online = useConnection((s) => s.online);
  const picked = useConnection((s) => s.personalityId);
  const isNew = props.sessionId === 'new';
  const personalities = usePersonalities();
  const row = useQuery({
    queryKey: ['session', props.sessionId],
    queryFn: () => rpc.sessions.get({ id: props.sessionId, withMessages: false }),
    enabled: !isNew,
  });
  const personalityId =
    props.personalityId ??
    row.data?.session.personalityId ??
    picked ??
    personalities.data?.defaultId ??
    null;
  const personality = personalities.data?.items.find((p) => p.id === personalityId);
  const name = personality?.name ?? personalityId ?? 'Ethos';
  const accent = personalityId ? personalityAccent(personalityId) : color.chrome;
  // The composer's mic (§3, T7): only when the key holds `voice:talk`, the
  // personality can talk, and the build carries the native audio (not Expo Go).
  const whoami = useQuery({ queryKey: ['whoami'], queryFn: () => rpc.meta.whoami() });
  const canCall = callAvailable({
    scopes: whoami.data?.authMethod === 'bearer' ? whoami.data.key.scopes : null,
    toolset: personality?.toolset,
    executionEnvironment: Constants.executionEnvironment,
  });
  const openCall = (params: { personalityId: string | null; sessionId: string | null }) =>
    router.push({
      pathname: '/chat/call',
      params: {
        ...(params.personalityId ? { personalityId: params.personalityId } : {}),
        ...(params.sessionId ? { sessionId: params.sessionId } : {}),
      },
    });

  const messages = useChatStore((s) => s.chat.messages);
  const trail = useChatStore((s) => s.chat.trail);
  const stopped = useChatStore((s) => s.chat.stoppedTurnIds);
  const streaming = useChatStore((s) => s.chat.isStreaming);
  const approvals = useChatStore((s) => s.chat.pendingApprovals);
  const [deciding, setDeciding] = useState(false);
  const head = approvals[0];

  const sessionId = props.sessionId;
  useFocusEffect(
    useCallback(() => {
      // Already following it (a new session adopted after its first send).
      if (useChatStore.getState().sessionId === sessionId) return;
      if (sessionId === 'new') {
        streams.closeSession();
        useChatStore.getState().reset(null);
        return;
      }
      void openSession(rpc, sessionId).catch((err: unknown) =>
        useChatStore.getState().notice(errorRow(err, 'sessions.messages')),
      );
    }, [sessionId, rpc]),
  );

  const send = async (text: string) => {
    const id = await sendMessage(rpc, {
      text,
      online,
      personalityId: isNew ? personalityId : null,
    });
    if (isNew && id) {
      await adoptSession(rpc, id);
      props.onStarted(id);
    }
  };

  const loading = !isNew && row.isPending && messages.length === 0;
  const empty = !loading && messages.length === 0 && !streaming;
  // At rest, clear the floating tab bar; with the keyboard up the composer
  // rides the keyboard via KeyboardStickyView's own transform and the tab bar
  // retreats behind it, so `opened` adds nothing on top (see tabBarBottomInset).
  // KeyboardStickyView's offset is a `translateY` add-on (positive = down), so
  // lifting the composer clear of the pill needs the NEGATIVE of the
  // clearance amount, not the clearance itself.
  const restInset = tabBarBottomInset({
    tabBarHeight: TAB_BAR_PILL_HEIGHT,
    safeAreaBottom: insets.bottom,
    keyboardVisible: false,
  });

  return (
    <View style={[styles.screen, { paddingTop: props.topInset }]}>
      <PersonalityBar
        personalityId={personalityId ?? 'ethos'}
        name={name}
        model={modelName(personality?.model)}
        accent={accent}
        {...(props.barContext ? { context: props.barContext } : {})}
        onOpenSessions={() => router.navigate('/chat/sessions')}
        onNew={() => router.push('/chat/new-session')}
      />
      <View style={styles.flex}>
        {loading ? <Skeleton rows={3} height={48} /> : null}
        {empty ? (
          <View style={styles.empty}>
            <Mark personalityId={personalityId ?? 'ethos'} size={48} />
            <Text style={type.h4}>{name}</Text>
            {modelName(personality?.model) ? (
              <Text style={type.mono}>{modelName(personality?.model)}</Text>
            ) : null}
            <Text style={type.small}>Ready to help.</Text>
          </View>
        ) : (
          <Messages
            messages={messages}
            trail={trail}
            stopped={stopped}
            agent={name}
            bottomInset={restInset}
            onOlder={() => void loadOlder(rpc)}
            onAnswer={(requestId, answer) => {
              void rpc.clarify
                .respond({ requestId, answer, source: 'user' })
                .then(() =>
                  useChatStore.getState().notice({
                    glyph: '✓',
                    word: 'answered',
                    subject: 'clarify',
                    result: answer,
                    time: clock(Date.now()),
                  }),
                )
                .catch((err: unknown) =>
                  useChatStore.getState().notice(errorRow(err, 'clarify.respond')),
                );
            }}
          />
        )}
        {head ? (
          <ApprovalPanel
            key={head.approvalId}
            request={head}
            agent={name}
            accent={accent}
            queued={approvals.length}
            onDeciding={setDeciding}
            onDecide={(d) => decideApproval(rpc, head.approvalId, d)}
          />
        ) : null}
      </View>
      <KeyboardStickyView offset={{ closed: -restInset, opened: 0 }}>
        <CallStrip
          accent={accent}
          onOpen={() => {
            const owner = useCallMode.getState().owner;
            openCall(owner ?? { personalityId, sessionId: isNew ? null : sessionId });
          }}
        />
        <Status accent={accent} deciding={deciding} online={online} />
        <Composer
          name={name}
          accent={accent}
          streaming={streaming}
          {...(canCall
            ? { onCall: () => openCall({ personalityId, sessionId: isNew ? null : sessionId }) }
            : {})}
          {...(props.placeholder ? { placeholder: props.placeholder } : {})}
          onSend={(text) => void send(text)}
          onStop={() => void abortTurn(rpc)}
        />
      </KeyboardStickyView>
    </View>
  );
}

type Chat = ReturnType<typeof useChatStore.getState>['chat'];

/** History, the turn in flight and the session's resolved rows. The list only
 *  re-renders when a turn finishes; tokens re-render `Tail` alone (R4a). */
function Messages(props: {
  messages: Chat['messages'];
  trail: Chat['trail'];
  stopped: string[];
  agent: string;
  bottomInset: number;
  onOlder: () => void;
  onAnswer: (requestId: string, answer: string) => void;
}) {
  const list = useRef<FlatList<Chat['messages'][number]>>(null);
  const atEnd = useRef(true);
  return (
    <FlatList
      ref={list}
      data={props.messages}
      keyExtractor={(m) => m.id}
      contentContainerStyle={[styles.list, { paddingBottom: props.bottomInset }]}
      renderScrollComponent={(p: ScrollViewProps) => (
        <KeyboardChatScrollView {...p} keyboardLiftBehavior="whenAtEnd" />
      )}
      onStartReached={props.onOlder}
      maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
      onScroll={(e) => {
        const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
        atEnd.current = contentOffset.y + layoutMeasurement.height >= contentSize.height - 40;
      }}
      onContentSizeChange={() => {
        if (atEnd.current) list.current?.scrollToEnd({ animated: false });
      }}
      renderItem={({ item }) => (
        <View>
          <MessageItem message={item} />
          {item.role === 'assistant' ? (
            <TrailFooter
              entries={props.trail[item.id] ?? []}
              stopped={props.stopped.includes(item.id)}
            />
          ) : null}
        </View>
      )}
      ListFooterComponent={<Tail agent={props.agent} onAnswer={props.onAnswer} />}
    />
  );
}

function Tail({
  agent,
  onAnswer,
}: {
  agent: string;
  onAnswer: (id: string, answer: string) => void;
}) {
  const turn = useChatStore((s) => s.chat.currentTurn);
  const trail = useChatStore((s) => (turn ? s.chat.trail[turn.id] : undefined));
  const question = useChatStore((s) => s.chat.pendingClarifies[0]);
  const notices = useChatStore((s) => s.notices);
  return (
    <View>
      {turn ? <MessageItem message={turn} /> : null}
      {turn && trail ? <TrailFooter entries={trail} stopped={false} /> : null}
      {question ? (
        <ClarifyCard
          key={question.requestId}
          request={question}
          agent={agent}
          onAnswer={(a) => onAnswer(question.requestId, a)}
        />
      ) : null}
      {notices.map((n, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: notices are append-only
        <Row key={i} row={n} />
      ))}
    </View>
  );
}

/** The reserved slot: phase + elapsed, `⚠ still working` after 20 s without an
 *  event, `deciding…` while an approval is in flight, `✗ offline` when the
 *  last /healthz probe failed. */
function Status({
  accent,
  deciding,
  online,
}: {
  accent: string;
  deciding: boolean;
  online: boolean;
}) {
  const phase = useChatStore((s) => s.chat.phase);
  const label = useChatStore((s) => s.chat.currentOp);
  const startedAt = useChatStore((s) => s.chat.turnStartedAt);
  const lastEventAt = useChatStore((s) => s.chat.lastStreamEventAt);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!phase) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [phase]);
  if (!online)
    return <Row row={{ glyph: '✗', word: 'offline', subject: 'server', result: 'unreachable' }} />;
  return (
    <StatusLine
      phase={phase}
      label={label}
      elapsedMs={startedAt ? Math.max(0, now - startedAt) : 0}
      stalled={!!lastEventAt && now - lastEventAt > STALL_MS}
      deciding={deciding}
      accent={accent}
    />
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.bgBase },
  flex: { flex: 1 },
  list: { paddingHorizontal: 16, paddingVertical: 8 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8 },
});
