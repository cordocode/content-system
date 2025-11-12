const { google } = require('googleapis');

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

/**
 * Send an email via Gmail API
 * @param {string} subject - Email subject line
 * @param {string} body - Email body content
 * @param {string} to - Recipient email (defaults to ben@corradoco.com)
 * @param {string} from - Sender email (defaults to ben@corradoco.com)
 */
async function sendEmail(subject, body, to = 'ben@corradoco.com', from = 'ben@corradoco.com') {
  try {
    const emailContent = [
      `From: ${from}`,
      `To: ${to}`,
      `Subject: ${subject}`,
      '',
      body
    ].join('\n');

    const encodedEmail = Buffer.from(emailContent)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    const result = await gmail.users.messages.send({
      userId: 'me',
      requestBody: {
        raw: encodedEmail
      }
    });

    console.log(`✅ Email sent: "${subject}"`);
    return result.data;
  } catch (error) {
    console.error('Email sending error:', error);
    throw error;
  }
}

/**
 * Send an email as a reply to an existing thread
 * @param {string} threadId - Gmail thread ID to reply to
 * @param {string} subject - Email subject line
 * @param {string} body - Email body content
 */
async function replyToThread(threadId, subject, body) {
  try {
    const emailContent = [
      `From: ben@corradoco.com`,
      `To: ben@corradoco.com`,
      `Subject: Re: ${subject}`,
      '',
      body
    ].join('\n');

    const encodedEmail = Buffer.from(emailContent)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    const result = await gmail.users.messages.send({
      userId: 'me',
      requestBody: {
        raw: encodedEmail,
        threadId: threadId
      }
    });

    console.log(`✅ Reply sent to thread: ${threadId}`);
    return result.data;
  } catch (error) {
    console.error('Reply sending error:', error);
    throw error;
  }
}

module.exports = {
  sendEmail,
  replyToThread
};