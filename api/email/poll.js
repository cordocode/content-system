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

// Get or create the "Content" label
async function getOrCreateContentLabel() {
  try {
    const response = await gmail.users.labels.list({
      userId: 'me'
    });
    
    const existingLabel = response.data.labels?.find(
      label => label.name.toLowerCase() === 'content'
    );
    
    if (existingLabel) {
      return existingLabel.id;
    }
    
    const createResponse = await gmail.users.labels.create({
      userId: 'me',
      requestBody: {
        name: 'Content',
        labelListVisibility: 'labelShow',
        messageListVisibility: 'show'
      }
    });
    
    console.log('✅ Created "Content" label');
    return createResponse.data.id;
  } catch (error) {
    console.error('Error managing Content label:', error);
    throw error;
  }
}

module.exports = async (req, res) => {
  // Verify cron secret for security
  const authHeader = req.headers.authorization || req.headers.Authorization;
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const response = await gmail.users.messages.list({
      userId: 'me',
      q: `from:ben@corradoco.com subject:CONTENT is:unread`,
      maxResults: 10
    });

    const messages = response.data.messages || [];
    
    if (messages.length === 0) {
      console.log('No new CONTENT emails found');
      return res.status(200).json({ 
        message: 'No new emails',
        checked: true 
      });
    }

    console.log(`Found ${messages.length} new CONTENT email(s)`);
    
    const contentLabelId = await getOrCreateContentLabel();
    
    for (const message of messages) {
      await processEmail(message.id, contentLabelId);
    }

    return res.status(200).json({ 
      success: true,
      processed: messages.length 
    });

  } catch (error) {
    console.error('Gmail polling error:', error);
    return res.status(500).json({ 
      error: 'Failed to poll Gmail',
      details: error.message 
    });
  }
};

async function processEmail(messageId, contentLabelId) {
  try {
    const message = await gmail.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'full'
    });

    const headers = message.data.payload.headers;
    const threadId = message.data.threadId;
    const subject = headers.find(h => h.name === 'Subject')?.value || '';

    if (!subject.toLowerCase().includes('content')) {
      console.log(`Skipping email without CONTENT in subject: ${subject}`);
      return;
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
      // Check if this specific message has already been processed
      // by looking at the thread's updated_at timestamp
      const messageDate = new Date(parseInt(message.data.internalDate));
      const threadLastUpdate = new Date(existingThread.created_at);
      
      // If thread exists and message is older than thread update, skip (already processed)
      if (messageDate <= threadLastUpdate) {
        console.log(`⏭️ SKIPPING: Email already processed in thread ${threadId}`);
        
        // Still mark as read to clean up inbox
        await gmail.users.messages.modify({
          userId: 'me',
          id: messageId,
          requestBody: {
            removeLabelIds: ['UNREAD'],
            addLabelIds: [contentLabelId]
          }
        });
        return;
      }
      
      // Handle approval/revision
      await handleApproval(existingThread, body, threadId);
    } else {
      // New content request
      await handleNewContent(body, threadId);
    }

    // Mark as read and move to Content label after successful processing
    await gmail.users.messages.modify({
      userId: 'me',
      id: messageId,
      requestBody: {
        removeLabelIds: ['UNREAD'],
        addLabelIds: [contentLabelId]
      }
    });

    console.log(`✅ Processed email: ${messageId}`);

  } catch (error) {
    console.error(`Error processing email ${messageId}:`, error);
    throw error;
  }
}

// ============================================================================
// PROMPT 1: INITIAL CONTENT GENERATION - USING CLAUDE 4.5 SONNET
// ============================================================================
async function handleNewContent(input, threadId) {
  const systemPrompt = `You are a professional LinkedIn content generation assistant for Ben Corrado. You are a sought after social media EXPERT. Ben sends content ideas - you turn them into quality posts. Your job: determine how many pieces of content to generate, then create them with variation.

Ben is someone who highly values honestly and setting realistic expectations. Although he sells AI and automation for mid sized companies - he is realistic about where the technology is at right now and some of the automation shortcomings. He doesn't think his ideas are revolutionary but does like sharing tips and tricks he uses. 

CONTENT RULES:
- Blogs = big stories with titles
- LinkedIn = smaller insights with BANGER hooks (make them NEED to read more)
- Add value. Make it human. Line breaks for digestibility. Make it a clear flowing story.
- Emojis sparingly (never at start), minimal em-dashes
- LinkedIn maximum 120 words

DETERMINING HOW MUCH CONTENT:
- Insight/hack = 1 LinkedIn post // 1 insight = 1 post
- Detailed project summary = up to 2 blogs + 3 LinkedIn posts
- Project story = 1 Blog + 2 Linkedin posts
- Default = 1 LinkedIn post (most common)
- Minimum: 1 LinkedIn | Maximum: 2 blogs + 3 LinkedIn

CRITICAL: Return ONLY raw JSON, no markdown formatting, no code blocks, no backticks. Just the JSON object.

Return in this exact format:
{
  "assessment": "Brief explanation of what you decided",
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
}`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 5000,
    system: systemPrompt,
    messages: [{ role: 'user', content: input }]
  });

  // Clean the response text to handle markdown code blocks if Claude adds them
  let responseText = response.content[0].text;
  
  // Remove markdown code blocks if present
  responseText = responseText.replace(/```json\s*/g, '');
  responseText = responseText.replace(/```\s*/g, '');
  responseText = responseText.trim();
  
  let generated;
  try {
    generated = JSON.parse(responseText);
  } catch (parseError) {
    console.error('Failed to parse Claude response:', responseText.substring(0, 500));
    throw new Error('Failed to parse AI response as JSON');
  }

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
  await sendApprovalEmail(generated, blogData, linkedInData, threadId);
  
  console.log(`✅ NEW CONTENT GENERATED: ${blogData.length} blog(s), ${linkedInData.length} LinkedIn post(s) - Sent for approval`);
}

// ============================================================================
// PROMPT 2: APPROVAL PARSING & HANDLING
// ============================================================================
async function handleApproval(thread, emailBody, threadId) {
  // Parse approval response
  const systemPrompt = `Analyze email responses to content approval requests.

Determine the user's intent and return JSON:
{
  "action": "approve|revise",
  "feedback": "specific changes if revise, otherwise null"
}

CRITICAL: Return ONLY raw JSON, no markdown formatting, no code blocks, no backticks.`;

  const parseResponse = await anthropic.messages.create({
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 500,
    system: systemPrompt,
    messages: [{ role: 'user', content: emailBody }]
  });

  // Clean the response text
  let responseText = parseResponse.content[0].text;
  responseText = responseText.replace(/```json\s*/g, '');
  responseText = responseText.replace(/```\s*/g, '');
  responseText = responseText.trim();
  
  const parsed = JSON.parse(responseText);

  // Handle based on action
  if (parsed.action === 'approve') {
    console.log('📋 APPROVAL DETECTED - Processing approval...');
    
    await supabase
      .from('content_library')
      .update({ status: 'approved' })
      .eq('id', thread.content_id);
    
    const { data: content } = await supabase
      .from('content_library')
      .select('type, title')
      .eq('id', thread.content_id)
      .single();
    
    const queue = require('../../lib/queue');
    const position = await queue.addToQueue(thread.content_id, content.type);
    
    console.log(`✅ CONTENT APPROVED: "${content.title || 'Untitled'}" added to ${content.type} queue at position ${position}`);
    
    // SEND CONFIRMATION EMAIL
    await sendConfirmationEmail(threadId, 'approved');
    
  } else if (parsed.action === 'revise') {
    console.log('✏️ REVISION REQUESTED - Processing feedback...');
    // Get original content
    const { data: originalContent } = await supabase
      .from('content_library')
      .select('*')
      .eq('id', thread.content_id)
      .single();
    
    // Revision prompt
    const systemPrompt = `You are revising content for Ben Corrado based on feedback.

Ben is someone who highly values honestly and setting realistic expectations. Although he sells AI and automation for mid sized companies - he is realistic about where the technology is at right now and some of the automation shortcomings. He doesn't think his ideas are revolutionary but does like sharing tips and tricks he uses.

STYLE GUIDELINES:
- Blogs = big stories with titles
- LinkedIn = smaller insights with BANGER hooks (make them NEED to read more)
- Add value. Make it human. Line breaks for digestibility. Make it a clear flowing story.
- Emojis sparingly (never at start), minimal em-dashes
- LinkedIn maximum 120 words

Return ONLY the revised content - no JSON, no explanations.`;

    const userPrompt = `ORIGINAL CONTENT:
${originalContent.content}

FEEDBACK:
${parsed.feedback}`;

    const revisionResponse = await anthropic.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 3000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    });

    const revisedContent = revisionResponse.content[0].text;

    // Update content
    await supabase
      .from('content_library')
      .update({
        content: revisedContent,
        version: originalContent.version + 1,
        updated_at: new Date().toISOString()
      })
      .eq('id', thread.content_id);

    // Send revised version for approval
    await sendRevisionEmail(originalContent, revisedContent, threadId);
    
    console.log(`✅ REVISION COMPLETED: "${originalContent.title || 'Untitled'}" v${originalContent.version + 1} sent for approval`);
  }
}

async function sendApprovalEmail(generated, blogData, linkedInData, threadId) {
  let emailContent = 'From: ben@corradoco.com\n';
  emailContent += 'To: ben@corradoco.com\n';
  emailContent += 'Subject: [Content Assistant] New content for approval\n\n';
  emailContent += `Assessment: ${generated.assessment}\n\n`;
  emailContent += '═══════════════════════════════════════\n\n';
  
  if (blogData.length > 0) {
    emailContent += '📝 BLOG POSTS:\n\n';
    blogData.forEach((blog, i) => {
      emailContent += `[B${i + 1}] ${blog.title}\n`;
      emailContent += '─────────────────────────────────────\n';
      emailContent += `${blog.content}\n`;
      emailContent += '─────────────────────────────────────\n\n';
    });
  }
  
  emailContent += '💼 LINKEDIN POSTS:\n\n';
  linkedInData.forEach((post, i) => {
    emailContent += `[L${i + 1}]\n`;
    emailContent += '─────────────────────────────────────\n';
    emailContent += `${post.content}\n`;
    emailContent += '─────────────────────────────────────\n\n';
  });
  
  emailContent += '═══════════════════════════════════════\n\n';
  emailContent += 'REPLY OPTIONS:\n';
  emailContent += '• "approved" - Queue all content\n';
  emailContent += '• "B1 - make it shorter" - Request changes\n';

  const encodedEmail = Buffer.from(emailContent)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  await gmail.users.messages.send({
    userId: 'me',
    requestBody: {
      raw: encodedEmail,
      threadId: threadId
    }
  });
}

async function sendRevisionEmail(originalContent, revisedContent, threadId) {
  let emailContent = 'From: ben@corradoco.com\n';
  emailContent += 'To: ben@corradoco.com\n';
  emailContent += 'Subject: Re: [Content Assistant] Revised content\n\n';
  emailContent += '📝 REVISED VERSION:\n\n';
  emailContent += revisedContent;
  emailContent += '\n\n═══════════════════════════════════════\n';
  emailContent += 'Reply "approved" to queue or provide more feedback.\n';

  const encodedEmail = Buffer.from(emailContent)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  await gmail.users.messages.send({
    userId: 'me',
    requestBody: {
      raw: encodedEmail,
      threadId: threadId
    }
  });
}

async function sendConfirmationEmail(threadId, action) {
  let emailContent = 'From: ben@corradoco.com\n';
  emailContent += 'To: ben@corradoco.com\n';
  emailContent += 'Subject: Re: [Content Assistant] Confirmation\n\n';
  
  if (action === 'approved') {
    emailContent += '✅ Content approved and added to queue!\n\n';
    emailContent += 'Your content has been queued for publishing.';
  }

  const encodedEmail = Buffer.from(emailContent)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  await gmail.users.messages.send({
    userId: 'me',
    requestBody: {
      raw: encodedEmail,
      threadId: threadId
    }
  });
}