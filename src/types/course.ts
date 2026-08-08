export type ThemeType = 'dark' | 'light' | 'pine' | 'sandalwood' | 'zen';
export type FontSizeScale = 'small' | 'normal' | 'large' | 'xlarge';

export interface PdfItem {
  num?: number;
  filename: string;
  url: string;
}

export interface CourseItem {
  id: number;
  name: string;
  main_menu: string;
  main_menu_title: string;
  sub_menu: string;
  sub_menu_title: string;
  topic: string;
  topic_title: string;
  location: string;
  time: string;
  total_episodes: number;
  audio_path: string | null;
  video_path: string | null;
  lecture_path: string | null;
  poster_path: string | null;
  comment: string | null;
  pdfs: PdfItem[];
}

export interface RemoteFile {
  name: string;
  type: string; // 'file' | 'dir'
  size?: number;
  mtime?: string;
}

export interface TreeNode {
  id: string;
  label: string;
  type: 'menu' | 'submenu' | 'topic' | 'course';
  children?: TreeNode[];
  course?: CourseItem;
  count?: number;
}
