import {
  CALL_MOTION,
  type CallTreatment,
  type CallVisualState,
  callDrive,
  callStateColor,
  glowAlpha,
  REDUCED_MOTION_LEVEL,
  smoothLevel,
  THINKING_RADIUS_SCALE,
} from '@ethosagent/voice-client';
import { useEffect, useId, useRef, useState } from 'react';
import { AccessibilityInfo } from 'react-native';
import Svg, {
  Circle,
  ClipPath,
  Defs,
  G,
  Path,
  RadialGradient,
  Stop,
  Text as SvgText,
} from 'react-native-svg';
import {
  cometSegments,
  liquidPaths,
  orbPath,
  ringGeometry,
  stateDescription,
} from '../../features/voice/call-stage';

/** Follow the system's Reduce Motion setting. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    let live = true;
    void AccessibilityInfo.isReduceMotionEnabled()
      .then((on) => {
        if (live) setReduced(on);
      })
      .catch(() => {});
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced);
    return () => {
      live = false;
      sub.remove();
    };
  }, []);
  return reduced;
}

interface Frame {
  level: number;
  phase: number;
  orbit: number;
}

/**
 * The amplitude-driven shape (DESIGN.md § "Call Stage"), drawn with
 * react-native-svg from a JS `requestAnimationFrame` loop that reads the levels
 * per frame — never stored in a store, so a 60 Hz meter re-renders this leaf
 * alone. HOW it moves is `@ethosagent/voice-client`'s call-motion (`callDrive`
 * picks the source and whether to smooth; `smoothLevel` runs once; `glowAlpha`
 * and `waveHeight` drop out under reduced motion). Under Reduce Motion there
 * is no loop at all: one frame at `REDUCED_MOTION_LEVEL`, the comet a static
 * ring — a loop redrawing an amplitude is still motion.
 */
export function CallShape(props: {
  state: CallVisualState;
  treatment: CallTreatment;
  accent: string;
  name: string;
  size: number;
  micLevel: () => number;
  agentLevel: () => number;
}) {
  const { state, treatment, accent, size } = props;
  const reduced = useReducedMotion();
  const [frame, setFrame] = useState<Frame>({ level: 0, phase: 0, orbit: 0 });
  const levels = useRef({ mic: props.micLevel, agent: props.agentLevel });
  levels.current = { mic: props.micLevel, agent: props.agentLevel };
  const clipId = `call-clip-${useId()}`;
  const glowId = `call-glow-${useId()}`;

  useEffect(() => {
    if (reduced) {
      setFrame({ level: REDUCED_MOTION_LEVEL, phase: 0, orbit: 0 });
      return;
    }
    let handle = 0;
    const start = Date.now();
    const loop = (): void => {
      setFrame((prev) => {
        const drive = callDrive({
          state,
          micLevel: levels.current.mic(),
          agentLevel: levels.current.agent(),
          tSec: (Date.now() - start) / 1000,
          reduced: false,
        });
        const level = drive.smooth
          ? smoothLevel(prev.level, drive.raw, CALL_MOTION.smoothing)
          : drive.raw;
        return {
          level,
          phase: prev.phase + 0.016 * CALL_MOTION.waveSpeed * (0.6 + level),
          orbit: prev.orbit + 0.03 * CALL_MOTION.thinkOrbit,
        };
      });
      handle = requestAnimationFrame(loop);
    };
    handle = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(handle);
  }, [state, reduced]);

  const color = callStateColor(state, accent);
  const cx = size / 2;
  const cy = size / 2;
  const radius = size * 0.3 * (state === 'thinking' ? THINKING_RADIUS_SCALE : 1);
  const { level, phase } = frame;
  const glow = glowAlpha(level, reduced);
  const letter = (props.name[0] ?? '?').toUpperCase();
  const shape = { cx, cy, radius, level, phase, reduced };

  return (
    <Svg
      width={size}
      height={size}
      accessibilityRole="image"
      accessibilityLabel={stateDescription(state, props.name)}
    >
      <Defs>
        <ClipPath id={clipId}>
          <Circle cx={cx} cy={cy} r={radius} />
        </ClipPath>
        <RadialGradient id={glowId} cx={cx} cy={cy} r={radius * 2.1} gradientUnits="userSpaceOnUse">
          <Stop offset="0.24" stopColor={color} stopOpacity={glow} />
          <Stop offset="1" stopColor={color} stopOpacity={0} />
        </RadialGradient>
      </Defs>
      {glow > 0 ? <Circle cx={cx} cy={cy} r={radius * 2.1} fill={`url(#${glowId})`} /> : null}
      {treatment === 'liquid' ? (
        <Liquid {...shape} color={color} clipId={clipId} />
      ) : treatment === 'orb' ? (
        <Path d={orbPath(shape)} fill={color} fillOpacity={0.8} />
      ) : (
        <Rings radius={radius} cx={cx} cy={cy} level={level} reduced={reduced} color={color} />
      )}
      <SvgText
        x={cx}
        y={cy}
        fill="#FFFFFF"
        fillOpacity={0.92}
        fontSize={Math.round((treatment === 'rings' ? radius * 0.62 : radius) * 0.52)}
        fontWeight="600"
        textAnchor="middle"
        alignmentBaseline="central"
      >
        {letter}
      </SvgText>
      {state === 'thinking' ? (
        reduced ? (
          <Circle
            cx={cx}
            cy={cy}
            r={radius * 1.2}
            stroke={color}
            strokeOpacity={0.3}
            strokeWidth={2}
            fill="none"
          />
        ) : (
          cometSegments(cx, cy, radius * 1.2, frame.orbit, false).map((s, i) => (
            <Path
              // biome-ignore lint/suspicious/noArrayIndexKey: fixed segment count
              key={i}
              d={s.d}
              stroke={color}
              strokeOpacity={s.opacity}
              strokeWidth={2.6}
              strokeLinecap="round"
              fill="none"
            />
          ))
        )
      ) : null}
    </Svg>
  );
}

function Liquid(props: {
  cx: number;
  cy: number;
  radius: number;
  level: number;
  phase: number;
  reduced: boolean;
  color: string;
  clipId: string;
}) {
  const { cx, cy, radius, color } = props;
  const paths = liquidPaths(props);
  return (
    <>
      <G clipPath={`url(#${props.clipId})`}>
        <Circle cx={cx} cy={cy} r={radius} fill={color} fillOpacity={0.07} />
        <Path d={paths.fill} fill={color} fillOpacity={0.8} />
        <Path d={paths.surface} stroke={color} strokeOpacity={0.9} strokeWidth={1.5} fill="none" />
      </G>
      <Circle
        cx={cx}
        cy={cy}
        r={radius}
        stroke={color}
        strokeOpacity={0.55}
        strokeWidth={1.5}
        fill="none"
      />
    </>
  );
}

function Rings(props: {
  cx: number;
  cy: number;
  radius: number;
  level: number;
  reduced: boolean;
  color: string;
}) {
  const g = ringGeometry(props.radius, props.level, props.reduced);
  return (
    <>
      {g.rings.map((ring, i) => (
        <Circle
          // biome-ignore lint/suspicious/noArrayIndexKey: three fixed rings
          key={i}
          cx={props.cx}
          cy={props.cy}
          r={ring.r}
          stroke={props.color}
          strokeOpacity={ring.opacity}
          strokeWidth={2}
          fill="none"
        />
      ))}
      <Circle cx={props.cx} cy={props.cy} r={g.core} fill={props.color} fillOpacity={0.92} />
    </>
  );
}
