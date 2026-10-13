export type ThemeType = 'dark' | 'light' | 'pine' | 'sandalwood' | 'zen' | 'gruvbox';
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

/**
 * Fields that are present in the shipped catalog but were previously accessed
 * without being declared, which made the optional-chaining in TreeNav look
 * redundant to the type checker and hid genuine null risks.
 */
export interface CourseDatabase {
  generated_at?: string;
  total_courses?: number;
  last_auto_healed_at?: string;
  total_repaired_courses?: number;
  courses: CourseItem[];
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
