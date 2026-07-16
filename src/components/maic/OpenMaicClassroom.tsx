'use client';

import React, {
  startTransition,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type {
  AgentRole,
  ClassroomEvent,
  ClassroomMode,
  ClassroomState,
  Course,
  CourseScene,
  CourseSceneType,
  SceneAction,
  SlidePage,
  TeachingAction,
  Utterance,
} from '@/lib/maic/types';
import {
  buildDefaultSlideAnimations,
  getSlideDescriptionElementId,
  getSlidePointElementId,
  shouldHoldFocus,
} from '@/lib/maic/slide-animation';

type SpeakerRole = AgentRole | 'student';

interface OpenMaicClassroomProps {
  courseId: string;
}

interface StageEffect {
  kind: 'spotlight' | 'laser' | 'discussion' | 'speech' | 'whiteboard';
  label: string;
  targetId?: string;
  dimOpacity?: number;
  color?: string;
  focusHold?: SceneAction['focusHold'];
}

interface TtsPlayback {
  speaking: boolean;
  queued: number;
  autoPaused: boolean;
}

interface CompletionSummary {
  totalQuestions: number;
  answeredQuestions: number;
  correctAnswers: number;
  sceneStats: Array<{ type: CourseSceneType; count: number }>;
}

const ROLE_META: Record<SpeakerRole, { name: string; initials: string; tone: string }> = {
  teacher: { name: '老师', initials: 'T', tone: 'from-emerald-300 to-teal-500' },
  ta: { name: '助教', initials: 'TA', tone: 'from-sky-300 to-blue-500' },
  clown: { name: '活跃同学', initials: 'C', tone: 'from-amber-300 to-orange-500' },
  thinker: { name: '深度思考者', initials: 'D', tone: 'from-indigo-300 to-violet-500' },
  notetaker: { name: '笔记员', initials: 'N', tone: 'from-slate-300 to-slate-500' },
  inquisitive: { name: '好问者', initials: 'Q', tone: 'from-rose-300 to-pink-500' },
  manager: { name: '课堂管理者', initials: 'M', tone: 'from-zinc-300 to-zinc-500' },
  student: { name: '我', initials: 'Me', tone: 'from-lime-300 to-green-500' },
};

const SCENE_LABELS: Record<CourseSceneType, string> = {
  slide: 'Slides',
  quiz: 'Quiz',
  interactive: 'Simulation',
  pbl: 'PBL',
  mindmap: 'Mind Map',
  code: 'Code Lab',
};

export function OpenMaicClassroom({ courseId }: OpenMaicClassroomProps) {
  const [course, setCourse] = useState<Course | null>(null);
  const [classroomState, setClassroomState] = useState<ClassroomState | null>(null);
  const [utterances, setUtterances] = useState<Utterance[]>([]);
  const [studentInput, setStudentInput] = useState('');
  const deferredStudentInput = useDeferredValue(studentInput);
  const [sending, setSending] = useState(false);
  const [connected, setConnected] = useState(false);
  const [stageEffect, setStageEffect] = useState<StageEffect | null>(null);
  const [heldFocusEffect, setHeldFocusEffect] = useState<StageEffect | null>(null);
  const [selectedSceneId, setSelectedSceneId] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [chatCollapsed, setChatCollapsed] = useState(false);
  const [whiteboardOpen, setWhiteboardOpen] = useState(true);
  const [ttsEnabled, setTtsEnabled] = useState(false);
  const [ttsPlayback, setTtsPlayback] = useState<TtsPlayback>({
    speaking: false,
    queued: 0,
    autoPaused: false,
  });
  const [quizAnswers, setQuizAnswers] = useState<Record<string, number>>({});
  const [codeDraft, setCodeDraft] = useState('const insight = "learning by doing";\nconsole.log(insight);');
  const [runOutput, setRunOutput] = useState('等待运行');
  const [selectedPblRole, setSelectedPblRole] = useState<string | null>(null);
  const chatRef = useRef<HTMLDivElement | null>(null);
  const sceneViewportRef = useRef<HTMLDivElement | null>(null);
  const quizHydratedRef = useRef(false);
  const quizInitialSaveSkippedRef = useRef(false);
  const stageAnimationTimersRef = useRef<number[]>([]);
  const ttsQueueRef = useRef<Utterance[]>([]);
  const ttsSeenIdsRef = useRef<Set<string>>(new Set());
  const ttsSpeakingRef = useRef(false);
  const ttsEnabledRef = useRef(false);
  const ttsAutoPausedRef = useRef(false);
  const ttsCurrentResolveRef = useRef<(() => void) | null>(null);
  const ttsKeepAliveTimerRef = useRef<number | null>(null);
  const ttsRunIdRef = useRef(0);
  const classroomStatusRef = useRef<ClassroomState['status']>('idle');
  const manualPauseRequestedRef = useRef(false);
  const stageHoverPauseRef = useRef(false);

  const pages = course?.prepared?.pages ?? [];
  const scenes = useMemo(() => deriveScenes(course), [course]);
  const currentPageIndex = classroomState?.P_t ?? 0;
  const automaticScene = useMemo(
    () =>
      scenes.find(scene => scene.type === 'slide' && scene.page_refs.includes(currentPageIndex)) ??
      scenes[0],
    [currentPageIndex, scenes]
  );
  const selectedScene = scenes.find(scene => scene.id === selectedSceneId) ?? automaticScene;
  const currentPage = pages[currentPageIndex];
  const latestUtterance = utterances.at(-1);
  const courseReady = course?.status === 'ready' && !!course.prepared;
  const courseCompleted = classroomState?.status === 'ended';
  const visibleStageEffect = useMemo(() => {
    if (stageEffect?.kind === 'spotlight' || stageEffect?.kind === 'laser') return stageEffect;
    return heldFocusEffect ?? stageEffect;
  }, [heldFocusEffect, stageEffect]);
  const quizStorageKey = useMemo(() => `maic:${courseId}:quiz-answers`, [courseId]);
  const completionSummary = useMemo(
    () => buildCompletionSummary(scenes, quizAnswers),
    [quizAnswers, scenes]
  );
  ttsEnabledRef.current = ttsEnabled;
  classroomStatusRef.current = classroomState?.status ?? 'idle';

  const handleClassroomEvent = useCallback((event: ClassroomEvent) => {
    switch (event.type) {
      case 'utterance':
        setUtterances(prev => appendUtterance(prev, event.data));
        break;
      case 'state':
        setClassroomState(event.data);
        setUtterances(prev => mergeUtterances(prev, event.data.H_t));
        break;
      case 'slide_change':
        setClassroomState(prev => (prev ? { ...prev, P_t: event.data.slide_index } : prev));
        break;
      case 'mode':
        setClassroomState(prev => (prev ? { ...prev, mode: event.data.mode } : prev));
        break;
      case 'end':
        setClassroomState(prev => (prev ? { ...prev, status: 'ended' } : prev));
        break;
      case 'error':
        setUtterances(prev => appendUtterance(prev, makeSystemUtterance(event.data.message)));
        break;
      default:
        break;
    }
  }, []);

  const clearStageAnimationTimers = useCallback(() => {
    for (const timer of stageAnimationTimersRef.current) {
      window.clearTimeout(timer);
    }
    stageAnimationTimersRef.current = [];
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function loadCourse(): Promise<void> {
      try {
        const response = await fetch(`/api/maic/courses/${courseId}`);
        const json = await response.json();
        if (!cancelled && json.success) {
          setCourse(json.data as Course);
        }
      } catch {
        if (!cancelled) setCourse(null);
      }
    }
    void loadCourse();
    return () => {
      cancelled = true;
    };
  }, [courseId]);

  useEffect(() => {
    if (!courseId || !courseReady) return;
    const eventSource = new EventSource(`/api/maic/classroom/${courseId}`);
    eventSource.onopen = () => setConnected(true);
    eventSource.onerror = () => setConnected(false);
    eventSource.onmessage = event => {
      try {
        const parsed = JSON.parse(event.data) as ClassroomEvent;
        startTransition(() => handleClassroomEvent(parsed));
      } catch {
        // Ignore malformed SSE frames instead of breaking the classroom.
      }
    };
    return () => {
      eventSource.close();
    };
  }, [courseId, courseReady, handleClassroomEvent]);

  useEffect(() => {
    if (!automaticScene || selectedSceneId) return;
    setSelectedSceneId(automaticScene.id);
  }, [automaticScene, selectedSceneId]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    quizHydratedRef.current = false;
    quizInitialSaveSkippedRef.current = false;
    try {
      const raw = window.localStorage.getItem(quizStorageKey);
      if (raw) {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          setQuizAnswers(normalizeStoredQuizAnswers(parsed as Record<string, unknown>));
        } else {
          setQuizAnswers({});
        }
      } else {
        setQuizAnswers({});
      }
    } catch {
      // Corrupt localStorage should not block classroom playback.
      setQuizAnswers({});
    } finally {
      quizHydratedRef.current = true;
    }
  }, [quizStorageKey]);

  useEffect(() => {
    if (!quizHydratedRef.current || typeof window === 'undefined') return;
    if (!quizInitialSaveSkippedRef.current) {
      quizInitialSaveSkippedRef.current = true;
      return;
    }
    try {
      window.localStorage.setItem(quizStorageKey, JSON.stringify(quizAnswers));
    } catch {
      // The quiz can still work in-memory when storage quota is unavailable.
    }
  }, [quizAnswers, quizStorageKey]);

  useEffect(() => {
    const nextScene = scenes.find(scene =>
      scene.type === 'slide' && scene.page_refs.includes(currentPageIndex)
    );
    if (nextScene) setSelectedSceneId(nextScene.id);
  }, [currentPageIndex, scenes]);

  useEffect(() => {
    clearStageAnimationTimers();
    setStageEffect(null);
    setHeldFocusEffect(null);
    if (!selectedScene || selectedScene.type !== 'slide' || selectedScene.actions.length === 0) {
      return;
    }

    const schedule = buildSceneEffectSchedule(selectedScene.actions);
    if (schedule.length === 0) return;

    for (const item of schedule) {
      const timer = window.setTimeout(() => {
        if (item.hold) {
          setHeldFocusEffect(item.effect);
          setStageEffect(current => (current?.kind === 'spotlight' ? null : current));
          return;
        }
        setStageEffect(item.effect);
        const clearTimer = window.setTimeout(() => {
          setStageEffect(current => (isSameStageEffect(current, item.effect) ? null : current));
        }, item.duration);
        stageAnimationTimersRef.current.push(clearTimer);
      }, item.delay);
      stageAnimationTimersRef.current.push(timer);
    }

    return () => {
      clearStageAnimationTimers();
    };
  }, [clearStageAnimationTimers, currentPageIndex, selectedScene]);

  useEffect(() => {
    if (!latestUtterance) return;
    if (selectedScene?.actions.some(action => toStageEffectFromSceneAction(action))) return;
    const effect = toStageEffect(latestUtterance.action);
    setStageEffect(effect);
    if (!effect) return;
    const timer = window.setTimeout(() => setStageEffect(null), 4200);
    return () => window.clearTimeout(timer);
  }, [latestUtterance, selectedScene]);

  useEffect(() => {
    if (chatRef.current) {
      chatRef.current.scrollTop = chatRef.current.scrollHeight;
    }
  }, [utterances]);

  const postClassroom = useCallback(
    async (payload: Record<string, unknown>) => {
      await fetch(`/api/maic/classroom/${courseId}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    },
    [courseId]
  );

  const sendMessage = useCallback(async () => {
    const content = studentInput.trim();
    if (!content || sending) return;
    setSending(true);
    try {
      await postClassroom({ content, mode: 'interactive' });
      setStudentInput('');
    } finally {
      setSending(false);
    }
  }, [postClassroom, sending, studentInput]);

  const setMode = useCallback(
    async (mode: ClassroomMode) => {
      await postClassroom({ mode });
    },
    [postClassroom]
  );

  const sendControl = useCallback(
    async (control: 'pause' | 'resume' | 'restart') => {
      await postClassroom({ control });
    },
    [postClassroom]
  );

  const syncTtsPlayback = useCallback(() => {
    setTtsPlayback({
      speaking: ttsSpeakingRef.current,
      queued: ttsQueueRef.current.length,
      autoPaused: ttsAutoPausedRef.current,
    });
  }, []);

  const releaseTtsAutoPause = useCallback(async () => {
    if (!ttsAutoPausedRef.current) return;
    ttsAutoPausedRef.current = false;
    syncTtsPlayback();
    if (!manualPauseRequestedRef.current) {
      try {
        await sendControl('resume');
      } catch {
        // The classroom can keep its current state if the resume request is lost.
      }
    }
  }, [sendControl, syncTtsPlayback]);

  const stopTtsPlayback = useCallback(
    ({ resumeClassroom = true }: { resumeClassroom?: boolean } = {}) => {
      ttsRunIdRef.current += 1;
      ttsQueueRef.current = [];
      ttsSpeakingRef.current = false;
      if (ttsKeepAliveTimerRef.current !== null && typeof window !== 'undefined') {
        window.clearInterval(ttsKeepAliveTimerRef.current);
        ttsKeepAliveTimerRef.current = null;
      }
      if (typeof window !== 'undefined' && window.speechSynthesis) {
        window.speechSynthesis.cancel();
      }
      ttsCurrentResolveRef.current?.();
      ttsCurrentResolveRef.current = null;
      if (resumeClassroom) {
        void releaseTtsAutoPause();
      } else if (ttsAutoPausedRef.current) {
        ttsAutoPausedRef.current = false;
      }
      syncTtsPlayback();
    },
    [releaseTtsAutoPause, syncTtsPlayback]
  );

  const speakQueuedUtterance = useCallback((utterance: Utterance): Promise<void> => {
    return new Promise(resolve => {
      if (typeof window === 'undefined' || !window.speechSynthesis) {
        resolve();
        return;
      }

      const speech = new window.SpeechSynthesisUtterance(utterance.content);
      speech.lang = mostlyChinese(utterance.content) ? 'zh-CN' : 'en-US';
      speech.rate = 1;

      const finish = () => {
        if (ttsKeepAliveTimerRef.current !== null) {
          window.clearInterval(ttsKeepAliveTimerRef.current);
          ttsKeepAliveTimerRef.current = null;
        }
        if (ttsCurrentResolveRef.current === finish) {
          ttsCurrentResolveRef.current = null;
        }
        resolve();
      };

      ttsCurrentResolveRef.current = finish;
      ttsKeepAliveTimerRef.current = window.setInterval(() => {
        window.speechSynthesis.resume();
      }, 8000);
      speech.onend = finish;
      speech.onerror = finish;
      window.speechSynthesis.speak(speech);
    });
  }, []);

  const playQueuedTts = useCallback(async () => {
    if (ttsSpeakingRef.current) return;
    if (typeof window === 'undefined' || !window.speechSynthesis) return;

    const runId = ttsRunIdRef.current;
    ttsSpeakingRef.current = true;
    syncTtsPlayback();

    if (classroomStatusRef.current === 'running' && !ttsAutoPausedRef.current) {
      ttsAutoPausedRef.current = true;
      syncTtsPlayback();
      try {
        await sendControl('pause');
      } catch {
        ttsAutoPausedRef.current = false;
        syncTtsPlayback();
      }
    }

    try {
      while (
        ttsRunIdRef.current === runId &&
        ttsEnabledRef.current &&
        ttsQueueRef.current.length > 0
      ) {
        const nextUtterance = ttsQueueRef.current.shift();
        syncTtsPlayback();
        if (nextUtterance) await speakQueuedUtterance(nextUtterance);
      }
    } finally {
      if (ttsRunIdRef.current === runId) {
        ttsSpeakingRef.current = false;
        syncTtsPlayback();
        if (ttsQueueRef.current.length === 0 || !ttsEnabledRef.current) {
          await releaseTtsAutoPause();
        }
      }
    }
  }, [releaseTtsAutoPause, sendControl, speakQueuedUtterance, syncTtsPlayback]);

  useEffect(() => {
    if (!ttsEnabled) {
      stopTtsPlayback({ resumeClassroom: true });
    }
  }, [stopTtsPlayback, ttsEnabled]);

  useEffect(() => {
    if (!ttsEnabled || !latestUtterance || latestUtterance.speaker === 'student') return;
    if (ttsSeenIdsRef.current.has(latestUtterance.id)) return;
    ttsSeenIdsRef.current.add(latestUtterance.id);
    ttsQueueRef.current.push(latestUtterance);
    syncTtsPlayback();
    void playQueuedTts();
  }, [latestUtterance, playQueuedTts, syncTtsPlayback, ttsEnabled]);

  useEffect(() => {
    return () => stopTtsPlayback({ resumeClassroom: false });
  }, [stopTtsPlayback]);

  const pauseClassroom = useCallback(async () => {
    manualPauseRequestedRef.current = true;
    stopTtsPlayback({ resumeClassroom: false });
    await sendControl('pause');
  }, [sendControl, stopTtsPlayback]);

  const resumeClassroom = useCallback(async () => {
    manualPauseRequestedRef.current = false;
    await sendControl('resume');
  }, [sendControl]);

  const pauseClassroomForStageHover = useCallback(() => {
    if (classroomStatusRef.current !== 'running' || stageHoverPauseRef.current) return;
    stageHoverPauseRef.current = true;
    void sendControl('pause').catch(() => {
      stageHoverPauseRef.current = false;
    });
  }, [sendControl]);

  const resumeClassroomAfterStageHover = useCallback(() => {
    if (!stageHoverPauseRef.current) return;
    stageHoverPauseRef.current = false;
    if (manualPauseRequestedRef.current || classroomStatusRef.current === 'ended') return;
    void sendControl('resume');
  }, [sendControl]);

  const restartClassroom = useCallback(async () => {
    manualPauseRequestedRef.current = false;
    stopTtsPlayback({ resumeClassroom: false });
    await sendControl('restart');
  }, [sendControl, stopTtsPlayback]);

  const navigateToSlide = useCallback(
    async (slideIndex: number) => {
      manualPauseRequestedRef.current = true;
      stopTtsPlayback({ resumeClassroom: false });
      const clamped = Math.max(0, Math.min(slideIndex, Math.max(pages.length - 1, 0)));
      await postClassroom({ control: 'navigate', slide_index: clamped });
      const slideScene = scenes.find(scene => scene.type === 'slide' && scene.page_refs.includes(clamped));
      if (slideScene) setSelectedSceneId(slideScene.id);
    },
    [pages.length, postClassroom, scenes, stopTtsPlayback]
  );

  const selectScene = useCallback(
    async (scene: CourseScene) => {
      setSelectedSceneId(scene.id);
      const firstPageRef = scene.page_refs[0];
      if (scene.type === 'slide' && firstPageRef !== undefined) {
        await navigateToSlide(firstPageRef);
      }
    },
    [navigateToSlide]
  );

  const runCodeLab = useCallback(() => {
    const output = codeDraft.includes('console.log')
      ? codeDraft
          .split('\n')
          .find(line => line.includes('console.log'))
          ?.replace(/console\.log\((.*)\);?/, '$1')
          .replaceAll('"', '')
          .replaceAll("'", '')
          .trim() || '已运行'
      : '已保存你的代码草稿';
    setRunOutput(output);
  }, [codeDraft]);

  const exportHtml = useCallback(() => {
    if (!course || typeof window === 'undefined') return;
    const sceneCards = scenes
      .map(scene => {
        const points = scene.key_points.map(point => `<li>${escapeHtml(point)}</li>`).join('');
        return `<section class="scene"><p class="kind">${escapeHtml(SCENE_LABELS[scene.type])}</p><h2>${escapeHtml(scene.title)}</h2><p>${escapeHtml(scene.description)}</p><ul>${points}</ul></section>`;
      })
      .join('\n');
    const payload = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(course.title)}</title>
  <style>
    body { margin: 0; font-family: ui-sans-serif, system-ui; background: #08111f; color: #e5eefb; }
    main { max-width: 1080px; margin: 0 auto; padding: 48px 24px; }
    .hero, .scene { border: 1px solid rgba(255,255,255,.12); border-radius: 28px; background: rgba(255,255,255,.06); padding: 28px; margin-bottom: 18px; }
    .kind { color: #5eead4; letter-spacing: .22em; text-transform: uppercase; font-size: 12px; }
    h1 { font-size: 42px; margin: 0 0 12px; }
    h2 { font-size: 28px; margin: 6px 0 12px; }
    li { margin: 8px 0; }
  </style>
</head>
<body>
  <main>
    <section class="hero">
      <p class="kind">OpenMAIC Export</p>
      <h1>${escapeHtml(course.title)}</h1>
      <p>${escapeHtml(course.prepared?.stage?.summary ?? '多智能体交互课堂导出')}</p>
    </section>
    ${sceneCards}
  </main>
</body>
</html>`;
    const blob = new Blob([payload], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${course.course_id}-openmaic-classroom.html`;
    link.click();
    URL.revokeObjectURL(url);
  }, [course, scenes]);

  if (!course) {
    return (
      <div className="grid min-h-[70vh] place-items-center text-slate-400">
        正在加载 OpenMAIC 课堂...
      </div>
    );
  }

  if (!courseReady) {
    return (
      <div className="mx-auto max-w-3xl rounded-3xl border border-amber-400/30 bg-amber-400/10 p-8 text-amber-100">
        课程尚未准备完成，请先返回准备页完成 Read/Plan/Scenes 流水线。
      </div>
    );
  }

  return (
    <div className="relative h-[calc(100dvh-8rem)] min-h-0 overflow-hidden rounded-[2rem] border border-white/10 bg-[#090d14] text-slate-100 shadow-2xl">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(20,184,166,0.22),transparent_34%),radial-gradient(circle_at_80%_10%,rgba(59,130,246,0.18),transparent_30%),linear-gradient(135deg,rgba(15,23,42,0.95),rgba(2,6,23,0.98))]" />
      <div className="relative z-10 flex h-full min-h-0">
        <SceneSidebar
          collapsed={sidebarCollapsed}
          scenes={scenes}
          activeSceneId={selectedScene?.id}
          stageTitle={course.prepared?.stage?.title ?? course.title}
          onCollapse={() => setSidebarCollapsed(prev => !prev)}
          onSelectScene={selectScene}
        />

        <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <StageHeader
            title={course.title}
            status={classroomState?.status ?? 'idle'}
            mode={classroomState?.mode ?? 'continuous'}
            connected={connected}
            pageIndex={currentPageIndex}
            pageCount={pages.length}
            scenesCount={scenes.length}
            ttsEnabled={ttsEnabled}
            ttsSpeaking={ttsPlayback.speaking}
            ttsQueued={ttsPlayback.queued}
            whiteboardOpen={whiteboardOpen}
            onModeChange={setMode}
            onPause={pauseClassroom}
            onResume={resumeClassroom}
            onRestart={restartClassroom}
            onPrev={() => navigateToSlide(currentPageIndex - 1)}
            onNext={() => navigateToSlide(currentPageIndex + 1)}
            onToggleTts={() => setTtsEnabled(prev => !prev)}
            onToggleWhiteboard={() => setWhiteboardOpen(prev => !prev)}
            onToggleChat={() => setChatCollapsed(prev => !prev)}
            onExport={exportHtml}
          />

          {courseCompleted && (
            <CourseCompletionPanel
              summary={completionSummary}
              stageTitle={course.prepared?.stage?.title ?? course.title}
              onRestart={restartClassroom}
            />
          )}

          <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[minmax(0,1fr)_minmax(14rem,0.6fr)] gap-4 overflow-hidden p-4 xl:grid-cols-[minmax(0,1fr)_22rem] xl:grid-rows-1">
            <section
              ref={sceneViewportRef}
              onMouseEnter={pauseClassroomForStageHover}
              onMouseLeave={resumeClassroomAfterStageHover}
              className="h-full min-h-0 overflow-hidden rounded-[1.75rem] border border-white/10 bg-white/[0.04] shadow-inner"
            >
              <SceneViewport
                scene={selectedScene}
                page={currentPage}
                effect={visibleStageEffect}
                whiteboardOpen={whiteboardOpen}
                utterance={latestUtterance}
                quizAnswers={quizAnswers}
                codeDraft={codeDraft}
                runOutput={runOutput}
                selectedPblRole={selectedPblRole}
                onQuizAnswer={(id, value) => setQuizAnswers(prev => ({ ...prev, [id]: value }))}
                onCodeDraftChange={setCodeDraft}
                onRunCode={runCodeLab}
                onPblRoleSelect={setSelectedPblRole}
              />
            </section>

            {!chatCollapsed && (
              <ClassroomChat
                ref={chatRef}
                utterances={utterances}
                mode={classroomState?.mode ?? 'continuous'}
                input={studentInput}
                deferredInput={deferredStudentInput}
                sending={sending}
                activeQuestions={course.prepared?.active_questions ?? []}
                roles={classroomState?.R ?? []}
                latestSpeaker={latestUtterance?.speaker}
                onInputChange={setStudentInput}
                onSend={sendMessage}
                onModeChange={setMode}
                onQuickAsk={question => setStudentInput(question)}
              />
            )}
          </div>
        </main>
      </div>
    </div>
  );
}

interface SceneSidebarProps {
  collapsed: boolean;
  scenes: CourseScene[];
  activeSceneId?: string;
  stageTitle: string;
  onCollapse: () => void;
  onSelectScene: (scene: CourseScene) => void;
}

function SceneSidebar({
  collapsed,
  scenes,
  activeSceneId,
  stageTitle,
  onCollapse,
  onSelectScene,
}: SceneSidebarProps) {
  return (
    <aside
      className={`hidden border-r border-white/10 bg-black/20 transition-all duration-300 lg:block ${
        collapsed ? 'w-20' : 'w-80'
      }`}
    >
      <div className="flex h-full flex-col">
        <div className="shrink-0 border-b border-white/10 p-4">
          <button
            type="button"
            onClick={onCollapse}
            className="mb-4 rounded-full border border-white/10 px-3 py-1 text-xs text-slate-300 hover:bg-white/10"
          >
            {collapsed ? '展开' : '收起'}
          </button>
          {!collapsed && (
            <>
              <div className="text-xs uppercase tracking-[0.35em] text-teal-200/70">
                OpenMAIC Stage
              </div>
              <h2 className="mt-2 line-clamp-2 text-lg font-semibold">{stageTitle}</h2>
            </>
          )}
        </div>

        <div className="flex-1 space-y-2 overflow-y-auto p-3">
          {scenes.map(scene => {
            const active = scene.id === activeSceneId;
            return (
              <button
                key={scene.id}
                type="button"
                onClick={() => onSelectScene(scene)}
                className={`w-full rounded-2xl border p-3 text-left transition ${
                  active
                    ? 'border-teal-300/50 bg-teal-300/15 shadow-lg shadow-teal-950/40'
                    : 'border-white/10 bg-white/[0.03] hover:bg-white/[0.07]'
                }`}
              >
                <div className="flex items-center gap-3">
                  <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-white/10 text-xs font-semibold">
                    {String(scene.order + 1).padStart(2, '0')}
                  </div>
                  {!collapsed && (
                    <div className="min-w-0">
                      <div className="mb-1 text-[10px] uppercase tracking-[0.2em] text-slate-400">
                        {SCENE_LABELS[scene.type]}
                      </div>
                      <div className="line-clamp-2 text-sm font-medium text-slate-100">
                        {scene.title}
                      </div>
                    </div>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </aside>
  );
}

interface StageHeaderProps {
  title: string;
  status: ClassroomState['status'];
  mode: ClassroomMode;
  connected: boolean;
  pageIndex: number;
  pageCount: number;
  scenesCount: number;
  ttsEnabled: boolean;
  ttsSpeaking: boolean;
  ttsQueued: number;
  whiteboardOpen: boolean;
  onModeChange: (mode: ClassroomMode) => void;
  onPause: () => void;
  onResume: () => void;
  onRestart: () => void;
  onPrev: () => void;
  onNext: () => void;
  onToggleTts: () => void;
  onToggleWhiteboard: () => void;
  onToggleChat: () => void;
  onExport: () => void;
}

function StageHeader({
  title,
  status,
  mode,
  connected,
  pageIndex,
  pageCount,
  scenesCount,
  ttsEnabled,
  ttsSpeaking,
  ttsQueued,
  whiteboardOpen,
  onModeChange,
  onPause,
  onResume,
  onRestart,
  onPrev,
  onNext,
  onToggleTts,
  onToggleWhiteboard,
  onToggleChat,
  onExport,
}: StageHeaderProps) {
  const isPaused = status === 'paused' || status === 'idle';
  const statusLabel = ttsSpeaking ? 'tts reading' : status;
  return (
    <header className="flex flex-wrap items-center gap-3 border-b border-white/10 bg-black/20 px-4 py-3 backdrop-blur-xl">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.28em] text-slate-400">
          <span className={`h-2 w-2 rounded-full ${connected ? 'bg-teal-300' : 'bg-slate-600'}`} />
          {connected ? 'Live Classroom' : 'Offline'} / {statusLabel}
        </div>
        <h1 className="mt-1 line-clamp-1 text-lg font-semibold">{title}</h1>
      </div>

      <div className="flex items-center overflow-hidden rounded-full border border-white/10 bg-white/[0.04] p-1 text-xs">
        <button
          type="button"
          onClick={() => onModeChange('continuous')}
          className={`rounded-full px-3 py-1.5 ${mode === 'continuous' ? 'bg-teal-300 text-slate-950' : 'text-slate-300'}`}
        >
          Continuous
        </button>
        <button
          type="button"
          onClick={() => onModeChange('interactive')}
          className={`rounded-full px-3 py-1.5 ${mode === 'interactive' ? 'bg-teal-300 text-slate-950' : 'text-slate-300'}`}
        >
          Interactive
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs">
        <HeaderButton onClick={onPrev}>上一页</HeaderButton>
        <HeaderButton onClick={isPaused ? onResume : onPause}>
          {isPaused ? '播放' : '暂停'}
        </HeaderButton>
        <HeaderButton onClick={onNext}>下一页</HeaderButton>
        <HeaderButton onClick={onRestart}>重播</HeaderButton>
        <HeaderButton active={whiteboardOpen} onClick={onToggleWhiteboard}>白板</HeaderButton>
        <HeaderButton active={ttsEnabled} onClick={onToggleTts}>
          {ttsQueued > 0 ? `TTS ${ttsQueued}` : 'TTS'}
        </HeaderButton>
        <HeaderButton onClick={onToggleChat}>聊天</HeaderButton>
        <HeaderButton onClick={onExport}>导出</HeaderButton>
      </div>

      <div className="w-full text-[11px] text-slate-500 md:w-auto">
        Slide {Math.min(pageIndex + 1, pageCount)} / {pageCount} · Scene {scenesCount}
        {ttsEnabled && (ttsSpeaking || ttsQueued > 0)
          ? ` · ${ttsSpeaking ? 'TTS reading' : 'TTS queued'}`
          : ''}
      </div>
    </header>
  );
}

function CourseCompletionPanel({
  summary,
  stageTitle,
  onRestart,
}: {
  summary: CompletionSummary;
  stageTitle: string;
  onRestart: () => void;
}) {
  const score = summary.totalQuestions > 0
    ? Math.round((summary.correctAnswers / summary.totalQuestions) * 100)
    : 100;
  return (
    <section className="mx-4 mt-4 rounded-[1.5rem] border border-teal-300/30 bg-teal-300/10 p-4">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="text-xs uppercase tracking-[0.25em] text-teal-100/70">
            Course Complete
          </div>
          <h2 className="mt-1 text-xl font-semibold text-teal-50">{stageTitle}</h2>
        </div>
        <button
          type="button"
          onClick={() => void onRestart()}
          className="rounded-2xl border border-teal-200/40 px-4 py-2 text-sm font-semibold text-teal-50 hover:bg-teal-200/10"
        >
          重新播放
        </button>
      </div>
      <div className="mt-4 grid gap-3 md:grid-cols-4">
        <CompletionMetric label="Quiz Score" value={`${score}%`} />
        <CompletionMetric label="Answered" value={`${summary.answeredQuestions}/${summary.totalQuestions}`} />
        <CompletionMetric label="Scenes" value={String(summary.sceneStats.reduce((sum, item) => sum + item.count, 0))} />
        <CompletionMetric
          label="Scene Types"
          value={String(summary.sceneStats.filter(item => item.count > 0).length)}
        />
      </div>
    </section>
  );
}

function CompletionMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-black/20 p-3">
      <div className="text-xs uppercase tracking-[0.18em] text-slate-400">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-white">{value}</div>
    </div>
  );
}

function HeaderButton({
  children,
  active,
  onClick,
}: {
  children: React.ReactNode;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full border px-3 py-1.5 transition ${
        active
          ? 'border-teal-300/60 bg-teal-300/15 text-teal-100'
          : 'border-white/10 bg-white/[0.04] text-slate-300 hover:bg-white/10'
      }`}
    >
      {children}
    </button>
  );
}

interface SceneViewportProps {
  scene?: CourseScene;
  page?: SlidePage;
  effect: StageEffect | null;
  whiteboardOpen: boolean;
  utterance?: Utterance;
  quizAnswers: Record<string, number>;
  codeDraft: string;
  runOutput: string;
  selectedPblRole: string | null;
  onQuizAnswer: (id: string, value: number) => void;
  onCodeDraftChange: (value: string) => void;
  onRunCode: () => void;
  onPblRoleSelect: (role: string) => void;
}

function SceneViewport({
  scene,
  page,
  effect,
  whiteboardOpen,
  utterance,
  quizAnswers,
  codeDraft,
  runOutput,
  selectedPblRole,
  onQuizAnswer,
  onCodeDraftChange,
  onRunCode,
  onPblRoleSelect,
}: SceneViewportProps) {
  if (!scene) {
    return <div className="grid h-full min-h-[34rem] place-items-center text-slate-500">暂无场景</div>;
  }

  return (
    <div className="relative h-full min-h-[34rem] overflow-hidden">
      <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.035)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.035)_1px,transparent_1px)] bg-[size:42px_42px]" />
      <div className="relative z-10 grid h-full gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="min-h-0 rounded-[1.5rem] border border-white/10 bg-slate-950/60 p-5">
          <SceneCanvas
            scene={scene}
            page={page}
            effect={effect}
            quizAnswers={quizAnswers}
            codeDraft={codeDraft}
            runOutput={runOutput}
            selectedPblRole={selectedPblRole}
            onQuizAnswer={onQuizAnswer}
            onCodeDraftChange={onCodeDraftChange}
            onRunCode={onRunCode}
            onPblRoleSelect={onPblRoleSelect}
          />
        </div>

        <aside className="hidden min-h-0 space-y-4 lg:block">
          <ActionTimeline scene={scene} effect={effect} />
          {whiteboardOpen && <Whiteboard scene={scene} utterance={utterance} />}
        </aside>
      </div>
    </div>
  );
}

interface SceneCanvasProps extends Omit<SceneViewportProps, 'scene' | 'whiteboardOpen' | 'utterance'> {
  scene: CourseScene;
}

function SceneCanvas({
  scene,
  page,
  effect,
  quizAnswers,
  codeDraft,
  runOutput,
  selectedPblRole,
  onQuizAnswer,
  onCodeDraftChange,
  onRunCode,
  onPblRoleSelect,
}: SceneCanvasProps) {
  if (scene.type === 'quiz') {
    return <QuizScene scene={scene} answers={quizAnswers} onAnswer={onQuizAnswer} />;
  }
  if (scene.type === 'interactive' || scene.type === 'mindmap') {
    return <InteractiveScene scene={scene} />;
  }
  if (scene.type === 'code') {
    return (
      <CodeScene
        scene={scene}
        codeDraft={codeDraft}
        output={runOutput}
        onCodeDraftChange={onCodeDraftChange}
        onRunCode={onRunCode}
      />
    );
  }
  if (scene.type === 'pbl') {
    return (
      <PblScene
        scene={scene}
        selectedRole={selectedPblRole}
        onRoleSelect={onPblRoleSelect}
      />
    );
  }
  return <SlideScene scene={scene} page={page} effect={effect} />;
}

interface SlideElementRect {
  x: number;
  y: number;
  width: number;
  height: number;
  centerX: number;
  centerY: number;
}

function SlideScene({
  scene,
  page,
  effect,
}: {
  scene: CourseScene;
  page?: SlidePage;
  effect: StageEffect | null;
}) {
  const points = scene.key_points.length > 0 ? scene.key_points : page?.key_points ?? [];
  const slideIndex = page?.index ?? scene.page_refs[0] ?? 0;
  const descriptionElementId = getSlideDescriptionElementId(slideIndex);
  const slideRef = useRef<HTMLDivElement | null>(null);
  const targetRefs = useRef<Record<string, HTMLElement | null>>({});
  const [effectRect, setEffectRect] = useState<SlideElementRect | null>(null);
  const [hoverTarget, setHoverTarget] = useState<{ sceneId: string; targetId: string } | null>(null);
  const hoverTargetId = hoverTarget?.sceneId === scene.id ? hoverTarget.targetId : null;
  const hoverEffect: StageEffect | null = hoverTargetId
    ? {
        kind: 'spotlight',
        label: '重点悬停',
        targetId: hoverTargetId,
        dimOpacity: 0.48,
        focusHold: 'until_next_focus',
      }
    : null;
  const visibleEffect = hoverEffect ?? effect;
  const activeTargetId = visibleEffect?.targetId;

  useLayoutEffect(() => {
    if (!activeTargetId || !slideRef.current) {
      const frame = window.requestAnimationFrame(() => setEffectRect(null));
      return () => window.cancelAnimationFrame(frame);
    }

    const measure = () => {
      const container = slideRef.current;
      const target = targetRefs.current[activeTargetId];
      if (!container || !target) {
        setEffectRect(null);
        return;
      }

      const containerRect = container.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      if (containerRect.width === 0 || containerRect.height === 0) {
        setEffectRect(null);
        return;
      }

      const x = ((targetRect.left - containerRect.left) / containerRect.width) * 100;
      const y = ((targetRect.top - containerRect.top) / containerRect.height) * 100;
      const width = (targetRect.width / containerRect.width) * 100;
      const height = (targetRect.height / containerRect.height) * 100;
      setEffectRect({
        x,
        y,
        width,
        height,
        centerX: x + width / 2,
        centerY: y + height / 2,
      });
    };

    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [activeTargetId, points.length, scene.id]);

  return (
    <div className="flex h-full flex-col">
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <div className="text-xs uppercase tracking-[0.3em] text-teal-200/70">Slide Lecture</div>
          <h2 className="mt-3 text-3xl font-semibold leading-tight text-white">{scene.title}</h2>
        </div>
        <div className="rounded-full border border-white/10 bg-white/[0.05] px-3 py-1 text-xs text-slate-300">
          Page {(page?.index ?? scene.page_refs[0] ?? 0) + 1}
        </div>
      </div>

      <div
        ref={slideRef}
        className="relative flex-1 overflow-hidden rounded-[1.5rem] border border-white/10 bg-gradient-to-br from-slate-100 to-white p-8 text-slate-950 shadow-2xl"
      >
        {visibleEffect?.kind === 'spotlight' && effectRect && (
          <SlideSpotlightOverlay rect={effectRect} dimOpacity={visibleEffect.dimOpacity ?? 0.55} />
        )}
        {visibleEffect?.kind === 'laser' && effectRect && (
          <SlideLaserOverlay rect={effectRect} color={visibleEffect.color ?? '#ff3b30'} />
        )}

        <div className="relative z-10 max-w-4xl">
          <p
            ref={node => {
              targetRefs.current[descriptionElementId] = node;
            }}
            data-maic-element-id={descriptionElementId}
            className="mb-8 max-w-3xl text-xl leading-relaxed text-slate-700"
            style={getElementAnimationStyle(scene, descriptionElementId, 0)}
          >
            {scene.description}
          </p>
          <div className="grid gap-4 md:grid-cols-2">
            {points.slice(0, 4).map((point, index) => {
              const elementId = getSlidePointElementId(slideIndex, index);
              const active = activeTargetId === elementId;
              return (
                <div
                  key={`${point}-${index}`}
                  ref={node => {
                    targetRefs.current[elementId] = node;
                  }}
                  tabIndex={0}
                  data-maic-element-id={elementId}
                  onMouseEnter={() => setHoverTarget({ sceneId: scene.id, targetId: elementId })}
                  onMouseLeave={() =>
                    setHoverTarget(current =>
                      current?.sceneId === scene.id && current.targetId === elementId ? null : current
                    )
                  }
                  onFocus={() => setHoverTarget({ sceneId: scene.id, targetId: elementId })}
                  onBlur={() =>
                    setHoverTarget(current =>
                      current?.sceneId === scene.id && current.targetId === elementId ? null : current
                    )
                  }
                  className={`rounded-2xl border p-5 shadow-sm transition duration-500 ${
                    active && visibleEffect?.kind === 'spotlight'
                      ? 'border-teal-400 bg-teal-50 shadow-teal-200/80'
                      : active && visibleEffect?.kind === 'laser'
                        ? 'border-red-300 bg-red-50 shadow-red-200/70'
                        : 'border-slate-200 bg-white/80'
                  }`}
                  style={getElementAnimationStyle(scene, elementId, 120 + index * 120)}
                >
                  <div className="mb-3 text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">
                    Key {index + 1}
                  </div>
                  <div className="text-lg font-semibold leading-snug">{point}</div>
                </div>
              );
            })}
          </div>
          {points.length === 0 && (
            <pre className="max-h-72 overflow-y-auto whitespace-pre-wrap rounded-2xl bg-slate-950 p-5 text-sm text-slate-100">
              {page?.raw_text.slice(0, 1600)}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

function SlideSpotlightOverlay({
  rect,
  dimOpacity,
}: {
  rect: SlideElementRect;
  dimOpacity: number;
}) {
  return (
    <div className="pointer-events-none absolute inset-0 z-20">
      <svg width="100%" height="100%" viewBox="0 0 100 100" preserveAspectRatio="none">
        <defs>
          <mask id="maic-slide-spotlight-mask">
            <rect x="0" y="0" width="100" height="100" fill="white" />
            <rect
              x={Math.max(rect.x - 0.6, 0)}
              y={Math.max(rect.y - 0.8, 0)}
              width={Math.min(rect.width + 1.2, 100)}
              height={Math.min(rect.height + 1.6, 100)}
              rx="1.2"
              fill="black"
              className="maic-ppt-spotlight-cutout"
            />
          </mask>
        </defs>
        <rect
          width="100"
          height="100"
          fill={`rgba(2,6,23,${dimOpacity})`}
          mask="url(#maic-slide-spotlight-mask)"
        />
        <rect
          x={Math.max(rect.x - 0.6, 0)}
          y={Math.max(rect.y - 0.8, 0)}
          width={Math.min(rect.width + 1.2, 100)}
          height={Math.min(rect.height + 1.6, 100)}
          rx="1.2"
          fill="none"
          stroke="rgba(255,255,255,0.78)"
          strokeWidth="0.65"
          className="maic-ppt-spotlight-border"
        />
      </svg>
    </div>
  );
}

function SlideLaserOverlay({ rect, color }: { rect: SlideElementRect; color: string }) {
  const startX = rect.centerX > 50 ? 44 : -44;
  const startY = rect.centerY > 50 ? 44 : -44;
  return (
    <div
      className="pointer-events-none absolute z-30"
      style={
        {
          left: `${rect.centerX}%`,
          top: `${rect.centerY}%`,
          '--maic-laser-color': color,
          '--maic-laser-start-x': `${startX}px`,
          '--maic-laser-start-y': `${startY}px`,
        } as React.CSSProperties
      }
    >
      <div className="maic-ppt-laser">
        <span className="maic-ppt-laser-ring" />
        <span className="maic-ppt-laser-dot" />
      </div>
    </div>
  );
}

function QuizScene({
  scene,
  answers,
  onAnswer,
}: {
  scene: CourseScene;
  answers: Record<string, number>;
  onAnswer: (id: string, value: number) => void;
}) {
  return (
    <div className="space-y-5">
      <div>
        <div className="text-xs uppercase tracking-[0.3em] text-amber-200/70">Interactive Quiz</div>
        <h2 className="mt-3 text-3xl font-semibold">{scene.title}</h2>
        <p className="mt-2 text-slate-300">{scene.description}</p>
      </div>
      {scene.quiz?.map(question => {
        const selected = answers[question.id];
        const answered = selected !== undefined;
        return (
          <div key={question.id} className="rounded-[1.5rem] border border-white/10 bg-white/[0.04] p-5">
            <h3 className="mb-4 text-lg font-semibold">{question.question}</h3>
            <div className="grid gap-3">
              {question.options.map((option, index) => {
                const correct = index === question.answer_index;
                const picked = selected === index;
                return (
                  <button
                    key={`${question.id}-${option}`}
                    type="button"
                    onClick={() => onAnswer(question.id, index)}
                    className={`rounded-2xl border p-4 text-left transition ${
                      answered && correct
                        ? 'border-teal-300 bg-teal-300/15'
                        : picked
                          ? 'border-amber-300 bg-amber-300/15'
                          : 'border-white/10 bg-slate-950/40 hover:bg-white/10'
                    }`}
                  >
                    <span className="mr-3 text-xs text-slate-400">{String.fromCharCode(65 + index)}</span>
                    {option}
                  </button>
                );
              })}
            </div>
            {answered && (
              <div className="mt-4 rounded-2xl border border-teal-300/30 bg-teal-300/10 p-4 text-sm text-teal-50">
                AI 讲评: {question.explanation}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function InteractiveScene({ scene }: { scene: CourseScene }) {
  const [complexity, setComplexity] = useState(45);
  const [focus, setFocus] = useState(62);
  return (
    <div className="grid h-full gap-5 lg:grid-cols-[1fr_18rem]">
      <div>
        <div className="text-xs uppercase tracking-[0.3em] text-sky-200/70">
          {scene.interactive?.kind === 'mindmap' ? 'Mind Map' : 'Deep Interactive Mode'}
        </div>
        <h2 className="mt-3 text-3xl font-semibold">{scene.title}</h2>
        <p className="mt-2 text-slate-300">{scene.interactive?.prompt || scene.description}</p>

        <div className="mt-6 rounded-[1.75rem] border border-white/10 bg-slate-950/70 p-6">
          <div className="relative h-80 overflow-hidden rounded-[1.25rem] bg-gradient-to-br from-sky-500/20 via-teal-500/10 to-slate-950">
            <div className="absolute left-[12%] top-[18%] h-24 w-24 rounded-full border border-sky-300/50 bg-sky-300/10" />
            <div
              className="absolute rounded-full border border-teal-300/70 bg-teal-300/20 transition-all duration-500"
              style={{
                left: `${complexity}%`,
                top: `${100 - focus}%`,
                width: `${72 + complexity}px`,
                height: `${72 + complexity}px`,
              }}
            />
            <div className="absolute bottom-5 left-5 right-5 rounded-2xl border border-white/10 bg-black/30 p-4 text-sm text-slate-200 backdrop-blur">
              教师正在操作交互 UI：调节复杂度与关注点，观察概念之间的动态关系。
            </div>
          </div>
        </div>
      </div>

      <div className="space-y-4 rounded-[1.5rem] border border-white/10 bg-white/[0.04] p-5">
        <ControlSlider label="复杂度" value={complexity} onChange={setComplexity} />
        <ControlSlider label="关注点" value={focus} onChange={setFocus} />
        <div className="space-y-2">
          {scene.interactive?.controls.map(control => (
            <button
              key={control}
              type="button"
              className="w-full rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-left text-sm hover:bg-white/10"
            >
              {control}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function ControlSlider({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="block text-sm text-slate-300">
      <span className="mb-2 flex justify-between">
        {label}
        <span>{value}%</span>
      </span>
      <input
        type="range"
        min={0}
        max={100}
        value={value}
        onChange={event => onChange(Number(event.target.value))}
        className="w-full accent-teal-300"
      />
    </label>
  );
}

function CodeScene({
  scene,
  codeDraft,
  output,
  onCodeDraftChange,
  onRunCode,
}: {
  scene: CourseScene;
  codeDraft: string;
  output: string;
  onCodeDraftChange: (value: string) => void;
  onRunCode: () => void;
}) {
  return (
    <div className="grid h-full gap-5 lg:grid-cols-[1fr_20rem]">
      <div className="flex min-h-0 flex-col">
        <div className="text-xs uppercase tracking-[0.3em] text-lime-200/70">Online Programming</div>
        <h2 className="mt-3 text-3xl font-semibold">{scene.title}</h2>
        <textarea
          value={codeDraft}
          onChange={event => onCodeDraftChange(event.target.value)}
          className="mt-5 min-h-80 flex-1 resize-none rounded-[1.5rem] border border-white/10 bg-slate-950 p-5 font-mono text-sm text-lime-100 outline-none focus:border-lime-300/60"
        />
      </div>
      <div className="rounded-[1.5rem] border border-white/10 bg-white/[0.04] p-5">
        <button
          type="button"
          onClick={onRunCode}
          className="w-full rounded-2xl bg-lime-300 px-4 py-3 text-sm font-semibold text-slate-950 hover:bg-lime-200"
        >
          运行示例
        </button>
        <div className="mt-4 rounded-2xl bg-black/40 p-4 font-mono text-sm text-lime-100">
          Output: {output}
        </div>
        <p className="mt-4 text-sm leading-relaxed text-slate-300">
          这里提供与 OpenMAIC 在线编程相同的学习路径：先读概念，再改变量，最后运行验证。
        </p>
      </div>
    </div>
  );
}

function PblScene({
  scene,
  selectedRole,
  onRoleSelect,
}: {
  scene: CourseScene;
  selectedRole: string | null;
  onRoleSelect: (role: string) => void;
}) {
  return (
    <div className="space-y-6">
      <div>
        <div className="text-xs uppercase tracking-[0.3em] text-fuchsia-200/70">
          Project-Based Learning
        </div>
        <h2 className="mt-3 text-3xl font-semibold">{scene.title}</h2>
        <p className="mt-2 text-slate-300">{scene.pbl?.challenge}</p>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        {scene.pbl?.roles.map(role => (
          <button
            key={role}
            type="button"
            onClick={() => onRoleSelect(role)}
            className={`rounded-[1.25rem] border p-5 text-left ${
              selectedRole === role
                ? 'border-fuchsia-300 bg-fuchsia-300/15'
                : 'border-white/10 bg-white/[0.04] hover:bg-white/10'
            }`}
          >
            <div className="text-lg font-semibold">{role}</div>
            <p className="mt-2 text-sm text-slate-400">选择后进入协作任务。</p>
          </button>
        ))}
      </div>
      {scene.pbl?.tasks?.length ? (
        <div className="rounded-[1.5rem] border border-white/10 bg-white/[0.04] p-5">
          <div className="mb-4 text-xs uppercase tracking-[0.25em] text-fuchsia-200/70">
            PBL v2 Task Chain
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            {scene.pbl.tasks.map(task => (
              <div key={task.id} className="rounded-2xl bg-black/30 p-4">
                <div className="mb-2 text-xs uppercase tracking-[0.18em] text-slate-500">{task.tier}</div>
                <div className="font-semibold text-white">{task.title}</div>
                <p className="mt-2 text-sm text-slate-400">{task.description}</p>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {task.evidence.map(item => (
                    <span key={item} className="rounded-full border border-fuchsia-300/25 px-2 py-0.5 text-[11px] text-fuchsia-100">
                      {item}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}
      <div className="rounded-[1.5rem] border border-white/10 bg-white/[0.04] p-5">
        <h3 className="mb-4 font-semibold">里程碑</h3>
        <div className="grid gap-3 md:grid-cols-4">
          {scene.pbl?.milestones.map((milestone, index) => (
            <div key={milestone} className="rounded-2xl bg-black/30 p-4">
              <div className="mb-2 text-xs text-slate-500">Step {index + 1}</div>
              {milestone}
            </div>
          ))}
        </div>
        <div className="mt-4 rounded-2xl border border-fuchsia-300/30 bg-fuchsia-300/10 p-4 text-sm">
          交付物: {scene.pbl?.deliverable}
        </div>
        {scene.pbl?.evaluation?.rubric?.length ? (
          <div className="mt-4 flex flex-wrap gap-2 text-xs text-slate-300">
            {scene.pbl.evaluation.rubric.map(item => (
              <span key={item} className="rounded-full bg-black/30 px-2.5 py-1">{item}</span>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ActionTimeline({ scene, effect }: { scene: CourseScene; effect: StageEffect | null }) {
  return (
    <div className="rounded-[1.5rem] border border-white/10 bg-black/25 p-4">
      <div className="mb-3 text-xs uppercase tracking-[0.25em] text-slate-400">Action Engine</div>
      <div className="space-y-2">
        {scene.actions.map(action => {
          const active = isSceneActionActive(action, effect);
          return (
            <div
              key={action.id}
              className={`rounded-2xl border p-3 text-sm ${
                active ? 'border-teal-300/50 bg-teal-300/10' : 'border-white/10 bg-white/[0.03]'
              }`}
            >
              <div className="text-xs uppercase tracking-[0.18em] text-slate-500">{action.type}</div>
              <div className="mt-1 font-medium">{action.title}</div>
              {action.content && <div className="mt-1 line-clamp-2 text-xs text-slate-400">{action.content}</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface SceneEffectScheduleItem {
  effect: StageEffect;
  delay: number;
  duration: number;
  hold: boolean;
}

function buildSceneEffectSchedule(actions: SceneAction[]): SceneEffectScheduleItem[] {
  const schedule: SceneEffectScheduleItem[] = [];
  let cursor = 0;

  for (const action of actions) {
    const effect = toStageEffectFromSceneAction(action);
    const duration = getSceneActionDuration(action);
    if (effect) {
      const delay = action.trigger === 'meantime' ? Math.max(cursor - Math.min(duration, 300), 0) : cursor;
      schedule.push({ effect, delay, duration, hold: shouldHoldFocus(action) });
    }

    if (action.type === 'spotlight' || action.type === 'laser') {
      if (action.trigger !== 'meantime') cursor += Math.min(duration, 250);
    } else {
      cursor += duration;
    }
  }

  return schedule;
}

function toStageEffectFromSceneAction(action: SceneAction): StageEffect | null {
  const targetId = action.elementId ?? action.target ?? action.animation?.elId;
  switch (action.type) {
    case 'speech':
      return { kind: 'speech', label: action.title, targetId };
    case 'spotlight':
      return {
        kind: 'spotlight',
        label: action.title,
        targetId,
        dimOpacity: action.dimOpacity,
        focusHold: action.focusHold,
      };
    case 'laser':
      return {
        kind: 'laser',
        label: action.title,
        targetId,
        color: action.color,
      };
    case 'whiteboard':
    case 'wb_open':
    case 'wb_draw_text':
    case 'wb_draw_shape':
    case 'wb_draw_chart':
    case 'wb_draw_latex':
    case 'wb_draw_table':
    case 'wb_draw_line':
    case 'wb_draw_code':
    case 'wb_clear':
    case 'wb_delete':
    case 'wb_close':
      return { kind: 'whiteboard', label: action.title };
    case 'discussion':
      return { kind: 'discussion', label: action.title };
    default:
      return null;
  }
}

function isSameStageEffect(current: StageEffect | null, next: StageEffect): boolean {
  return (
    current?.kind === next.kind &&
    current.label === next.label &&
    current.targetId === next.targetId
  );
}

function getSceneActionDuration(action: SceneAction): number {
  if (typeof action.duration === 'number' && action.duration > 0) return action.duration;
  if (typeof action.animation?.duration === 'number' && action.animation.duration > 0) {
    return action.animation.duration;
  }
  switch (action.type) {
    case 'speech':
      return 1200;
    case 'spotlight':
    case 'laser':
      return 900;
    case 'whiteboard':
    case 'wb_open':
    case 'wb_draw_text':
    case 'wb_draw_shape':
    case 'wb_draw_chart':
    case 'wb_draw_latex':
    case 'wb_draw_table':
    case 'wb_draw_line':
    case 'wb_draw_code':
      return 800;
    case 'discussion':
      return 700;
    default:
      return 500;
  }
}

function getElementAnimationStyle(
  scene: CourseScene,
  elementId: string,
  fallbackDelay: number
): React.CSSProperties | undefined {
  const action = scene.actions.find(candidate =>
    candidate.elementId === elementId ||
    candidate.target === elementId ||
    candidate.animation?.elId === elementId
  );
  const animation = action?.animation;
  if (!animation) return undefined;

  return {
    animation: `${toCssAnimationName(animation.effect, animation.type)} ${animation.duration}ms cubic-bezier(0.16, 1, 0.3, 1) ${fallbackDelay}ms both`,
  };
}

function toCssAnimationName(effect: string, type: string): string {
  const normalized = effect.toLowerCase();
  if (normalized.includes('spotlight') || normalized.includes('pulse')) {
    return 'maicPptAttentionPulse';
  }
  if (normalized.includes('fade')) return type === 'attention' ? 'maicPptAttentionPulse' : 'maicPptFadeIn';
  if (normalized.includes('wipe') || normalized.includes('fly')) return 'maicPptFadeUp';
  if (normalized.includes('laser')) return 'maicPptFadeUp';
  return type === 'attention' ? 'maicPptAttentionPulse' : 'maicPptFadeUp';
}

function isSceneActionActive(action: SceneAction, effect: StageEffect | null): boolean {
  if (!effect) return false;
  const actionTarget = action.elementId ?? action.target ?? action.animation?.elId;
  return action.type === effect.kind || (!!actionTarget && actionTarget === effect.targetId);
}

function Whiteboard({ scene, utterance }: { scene: CourseScene; utterance?: Utterance }) {
  return (
    <div className="rounded-[1.5rem] border border-white/10 bg-slate-100 p-4 text-slate-950 shadow-xl">
      <div className="mb-3 flex items-center justify-between">
        <div className="text-xs font-semibold uppercase tracking-[0.25em] text-slate-500">
          Whiteboard
        </div>
        <div className="h-2 w-2 rounded-full bg-red-500" />
      </div>
      <svg viewBox="0 0 300 160" className="mb-3 h-36 w-full rounded-xl bg-white">
        <path d="M30 120 C80 40 125 80 160 30 S235 65 270 25" fill="none" stroke="#14b8a6" strokeWidth="4" />
        <line x1="40" y1="130" x2="260" y2="130" stroke="#94a3b8" strokeDasharray="6 6" />
        <circle cx="160" cy="30" r="8" fill="#0f766e" />
      </svg>
      <div className="space-y-2 text-sm">
        {scene.key_points.slice(0, 3).map(point => (
          <div key={point} className="rounded-xl bg-slate-100 p-2 shadow-sm">
            {point}
          </div>
        ))}
        {utterance && (
          <div className="rounded-xl bg-teal-50 p-2 text-teal-950">
            最新发言: {utterance.content.slice(0, 80)}
          </div>
        )}
      </div>
    </div>
  );
}

interface ClassroomChatProps {
  utterances: Utterance[];
  mode: ClassroomMode;
  input: string;
  deferredInput: string;
  sending: boolean;
  activeQuestions: string[];
  roles: AgentRole[];
  latestSpeaker?: SpeakerRole;
  onInputChange: (value: string) => void;
  onSend: () => void;
  onModeChange: (mode: ClassroomMode) => void;
  onQuickAsk: (question: string) => void;
}

const ClassroomChat = React.forwardRef<HTMLDivElement, ClassroomChatProps>(function ClassroomChat(
  {
    utterances,
    mode,
    input,
    deferredInput,
    sending,
    activeQuestions,
    roles,
    latestSpeaker,
    onInputChange,
    onSend,
    onModeChange,
    onQuickAsk,
  },
  ref
) {
  return (
    <aside className="flex h-full min-h-0 flex-col overflow-hidden rounded-[1.75rem] border border-white/10 bg-black/25">
      <div className="shrink-0 border-b border-white/10 p-4">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <div className="text-xs uppercase tracking-[0.25em] text-slate-500">Roundtable</div>
            <h2 className="font-semibold">多智能体讨论</h2>
          </div>
          <div className="flex rounded-full border border-white/10 p-1 text-xs">
            <button
              type="button"
              onClick={() => onModeChange('continuous')}
              className={`rounded-full px-3 py-1 ${mode === 'continuous' ? 'bg-teal-300 text-slate-950' : 'text-slate-400'}`}
            >
              连续
            </button>
            <button
              type="button"
              onClick={() => onModeChange('interactive')}
              className={`rounded-full px-3 py-1 ${mode === 'interactive' ? 'bg-teal-300 text-slate-950' : 'text-slate-400'}`}
            >
              交互
            </button>
          </div>
        </div>
        <div className="flex -space-x-2">
          {roles.map(role => (
            <AgentBadge key={role} role={role} active={latestSpeaker === role} />
          ))}
        </div>
      </div>

      <div ref={ref} className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
        {utterances.map(utterance => (
          <ChatBubble key={utterance.id} utterance={utterance} />
        ))}
        {utterances.length === 0 && (
          <div className="rounded-2xl border border-dashed border-white/10 p-6 text-center text-sm text-slate-500">
            课堂即将开始，老师和同学会在这里实时发言。
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-white/10 p-4">
        <div className="mb-3 flex gap-2 overflow-x-auto pb-1">
          {activeQuestions.slice(0, 3).map(question => (
            <button
              key={question}
              type="button"
              onClick={() => onQuickAsk(question)}
              className="shrink-0 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-xs text-slate-300 hover:bg-white/10"
            >
              {question}
            </button>
          ))}
        </div>
        <textarea
          value={input}
          onChange={event => onInputChange(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void onSend();
            }
          }}
          rows={3}
          placeholder="随时打断、提问，或请求换一种讲法..."
          className="w-full resize-none rounded-2xl border border-white/10 bg-slate-950/80 p-3 text-sm text-slate-100 outline-none placeholder:text-slate-500 focus:border-teal-300/60"
        />
        <div className="mt-3 flex items-center justify-between gap-3">
          <div className="text-[11px] text-slate-500">
            {deferredInput.trim().length} 字 · Enter 发送
          </div>
          <button
            type="button"
            onClick={() => void onSend()}
            disabled={sending || !input.trim()}
            className="rounded-2xl bg-teal-300 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-teal-200 disabled:opacity-50"
          >
            发送
          </button>
        </div>
      </div>
    </aside>
  );
});

function AgentBadge({ role, active }: { role: AgentRole; active: boolean }) {
  const meta = ROLE_META[role];
  return (
    <div
      title={meta.name}
      className={`grid h-10 w-10 place-items-center rounded-full border-2 border-slate-950 bg-gradient-to-br ${meta.tone} text-xs font-bold text-slate-950 ${
        active ? 'ring-2 ring-teal-200' : ''
      }`}
    >
      {meta.initials}
    </div>
  );
}

function ChatBubble({ utterance }: { utterance: Utterance }) {
  const role = utterance.speaker as SpeakerRole;
  const meta = ROLE_META[role] ?? ROLE_META.student;
  const isStudent = role === 'student';
  return (
    <div className={`flex gap-3 ${isStudent ? 'flex-row-reverse' : ''}`}>
      <div className={`grid h-9 w-9 shrink-0 place-items-center rounded-full bg-gradient-to-br ${meta.tone} text-xs font-bold text-slate-950`}>
        {meta.initials}
      </div>
      <div
        className={`max-w-[82%] rounded-2xl border px-3 py-2 text-sm ${
          isStudent
            ? 'border-lime-300/30 bg-lime-300/10'
            : 'border-white/10 bg-white/[0.05]'
        }`}
      >
        <div className="mb-1 text-xs font-semibold text-slate-300">
          {utterance.speaker_name || meta.name}
        </div>
        <div className="whitespace-pre-wrap leading-relaxed text-slate-100">{utterance.content}</div>
      </div>
    </div>
  );
}

function deriveScenes(course: Course | null): CourseScene[] {
  const prepared = course?.prepared;
  if (!prepared) return [];
  if (Array.isArray(prepared.scenes) && prepared.scenes.length > 0) {
    return prepared.scenes.map(scene => hydrateSlideSceneAnimations(scene, prepared.pages));
  }
  const pages = prepared.pages ?? [];
  const fallbackScenes: CourseScene[] = pages.map((page, index) => ({
    id: `fallback_slide_${page.index}`,
    order: index,
    type: 'slide',
    title: page.key_points[0] || `第 ${page.index + 1} 页`,
    description: page.description || page.raw_text.slice(0, 200),
    page_refs: [page.index],
    key_points: page.key_points,
    actions: [
      {
        id: `fallback_speech_${page.index}`,
        type: 'speech',
        title: '教师讲解',
        content: page.description,
      },
      {
        id: `fallback_discussion_${page.index}`,
        type: 'discussion',
        title: '课堂讨论',
        content: prepared.active_questions[index % Math.max(prepared.active_questions.length, 1)],
      },
    ],
  }));
  if (prepared.active_questions.length > 0) {
    fallbackScenes.push({
      id: 'fallback_quiz',
      order: fallbackScenes.length,
      type: 'quiz',
      title: '即时测验',
      description: '基于课程主动提问生成的检查点。',
      page_refs: [0],
      key_points: [],
      actions: [],
      quiz: [
        {
          id: 'fallback_quiz_1',
          question: prepared.active_questions[0],
          options: ['围绕核心概念回答', '跳过细节', '只背结论', '不需要联系例子'],
          answer_index: 0,
          explanation: 'OpenMAIC 课堂强调理解概念关系与迁移应用。',
        },
      ],
    });
  }
  return fallbackScenes;
}

function hydrateSlideSceneAnimations(scene: CourseScene, pages: SlidePage[]): CourseScene {
  if (scene.type !== 'slide') return scene;
  if (scene.actions.some(action => action.animation || action.elementId)) return scene;

  const slideIndex = scene.page_refs[0] ?? 0;
  const page = pages.find(candidate => candidate.index === slideIndex);
  const pointCount = Math.min(scene.key_points.length || page?.key_points.length || 1, 4);
  const animations = page?.animations?.length
    ? page.animations
    : buildDefaultSlideAnimations(slideIndex, pointCount);

  return {
    ...scene,
    actions: scene.actions.map(action => {
      if (action.type === 'speech') {
        const elementId = getSlideDescriptionElementId(slideIndex);
        return {
          ...action,
          elementId,
          animation: animations.find(animation => animation.elId === elementId) ?? animations[0],
        };
      }
      if (action.type === 'spotlight' || action.type === 'laser') {
        const pointIndex = action.type === 'spotlight' ? 0 : Math.min(1, pointCount - 1);
        const elementId = getSlidePointElementId(slideIndex, pointIndex);
        const animation = animations[pointIndex + 1] ?? animations[0];
        return {
          ...action,
          target: elementId,
          elementId,
          animation: { ...animation, elId: elementId },
          dimOpacity: action.type === 'spotlight' ? 0.55 : action.dimOpacity,
          color: action.type === 'laser' ? action.color ?? '#ff3b30' : action.color,
          focusHold:
            action.type === 'spotlight' ? action.focusHold ?? 'until_next_focus' : action.focusHold,
        };
      }
      return action;
    }),
  };
}

function buildCompletionSummary(
  scenes: CourseScene[],
  quizAnswers: Record<string, number>
): CompletionSummary {
  const sceneStats = Object.keys(SCENE_LABELS).map(type => ({
    type: type as CourseSceneType,
    count: scenes.filter(scene => scene.type === type).length,
  }));
  const questions = scenes.flatMap(scene => scene.quiz ?? []);
  const answeredQuestions = questions.filter(question => quizAnswers[question.id] !== undefined);
  const correctAnswers = answeredQuestions.filter(
    question => quizAnswers[question.id] === question.answer_index
  ).length;

  return {
    totalQuestions: questions.length,
    answeredQuestions: answeredQuestions.length,
    correctAnswers,
    sceneStats,
  };
}

function normalizeStoredQuizAnswers(raw: Record<string, unknown>): Record<string, number> {
  const answers: Record<string, number> = {};
  for (const [questionId, value] of Object.entries(raw)) {
    const numericValue = Number(value);
    if (Number.isInteger(numericValue) && numericValue >= 0) {
      answers[questionId] = numericValue;
    }
  }
  return answers;
}

function appendUtterance(existing: Utterance[], utterance: Utterance): Utterance[] {
  if (existing.some(item => item.id === utterance.id)) return existing;
  return [...existing, utterance];
}

function mergeUtterances(existing: Utterance[], incoming: Utterance[]): Utterance[] {
  const byId = new Map(existing.map(item => [item.id, item]));
  for (const utterance of incoming) byId.set(utterance.id, utterance);
  return Array.from(byId.values()).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

function makeSystemUtterance(message: string): Utterance {
  return {
    id: `system_${Date.now()}`,
    speaker: 'ta',
    speaker_name: '系统提示',
    content: message,
    timestamp: new Date().toISOString(),
  };
}

function toStageEffect(action: TeachingAction | undefined): StageEffect | null {
  if (!action) return null;
  switch (action.type) {
    case 'ShowFile':
      return { kind: 'spotlight', label: '切换课件' };
    case 'ReadScript':
      return { kind: 'laser', label: '讲解重点' };
    case 'AskQuestion':
      return { kind: 'discussion', label: '主动提问' };
    case 'AnswerStudent':
      return { kind: 'spotlight', label: '回答学生' };
    default:
      return null;
  }
}

function mostlyChinese(text: string): boolean {
  if (!text) return true;
  const matches = text.match(/[\u4e00-\u9fff]/g);
  return (matches?.length ?? 0) / text.length > 0.25;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
