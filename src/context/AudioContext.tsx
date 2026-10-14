'use client';

import React, { createContext, useContext, useState, useRef, useEffect, useCallback } from 'react';
import { triggerBackgroundServerCache, getOptimalMediaRoute, fetchCacheStatus } from '@/lib/speedTester';

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
  playTrack: (courseTitle: string, courseId: number, tracks: { filename: string; proxyUrl: string; url: string; index: number }[], trackIndex: number) => void;
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

  const playlistRef = useRef<PlayingTrack[]>(playlist);
  playlistRef.current = playlist;

  const currentTrackRef = useRef<PlayingTrack | null>(currentTrack);
  currentTrackRef.current = currentTrack;

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

  // Restore last played track from localStorage on mount
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed && parsed.currentTrack) {
          setCurrentTrack(parsed.currentTrack);
          if (parsed.playlist) setPlaylist(parsed.playlist);
        }
      }
    } catch (e) {
      console.warn('Failed to load last played track from localStorage:', e);
    }
  }, []);

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

  // Dynamic Cache Status Polling for Current Track
  useEffect(() => {
    if (!currentTrack || currentTrack.isServerCached) return;

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
      const isCached = await fetchCacheStatus(currentTrack.proxyUrl);
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
      } else if (!currentTrack.isServerCached) {
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
  }, [currentTrack?.proxyUrl, currentTrack?.isServerCached]);

  // Audio HTML5 element lifecycle & event listeners
  useEffect(() => {
    const audio = new Audio();
    audioRef.current = audio;

    if (currentTrackRef.current) {
      audio.src = currentTrackRef.current.proxyUrl;
    }

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
      const curr = currentTrackRef.current;
      const list = playlistRef.current;
      if (curr && list.length > 0) {
        // Resolve the next episode by index VALUE rather than by array
        // position, so a playlist whose indices are not contiguous (a filtered
        // list) still advances to the intended episode.
        const nextTrack =
          list.find((t) => t.index === curr.index + 1) ?? list[curr.index + 1];
        if (nextTrack) {
          const reqId = ++playRequestIdRef.current;
          triggerBackgroundServerCache(nextTrack.proxyUrl);

          Promise.all([
            getOptimalMediaRoute(nextTrack.proxyUrl, nextTrack.url),
            fetchCacheStatus(nextTrack.proxyUrl)
          ]).then(([routeRes, isCached]) => {
            if (!isMountedRef.current || reqId !== playRequestIdRef.current) return;
            const updatedTrack: PlayingTrack = {
              ...nextTrack,
              activeRoute: routeRes.route,
              isServerCached: isCached
            };
            setCurrentTrack(updatedTrack);

            if (audioRef.current) {
              audioRef.current.src = routeRes.activeUrl;
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
    trackIndex: number
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
        audioRef.current.playbackRate = playbackRate;
        applyElementVolume(audioRef.current, volume, isMuted);
        audioRef.current.load();

        audioRef.current
          .play()
          .then(() => setIsPlaying(true))
          .catch((err) => {
            console.warn('Playback error:', err);
            setIsPlaying(false);
          });
      }
    });
  }, [playbackRate, volume, isMuted, applyElementVolume]);

  const togglePlay = useCallback(() => {
    if (!audioRef.current || !currentTrack) return;
    if (isPlaying) {
      audioRef.current.pause();
      setIsPlaying(false);
    } else {
      if (!audioRef.current.src) {
        audioRef.current.src = currentTrack.proxyUrl;
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
    if (audioRef.current) {
      audioRef.current.playbackRate = rate;
    }
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
