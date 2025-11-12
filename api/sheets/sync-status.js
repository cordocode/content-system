const { createClient } = require('@supabase/supabase-js');
const { syncStatusToSheet } = require('../../lib/sheets');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

module.exports = async (req, res) => {
  // Verify cron secret for security (or allow manual trigger without auth for now)
  const authHeader = req.headers.authorization || req.headers.Authorization;
  if (authHeader && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    // Get all content from Supabase, ordered by creation date (newest first)
    const { data: content, error } = await supabase
      .from('content_library')
      .select('*')
      .order('created_at', { ascending: false });
    
    if (error) throw error;

    // Sync to Google Sheet
    await syncStatusToSheet(content || []);

    console.log(`✅ Synced ${content?.length || 0} items to Status sheet`);

    return res.status(200).json({ 
      success: true,
      synced: content?.length || 0,
      message: 'Status sheet updated successfully'
    });

  } catch (error) {
    console.error('Status sync error:', error);
    return res.status(500).json({ 
      error: 'Failed to sync status',
      details: error.message 
    });
  }
};