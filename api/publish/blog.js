const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

function generateSlug(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

module.exports = async (req, res) => {
  // Verify cron secret for security
  const authHeader = req.headers.authorization || req.headers.Authorization;
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    // Get next blog post from queue (position 1)
    const { data: content, error: fetchError } = await supabase
      .from('content_library')
      .select('*')
      .eq('type', 'blog')
      .eq('status', 'approved')
      .eq('queue_position', 1)
      .single();
    
    if (fetchError || !content) {
      console.log('No blog post in queue for publishing');
      return res.status(200).json({ 
        message: 'No blog post in queue',
        queued: false 
      });
    }
    
    // Generate slug from title
    const slug = generateSlug(content.title);
    
    // Prepare excerpt (use existing or first 200 chars)
    const excerpt = content.excerpt || content.content.substring(0, 200) + '...';
    
    // Write directly to blog_posts table (shared with website)
    const { data: publishedPost, error: publishError } = await supabase
      .from('blog_posts')
      .insert({
        title: content.title,
        slug: slug,
        content: content.content,
        excerpt: excerpt,
        published: true,
        published_at: new Date().toISOString()
      })
      .select()
      .single();
    
    if (publishError) {
      console.error('Blog publish error:', publishError);
      throw publishError;
    }
    
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
      content_type: 'blog',
      from_position: 1
    });
    
    console.log(`✅ Published blog: "${content.title}" to website`);
    
    return res.status(200).json({ 
      success: true,
      message: `Published: ${content.title}`,
      published: publishedPost 
    });
    
  } catch (error) {
    console.error('Blog publishing error:', error);
    
    return res.status(500).json({ 
      error: 'Failed to publish blog',
      details: error.message 
    });
  }
};