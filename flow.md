# Content Automation System - Data Flow Summary

## System Overview
Email-based content automation that generates blog posts and LinkedIn content from brain dumps, manages approval loops, and publishes on a schedule using a position-based queue system.

---

## Core Data Flow

### 1. EMAIL ARRIVES (Every 5 minutes)
**Trigger:** Vercel cron job  
**File:** `api/email/poll.js`

**Process:**
1. Gmail API polls for unread emails matching: `from:ben@corradoco.com subject:CONTENT`
2. Checks if email is part of existing thread (approval response) or new content request
3. Routes to appropriate handler

**Database:**
- Queries: `conversation_threads` (check for existing thread)
- Uses: `lib/email.js` for Gmail operations

---

### 2A. NEW CONTENT GENERATION
**File:** `api/email/poll.js` → `handleNewContent()`

**Process:**
1. Claude analyzes input and decides how many pieces to create (1-5 total)
2. Generates content with assessment explaining the decision
3. Stores in database with status='draft'
4. Creates conversation thread for first piece
5. Sends approval email back to user

**Expected Output Format:**
```json
{
  "assessment": "Single tactical insight, creating 1 LinkedIn post",
  "blog": [
    {
      "title": "How We Saved...",
      "content": "Full 800-1200 word post...",
      "excerpt": "First 200 chars..."
    }
  ],
  "linkedin": [
    { "content": "75-200 word post with hook..." }
  ]
}
```

**Database:**
- Inserts: `content_library` (all generated pieces, status='draft')
- Inserts: `conversation_threads` (links first content piece to email thread)
- Uses: `lib/email.js` to send approval email

**Email Format:**
```
Subject: [Content Assistant] New content for approval

Assessment: [Claude's decision reasoning]

═══════════════════════════════════════
📝 BLOG POSTS:

[B1] Title Here
─────────────────────────────────────
Full content...
─────────────────────────────────────

💼 LINKEDIN POSTS:

[L1]
─────────────────────────────────────
Post content...
─────────────────────────────────────

═══════════════════════════════════════
REPLY OPTIONS:
• "approved" - Queue all content
• "B1 - make it shorter" - Request changes
```

---

### 2B. APPROVAL RESPONSE
**File:** `api/email/poll.js` → `handleApproval()`

**Process:**
1. Claude parses user's email response
2. Determines action: approve, revise, swap, or skip
3. Updates content status accordingly

**Expected Actions:**
- **"approved"** → status='approved', assigns queue_position, calls `lib/queue.js`
- **"B1 - trim intro"** → status='revision', generates new version with feedback
- **"B1 next"** → swaps queue positions using `lib/queue.js`
- **"skip"** → removes from queue

**Database:**
- Updates: `content_library` (status, queue_position)
- Inserts: `content_versions` (if revision requested)
- Uses: `lib/queue.js` for queue operations
- Uses: `lib/email.js` to send revision or confirmation

**Revision Flow:**
```
User: "B1 - trim intro"
↓
Claude analyzes original + feedback
↓
Generates revised version
↓
Stores in content_versions
↓
Updates content_library.content
↓
Sends revised version for approval
```

---

### 3. MONDAY LINEUP (Monday 8am)
**Trigger:** Vercel cron job  
**File:** `api/assistant/lineup.js`

**Process:**
1. Queries next 4 pieces from queue (1 blog, 3 LinkedIn)
2. Shows preview with "next in queue" context
3. Sends approval email

**Database:**
- Queries: `content_library` WHERE status='approved' AND queue_position IN (1,2,3)
- Uses: `lib/queue.js` to get queue contents
- Uses: `lib/email.js` to send lineup

**Email Format:**
```
Subject: [Content Assistant] Weekly Content Lineup

📝 BLOG (Monday): [B1]
Title: "How We Saved Fleet 400 Hours..."
[Preview...]
→ Next: "3 Automation Truths"

💼 LINKEDIN (Tuesday): [L1]
"Stop writing prompts like..."
→ Next: "My favorite debugging trick"

REPLY OPTIONS:
• "All approved" - Lock in all 4 pieces
• "B1 next" - Skip to next blog
• "L2 - trim intro" - Request changes
```

---

### 4. BLOG PUBLISHING (Monday 10am)
**Trigger:** Vercel cron job  
**File:** `api/publish/blog.js`

**Process:**
1. Gets content at queue_position=1 with status='approved'
2. Generates URL slug from title
3. **Writes directly to blog_posts table** (shared with website)
4. Updates content_library to status='posted' or 'failed'
5. Shifts remaining queue positions up

**Database:**
- Queries: `content_library` WHERE type='blog' AND queue_position=1 AND status='approved'
- Inserts: `blog_posts` (published content for website)
- Updates: `content_library` (status='posted' or 'failed', queue_position=NULL)
- Calls: `shift_queue_positions('blog', 1)` function
- Uses: `lib/email.js` to send success/failure notification

**Success Flow:**
```
Get content at position 1
↓
Generate slug: "how-we-saved-fleet-400-hours"
↓
INSERT into blog_posts (published=true)
↓
UPDATE content_library (status='posted', queue_position=NULL)
↓
Run shift_queue_positions() - moves position 2→1, 3→2, etc.
```

**Failure Flow:**
```
Publishing fails
↓
UPDATE content_library (status='failed', queue_position=NULL)
↓
Run shift_queue_positions() - next item becomes position 1
↓
Send email notification with error details
```

---

### 5. LINKEDIN PUBLISHING (Tue/Thu/Sat 9am)
**Trigger:** Vercel cron job (3 times per week)  
**File:** `api/publish/linkedin.js`

**Process:**
1. Gets content at queue_position=1 with status='approved'
2. Calls LinkedIn API to post content
3. Updates content_library to status='posted' or 'failed'
4. Shifts remaining queue positions up

**Database:**
- Queries: `content_library` WHERE type='linkedin' AND queue_position=1 AND status='approved'
- Updates: `content_library` (status='posted' or 'failed', queue_position=NULL)
- Calls: `shift_queue_positions('linkedin', 1)` function
- Uses: `lib/email.js` to send success/failure notification

**LinkedIn API Flow:**
```
GET /v2/userinfo (get author URN)
↓
POST /v2/ugcPosts with content
↓
If success: status='posted'
If failure: status='failed'
↓
Shift queue positions up
```

---

### 6. GOOGLE SHEETS SYNC (Every 30 minutes)
**Trigger:** Vercel cron job  
**File:** `api/sheets/sync-status.js`

**Process:**
1. Gets all content from content_library
2. Formats into rows for Google Sheets
3. Clears existing data (except header)
4. Writes all content status

**Database:**
- Queries: `content_library` ORDER BY created_at DESC
- Uses: `lib/sheets.js` for Google Sheets operations

**Sheet Format:**
```
ID | TYPE | TITLE | PREVIEW | STATUS | QUEUE_POS | CREATED | POSTED | TAGS
```

---

## Queue Management System

**Files:** `lib/queue.js`

**Key Functions:**
- `addToQueue(contentId, type)` - Adds to end of queue
- `getQueue(type, limit)` - Gets queue contents
- `swapWithNext(contentId, type)` - Swaps with next item
- `moveToPosition(contentId, type, position)` - Moves to specific position
- `removeFromQueue(contentId)` - Removes from queue
- `getQueueHealth()` - Checks if queues are healthy (enough content)

**Position System:**
- Content in queue has queue_position: 1, 2, 3, etc.
- Publishing always pulls from position 1
- After publishing, positions shift: 2→1, 3→2, 4→3, etc.
- Failed content is removed (queue_position=NULL) and positions shift

---

## Status Lifecycle

```
draft → approved → posted     (successful path)
  ↓        ↓         ↓
  ↓        ↓      failed      (publishing error)
  ↓        ↓
  ↓     revision → approved   (changes requested)
  ↓
queued (deprecated - use approved + queue_position instead)
```

---

## File Reference Map

### API Endpoints
- `api/email/poll.js` - Email polling (every 5 min)
- `api/assistant/lineup.js` - Monday lineup (Monday 8am)
- `api/publish/blog.js` - Blog publishing (Monday 10am)
- `api/publish/linkedin.js` - LinkedIn publishing (Tue/Thu/Sat 9am)
- `api/sheets/sync-status.js` - Sheet sync (every 30 min)

### Libraries
- `lib/queue.js` - Queue management utilities
- `lib/email.js` - Gmail sending utilities
- `lib/sheets.js` - Google Sheets read/write

### Configuration
- `vercel.json` - Cron job definitions
- `package.json` - Dependencies
- `.gitignore` - Git exclusions

---

## Environment Variables Required

```env
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_SERVICE_KEY=eyJxxx...
ANTHROPIC_API_KEY=sk-ant-xxx...
GMAIL_CLIENT_ID=xxx.apps.googleusercontent.com
GMAIL_CLIENT_SECRET=xxx
GMAIL_REFRESH_TOKEN=1//xxx
LINKEDIN_ACCESS_TOKEN=xxx
GOOGLE_SERVICE_ACCOUNT_BASE64=xxx
GOOGLE_SHEET_ID=xxx
CRON_SECRET=xxx
ENABLE_PUBLISHING=true
```

---

## Critical Notes

1. **Shared Database**: blog_posts table is owned by website, content system writes to it
2. **Cascade Deletes**: conversation_threads and content_versions delete automatically with content
3. **Gmail Polling**: No webhooks, cron polls every 5 minutes
4. **Queue Positions**: NULL = not queued, 1 = next to publish
5. **Failed Status**: New status added to handle publishing errors without blocking queue
6. **DRY RUN Mode**: Set ENABLE_PUBLISHING=false to preview without actual publishing

---

## Testing Checklist

- [ ] Send email with "CONTENT" subject → generates content
- [ ] Reply "approved" → adds to queue
- [ ] Reply with feedback → creates revision
- [ ] Monday lineup email arrives at 8am
- [ ] Blog publishes to website at 10am Monday
- [ ] LinkedIn posts at 9am Tue/Thu/Sat
- [ ] Sheets sync updates every 30 min
- [ ] Failed publishing marks content as 'failed' and shifts queue