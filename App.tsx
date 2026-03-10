import React, {
  useState,
  useEffect,
  useRef,
  useCallback,
} from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  Dimensions,
  Animated,
  Easing,
  PanResponder,
  StatusBar,
  SafeAreaView,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Haptics from 'expo-haptics';

const { width: SW, height: SH } = Dimensions.get('window');

// ─── Constants ────────────────────────────────────────────────────────────────
const HUD_H            = SH * 0.17;
const GAME_TOP         = HUD_H;
const GAME_H           = SH - HUD_H - 60;
const TARGET_R         = 32;
const HIT_TOLERANCE    = TARGET_R + 14;
const APPROACH_START   = TARGET_R * 3.2;
const APPROACH_DURATION = 1400;
const VISIBLE_AHEAD    = 4;
const GHOST_INTERVAL   = 10;

const HIGH_SCORE_KEY   = 'flow_high_score';
const THEME_UNLOCK_KEY = 'flow_theme_unlocked';

type GameState = 'start' | 'playing' | 'dying' | 'over';

// ─── Color Themes ─────────────────────────────────────────────────────────────
const THEMES = {
  default: {
    bg: '#03000A',
    accent: '#00FFAA',
    accent2: '#FF6BFF',
    hudGlow: '#00FFAA',
    progressBar: '#00FFAA',
    starColor: '#ffffff',
    colors: ['#FF6BFF','#00FFAA','#FFD700','#00CFFF','#FF4F7B','#A78BFA','#34D399','#60A5FA'],
  },
  inferno: {
    bg: '#0A0100',
    accent: '#FF6B00',
    accent2: '#FF003C',
    hudGlow: '#FF6B00',
    progressBar: '#FF6B00',
    starColor: '#FFB060',
    colors: ['#FF6B00','#FF003C','#FFD700','#FF8C42','#FF4F7B','#FF2D78','#F59E0B','#EF4444'],
  },
} as const;

type ThemeName = keyof typeof THEMES;

// ─── Speed Tiers ──────────────────────────────────────────────────────────────
const SPEED_TIERS = [
  { min: 0,  label: 'SLOW',   color: '#60A5FA' },
  { min: 5,  label: 'NORMAL', color: '#00FFAA' },
  { min: 12, label: 'FAST',   color: '#FFD700' },
  { min: 22, label: 'TURBO',  color: '#FF6BFF' },
  { min: 35, label: 'INSANE', color: '#FF4F7B' },
];

function getSpeedTier(score: number) {
  let tier = SPEED_TIERS[0];
  for (const t of SPEED_TIERS) { if (score >= t.min) tier = t; }
  return tier;
}

// ─── Interfaces ───────────────────────────────────────────────────────────────
interface HitTarget {
  id: number; seqNum: number; x: number; y: number; color: string;
  approachAnim: Animated.Value; fadeAnim: Animated.Value; hitScale: Animated.Value;
  state: 'waiting' | 'active' | 'hit' | 'missed';
}

interface GhostDecoy {
  id: number; x: number; y: number; color: string;
  fadeAnim: Animated.Value; pulseAnim: Animated.Value;
}

interface Spark {
  id: number; x: number; y: number; color: string;
  anim: Animated.ValueXY; opacity: Animated.Value;
}

interface ComboPopup {
  id: number; x: number; y: number; label: string;
  anim: Animated.Value; opacity: Animated.Value;
}

let globalId = 0, sparkId = 0, ghostIdCounter = 0, popupIdCounter = 0;

// ─── Stars with parallax depth layer ─────────────────────────────────────────
const STARS = Array.from({ length: 80 }, () => ({
  x: Math.random() * SW, y: Math.random() * SH,
  r: 0.4 + Math.random() * 1.4, o: 0.1 + Math.random() * 0.55,
  layer: Math.random(), // 0=far/barely moves  1=close/moves most
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────
const POS_POOL: { x: number; y: number }[] = [];

function randomPos(existing: { x: number; y: number }[]): { x: number; y: number } {
  const pad = TARGET_R + 30, minDist = TARGET_R * 3.5;
  let attempts = 0;
  while (attempts < 60) {
    const x = pad + Math.random() * (SW - pad * 2);
    const y = GAME_TOP + pad + Math.random() * (GAME_H - pad * 2);
    const tooClose = existing.some((e) => {
      const dx = e.x - x, dy = e.y - y;
      return Math.sqrt(dx * dx + dy * dy) < minDist;
    });
    if (!tooClose) return { x, y };
    attempts++;
  }
  return { x: pad + Math.random() * (SW - pad * 2), y: GAME_TOP + pad + Math.random() * (GAME_H - pad * 2) };
}

function getPos(idx: number): { x: number; y: number } {
  while (POS_POOL.length <= idx) POS_POOL.push(randomPos(POS_POOL.slice(-5)));
  return POS_POOL[idx];
}

// ─── Main Component ───────────────────────────────────────────────────────────
export default function App() {
  const [gameState, setGameState]           = useState<GameState>('start');
  const [score, setScore]                   = useState(0);
  const [finalScore, setFinalScore]         = useState(0);
  const [combo, setCombo]                   = useState(0);
  const [highScore, setHighScore]           = useState(0);
  const [visibleTargets, setVisibleTargets] = useState<HitTarget[]>([]);
  const [sparks, setSparks]                 = useState<Spark[]>([]);
  const [ghostDecoys, setGhostDecoys]       = useState<GhostDecoy[]>([]);
  const [comboPopups, setComboPopups]       = useState<ComboPopup[]>([]);
  const [fingerPos, setFingerPos]           = useState<{ x: number; y: number } | null>(null);
  const [isDragging, setIsDragging]         = useState(false);
  const [missFlash, setMissFlash]           = useState(false);
  const [isNewHighScore, setIsNewHighScore] = useState(false);
  const [themeName, setThemeName]           = useState<ThemeName>('default');
  const [themeUnlocked, setThemeUnlocked]   = useState(false);
  const [speedTier, setSpeedTier]           = useState(SPEED_TIERS[0]);
  const [parallaxOffset, setParallaxOffset] = useState({ x: 0, y: 0 });

  // ── Animated values ──────────────────────────────────────────────────────────
  const comboScaleAnim   = useRef(new Animated.Value(1)).current;
  const crownScaleAnim   = useRef(new Animated.Value(0)).current;
  const crownOpacityAnim = useRef(new Animated.Value(0)).current;
  const crownGlowAnim    = useRef(new Animated.Value(0)).current;
  const speedTierAnim    = useRef(new Animated.Value(1)).current;
  const slowMoAnim       = useRef(new Animated.Value(0)).current;

  // ── Refs ──────────────────────────────────────────────────────────────────────
  const scoreRef           = useRef(0);
  const comboRef           = useRef(0);
  const highScoreRef       = useRef(0);
  const ghostDecoysRef     = useRef<GhostDecoy[]>([]);
  const gameActiveRef      = useRef(false);
  const isDraggingRef      = useRef(false);
  const nextHitRef         = useRef(0);
  const targetPoolRef      = useRef<HitTarget[]>([]);
  const approachTimers     = useRef<ReturnType<typeof setTimeout>[]>([]);
  const prevSpeedTierRef   = useRef(SPEED_TIERS[0].label);
  const themeRef           = useRef<ThemeName>('default');

  const theme = THEMES[themeName];

  // ── Keep ghostDecoysRef in sync with state ───────────────────────────────────
  useEffect(() => { ghostDecoysRef.current = ghostDecoys; }, [ghostDecoys]);

  // ── Load persisted data ───────────────────────────────────────────────────────
  useEffect(() => {
    AsyncStorage.multiGet([HIGH_SCORE_KEY, THEME_UNLOCK_KEY]).then((pairs) => {
      const hs = pairs[0][1], tu = pairs[1][1];
      if (hs) { const n = parseInt(hs, 10); setHighScore(n); highScoreRef.current = n; }
      if (tu === 'true') setThemeUnlocked(true);
    });
  }, []);

  // ── Haptics ───────────────────────────────────────────────────────────────────
  const playHitSound      = useCallback(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light), []);
  const playComboSound    = useCallback(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy), []);
  const playMissSound     = useCallback(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error), []);
  const playGhostHitSound = useCallback(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning), []);

  // ── Stop all ──────────────────────────────────────────────────────────────────
  const stopAll = useCallback(() => {
    gameActiveRef.current = false;
    approachTimers.current.forEach(clearTimeout);
    approachTimers.current = [];
    targetPoolRef.current.forEach((t) => {
      t.approachAnim.stopAnimation();
      t.fadeAnim.stopAnimation();
      t.hitScale.stopAnimation();
    });
  }, []);

  // ── Crown animation ───────────────────────────────────────────────────────────
  const animateCrown = useCallback(() => {
    crownScaleAnim.setValue(0);
    crownOpacityAnim.setValue(0);
    crownGlowAnim.setValue(0);
    Animated.sequence([
      Animated.parallel([
        Animated.spring(crownScaleAnim, { toValue: 1.3, friction: 3, tension: 200, useNativeDriver: true }),
        Animated.timing(crownOpacityAnim, { toValue: 1, duration: 200, useNativeDriver: true }),
      ]),
      Animated.spring(crownScaleAnim, { toValue: 1, friction: 5, tension: 300, useNativeDriver: true }),
    ]).start();
    Animated.loop(Animated.sequence([
      Animated.timing(crownGlowAnim, { toValue: 1, duration: 700, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      Animated.timing(crownGlowAnim, { toValue: 0.3, duration: 700, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
    ])).start();
  }, [crownScaleAnim, crownOpacityAnim, crownGlowAnim]);

  // ── Speed tier animation ──────────────────────────────────────────────────────
  const animateSpeedTier = useCallback(() => {
    speedTierAnim.setValue(1.8);
    Animated.spring(speedTierAnim, { toValue: 1, friction: 4, tension: 250, useNativeDriver: true }).start();
  }, [speedTierAnim]);

  // ── Explosion sparks ──────────────────────────────────────────────────────────
  const explode = useCallback((x: number, y: number, color: string, count = 12) => {
    const newSparks: Spark[] = Array.from({ length: count }, (_, i) => {
      const anim = new Animated.ValueXY({ x: 0, y: 0 });
      const opacity = new Animated.Value(1);
      const angle = (i / count) * Math.PI * 2;
      const dist  = 28 + Math.random() * 38;
      Animated.parallel([
        Animated.timing(anim, { toValue: { x: Math.cos(angle) * dist, y: Math.sin(angle) * dist }, duration: 500, easing: Easing.out(Easing.quad), useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0, duration: 500, useNativeDriver: true }),
      ]).start();
      return { id: sparkId++, x, y, color, anim, opacity };
    });
    setSparks((s) => [...s.slice(-80), ...newSparks]);
  }, []);

  // ── Combo bounce ──────────────────────────────────────────────────────────────
  const bounceCombo = useCallback(() => {
    comboScaleAnim.setValue(1.6);
    Animated.spring(comboScaleAnim, { toValue: 1, friction: 4, tension: 200, useNativeDriver: true }).start();
  }, [comboScaleAnim]);

  // ── Combo popup ───────────────────────────────────────────────────────────────
  const spawnComboPopup = useCallback((x: number, y: number, label: string) => {
    const anim = new Animated.Value(0), opacity = new Animated.Value(1);
    Animated.timing(anim, { toValue: -50, duration: 700, easing: Easing.out(Easing.quad), useNativeDriver: true }).start();
    Animated.sequence([Animated.delay(300), Animated.timing(opacity, { toValue: 0, duration: 400, useNativeDriver: true })]).start();
    setComboPopups((p) => [...p.slice(-5), { id: popupIdCounter++, x, y, label, anim, opacity }]);
  }, []);

  // ── Ghost decoy ───────────────────────────────────────────────────────────────
  const spawnGhostDecoy = useCallback((nextColor: string, existingPositions: { x: number; y: number }[]) => {
    const pos = randomPos(existingPositions);
    const fadeAnim = new Animated.Value(0), pulseAnim = new Animated.Value(1);
    Animated.timing(fadeAnim, { toValue: 0.85, duration: 300, useNativeDriver: true }).start();
    Animated.loop(Animated.sequence([
      Animated.timing(pulseAnim, { toValue: 1.12, duration: 600, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      Animated.timing(pulseAnim, { toValue: 0.92, duration: 600, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
    ])).start();
    const ghost: GhostDecoy = { id: ghostIdCounter++, x: pos.x, y: pos.y, color: nextColor, fadeAnim, pulseAnim };
    ghostDecoysRef.current = [...ghostDecoysRef.current, ghost];
    setGhostDecoys(ghostDecoysRef.current);
    setTimeout(() => {
      Animated.timing(fadeAnim, { toValue: 0, duration: 300, useNativeDriver: true }).start(() => {
        setGhostDecoys((g) => {
          const updated = g.filter((d) => d.id !== ghost.id);
          ghostDecoysRef.current = updated;
          return updated;
        });
      });
    }, 2500);
    return ghost;
  }, []);

  // ── Create target ─────────────────────────────────────────────────────────────
  const createTarget = useCallback((seqNum: number): HitTarget => {
    const pos   = getPos(seqNum - 1);
    const palette = themeRef.current === 'inferno' ? THEMES.inferno.colors : THEMES.default.colors;
    const color = palette[(seqNum - 1) % palette.length];
    return {
      id: globalId++, seqNum, x: pos.x, y: pos.y, color,
      approachAnim: new Animated.Value(1), fadeAnim: new Animated.Value(1), hitScale: new Animated.Value(1),
      state: 'waiting',
    };
  }, []);

  // ── Approach duration ─────────────────────────────────────────────────────────
  // Quadratic ease: ramps quickly in first ~15 hits, then plateaus gently
  const getApproachDuration = useCallback((currentScore: number) => {
    const t = Math.min(currentScore / 40, 1);
    const speedFactor = 1 - (t * t) * 0.65;
    return APPROACH_DURATION * Math.max(0.40, speedFactor);
  }, []);

  // ── Activate target ───────────────────────────────────────────────────────────
  const activateTarget = useCallback((target: HitTarget, duration: number, onExpire: () => void) => {
    target.state = 'active';
    Animated.timing(target.approachAnim, { toValue: 0, duration, easing: Easing.in(Easing.quad), useNativeDriver: true }).start();
    const t = setTimeout(() => {
      if (!gameActiveRef.current) return;
      if (target.state === 'active') { target.state = 'missed'; onExpire(); }
    }, duration);
    approachTimers.current.push(t);
  }, []);

  // ── Slow-mo death + game over ─────────────────────────────────────────────────
  const triggerGameOver = useCallback(async () => {
    stopAll();
    playMissSound();
    setGameState('dying');

    // Slow-mo white flash: surge in then fade out over ~600ms
    slowMoAnim.setValue(0);
    Animated.sequence([
      Animated.timing(slowMoAnim, { toValue: 1, duration: 160, easing: Easing.out(Easing.quad), useNativeDriver: true }),
      Animated.timing(slowMoAnim, { toValue: 0, duration: 400, easing: Easing.in(Easing.quad), useNativeDriver: true }),
    ]).start();

    setMissFlash(true);
    setTimeout(() => setMissFlash(false), 560);

    const finalS = scoreRef.current;
    setFinalScore(finalS);
    setGhostDecoys([]);

    let newHS = false;
    if (finalS > highScoreRef.current) {
      highScoreRef.current = finalS;
      setHighScore(finalS);
      setIsNewHighScore(true);
      newHS = true;
      await AsyncStorage.setItem(HIGH_SCORE_KEY, String(finalS));
    } else {
      setIsNewHighScore(false);
    }

    // Unlock inferno theme at 50+
    if (finalS >= 50) {
      setThemeUnlocked(true);
      await AsyncStorage.setItem(THEME_UNLOCK_KEY, 'true');
    }

    setTimeout(() => {
      setGameState('over');
      if (newHS) animateCrown();
    }, 620);
  }, [stopAll, playMissSound, slowMoAnim, animateCrown]);

  // ── Refresh visible ───────────────────────────────────────────────────────────
  const refreshVisible = useCallback(() => {
    const next  = nextHitRef.current;
    const slice = targetPoolRef.current.filter(
      (t) => t.seqNum >= next && t.seqNum < next + VISIBLE_AHEAD && t.state !== 'hit'
    );
    setVisibleTargets([...slice]);
  }, []);

  // ── Ensure pool ───────────────────────────────────────────────────────────────
  const ensurePool = useCallback(() => {
    const next = nextHitRef.current;
    const maxInPool = Math.max(...targetPoolRef.current.map((t) => t.seqNum));
    if (maxInPool < next + VISIBLE_AHEAD + 2) {
      for (let i = maxInPool + 1; i <= next + VISIBLE_AHEAD + 2; i++)
        targetPoolRef.current.push(createTarget(i));
    }
  }, [createTarget]);

  // ── Handle hit ────────────────────────────────────────────────────────────────
  const handleHit = useCallback(
    (target: HitTarget) => {
      target.state = 'hit';
      const newScore = scoreRef.current + 1;
      const newCombo = comboRef.current + 1;
      scoreRef.current = newScore;
      comboRef.current = newCombo;
      setScore(newScore);
      setCombo(newCombo);

      explode(target.x, target.y, target.color);
      bounceCombo();

      // Speed tier check
      const tier = getSpeedTier(newScore);
      if (tier.label !== prevSpeedTierRef.current) {
        prevSpeedTierRef.current = tier.label;
        setSpeedTier(tier);
        animateSpeedTier();
        spawnComboPopup(SW / 2, SH * 0.38, tier.label + '!');
      }

      // Combo milestone
      if (newCombo % 10 === 0) {
        playComboSound();
        spawnComboPopup(target.x, target.y, `${newCombo}x COMBO!`);
      } else {
        playHitSound();
      }

      Animated.parallel([
        Animated.spring(target.hitScale, { toValue: 1.6, friction: 3, tension: 300, useNativeDriver: true }),
        Animated.timing(target.fadeAnim, { toValue: 0, duration: 200, useNativeDriver: true }),
      ]).start();

      const nextSeq = nextHitRef.current + 1;
      nextHitRef.current = nextSeq;
      ensurePool();

      const nextTarget = targetPoolRef.current.find((t) => t.seqNum === nextSeq);
      if (nextTarget && nextTarget.state === 'waiting') {
        const dur = getApproachDuration(newScore);
        activateTarget(nextTarget, dur, triggerGameOver);

        if (newScore > 0 && newScore % GHOST_INTERVAL === 0) {
          const allPos = targetPoolRef.current
            .filter((t) => t.seqNum >= nextSeq && t.seqNum < nextSeq + VISIBLE_AHEAD)
            .map((t) => ({ x: t.x, y: t.y }));
          spawnGhostDecoy(nextTarget.color, allPos);
        }
      }

      refreshVisible();
    },
    [
      explode, bounceCombo, animateSpeedTier,
      playHitSound, playComboSound,
      spawnComboPopup, spawnGhostDecoy,
      ensurePool, getApproachDuration, activateTarget, triggerGameOver, refreshVisible,
    ]
  );

  // ── Check hit ─────────────────────────────────────────────────────────────────
  const checkHit = useCallback(
    (fx: number, fy: number) => {
      if (!gameActiveRef.current) return;

      // Use ref — always has the latest ghosts, no stale closure issue
      const hitGhost = ghostDecoysRef.current.find((g) => {
        const dx = fx - g.x, dy = fy - g.y;
        return Math.sqrt(dx * dx + dy * dy) <= HIT_TOLERANCE;
      });
      if (hitGhost) {
        playGhostHitSound();
        explode(hitGhost.x, hitGhost.y, '#FF4F7B', 16);
        triggerGameOver();
        return;
      }

      const next         = nextHitRef.current;
      const activeTarget = targetPoolRef.current.find((t) => t.seqNum === next && t.state === 'active');
      if (!activeTarget) return;
      const dx = fx - activeTarget.x, dy = fy - activeTarget.y;
      if (Math.sqrt(dx * dx + dy * dy) <= HIT_TOLERANCE) handleHit(activeTarget);
    },
    [handleHit, explode, playGhostHitSound, triggerGameOver]
  );

  // ── Start game ────────────────────────────────────────────────────────────────
  const startGame = useCallback(() => {
    globalId = 0; sparkId = 0; ghostIdCounter = 0; popupIdCounter = 0;
    POS_POOL.length = 0;
    scoreRef.current = 0; comboRef.current = 0;
    gameActiveRef.current = true; nextHitRef.current = 1;
    isDraggingRef.current = false;
    prevSpeedTierRef.current = SPEED_TIERS[0].label;
    approachTimers.current.forEach(clearTimeout);
    approachTimers.current = [];

    setScore(0); setCombo(0); setFinalScore(0);
    setSparks([]); setGhostDecoys([]); setComboPopups([]);
    setFingerPos(null); setIsDragging(false); setMissFlash(false);
    setIsNewHighScore(false); setSpeedTier(SPEED_TIERS[0]);
    setParallaxOffset({ x: 0, y: 0 });
    comboScaleAnim.setValue(1);
    crownOpacityAnim.setValue(0);
    crownGlowAnim.setValue(0);
    slowMoAnim.setValue(0);

    const initialPool: HitTarget[] = [];
    for (let i = 1; i <= VISIBLE_AHEAD + 2; i++) initialPool.push(createTarget(i));
    targetPoolRef.current = initialPool;
    setGameState('playing');

    setTimeout(() => {
      if (!gameActiveRef.current) return;
      const first = targetPoolRef.current.find((t) => t.seqNum === 1);
      if (first) {
        activateTarget(first, getApproachDuration(0), triggerGameOver);
        setVisibleTargets([...targetPoolRef.current.slice(0, VISIBLE_AHEAD)]);
      }
    }, 300);
  }, [createTarget, getApproachDuration, activateTarget, triggerGameOver,
      comboScaleAnim, crownOpacityAnim, crownGlowAnim, slowMoAnim]);

  // ── PanResponder ──────────────────────────────────────────────────────────────
  const checkHitRef = useRef(checkHit);
  useEffect(() => { checkHitRef.current = checkHit; }, [checkHit]);

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder:  () => true,
      onPanResponderGrant: (evt) => {
        if (!gameActiveRef.current) return;
        isDraggingRef.current = true; setIsDragging(true);
        const { pageX, pageY } = evt.nativeEvent;
        setFingerPos({ x: pageX, y: pageY });
        setParallaxOffset({ x: (pageX / SW - 0.5) * 20, y: (pageY / SH - 0.5) * 14 });
        checkHitRef.current(pageX, pageY);
      },
      onPanResponderMove: (evt) => {
        if (!gameActiveRef.current || !isDraggingRef.current) return;
        const { pageX, pageY } = evt.nativeEvent;
        setFingerPos({ x: pageX, y: pageY });
        setParallaxOffset({ x: (pageX / SW - 0.5) * 20, y: (pageY / SH - 0.5) * 14 });
        checkHitRef.current(pageX, pageY);
      },
      onPanResponderRelease:   () => { isDraggingRef.current = false; setIsDragging(false); setFingerPos(null); },
      onPanResponderTerminate: () => { isDraggingRef.current = false; setIsDragging(false); setFingerPos(null); },
    })
  ).current;

  // ── Cleanup ───────────────────────────────────────────────────────────────────
  useEffect(() => () => stopAll(), [stopAll]);

  // ── Theme toggle ──────────────────────────────────────────────────────────────
  const toggleTheme = useCallback(() => {
    const next = themeName === 'default' ? 'inferno' : 'default';
    setThemeName(next);
    themeRef.current = next;
  }, [themeName]);

  const isPlaying = gameState === 'playing' || gameState === 'dying';

  // ─── Render ───────────────────────────────────────────────────────────────────
  return (
    <View style={[styles.root, { backgroundColor: theme.bg }]}>
      <StatusBar barStyle="light-content" backgroundColor={theme.bg} />

      {/* ── Parallax star field ── */}
      {STARS.map((s, i) => (
        <View
          key={i}
          pointerEvents="none"
          style={[
            styles.star,
            {
              left:            s.x + parallaxOffset.x * s.layer,
              top:             s.y + parallaxOffset.y * s.layer,
              width:           s.r * 2,
              height:          s.r * 2,
              borderRadius:    s.r,
              opacity:         s.o,
              backgroundColor: theme.starColor,
            },
          ]}
        />
      ))}

      {/* ── Miss flash ── */}
      {missFlash && <View style={styles.missFlash} pointerEvents="none" />}

      {/* ── Slow-mo death overlay ── */}
      <Animated.View
        pointerEvents="none"
        style={[styles.slowMoOverlay, { opacity: slowMoAnim }]}
      />

      {/* ── GAME SCREEN ── */}
      {isPlaying && (
        <View
          style={StyleSheet.absoluteFill}
          {...(gameState === 'playing' ? panResponder.panHandlers : {})}
        >
          {/* Connection lines */}
          {gameState === 'playing' &&
            visibleTargets.slice(0, 2).map((t, idx) => {
              if (idx === 0) return null;
              const prev = visibleTargets[idx - 1];
              if (!prev) return null;
              const dx = t.x - prev.x, dy = t.y - prev.y;
              const len   = Math.sqrt(dx * dx + dy * dy);
              const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
              return (
                <View
                  key={`line-${t.id}`}
                  pointerEvents="none"
                  style={[styles.connectLine, { left: prev.x, top: prev.y - 1, width: len, transform: [{ rotate: `${angle}deg` }] }]}
                />
              );
            })}

          {/* Ghost decoys */}
          {ghostDecoys.map((g) => (
            <Animated.View
              key={`ghost-${g.id}`}
              pointerEvents="none"
              style={[styles.targetContainer, { left: g.x - TARGET_R, top: g.y - TARGET_R, opacity: g.fadeAnim, transform: [{ scale: g.pulseAnim }], zIndex: 3 }]}
            >
              <View style={[styles.hitCircle, { borderColor: g.color, backgroundColor: `${g.color}18`, shadowColor: g.color, borderStyle: 'dashed' }]} />
              <Text style={[styles.seqNum, { color: g.color, opacity: 0.6 }]}>?</Text>
            </Animated.View>
          ))}

          {/* Sparks */}
          {sparks.map((s) => (
            <Animated.View
              key={s.id}
              pointerEvents="none"
              style={[styles.spark, { left: s.x - 5, top: s.y - 5, backgroundColor: s.color, opacity: s.opacity, transform: s.anim.getTranslateTransform() }]}
            />
          ))}

          {/* Combo / popup labels */}
          {comboPopups.map((p) => (
            <Animated.Text
              key={`popup-${p.id}`}
              pointerEvents="none"
              style={[styles.comboPopup, { left: p.x - 60, top: p.y - 20, opacity: p.opacity, transform: [{ translateY: p.anim }] }]}
            >
              {p.label}
            </Animated.Text>
          ))}

          {/* Targets */}
          {visibleTargets.map((t, idx) => {
            const isNext      = t.seqNum === nextHitRef.current;
            const approachScale = t.approachAnim.interpolate({ inputRange: [0, 1], outputRange: [1, APPROACH_START / TARGET_R] });
            return (
              <Animated.View
                key={t.id}
                pointerEvents="none"
                style={[styles.targetContainer, { left: t.x - TARGET_R, top: t.y - TARGET_R, opacity: t.fadeAnim, transform: [{ scale: t.hitScale }], zIndex: isNext ? 10 : 5 - idx }]}
              >
                {isNext && (
                  <Animated.View
                    style={[styles.approachCircle, {
                      borderColor: t.color,
                      transform: [{ scale: approachScale }],
                      opacity: t.approachAnim.interpolate({ inputRange: [0, 0.15, 1], outputRange: [0, 1, 1] }),
                    }]}
                  />
                )}
                <View
                  style={[styles.hitCircle, {
                    borderColor: t.color,
                    backgroundColor: isNext ? `${t.color}22` : 'rgba(255,255,255,0.04)',
                    shadowColor: t.color,
                    opacity: isNext ? 1 : Math.max(0.1, 0.4 - idx * 0.08),
                  }]}
                />
                <Text style={[styles.seqNum, { color: isNext ? t.color : 'rgba(255,255,255,0.25)', textShadowColor: isNext ? t.color : 'transparent' }]}>
                  {t.seqNum}
                </Text>
              </Animated.View>
            );
          })}

          {/* Finger cursor */}
          {isDragging && fingerPos && (
            <View pointerEvents="none" style={[styles.finger, { left: fingerPos.x - 22, top: fingerPos.y - 22 }]} />
          )}

          {/* HUD */}
          <SafeAreaView style={styles.hud} pointerEvents="none">
            <View style={styles.hudRow}>
              {/* Score */}
              <View style={styles.hudBlock}>
                <Text style={styles.hudLabel}>SCORE</Text>
                <Text style={[styles.hudValue, { textShadowColor: theme.hudGlow }]}>{score}</Text>
              </View>

              {/* Center */}
              <View style={styles.hudCenter}>
                <Text style={styles.hudTitle}>FLOW</Text>
                <Animated.Text style={[styles.speedTierLabel, { color: speedTier.color, transform: [{ scale: speedTierAnim }] }]}>
                  {speedTier.label}
                </Animated.Text>
                <Text style={[styles.hudBest, { color: theme.accent + '99' }]}>BEST {highScore}</Text>
              </View>

              {/* Combo */}
              <View style={[styles.hudBlock, { alignItems: 'flex-end' }]}>
                <Text style={styles.hudLabel}>COMBO</Text>
                <Animated.Text style={[styles.hudValue, { color: combo >= 10 ? '#FFD700' : '#E8F4FF', transform: [{ scale: comboScaleAnim }] }]}>
                  {combo}x
                </Animated.Text>
              </View>
            </View>

            {/* Progress bar */}
            <View style={styles.progressBg}>
              <View style={[styles.progressFill, { width: `${Math.min(100, (score / 50) * 100)}%`, backgroundColor: theme.progressBar }]} />
            </View>
          </SafeAreaView>

          {/* Ghost warning */}
          {score > 0 && score % GHOST_INTERVAL === 0 && ghostDecoys.length > 0 && (
            <View style={styles.ghostWarning} pointerEvents="none">
              <Text style={[styles.ghostWarningText, { color: theme.accent2 }]}>⚠ AVOID THE DECOY</Text>
            </View>
          )}

          {/* First-play hint */}
          {score === 0 && gameState === 'playing' && (
            <View style={styles.hint} pointerEvents="none">
              <Text style={styles.hintText}>TAP THE CIRCLES IN ORDER  1 → 2 → 3...</Text>
            </View>
          )}
        </View>
      )}

      {/* ── START SCREEN ── */}
      {gameState === 'start' && (
        <View style={[styles.overlay, { backgroundColor: theme.bg + 'F5' }]}>
          <View style={styles.card}>
            <Text style={[styles.startIcon, { color: theme.accent, textShadowColor: theme.accent }]}>◎</Text>
            <Text style={[styles.startTitle, { textShadowColor: theme.accent2 }]}>FLOW</Text>
            {highScore > 0 && <Text style={styles.startBest}>BEST: {highScore}</Text>}
            <View style={[styles.divider, { backgroundColor: theme.accent, shadowColor: theme.accent }]} />
            <Text style={styles.bodyText}>Tap the numbered circles{'\n'}in order before time runs out.</Text>
            <View style={[styles.ruleBox, { borderColor: theme.accent + '30' }]}>
              <Text style={styles.ruleText}>① Hit circle 1 first</Text>
              <Text style={styles.ruleText}>② Then circle 2, 3...</Text>
              <Text style={styles.ruleText}>③ Miss one = Game Over</Text>
              <Text style={[styles.ruleText, { color: theme.accent2 }]}>④ Avoid the ? decoys</Text>
            </View>

            {themeUnlocked ? (
              <Pressable onPress={toggleTheme} style={[styles.themeBtn, { borderColor: theme.accent2 }]}>
                {({ pressed }) => (
                  <Text style={[styles.themeBtnText, { color: theme.accent2, opacity: pressed ? 0.5 : 1 }]}>
                    {themeName === 'default' ? '🔥 INFERNO MODE' : '✦ DEFAULT MODE'}
                  </Text>
                )}
              </Pressable>
            ) : (
              <Text style={styles.themeHint}>Score 50 to unlock 🔥 INFERNO MODE</Text>
            )}

            <Pressable style={[styles.btnStart, { borderColor: theme.accent, shadowColor: theme.accent }]} onPress={startGame}>
              {({ pressed }) => (
                <Text style={[styles.btnStartText, { color: theme.accent }, pressed && { opacity: 0.4 }]}>TAP TO START</Text>
              )}
            </Pressable>
          </View>
        </View>
      )}

      {/* ── GAME OVER SCREEN ── */}
      {gameState === 'over' && (
        <View style={[styles.overlay, { backgroundColor: theme.bg + 'F6' }]} pointerEvents="box-none">
          <View style={styles.card}>
            <Text style={styles.overIcon}>✕</Text>
            <Text style={styles.overTitle}>MISSED!</Text>

            {/* Animated crown */}
            {isNewHighScore && (
              <Animated.Text
                style={[
                  styles.crown,
                  {
                    transform: [{ scale: crownScaleAnim }],
                    opacity: crownOpacityAnim,
                  },
                ]}
              >
                👑
              </Animated.Text>
            )}

            <Text style={[styles.overScore, { textShadowColor: theme.hudGlow }]}>{finalScore}</Text>
            <Text style={styles.overSub}>circles hit</Text>

            {isNewHighScore && (
              <Animated.Text
                style={[
                  styles.newHighScore,
                  {
                    opacity: crownGlowAnim.interpolate({ inputRange: [0, 1], outputRange: [0.65, 1] }),
                  },
                ]}
              >
                🎉 NEW BEST!
              </Animated.Text>
            )}
            {!isNewHighScore && highScore > 0 && (
              <Text style={styles.prevBest}>BEST: {highScore}</Text>
            )}

            <View style={[styles.divider, { backgroundColor: theme.accent, shadowColor: theme.accent }]} />

            <Text style={styles.rankText}>
              {finalScore >= 50 ? '🏆 FLOW MASTER'
               : finalScore >= 30 ? '⭐ GREAT FLOW'
               : finalScore >= 15 ? '👍 SOLID FLOW'
               : finalScore >= 8  ? '😅 WARMING UP'
               : '💀 FIND THE FLOW'}
            </Text>

            {finalScore >= 50 && (
              <Text style={[styles.unlockNotice, { color: theme.accent2 }]}>
                {themeUnlocked ? '🔥 INFERNO MODE AVAILABLE' : '🔥 INFERNO MODE UNLOCKED!'}
              </Text>
            )}

            <Pressable style={[styles.btnRestart, { borderColor: theme.accent2, shadowColor: theme.accent2 }]} onPress={startGame}>
              {({ pressed }) => (
                <Text style={[styles.btnRestartText, { color: theme.accent2 }, pressed && { opacity: 0.4 }]}>PLAY AGAIN</Text>
              )}
            </Pressable>
          </View>
        </View>
      )}
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  root:  { flex: 1 },
  star:  { position: 'absolute' },
  missFlash: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(255,60,60,0.30)',
    zIndex: 999,
  },
  slowMoOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(255,255,255,0.22)',
    zIndex: 998,
  } as any,
  connectLine: {
    position: 'absolute', height: 2,
    backgroundColor: '#ffffff', opacity: 0.18,
    transformOrigin: 'left center',
  },
  targetContainer: {
    position: 'absolute',
    width: TARGET_R * 2, height: TARGET_R * 2,
    justifyContent: 'center', alignItems: 'center',
  },
  approachCircle: {
    position: 'absolute',
    width: TARGET_R * 2, height: TARGET_R * 2,
    borderRadius: TARGET_R, borderWidth: 3,
  },
  hitCircle: {
    position: 'absolute',
    width: TARGET_R * 2, height: TARGET_R * 2,
    borderRadius: TARGET_R, borderWidth: 3,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.9, shadowRadius: 12, elevation: 8,
  },
  seqNum: {
    fontFamily: 'monospace', fontSize: 18, fontWeight: '900',
    textShadowOffset: { width: 0, height: 0 }, textShadowRadius: 10, zIndex: 2,
  },
  spark: {
    position: 'absolute', width: 10, height: 10, borderRadius: 5,
  },
  comboPopup: {
    position: 'absolute', fontFamily: 'monospace', fontSize: 13, fontWeight: '900',
    color: '#FFD700', letterSpacing: 1,
    textShadowColor: '#FFD700', textShadowOffset: { width: 0, height: 0 }, textShadowRadius: 8,
    width: 120, textAlign: 'center', zIndex: 20,
  },
  finger: {
    position: 'absolute', width: 44, height: 44, borderRadius: 22,
    borderWidth: 2, borderColor: 'rgba(255,255,255,0.55)', backgroundColor: 'rgba(255,255,255,0.07)',
  },
  hud: {
    position: 'absolute', top: 0, left: 0, right: 0,
    paddingHorizontal: 20, paddingTop: 10,
  },
  hudRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 6,
  },
  hudBlock:  { minWidth: 70 },
  hudCenter: { alignItems: 'center' },
  hudTitle: {
    fontFamily: 'monospace', fontSize: 11, letterSpacing: 5,
    color: 'rgba(255,255,255,0.12)',
  },
  speedTierLabel: {
    fontFamily: 'monospace', fontSize: 10, fontWeight: '900', letterSpacing: 3, marginTop: 1,
  },
  hudBest: {
    fontFamily: 'monospace', fontSize: 9, letterSpacing: 2, marginTop: 2,
  },
  hudLabel: {
    fontFamily: 'monospace', fontSize: 9, letterSpacing: 3, color: '#2A4060',
  },
  hudValue: {
    fontFamily: 'monospace', fontSize: 28, fontWeight: '900', color: '#E8F4FF',
    textShadowOffset: { width: 0, height: 0 }, textShadowRadius: 10,
  },
  progressBg: {
    height: 3, backgroundColor: 'rgba(255,255,255,0.06)', borderRadius: 2, overflow: 'hidden',
  },
  progressFill: { height: 3, borderRadius: 2 },
  ghostWarning: {
    position: 'absolute', bottom: 90, left: 0, right: 0, alignItems: 'center',
  },
  ghostWarningText: {
    fontFamily: 'monospace', fontSize: 11, letterSpacing: 2, textAlign: 'center',
  },
  hint: {
    position: 'absolute', bottom: 90, left: 0, right: 0, alignItems: 'center',
  },
  hintText: {
    fontFamily: 'monospace', fontSize: 10, letterSpacing: 2, color: '#2A4060', textAlign: 'center',
  },
  overlay: {
    ...StyleSheet.absoluteFillObject, justifyContent: 'center', alignItems: 'center',
  },
  card: { alignItems: 'center', paddingHorizontal: 36 },
  startIcon: {
    fontSize: 52, textShadowOffset: { width: 0, height: 0 }, textShadowRadius: 24, marginBottom: 4,
  },
  startTitle: {
    fontFamily: 'monospace', fontSize: 58, fontWeight: '900', color: '#E8F4FF',
    letterSpacing: 10, textShadowOffset: { width: 3, height: 3 }, textShadowRadius: 0,
  },
  startBest: {
    fontFamily: 'monospace', fontSize: 11, letterSpacing: 3, color: '#FFD700', marginTop: 4,
  },
  divider: {
    width: 56, height: 2, marginVertical: 22,
    shadowOffset: { width: 0, height: 0 }, shadowOpacity: 1, shadowRadius: 10, elevation: 4,
  },
  bodyText: {
    fontFamily: 'monospace', fontSize: 14, color: '#6A8AA8',
    textAlign: 'center', lineHeight: 22, marginBottom: 16,
  },
  ruleBox: {
    borderWidth: 1, borderRadius: 8,
    paddingVertical: 12, paddingHorizontal: 24, marginBottom: 20,
  },
  ruleText: {
    fontFamily: 'monospace', fontSize: 12, color: '#4A7090', letterSpacing: 1, marginBottom: 6,
  },
  themeBtn: {
    borderWidth: 1, borderRadius: 6,
    paddingHorizontal: 20, paddingVertical: 8, marginBottom: 16,
  },
  themeBtnText: {
    fontFamily: 'monospace', fontSize: 12, fontWeight: '900', letterSpacing: 2,
  },
  themeHint: {
    fontFamily: 'monospace', fontSize: 10, color: '#2A4060',
    letterSpacing: 1, marginBottom: 16, textAlign: 'center',
  },
  btnStart: {
    borderWidth: 2, paddingHorizontal: 36, paddingVertical: 14,
    shadowOffset: { width: 0, height: 0 }, shadowOpacity: 0.8, shadowRadius: 14, elevation: 8,
  },
  btnStartText: {
    fontFamily: 'monospace', fontSize: 15, fontWeight: '900', letterSpacing: 5,
  },
  overIcon: {
    fontSize: 48, color: '#FF4F7B', textShadowColor: '#FF4F7B',
    textShadowOffset: { width: 0, height: 0 }, textShadowRadius: 20, marginBottom: 6,
  },
  overTitle: {
    fontFamily: 'monospace', fontSize: 14, letterSpacing: 6, color: '#FF4F7B', marginBottom: 14,
  },
  crown: { fontSize: 48, marginBottom: 4 },
  overScore: {
    fontFamily: 'monospace', fontSize: 90, fontWeight: '900', color: '#E8F4FF',
    lineHeight: 94, textShadowOffset: { width: 0, height: 0 }, textShadowRadius: 26,
  },
  overSub: {
    fontFamily: 'monospace', fontSize: 12, letterSpacing: 3, color: '#3A5570', marginTop: 4,
  },
  newHighScore: {
    fontFamily: 'monospace', fontSize: 14, fontWeight: '900',
    color: '#FFD700', letterSpacing: 3, marginTop: 8,
    textShadowColor: '#FFD700', textShadowOffset: { width: 0, height: 0 }, textShadowRadius: 12,
  },
  prevBest: {
    fontFamily: 'monospace', fontSize: 11, letterSpacing: 2, color: '#FFD70066', marginTop: 6,
  },
  rankText: {
    fontFamily: 'monospace', fontSize: 13, color: '#FFD700',
    letterSpacing: 2, marginBottom: 4, textAlign: 'center',
  },
  unlockNotice: {
    fontFamily: 'monospace', fontSize: 12, fontWeight: '900',
    letterSpacing: 2, marginTop: 6, marginBottom: 4, textAlign: 'center',
  },
  btnRestart: {
    marginTop: 30, borderWidth: 2, paddingHorizontal: 36, paddingVertical: 14,
    shadowOffset: { width: 0, height: 0 }, shadowOpacity: 0.7, shadowRadius: 12, elevation: 8,
  },
  btnRestartText: {
    fontFamily: 'monospace', fontSize: 15, fontWeight: '900', letterSpacing: 4,
  },
});
