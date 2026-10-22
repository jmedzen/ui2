'use client';

import React, { createContext, useContext, useState, useRef, useEffect, useCallback } from 'react';
import { triggerBackgroundServerCache, getOptimalMediaRoute, fetchCacheStatus } from '@/lib/speedTester';
import {
  readProgressMap,
  saveProgressMap,
  setEpisodeProgress as recordEpisodeProgress,
  getEpisodeProgress,
  resumeTimeFor,
  readPlayerPrefs,
  savePlayerPrefs,
  nextRepeatMode as computeNextRepeatMode,
  type ProgressMap,
  type RepeatMode,
  type SleepTimerState
} from '@/lib/playbackStore';

export interface PlayingTrack {
  courseId: number;
  courseTitle: string;
  filename: string;
  proxyUrl: string;
  url: string;
  index: number;
  activeRoute?: 'proxy' | 'direct';
  isServerCached?: boolean;
}

interface AudioContextType {
  currentTrack: PlayingTrack | null;
  playlist: PlayingTrack[];
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  playbackRate: number;
  volume: number;
  isMuted: boolean;
  isExpanded: boolean;
  /** Reserved resume point for the current episode, 0 when none. */
  resumeAt: number;
  /** Clears the stored position for the current episode. */
  clearResume: () => void;
  repeatMode: RepeatMode;
  cycleRepeatMode: () => void;
  sleepTimer: SleepTimerState;
  /** Arms a stop at `minutes` from now; 0 disarms. */
  setSleepMinutes: (minutes: number) => void;
  /** Arms a stop at the end of the current episode. */
  setSleepEndOfEpisode: () => void;
  cancelSleepTimer: () => void;
  playTrack: (courseTitle: string, courseId: number, tracks: { filename: string; proxyUrl: string; url: string; index: number }[], trackIndex: number, startAt?: number) => void;
  togglePlay: () => void;
  playNext: () => void;
  playPrev: () => void;
  seekTo: (time: number) => void;
  seekRelative: (seconds: number) => void;
  setRate: (rate: number) => void;
  setVol: (vol: number) => void;
  toggleMute: () => void;
  toggleExpanded: () => void;
}

const AudioContext = createContext<AudioContextType | undefined>(undefined);
const STORAGE_KEY = 'fayun_last_played_track';

/**
 * Writes the chosen speed to a media element from one place.
 *
 * `defaultPlaybackRate` is the durable half of the pair: the HTML media load
 * algorithm — which every `load()` and every `src` assignment runs — ends with
 * "Set the playbackRate attribute to the value of the defaultPlaybackRate
 * attribute". A rate written only to `playbackRate` is therefore discarded by
 * the next load, and `defaultPlaybackRate` defaults to 1.0, so every track
 * change and every auto-advance silently reverted to 1.0x while the UI still
 * highlighted the chosen speed (React state was never changed).
 *
 * Module scope (unlike `applyElementVolume`) because it holds no React state,
 * so the one-shot element-creation effect can call it without widening its
 * dependency array.
 */
function applyElementPlaybackRate(el: HTMLMediaElement | null, rate: number) {
  if (!el) return;
  try {
    el.defaultPlaybackRate = rate;
    el.playbackRate = rate;
  } catch {}
}

export function AudioProvider({ children }: { children: React.ReactNode }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [currentTrack, setCurrentTrack] = useState<PlayingTrack | null>(null);
  const [playlist, setPlaylist] = useState<PlayingTrack[]>([]);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [currentTime, setCurrentTime] = useState<number>(0);
  const [duration, setDuration] = useState<number>(0);
  const [playbackRate, setPlaybackRate] = useState<number>(1.0);
  const [volume, setVolume] = useState<number>(1.0);
  const [isMuted, setIsMuted] = useState<boolean>(false);
  const [isExpanded, setIsExpanded] = useState<boolean>(true);

  /**
   * Listening progress, repeat mode and the sleep timer.
   *
   * All three are seeded with defaults and hydrated in a mount effect rather
   * than a `useState` initialiser: this provider is server-rendered, so reading
   * `localStorage` during render would produce a hydration mismatch between the
   * server's defaults and the client's stored values.
   */
  const [resumeAt, setResumeAt] = useState<number>(0);
  const [repeatMode, setRepeatMode] = useState<RepeatMode>('all');
  const [sleepTimer, setSleepTimer] = useState<SleepTimerState>({ endsAt: null, endOfEpisode: false });

  /**
   * The progress map is never rendered — it is read only when a track starts
   * and written on a throttled interval — so it lives in a ref rather than in
   * state. Holding it in state re-rendered this provider and every audio
   * consumer once every five seconds during playback, for no visual change.
   */
  const progressMapRef = useRef<ProgressMap>({});

  /**
   * Ref mirrors for the two settings the one-shot `ended` handler reads.
   *
   * That handler is registered once on the element and cannot depend on React
   * state without re-attaching every listener on each change, so both values
   * are mirrored here and read at call time.
   */
  const repeatModeRef = useRef<RepeatMode>(repeatMode);
  const sleepTimerRef = useRef<SleepTimerState>(sleepTimer);
  useEffect(() => {
    repeatModeRef.current = repeatMode;
  }, [repeatMode]);
  useEffect(() => {
    sleepTimerRef.current = sleepTimer;
  }, [sleepTimer]);

  /**
   * Mirrors of `playlist` / `currentTrack` for the callbacks that must not
   * depend on them.
   *
   * Written from an effect rather than during render: assigning a ref while
   * rendering is unsafe under concurrent rendering (a render that is thrown away
   * would still have mutated the ref) and is rejected by the hooks lint rules.
   *
   * The effects sit above the hydration effect on purpose — effects run in
   * declaration order, so these values are already current when it reads them.
   */
  const playlistRef = useRef<PlayingTrack[]>(playlist);
  const currentTrackRef = useRef<PlayingTrack | null>(currentTrack);

  useEffect(() => {
    playlistRef.current = playlist;
  }, [playlist]);

  useEffect(() => {
    currentTrackRef.current = currentTrack;
  }, [currentTrack]);

  /**
   * The chosen speed, readable from the element-creation effect and the media
   * event handlers. Those two run once and cannot depend on `playbackRate`
   * without tearing the element (and its listeners) down on every speed change,
   * so they read the current value through this ref instead. Kept up to date in
   * an effect rather than during render, since the refs above already record
   * state that way elsewhere in this file.
   */
  const playbackRateRef = useRef<number>(playbackRate);

  const playRequestIdRef = useRef<number>(0);

  /**
   * False once the provider has unmounted.
   *
   * Async continuations (route probing, cache status, autoplay-next) previously
   * checked only the request id, so a continuation that resolved after unmount
   * still called setState on a torn-down tree. The request id cannot cover this
   * because nothing bumps it on unmount.
   */
  const isMountedRef = useRef<boolean>(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  /**
   * Applies volume/mute to the element from one place.
   *
   * `playTrack` wrote `volume` while `toggleMute` wrote `muted`, so mixing them
   * (mute, then start another track) left the element muted with a non-zero
   * volume — silence behind a slider that looked unmuted.
   */
  const applyElementVolume = useCallback((el: HTMLAudioElement | null, vol: number, muted: boolean) => {
    if (!el) return;
    try {
      el.muted = muted;
      el.volume = muted ? 0 : vol;
    } catch {}
  }, []);

  // Mirror the chosen speed into the ref read by the one-shot media effects.
  useEffect(() => {
    playbackRateRef.current = playbackRate;
  }, [playbackRate]);

  // Restore last played track from localStorage on mount
  useEffect(() => {
    let restoredTrack: PlayingTrack | null = null;
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed && parsed.currentTrack) {
          restoredTrack = parsed.currentTrack as PlayingTrack;
          // State writes in an effect are correct here: the value lives in
          // localStorage, which is an external system that cannot be read during
          // render without a hydration mismatch. This is the documented
          // "synchronise with an external store" case, not a render cascade, and
          // the effect runs once on mount.
          // eslint-disable-next-line react-hooks/set-state-in-effect
          setCurrentTrack(restoredTrack);
          if (parsed.playlist) setPlaylist(parsed.playlist);
        }
      }
      // `setRate()` writes the element directly, and the element does not exist
      // yet on the first mount, so re-assert the chosen speed above the default
      // 1.0x here.
      applyElementPlaybackRate(audioRef.current, playbackRateRef.current);
    } catch (e) {
      console.warn('Failed to load last played track from localStorage:', e);
    }

    // Listening progress, speed/volume and the repeat mode are hydrated here
    // (not in a useState initialiser) so the server-rendered markup and the
    // first client render agree. A stored speed is applied to the element as
    // soon as it exists, for the same reason as the line above.
    const storedPrefs = readPlayerPrefs();
    setPlaybackRate(storedPrefs.rate);
    setVolume(storedPrefs.volume);
    setIsMuted(storedPrefs.muted);
    setRepeatMode(storedPrefs.repeat);
    applyElementPlaybackRate(audioRef.current, storedPrefs.rate);
    applyElementVolume(audioRef.current, storedPrefs.volume, storedPrefs.muted);

    const storedProgress = readProgressMap();
    progressMapRef.current = storedProgress;

    // Offer to resume the episode that was last played, so a reload lands on
    // the right spot instead of the top of a 40-minute lecture.
    //
    // Reads the track parsed above, not `currentTrackRef`: the ref is now
    // updated by an effect that runs *after* this one, and `setCurrentTrack` in
    // this same effect has not rendered yet either, so the ref still held null
    // here and the resume hint never appeared on a fresh load.
    const restored = restoredTrack;
    if (restored) {
      const entry = getEpisodeProgress(storedProgress, restored.courseId, restored.filename);
      setResumeAt(resumeTimeFor(entry));
    }
  }, [applyElementVolume]);

  /**
   * Persists the playhead for the current episode.
   *
   * Called from a throttled interval rather than on every `timeupdate` event:
   * the event fires ~4x/second and each write is a synchronous JSON
   * serialisation of the whole map plus a `localStorage` write on the main
   * thread, which is exactly the kind of work that causes dropouts during
   * playback on a low-end phone.
   */
  useEffect(() => {
    const track = currentTrackRef.current;
    if (!track) return;
    let lastSaved = 0;

    const persist = (force = false) => {
      const audio = audioRef.current;
      if (!audio) return;
      const position = audio.currentTime;
      const total = audio.duration;
      if (!Number.isFinite(position) || position <= 0) return;

      const now = Date.now();
      if (!force && now - lastSaved < 5000) return;
      lastSaved = now;

      const prev = progressMapRef.current;
      const next = recordEpisodeProgress(
        prev,
        track.courseId,
        track.filename,
        position,
        Number.isFinite(total) ? total : 0,
        now
      );
      if (next === prev) return;
      progressMapRef.current = next;
      saveProgressMap(next);
    };

    const interval = setInterval(() => persist(), 5000);

    // A `pagehide`/`visibilitychange` write catches the common "tab closed or
    // phone locked mid-lecture" case that the interval would miss by up to 5s.
    const handleHide = () => persist(true);
    const handleVisibility = () => {
      if (document.hidden) persist(true);
    };
    window.addEventListener('pagehide', handleHide);
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      persist(true);
      clearInterval(interval);
      window.removeEventListener('pagehide', handleHide);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [currentTrack?.courseId, currentTrack?.filename]);

  // Persist speed / volume / mute / repeat whenever one of them changes.
  const prefsHydratedRef = useRef<boolean>(false);
  useEffect(() => {
    // The first pass runs with the defaults and would overwrite the stored
    // preferences with them before the hydration effect above reads the file.
    if (!prefsHydratedRef.current) {
      prefsHydratedRef.current = true;
      return;
    }
    savePlayerPrefs({
      rate: playbackRate,
      volume,
      muted: isMuted,
      repeat: repeatMode
    });
  }, [playbackRate, volume, isMuted, repeatMode]);

  // Save state to localStorage
  useEffect(() => {
    if (currentTrack) {
      try {
        localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({
            currentTrack,
            playlist
          })
        );
      } catch (e) {
        console.warn('Failed to save to localStorage:', e);
      }
    }
  }, [currentTrack, playlist]);

  /**
   * The two fields the polling effect reads.
   *
   * Named separately so the effect can depend on exactly what changes its
   * behaviour. The object identity of `currentTrack` changes on every cache
   * update (the poll itself rebuilds it), so depending on it would restart the
   * interval each time — the timer would never reach its second tick.
   */
  const currentProxyUrl = currentTrack?.proxyUrl;
  const isCurrentCached = currentTrack?.isServerCached ?? false;

  // Dynamic Cache Status Polling for Current Track
  useEffect(() => {
    if (!currentProxyUrl || isCurrentCached) return;

    let isMounted = true;
    let interval: ReturnType<typeof setInterval> | null = null;

    const stopPolling = () => {
      if (interval !== null) {
        clearInterval(interval);
        interval = null;
      }
    };

    const markCached = () => {
      if (!isMounted) return;
      setCurrentTrack((prev) => (prev ? { ...prev, isServerCached: true } : null));
      stopPolling();
    };

    const check = async () => {
      const isCached = await fetchCacheStatus(currentProxyUrl);
      if (isCached) markCached();
    };

    const startPolling = () => {
      if (interval !== null) return;
      interval = setInterval(check, 3000);
    };

    // Suspend polling while the tab is hidden so a long lecture does not keep
    // issuing requests in the background on battery-powered devices.
    const handleVisibility = () => {
      if (document.hidden) {
        stopPolling();
      } else if (!isCurrentCached) {
        startPolling();
      }
    };

    check();
    startPolling();
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      isMounted = false;
      stopPolling();
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [currentProxyUrl, isCurrentCached]);

  // Audio HTML5 element lifecycle & event listeners
  useEffect(() => {
    const audio = new Audio();
    audioRef.current = audio;

    if (currentTrackRef.current) {
      audio.src = currentTrackRef.current.proxyUrl;
    }
    // The element is created once, so this is the only place that can seed the
    // rate for the restored track; without it a browser-initiated load (reload
    // while a lecture was playing) starts at 1.0x.
    applyElementPlaybackRate(audio, playbackRateRef.current);

    const handleTimeUpdate = () => {
      // Both values are NaN/Infinity in the window between assigning `src` (or
      // calling load()) and metadata arriving. `duration` was guarded but
      // `currentTime` was stored verbatim, so the UI could render a NaN
      // position ("00:00" via formatTime, and a progress bar using NaN).
      const time = audio.currentTime;
      const dur = audio.duration;
      setCurrentTime(Number.isFinite(time) ? time : 0);
      setDuration(Number.isFinite(dur) && dur > 0 ? dur : 0);
    };

    const handleEnded = () => {
      setIsPlaying(false);

      // A sleep timer that was armed "at end of episode" stops here, before any
      // auto-advance: the point of the feature is to fall asleep to one talk,
      // not to start the next one an hour later.
      if (sleepTimerRef.current.endOfEpisode) {
        setSleepTimer({ endsAt: null, endOfEpisode: false });
        return;
      }

      const curr = currentTrackRef.current;
      const list = playlistRef.current;

      // Single-episode repeat restarts the same track instead of advancing.
      if (curr && repeatModeRef.current === 'one') {
        const reqId = ++playRequestIdRef.current;
        Promise.all([
          getOptimalMediaRoute(curr.proxyUrl, curr.url),
          fetchCacheStatus(curr.proxyUrl)
        ]).then(([routeRes, isCached]) => {
          if (!isMountedRef.current || reqId !== playRequestIdRef.current) return;
          setCurrentTrack({ ...curr, activeRoute: routeRes.route, isServerCached: isCached });
          if (audioRef.current) {
            audioRef.current.src = routeRes.activeUrl;
            applyElementPlaybackRate(audioRef.current, playbackRateRef.current);
            audioRef.current.load();
            audioRef.current
              .play()
              .then(() => setIsPlaying(true))
              .catch(() => setIsPlaying(false));
          }
        });
        return;
      }

      if (curr && list.length > 0) {
        // Resolve the next episode by index VALUE rather than by array
        // position, so a playlist whose indices are not contiguous (a filtered
        // list) still advances to the intended episode.
        const nextTrack =
          list.find((t) => t.index === curr.index + 1) ?? list[curr.index + 1];
        // "No repeat" stops at the end of the playlist; repeat-all wraps.
        const wrapped =
          !nextTrack && repeatModeRef.current === 'all' && list.length > 1
            ? list.find((t) => t.index === 0) ?? list[0]
            : null;
        const target = nextTrack ?? wrapped;
        if (target) {
          const reqId = ++playRequestIdRef.current;
          triggerBackgroundServerCache(target.proxyUrl);

          Promise.all([
            getOptimalMediaRoute(target.proxyUrl, target.url),
            fetchCacheStatus(target.proxyUrl)
          ]).then(([routeRes, isCached]) => {
            if (!isMountedRef.current || reqId !== playRequestIdRef.current) return;
            const updatedTrack: PlayingTrack = {
              ...target,
              activeRoute: routeRes.route,
              isServerCached: isCached
            };
            setCurrentTrack(updatedTrack);

            if (audioRef.current) {
              audioRef.current.src = routeRes.activeUrl;
              applyElementPlaybackRate(audioRef.current, playbackRateRef.current);
              audioRef.current.load();
              audioRef.current
                .play()
                .then(() => setIsPlaying(true))
                .catch((err) => {
                  console.warn('Auto-play next playback error:', err);
                  setIsPlaying(false);
                });
            }
          });
        }
      }
    };

    audio.addEventListener('timeupdate', handleTimeUpdate);    audio.addEventListener('loadedmetadata', handleTimeUpdate);
    audio.addEventListener('ended', handleEnded);

    return () => {
      audio.removeEventListener('timeupdate', handleTimeUpdate);
      audio.removeEventListener('loadedmetadata', handleTimeUpdate);
      audio.removeEventListener('ended', handleEnded);
      audio.pause();
      // Clearing src alone does not reliably abort the in-flight media request;
      // removing the attribute and re-loading releases the network stream.
      audio.removeAttribute('src');
      try {
        audio.load();
      } catch {}
      audioRef.current = null;
    };
  }, []);

  const playTrack = useCallback((
    courseTitle: string,
    courseId: number,
    tracks: { filename: string; proxyUrl: string; url: string; index: number }[],
    trackIndex: number,
    startAt?: number
  ) => {
    // Preserve the caller's `index` instead of overwriting it with the array
    // position. The two coincide only while callers always pass the unfiltered
    // list; a filtered list (which CourseDetail already builds for the volume /
    // search filters) would otherwise store shifted indices and "next episode"
    // would silently play the wrong episode. Falls back to the position only
    // when a caller supplies no index at all.
    const formattedPlaylist: PlayingTrack[] = tracks.map((t, idx) => ({
      courseId,
      courseTitle,
      filename: t.filename,
      proxyUrl: t.proxyUrl,
      url: t.url,
      index: typeof t.index === 'number' ? t.index : idx
    }));

    // Look the track up by its index value, matching how playNext/playPrev and
    // the highlight resolve it, rather than assuming index === position.
    const targetTrack =
      formattedPlaylist.find((t) => t.index === trackIndex) ?? formattedPlaylist[trackIndex];
    if (!targetTrack || !audioRef.current) return;

    setIsExpanded(true);
    setPlaylist(formattedPlaylist);

    // Resolve where to start: an explicit `startAt` (used by the "continue
    // listening" card and by deep links) wins; otherwise resume the stored
    // position of that episode when it is worth resuming.
    const stored = getEpisodeProgress(progressMapRef.current, courseId, targetTrack.filename);
    const resumePoint = typeof startAt === 'number' && startAt > 0 ? startAt : resumeTimeFor(stored);
    setResumeAt(resumePoint);

    const reqId = ++playRequestIdRef.current;

    // Initial cache status check & dual-path speed evaluation
    Promise.all([
      getOptimalMediaRoute(targetTrack.proxyUrl, targetTrack.url),
      fetchCacheStatus(targetTrack.proxyUrl)
    ]).then(([routeRes, isCached]) => {
      if (!isMountedRef.current || reqId !== playRequestIdRef.current) return;
      const updatedTrack: PlayingTrack = {
        ...targetTrack,
        activeRoute: routeRes.route,
        isServerCached: isCached
      };
      setCurrentTrack(updatedTrack);

      if (audioRef.current) {
        audioRef.current.src = routeRes.activeUrl;
        applyElementPlaybackRate(audioRef.current, playbackRateRef.current);
        applyElementVolume(audioRef.current, volume, isMuted);
        audioRef.current.load();

        // Seeking before metadata has loaded either throws or is discarded by
        // the browser, so apply the resume point once the element knows its
        // timeline. `loadedmetadata` is guaranteed to fire after load() here.
        if (resumePoint > 0) {
          const audio = audioRef.current;
          const seekOnce = () => {
            audio.removeEventListener('loadedmetadata', seekOnce);
            try {
              audio.currentTime = resumePoint;
              setCurrentTime(resumePoint);
            } catch {}
          };
          audio.addEventListener('loadedmetadata', seekOnce);
        }

        audioRef.current
          .play()
          .then(() => setIsPlaying(true))
          .catch((err) => {
            console.warn('Playback error:', err);
            setIsPlaying(false);
          });
      }
    });
  }, [volume, isMuted, applyElementVolume]);

  const togglePlay = useCallback(() => {
    if (!audioRef.current || !currentTrack) return;
    if (isPlaying) {
      audioRef.current.pause();
      setIsPlaying(false);
    } else {
      if (!audioRef.current.src) {
        audioRef.current.src = currentTrack.proxyUrl;
        // Assigning `src` runs the load algorithm, which resets the rate; a
        // paused track that was never started reaches this branch and would
        // otherwise play at 1.0x.
        applyElementPlaybackRate(audioRef.current, playbackRateRef.current);
      }
      // Always trigger background cache on play
      triggerBackgroundServerCache(currentTrack.proxyUrl);

      audioRef.current
        .play()
        .then(() => setIsPlaying(true))
        .catch(() => setIsPlaying(false));
    }
  }, [currentTrack, isPlaying]);

  const playNext = useCallback(() => {
    if (!currentTrack || playlist.length === 0) return;
    const nextIdx = currentTrack.index + 1;
    if (nextIdx < playlist.length) {
      playTrack(currentTrack.courseTitle, currentTrack.courseId, playlist, nextIdx);
    }
  }, [currentTrack, playlist, playTrack]);

  const playPrev = useCallback(() => {
    if (!currentTrack || playlist.length === 0) return;
    const prevIdx = currentTrack.index - 1;
    if (prevIdx >= 0) {
      playTrack(currentTrack.courseTitle, currentTrack.courseId, playlist, prevIdx);
    }
  }, [currentTrack, playlist, playTrack]);

  // MediaSession API Integration for Lock Screen & Native Notification Controls (Chrome, Safari, Firefox)
  useEffect(() => {
    if (typeof window === 'undefined' || !('mediaSession' in navigator)) return;

    if (currentTrack) {
      try {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: currentTrack.filename.replace(/\.[^/.]+$/, ''),
          artist: '玅境長老',
          album: currentTrack.courseTitle
        });
        navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused';
      } catch {}
    }
  }, [currentTrack, isPlaying]);

  useEffect(() => {
    if (typeof window === 'undefined' || !('mediaSession' in navigator)) return;

    try {
      navigator.mediaSession.setActionHandler('play', () => {
        if (audioRef.current) {
          audioRef.current.play().then(() => setIsPlaying(true)).catch(() => {});
        }
      });
      navigator.mediaSession.setActionHandler('pause', () => {
        if (audioRef.current) {
          audioRef.current.pause();
          setIsPlaying(false);
        }
      });
      navigator.mediaSession.setActionHandler('previoustrack', () => {
        playPrev();
      });
      navigator.mediaSession.setActionHandler('nexttrack', () => {
        playNext();
      });
      navigator.mediaSession.setActionHandler('seekto', (details) => {
        if (details.seekTime !== undefined && audioRef.current) {
          audioRef.current.currentTime = details.seekTime;
          setCurrentTime(details.seekTime);
        }
      });
    } catch {}
  }, [playNext, playPrev]);

  const seekTo = useCallback((time: number) => {
    if (audioRef.current) {
      audioRef.current.currentTime = time;
      setCurrentTime(time);
    }
  }, []);

  const seekRelative = useCallback((seconds: number) => {
    const audio = audioRef.current;
    if (audio) {
      // `duration` is NaN until metadata loads (and Infinity for a stream). The
      // old `Math.min(audio.duration || 0, ...)` coerced both to 0, so pressing
      // the skip key before metadata arrived snapped playback to the very start
      // instead of moving relative to the current position. Only clamp against a
      // real finite duration.
      const duration = audio.duration;
      const upperBound = Number.isFinite(duration) && duration > 0 ? duration : Infinity;
      const newTime = Math.max(0, Math.min(upperBound, audio.currentTime + seconds));
      audio.currentTime = newTime;
      setCurrentTime(newTime);
    }
  }, []);

  const setRate = useCallback((rate: number) => {
    setPlaybackRate(rate);
    // Both attributes, so a later load() (a track change, auto-advance, or a
    // browser-initiated reload) keeps the chosen speed instead of dropping
    // back to defaultPlaybackRate's 1.0 default.
    applyElementPlaybackRate(audioRef.current, rate);
  }, []);

  const setVol = useCallback((vol: number) => {
    const clamped = Math.max(0, Math.min(1, vol));
    setVolume(clamped);
    // Dragging the slider to a non-zero value unmutes; and we must also clear
    // the element's `muted` flag, otherwise the UI shows 🔊 while the audio
    // element stays silent (muted was set by toggleMute and never reset).
    const shouldMute = clamped === 0;
    setIsMuted(shouldMute);
    applyElementVolume(audioRef.current, clamped, shouldMute);
  }, [applyElementVolume]);

  const toggleMute = useCallback(() => {
    if (!audioRef.current) return;
    const nextMuted = !isMuted;
    // Keep `muted` and `volume` consistent; the element's own volume is set
    // from this single place so the slider and the audible state cannot diverge.
    applyElementVolume(audioRef.current, volume, nextMuted);
    setIsMuted(nextMuted);
  }, [isMuted, volume, applyElementVolume]);

  const toggleExpanded = useCallback(() => {
    setIsExpanded((prev) => !prev);
  }, []);

  /* ---------------------------------------------------------------- *
   * Sleep timer, repeat mode and resume controls
   * ---------------------------------------------------------------- */

  /**
   * Countdown for a clock-based sleep timer.
   *
   * A single `setTimeout` for the full interval is not enough: laptops and
   * phones throttle timers in background tabs and suspend entirely when the
   * screen locks, so a 90-minute timeout can fire hours late. This ticks once a
   * second while an end time is armed and stops as soon as the deadline passes,
   * which also keeps the displayed remaining time accurate after a wake-up.
   */
  useEffect(() => {
    if (!sleepTimer.endsAt) return;

    let stopped = false;
    const check = () => {
      if (stopped) return;
      if (Date.now() >= (sleepTimer.endsAt as number)) {
        stopped = true;
        audioRef.current?.pause();
        setIsPlaying(false);
        setSleepTimer({ endsAt: null, endOfEpisode: false });
      }
    };

    const interval = setInterval(check, 1000);
    check();

    return () => {
      stopped = true;
      clearInterval(interval);
    };
  }, [sleepTimer.endsAt]);

  const setSleepMinutes = useCallback((minutes: number) => {
    if (!Number.isFinite(minutes) || minutes <= 0) {
      setSleepTimer({ endsAt: null, endOfEpisode: false });
      return;
    }
    // Bounded so a malformed value cannot arm a timer for years.
    const clamped = Math.min(12 * 60, Math.max(1, Math.round(minutes)));
    setSleepTimer({ endsAt: Date.now() + clamped * 60 * 1000, endOfEpisode: false });
  }, []);

  const setSleepEndOfEpisode = useCallback(() => {
    setSleepTimer({ endsAt: null, endOfEpisode: true });
  }, []);

  const cancelSleepTimer = useCallback(() => {
    setSleepTimer({ endsAt: null, endOfEpisode: false });
  }, []);

  const cycleRepeatMode = useCallback(() => {
    setRepeatMode((prev) => computeNextRepeatMode(prev));
  }, []);

  const clearResume = useCallback(() => {
    const track = currentTrackRef.current;
    if (!track) return;
    setResumeAt(0);
    const prev = progressMapRef.current;
    const next = recordEpisodeProgress(prev, track.courseId, track.filename, 0, 0);
    if (next === prev) return;
    progressMapRef.current = next;
    saveProgressMap(next);
  }, []);

  return (
    <AudioContext.Provider
      value={{
        currentTrack,
        playlist,
        isPlaying,
        currentTime,
        duration,
        playbackRate,
        volume,
        isMuted,
        isExpanded,
        resumeAt,
        clearResume,
        repeatMode,
        cycleRepeatMode,
        sleepTimer,
        setSleepMinutes,
        setSleepEndOfEpisode,
        cancelSleepTimer,
        playTrack,
        togglePlay,
        playNext,
        playPrev,
        seekTo,
        seekRelative,
        setRate,
        setVol,
        toggleMute,
        toggleExpanded
      }}
    >
      {children}
    </AudioContext.Provider>
  );
}

export function useAudio() {
  const context = useContext(AudioContext);
  if (!context) {
    throw new Error('useAudio must be used within an AudioProvider');
  }
  return context;
}
