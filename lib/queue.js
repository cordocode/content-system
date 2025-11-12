const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Add content to queue (assigns next position)
async function addToQueue(contentId, type) {
  // Get current highest position
  const { data: maxPos } = await supabase
    .from('content_library')
    .select('queue_position')
    .eq('type', type)
    .not('queue_position', 'is', null)
    .order('queue_position', { ascending: false })
    .limit(1);
  
  const nextPosition = maxPos && maxPos[0] ? maxPos[0].queue_position + 1 : 1;
  
  const { error } = await supabase
    .from('content_library')
    .update({ 
      queue_position: nextPosition,
      status: 'queued' 
    })
    .eq('id', contentId);
  
  if (error) throw error;
  
  return nextPosition;
}

// Get all content in queue for a type
async function getQueue(type, limit = 10) {
  const { data, error } = await supabase
    .from('content_library')
    .select('*')
    .eq('type', type)
    .not('queue_position', 'is', null)
    .order('queue_position', { ascending: true })
    .limit(limit);
  
  if (error) throw error;
  return data || [];
}

// Swap content with next item in queue
async function swapWithNext(contentId, type) {
  const { data: current } = await supabase
    .from('content_library')
    .select('queue_position')
    .eq('id', contentId)
    .single();
  
  if (!current || !current.queue_position) {
    throw new Error('Content not in queue');
  }
  
  const targetPosition = current.queue_position + 1;
  
  const { data: target } = await supabase
    .from('content_library')
    .select('id, queue_position')
    .eq('type', type)
    .eq('queue_position', targetPosition)
    .single();
  
  if (!target) {
    throw new Error('No next item in queue');
  }
  
  // Swap positions
  await supabase
    .from('content_library')
    .update({ queue_position: targetPosition })
    .eq('id', contentId);
  
  await supabase
    .from('content_library')
    .update({ queue_position: current.queue_position })
    .eq('id', target.id);
  
  return { swapped: true, newPosition: targetPosition };
}

// Move content to specific position
async function moveToPosition(contentId, type, targetPosition) {
  const { data: current } = await supabase
    .from('content_library')
    .select('queue_position')
    .eq('id', contentId)
    .single();
  
  if (!current || !current.queue_position) {
    throw new Error('Content not in queue');
  }
  
  const currentPosition = current.queue_position;
  
  if (currentPosition === targetPosition) {
    return { moved: false, message: 'Already at target position' };
  }
  
  // Get the item currently at target position
  const { data: targetItem } = await supabase
    .from('content_library')
    .select('id')
    .eq('type', type)
    .eq('queue_position', targetPosition)
    .single();
  
  if (targetItem) {
    // Swap with target
    await supabase
      .from('content_library')
      .update({ queue_position: currentPosition })
      .eq('id', targetItem.id);
  }
  
  // Move to target position
  await supabase
    .from('content_library')
    .update({ queue_position: targetPosition })
    .eq('id', contentId);
  
  return { moved: true, newPosition: targetPosition };
}

// Remove from queue
async function removeFromQueue(contentId) {
  const { error } = await supabase
    .from('content_library')
    .update({ 
      queue_position: null,
      status: 'draft'
    })
    .eq('id', contentId);
  
  if (error) throw error;
  
  return { removed: true };
}

// Get queue health (how many items ready)
async function getQueueHealth() {
  const { data: blogQueue } = await supabase
    .from('content_library')
    .select('id')
    .eq('type', 'blog')
    .eq('status', 'approved')
    .not('queue_position', 'is', null);
  
  const { data: linkedInQueue } = await supabase
    .from('content_library')
    .select('id')
    .eq('type', 'linkedin')
    .eq('status', 'approved')
    .not('queue_position', 'is', null);
  
  return {
    blog: blogQueue ? blogQueue.length : 0,
    linkedin: linkedInQueue ? linkedInQueue.length : 0,
    needsBlog: !blogQueue || blogQueue.length < 2,
    needsLinkedIn: !linkedInQueue || linkedInQueue.length < 4
  };
}

module.exports = {
  addToQueue,
  getQueue,
  swapWithNext,
  moveToPosition,
  removeFromQueue,
  getQueueHealth
};