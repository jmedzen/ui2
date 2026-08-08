'use client';

import React, { createContext, useContext, useState, useRef, useEffect } from 'react';

export interface PlayingTrack {
  courseId: number;
  courseTitle: string;
  filename: string;
  proxyUrl: string;
  url: string;
  index: number;
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

  useEffect(() => {
    const audio = new Audio();
    audioRef.current = audio;

    const handleTimeUpdate = () => {
      setCurrentTime(audio.currentTime);
      setDuration(audio.duration || 0);
    };

    const handleEnded = () => {
      setIsPlaying(false);
      setCurrentTrack((prevTrack) => {
        if (!prevTrack) return null;
        setPlaylist((currentPlaylist) => {
          const nextIdx = prevTrack.index + 1;
          if (nextIdx < currentPlaylist.length) {
            const nextTrack = currentPlaylist[nextIdx];
            audio.src = nextTrack.proxyUrl;
            audio.play().then(() => setIsPlaying(true)).catch(console.warn);
            return currentPlaylist;
          }
          return currentPlaylist;
        });
        return prevTrack;
      });
    };

    audio.addEventListener('timeupdate', handleTimeUpdate);
    audio.addEventListener('loadedmetadata', handleTimeUpdate);
    audio.addEventListener('ended', handleEnded);

    return () => {
      audio.removeEventListener('timeupdate', handleTimeUpdate);
      audio.removeEventListener('loadedmetadata', handleTimeUpdate);
      audio.removeEventListener('ended', handleEnded);
      audio.pause();
    };
  }, []);

  const playTrack = (
    courseTitle: string,
    courseId: number,
    tracks: { filename: string; proxyUrl: string; url: string; index: number }[],
    trackIndex: number
  ) => {
    const formattedPlaylist: PlayingTrack[] = tracks.map((t, idx) => ({
      courseId,
      courseTitle,
      filename: t.filename,
      proxyUrl: t.proxyUrl,
      url: t.url,
      index: idx
    }));

    const targetTrack = formattedPlaylist[trackIndex];
    if (!targetTrack || !audioRef.current) return;

    setPlaylist(formattedPlaylist);
    setCurrentTrack(targetTrack);

    audioRef.current.src = targetTrack.proxyUrl;
    audioRef.current.playbackRate = playbackRate;
    audioRef.current.volume = isMuted ? 0 : volume;
    audioRef.current.load();

    audioRef.current
      .play()
      .then(() => setIsPlaying(true))
      .catch((err) => {
        console.warn('Playback error:', err);
        setIsPlaying(false);
      });
  };

  const togglePlay = () => {
    if (!audioRef.current || !currentTrack) return;
    if (isPlaying) {
      audioRef.current.pause();
      setIsPlaying(false);
    } else {
      if (!audioRef.current.src) {
        audioRef.current.src = currentTrack.proxyUrl;
      }
      audioRef.current
        .play()
        .then(() => setIsPlaying(true))
        .catch(() => setIsPlaying(false));
    }
  };

  const playNext = () => {
    if (!currentTrack || playlist.length === 0) return;
    const nextIdx = currentTrack.index + 1;
    if (nextIdx < playlist.length) {
      playTrack(currentTrack.courseTitle, currentTrack.courseId, playlist, nextIdx);
    }
  };

  const playPrev = () => {
    if (!currentTrack || playlist.length === 0) return;
    const prevIdx = currentTrack.index - 1;
    if (prevIdx >= 0) {
      playTrack(currentTrack.courseTitle, currentTrack.courseId, playlist, prevIdx);
    }
  };

  const seekTo = (time: number) => {
    if (audioRef.current) {
      audioRef.current.currentTime = time;
      setCurrentTime(time);
    }
  };

  const seekRelative = (seconds: number) => {
    if (audioRef.current) {
      const newTime = Math.max(0, Math.min(audioRef.current.duration || 0, audioRef.current.currentTime + seconds));
      audioRef.current.currentTime = newTime;
      setCurrentTime(newTime);
    }
  };

  const setRate = (rate: number) => {
    setPlaybackRate(rate);
    if (audioRef.current) {
      audioRef.current.playbackRate = rate;
    }
  };

  const setVol = (vol: number) => {
    setVolume(vol);
    setIsMuted(vol === 0);
    if (audioRef.current) {
      audioRef.current.volume = vol;
    }
  };

  const toggleMute = () => {
    if (audioRef.current) {
      audioRef.current.muted = !isMuted;
      setIsMuted(!isMuted);
    }
  };

  const toggleExpanded = () => {
    setIsExpanded(!isExpanded);
  };

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
