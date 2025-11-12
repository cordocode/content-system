const { createClient } = require('@supabase/supabase-js');
const { google } = require('googleapis');
const Anthropic = require('@anthropic-ai/sdk');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// Set up Gmail auth
const oauth2Client = new google.auth.OAuth2(
  process.env.GMAIL_CLIENT_ID,
  process.env.GMAIL_CLIENT_SECRET,
  'http://localhost:3000/oauth2callback'
);

oauth2Client.setCredentials({
  refresh_token: process.env.GMAIL_REFRESH_TOKEN
});

const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { messageId } = req.body;

    if (!messageId) {
      return res.status(400).json({ error: 'Message ID required' });
    }

    // Get the email message
    const message = await gmail.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'full'
    });

    const headers = message.data.payload.headers;
    const threadId = message.data.threadId;
    const subject = headers.find(h => h.name === 'Subject')?.value || '';
    const from = headers.find(h => h.name === 'From')?.value || '';

    // FILTER: Only process emails from ben@corradoco.com with subject containing "CONTENT" or "content"
    if (!from.includes('ben@corradoco.com')) {
      console.log(`Ignoring email from: ${from}`);
      return res.status(200).json({ 
        message: 'Email ignored - not from ben@corradoco.com' 
      });
    }

    if (!subject.toLowerCase().includes('content')) {
      console.log(`Ignoring email with subject: ${subject}`);
      return res.status(200).json({ 
        message: 'Email ignored - subject does not contain CONTENT' 
      });
    }

    // Get email body
    let body = '';
    if (message.data.payload.body.data) {
      body = Buffer.from(message.data.payload.body.data, 'base64').toString('utf-8');
    } else if (message.data.payload.parts) {
      const textPart = message.data.payload.parts.find(p => p.mimeType === 'text/plain');
      if (textPart && textPart.body.data) {
        body = Buffer.from(textPart.body.data, 'base64').toString('utf-8');
      }
    }

    // Check if this is part of an existing conversation
    const { data: existingThread } = await supabase
      .from('conversation_threads')
      .select('*')
      .eq('email_thread_id', threadId)
      .single();

    if (existingThread) {
      // This is a reply to existing content - handle approval/revision
      return await handleApproval(existingThread, body, res);
    } else {
      // New content request
      return await handleNewContent(body, threadId, res);
    }

  } catch (error) {
    console.error('Email processing error:', error);
    return res.status(500).json({ 
      error: 'Failed to process email',
      details: error.message 
    });
  }
};

async function handleNewContent(input, threadId, res) {
  const systemPrompt = `You are an intelligent content assistant for Ben Corrado, founder of Corrado & Co., a Denver-based automation consulting company.

CONTEXT:
- Ben sends you brain dumps, stories, insights, or quick ideas via email
- Your job is to transform these into polished blog posts and LinkedIn content
- You're part of a content automation system that helps Ben maintain consistent output

BEN'S VOICE & EXPERTISE:
- Automation consultant specializing in n8n, Zapier, custom code workflows
- Works with mid-sized companies (20-100 employees)
- Values efficiency, excellence, systematic approaches
- Writes in a professional but approachable tone - technical when needed, accessible when possible, honest and realistic
- Uses real examples from client work
- Focuses on practical, actionable insights

YOUR TASK:
1. ANALYZE the input to determine what content can legitimately be created from it
2. DO NOT fabricate or stretch content too far beyond what the input supports
3. Generate between 1-5 total pieces based on substance:
   - Minimum: 1 LinkedIn post (always possible)
   - Maximum: 2 blog posts + 3 LinkedIn posts

CONTENT GUIDELINES:
- Blog posts: 800-1200 words, deeper dives, technical depth, real examples
- LinkedIn posts: 75-200 words, conversational, single insight or story, actionable

ASSESSMENT CRITERIA:
- Quick tip/hack = 1 LinkedIn post
- Single story/insight = 1 LinkedIn post or 1 blog
- Detailed case study = 1 blog + 1-2 LinkedIn posts
- Multiple insights = 2-3 LinkedIn posts (different angles)
- Major project/learning = 1-2 blogs + 2-3 LinkedIn posts`;

  const userPrompt = `Input from Ben:
"${input}"

ANALYZE THIS INPUT:
1. How much substance is here?
2. What content can legitimately be created without fabricating?
3. What would provide the most value to Ben's audience?

Generate the appropriate number of pieces (1-5 total, with minimum 1 LinkedIn post).

Return ONLY valid JSON in this format:
{
  "assessment": "Brief explanation of what you decided and why",
  "blog": [
    {
      "title": "...",
      "content": "...",
      "excerpt": "..."
    }
  ],
  "linkedin": [
    { "content": "..." }
  ]
}

Note: blog array can be empty, have 1 item, or 2 items. LinkedIn array must have 1-3 items.`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 5000,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }]
  });

  const generated = JSON.parse(response.content[0].text);

  // Store content in database
  let blogData = [];
  if (generated.blog && generated.blog.length > 0) {
    const blogInserts = generated.blog.map(blog => ({
      title: blog.title,
      content: blog.content,
      type: 'blog',
      status: 'draft',
      tags: ['generated']
    }));

    const { data: blogs } = await supabase
      .from('content_library')
      .insert(blogInserts)
      .select();

    blogData = blogs || [];
  }

  const linkedInInserts = generated.linkedin.map((post, index) => ({
    title: `LinkedIn Post ${index + 1}`,
    content: post.content,
    type: 'linkedin',
    status: 'draft',
    tags: ['generated']
  }));

  const { data: linkedInData } = await supabase
    .from('content_library')
    .insert(linkedInInserts)
    .select();

  // Create conversation thread for first piece of content
  const firstContentId = blogData.length > 0 ? blogData[0].id : linkedInData[0].id;
  
  await supabase
    .from('conversation_threads')
    .insert({
      content_id: firstContentId,
      email_thread_id: threadId,
      status: 'pending_approval'
    });

  // Send approval email
  await sendApprovalEmail(generated, blogData, linkedInData);

  return res.status(200).json({
    success: true,
    message: `Generated ${blogData.length} blog(s) and ${linkedInData.length} LinkedIn post(s)`,
    assessment: generated.assessment
  });
}

async function handleApproval(thread, emailBody, res) {
  // Parse approval response using Claude
  const prompt = `Analyze this email response to a content approval request.

Email body: "${emailBody}"

Determine the user's intent and return JSON:
{
  "action": "approve|revise|swap|skip",
  "feedback": "specific changes requested if action is revise, otherwise null",
  "contentReference": "B1, L1, L2, etc if mentioned, otherwise null"
}`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 500,
    messages: [{ role: 'user', content: prompt }]
  });

  const parsed = JSON.parse(response.content[0].text);

  // Handle based on action
  if (parsed.action === 'approve') {
    await supabase
      .from('content_library')
      .update({ status: 'approved' })
      .eq('id', thread.content_id);
    
    // Add to queue
    const { data: content } = await supabase
      .from('content_library')
      .select('type')
      .eq('id', thread.content_id)
      .single();
    
    const queue = require('../../lib/queue');
    await queue.addToQueue(thread.content_id, content.type);
  }

  return res.status(200).json({
    success: true,
    action: parsed.action
  });
}

async function sendApprovalEmail(generated, blogData, linkedInData) {
  let emailContent = 'From: ben@corradoco.com\n';
  emailContent += 'To: ben@corradoco.com\n';
  emailContent += 'Subject: [Content Assistant] New content for approval\n\n';
  emailContent += `Assessment: ${generated.assessment}\n\n`;
  
  if (blogData.length > 0) {
    emailContent += '📝 BLOG POSTS:\n\n';
    blogData.forEach((blog, i) => {
      emailContent += `[B${i + 1}] ${blog.title}\n`;
      emailContent += `${blog.content.substring(0, 200)}...\n\n`;
    });
  }
  
  emailContent += '💼 LINKEDIN POSTS:\n\n';
  linkedInData.forEach((post, i) => {
    emailContent += `[L${i + 1}]\n${post.content}\n\n`;
  });
  
  emailContent += 'Reply with "approved" to queue all content, or provide specific feedback.';

  const encodedEmail = Buffer.from(emailContent)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  await gmail.users.messages.send({
    userId: 'me',
    requestBody: {
      raw: encodedEmail
    }
  });
}