const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { input } = req.body;

    if (!input) {
      return res.status(400).json({ error: 'Input text required' });
    }

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

    // Store blogs if any were generated
    let blogData = [];
    if (generated.blog && generated.blog.length > 0) {
      const blogInserts = generated.blog.map(blog => ({
        title: blog.title,
        content: blog.content,
        type: 'blog',
        status: 'draft',
        tags: ['generated']
      }));

      const { data: blogs, error: blogError } = await supabase
        .from('content_library')
        .insert(blogInserts)
        .select();

      if (blogError) throw blogError;
      blogData = blogs;
    }

    // Store LinkedIn posts
    const linkedInInserts = generated.linkedin.map((post, index) => ({
      title: `LinkedIn Post ${index + 1}`,
      content: post.content,
      type: 'linkedin',
      status: 'draft',
      tags: ['generated']
    }));

    const { data: linkedInData, error: linkedInError } = await supabase
      .from('content_library')
      .insert(linkedInInserts)
      .select();

    if (linkedInError) throw linkedInError;

    return res.status(200).json({
      success: true,
      assessment: generated.assessment,
      message: `Generated ${blogData.length} blog(s) and ${linkedInData.length} LinkedIn post(s)`,
      content: {
        blog: blogData,
        linkedin: linkedInData
      }
    });

  } catch (error) {
    console.error('Content generation error:', error);
    return res.status(500).json({ 
      error: 'Failed to generate content',
      details: error.message 
    });
  }
};