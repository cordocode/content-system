-- Content Automation System - Database Tables
-- Run these commands in order in Supabase SQL Editor

-- Enable vector extension for future semantic search
CREATE EXTENSION IF NOT EXISTS vector;

-- Main content storage
CREATE TABLE content_library (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  title text,
  content text NOT NULL,
  type varchar(20) CHECK (type IN ('blog', 'linkedin')),
  status varchar(20) DEFAULT 'draft' CHECK (status IN ('draft', 'queued', 'approved', 'revision', 'posted', 'failed')),
  version integer DEFAULT 1,
  posted_date timestamptz,
  queue_position integer,
  embedding vector(1536),
  tags text[],
  style_notes text,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL
);

CREATE INDEX idx_content_type_status ON content_library(type, status);
CREATE INDEX idx_queue_position ON content_library(type, queue_position) WHERE queue_position IS NOT NULL;
CREATE INDEX ON content_library USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- Email conversation tracking
CREATE TABLE conversation_threads (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  content_id uuid REFERENCES content_library(id) ON DELETE CASCADE,
  email_thread_id text,
  current_version integer DEFAULT 1,
  status varchar(20),
  created_at timestamptz DEFAULT now() NOT NULL
);

CREATE INDEX idx_thread_content ON conversation_threads(content_id);
CREATE INDEX idx_thread_email ON conversation_threads(email_thread_id);

-- Content revision history
CREATE TABLE content_versions (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  content_id uuid REFERENCES content_library(id) ON DELETE CASCADE,
  thread_id uuid REFERENCES conversation_threads(id) ON DELETE CASCADE,
  version_number integer,
  content text,
  feedback text,
  created_at timestamptz DEFAULT now() NOT NULL
);

CREATE INDEX idx_version_content ON content_versions(content_id);

-- Assistant memory (future feature)
CREATE TABLE assistant_memory (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  memory_type varchar(50),
  content jsonb,
  valid_from timestamptz DEFAULT now() NOT NULL,
  valid_until timestamptz
);

CREATE INDEX idx_memory_type ON assistant_memory(memory_type);

-- Helper function: shift queue positions after publishing
CREATE OR REPLACE FUNCTION shift_queue_positions(
  content_type varchar(20),
  from_position integer
)
RETURNS void
LANGUAGE sql
AS $$
  UPDATE content_library
  SET queue_position = queue_position - 1
  WHERE type = content_type 
  AND queue_position > from_position;
$$;

-- Helper function: semantic search (future feature)
CREATE OR REPLACE FUNCTION match_content(
  query_embedding vector(1536),
  match_threshold float,
  match_count int
)
RETURNS TABLE (
  id uuid,
  title text,
  content text,
  type varchar(20),
  similarity float
)
LANGUAGE sql STABLE
AS $$
  SELECT
    id,
    title,
    content,
    type,
    1 - (embedding <=> query_embedding) as similarity
  FROM content_library
  WHERE 1 - (embedding <=> query_embedding) > match_threshold
  ORDER BY embedding <=> query_embedding
  LIMIT match_count;
$$;

-- NOTE: blog_posts table already exists from website - DO NOT CREATE
-- Content system writes to it but does not manage its schema