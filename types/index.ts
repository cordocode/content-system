export type ContentType = 'blog' | 'linkedin';
export type ContentStatus = 'draft' | 'queued' | 'approved' | 'revision' | 'posted';

export interface Content {
  id: string;
  title: string | null;
  content: string;
  type: ContentType;
  status: ContentStatus;
  version: number;
  posted_date: string | null;
  queue_position: number | null;
  embedding: number[] | null;
  tags: string[] | null;
  style_notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface ConversationThread {
  id: string;
  content_id: string;
  email_thread_id: string;
  current_version: number;
  status: string;
  created_at: string;
}

export interface BlogPost {
  id: string;
  title: string;
  slug: string;
  content: string;
  excerpt: string | null;
  published: boolean;
  published_at: string | null;
  created_at: string;
  updated_at: string;
}