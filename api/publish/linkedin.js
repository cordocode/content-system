const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const { sendEmail } = require('../../lib/email');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

module.exports = async (req, res) => {
  // Verify cron secret for security
  const authHeader = req.headers.authorization || req.headers.Authorization;
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    // Get next LinkedIn post from queue (position 1)
    const { data: content, error: fetchError } = await supabase
      .from('content_library')
      .select('*')
      .eq('type', 'linkedin')
      .eq('status', 'approved')
      .eq('queue_position', 1)
      .single();
    
    if (fetchError || !content) {
      console.log('No LinkedIn post in queue for publishing');
      return res.status(200).json({ 
        message: 'No LinkedIn post in queue',
        queued: false 
      });
    }
    
    // DRY RUN MODE - Safety check
    const dryRun = process.env.ENABLE_PUBLISHING !== 'true';
    
    if (dryRun) {
      console.log('🔒 DRY RUN MODE - Would publish LinkedIn:', content.content.substring(0, 50) + '...');
      
      // Send preview email
      await sendEmail(
        '[DRY RUN] Would publish LinkedIn',
        `LinkedIn Post Preview:\n\n${content.content}\n\n---\nTo enable actual publishing, set ENABLE_PUBLISHING=true in Vercel environment variables.`
      );
      
      return res.status(200).json({ 
        dryRun: true,
        message: 'Dry run - no actual publishing',
        wouldPublish: {
          preview: content.content.substring(0, 100) + '...',
          fullLength: content.content.length
        }
      });
    }
    
    // ACTUAL PUBLISHING (only runs if ENABLE_PUBLISHING=true)
    
    // Get LinkedIn user info (to get URN)
    // IMPORTANT: Use /v2/userinfo (OpenID Connect) instead of /v2/me (legacy)
    // This works with the 'openid' and 'profile' scopes
    const userInfoResponse = await axios.get('https://api.linkedin.com/v2/userinfo', {
      headers: {
        'Authorization': `Bearer ${process.env.LINKEDIN_ACCESS_TOKEN}`
      }
    });
    
    // The 'sub' field contains the person ID
    const authorUrn = `urn:li:person:${userInfoResponse.data.sub}`;
    
    // Post to LinkedIn using UGC Posts API
    const postResponse = await axios.post(
      'https://api.linkedin.com/v2/ugcPosts',
      {
        author: authorUrn,
        lifecycleState: 'PUBLISHED',
        specificContent: {
          'com.linkedin.ugc.ShareContent': {
            shareCommentary: {
              text: content.content
            },
            shareMediaCategory: 'NONE'
          }
        },
        visibility: {
          'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC'
        }
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.LINKEDIN_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
          'X-Restli-Protocol-Version': '2.0.0'
        }
      }
    );
    
    // Update content_library status
    await supabase
      .from('content_library')
      .update({
        status: 'posted',
        posted_date: new Date().toISOString(),
        queue_position: null
      })
      .eq('id', content.id);
    
    // Shift remaining queue positions up
    await supabase.rpc('shift_queue_positions', {
      content_type: 'linkedin',
      from_position: 1
    });
    
    console.log(`✅ Published LinkedIn post`);
    
    return res.status(200).json({ 
      success: true,
      message: 'LinkedIn post published',
      postId: postResponse.data.id 
    });
    
  } catch (error) {
    console.error('LinkedIn publishing error:', error);
    
    // Log more details for debugging
    if (error.response) {
      console.error('LinkedIn API error:', error.response.data);
    }
    
    return res.status(500).json({ 
      error: 'Failed to publish LinkedIn post',
      details: error.message 
    });
  }
};