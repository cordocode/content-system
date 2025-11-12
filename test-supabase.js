const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.local' });

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

async function testSupabase() {
  console.log('Testing Supabase connection...\n');
  
  try {
    // Test 1: Insert a test content item
    const { data: inserted, error: insertError } = await supabase
      .from('content_library')
      .insert({
        title: 'Test Content',
        content: 'This is a test content item to verify database connection.',
        type: 'blog',
        status: 'draft'
      })
      .select()
      .single();
    
    if (insertError) throw insertError;
    console.log('✅ Successfully inserted test content');
    console.log('   ID:', inserted.id);
    
    // Test 2: Read it back
    const { data: read, error: readError } = await supabase
      .from('content_library')
      .select('*')
      .eq('id', inserted.id)
      .single();
    
    if (readError) throw readError;
    console.log('✅ Successfully read test content');
    
    // Test 3: Update it
    const { error: updateError } = await supabase
      .from('content_library')
      .update({ status: 'queued', queue_position: 1 })
      .eq('id', inserted.id);
    
    if (updateError) throw updateError;
    console.log('✅ Successfully updated test content');
    
    // Test 4: Delete it
    const { error: deleteError } = await supabase
      .from('content_library')
      .delete()
      .eq('id', inserted.id);
    
    if (deleteError) throw deleteError;
    console.log('✅ Successfully deleted test content');
    
    console.log('\n🎉 All Supabase tests passed!');
    
  } catch (error) {
    console.error('❌ Supabase test failed:', error.message);
  }
}

testSupabase();