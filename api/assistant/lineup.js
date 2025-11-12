const { createClient } = require('@supabase/supabase-js');
const { google } = require('googleapis');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

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
  // Verify cron secret for security
  const authHeader = req.headers.authorization || req.headers.Authorization;
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    // Get next blog from queue (position 1)
    const { data: nextBlog } = await supabase
      .from('content_library')
      .select('*')
      .eq('type', 'blog')
      .eq('status', 'approved')
      .eq('queue_position', 1)
      .single();
    
    // Get next 3 LinkedIn posts from queue (positions 1, 2, 3)
    const { data: nextLinkedIn } = await supabase
      .from('content_library')
      .select('*')
      .eq('type', 'linkedin')
      .eq('status', 'approved')
      .in('queue_position', [1, 2, 3])
      .order('queue_position', { ascending: true });
    
    // Get next items in queue for context
    const { data: blogQueue } = await supabase
      .from('content_library')
      .select('*')
      .eq('type', 'blog')
      .eq('status', 'approved')
      .not('queue_position', 'is', null)
      .order('queue_position', { ascending: true })
      .limit(5);
    
    const { data: linkedInQueue } = await supabase
      .from('content_library')
      .select('*')
      .eq('type', 'linkedin')
      .eq('status', 'approved')
      .not('queue_position', 'is', null)
      .order('queue_position', { ascending: true })
      .limit(6);
    
    // Build lineup email
    let emailContent = 'From: ben@corradoco.com\n';
    emailContent += 'To: ben@corradoco.com\n';
    emailContent += 'Subject: [Content Assistant] Weekly Content Lineup\n\n';
    emailContent += '📅 WEEKLY CONTENT LINEUP\n\n';
    
    // Blog (Monday)
    emailContent += '📝 BLOG (Monday): [B1]\n';
    if (nextBlog) {
      emailContent += `Title: ${nextBlog.title}\n`;
      emailContent += `${nextBlog.content.substring(0, 200)}...\n`;
      emailContent += `→ Next: ${blogQueue[1]?.title || 'None'}\n\n`;
    } else {
      emailContent += '⚠️ No blog in queue\n\n';
    }
    
    // LinkedIn (Tuesday)
    emailContent += '💼 LINKEDIN (Tuesday): [L1]\n';
    if (nextLinkedIn && nextLinkedIn[0]) {
      emailContent += `${nextLinkedIn[0].content}\n`;
      emailContent += `→ Next: ${linkedInQueue[1]?.title || 'None'}\n\n`;
    } else {
      emailContent += '⚠️ No LinkedIn post in queue\n\n';
    }
    
    // LinkedIn (Thursday)
    emailContent += '💼 LINKEDIN (Thursday): [L2]\n';
    if (nextLinkedIn && nextLinkedIn[1]) {
      emailContent += `${nextLinkedIn[1].content}\n`;
      emailContent += `→ Next: ${linkedInQueue[2]?.title || 'None'}\n\n`;
    } else {
      emailContent += '⚠️ No LinkedIn post in queue\n\n';
    }
    
    // LinkedIn (Saturday)
    emailContent += '💼 LINKEDIN (Saturday): [L3]\n';
    if (nextLinkedIn && nextLinkedIn[2]) {
      emailContent += `${nextLinkedIn[2].content}\n`;
      emailContent += `→ Next: ${linkedInQueue[3]?.title || 'None'}\n\n`;
    } else {
      emailContent += '⚠️ No LinkedIn post in queue\n\n';
    }
    
    emailContent += '---\n';
    emailContent += 'REPLY OPTIONS:\n';
    emailContent += '• "All approved" - Lock in all 4 pieces\n';
    emailContent += '• "B1 next" - Skip to next blog\n';
    emailContent += '• "L2 - [feedback]" - Request changes\n';
    emailContent += '• "Show more blogs" - See deeper queue\n';
    
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
    
    console.log('✅ Monday lineup email sent');
    
    return res.status(200).json({ 
      success: true,
      message: 'Weekly lineup sent',
      lineup: {
        blog: nextBlog?.title || 'None',
        linkedin: nextLinkedIn?.length || 0
      }
    });
    
  } catch (error) {
    console.error('Lineup generation error:', error);
    return res.status(500).json({ 
      error: 'Failed to generate lineup',
      details: error.message 
    });
  }
};