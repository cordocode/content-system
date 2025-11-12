const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

// Load service account credentials
const serviceAccountPath = path.join(process.cwd(), 'private', 'google-service-account.json');
const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));

// Set up auth
const auth = new google.auth.GoogleAuth({
  credentials: serviceAccount,
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
});

const sheets = google.sheets({ version: 'v4', auth });

const SHEET_ID = process.env.GOOGLE_SHEET_ID;

/**
 * Read data from a specific sheet tab
 * @param {string} sheetName - Name of the sheet tab (e.g., 'Examples', 'Status')
 * @param {string} range - Range to read (e.g., 'A1:E10' or 'A:E' for all rows)
 * @returns {Array} Array of rows
 */
async function readSheet(sheetName, range) {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${sheetName}!${range}`
    });
    
    return response.data.values || [];
  } catch (error) {
    console.error(`Error reading sheet ${sheetName}:`, error);
    throw error;
  }
}

/**
 * Write data to a specific sheet tab
 * @param {string} sheetName - Name of the sheet tab
 * @param {string} range - Starting cell (e.g., 'A2' to start writing at row 2)
 * @param {Array} values - 2D array of values to write
 */
async function writeSheet(sheetName, range, values) {
  try {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${sheetName}!${range}`,
      valueInputOption: 'RAW',
      requestBody: { values }
    });
    
    console.log(`✅ Wrote ${values.length} rows to ${sheetName}`);
  } catch (error) {
    console.error(`Error writing to sheet ${sheetName}:`, error);
    throw error;
  }
}

/**
 * Append data to the end of a sheet
 * @param {string} sheetName - Name of the sheet tab
 * @param {Array} values - 2D array of values to append
 */
async function appendSheet(sheetName, values) {
  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${sheetName}!A:Z`,
      valueInputOption: 'RAW',
      requestBody: { values }
    });
    
    console.log(`✅ Appended ${values.length} rows to ${sheetName}`);
  } catch (error) {
    console.error(`Error appending to sheet ${sheetName}:`, error);
    throw error;
  }
}

/**
 * Clear a range in a sheet
 * @param {string} sheetName - Name of the sheet tab
 * @param {string} range - Range to clear (e.g., 'A2:Z1000')
 */
async function clearSheet(sheetName, range) {
  try {
    await sheets.spreadsheets.values.clear({
      spreadsheetId: SHEET_ID,
      range: `${sheetName}!${range}`
    });
    
    console.log(`✅ Cleared ${sheetName}!${range}`);
  } catch (error) {
    console.error(`Error clearing sheet ${sheetName}:`, error);
    throw error;
  }
}

/**
 * Load training examples from Examples sheet
 * @returns {Array} Array of example objects
 */
async function loadExamples() {
  try {
    const rows = await readSheet('Examples', 'A2:H'); // Skip header row
    
    return rows.map(row => ({
      input: row[0] || '',
      date: row[1] || '',
      density: row[2] || '',
      blog1: row[3] || '',
      blog2: row[4] || '',
      linkedin1: row[5] || '',
      linkedin2: row[6] || '',
      linkedin3: row[7] || ''
    }));
  } catch (error) {
    console.error('Error loading examples:', error);
    return []; // Return empty array if sheet not found
  }
}

/**
 * Sync content library status to Google Sheet
 * @param {Array} content - Array of content items from Supabase
 */
async function syncStatusToSheet(content) {
  try {
    // Clear existing data (except header)
    await clearSheet('Status', 'A2:Z1000');
    
    // Prepare rows
    const rows = content.map(item => [
      item.id,                                          // A: ID
      item.type.toUpperCase(),                          // B: TYPE
      item.title || 'Untitled',                         // C: TITLE
      item.content.substring(0, 100) + '...',          // D: PREVIEW
      item.status.toUpperCase(),                        // E: STATUS
      item.queue_position || '',                        // F: QUEUE_POS
      new Date(item.created_at).toLocaleDateString(),  // G: CREATED
      item.posted_date ? new Date(item.posted_date).toLocaleDateString() : '', // H: POSTED
      item.tags ? item.tags.join(', ') : ''            // I: TAGS
    ]);
    
    // Write all rows at once
    if (rows.length > 0) {
      await writeSheet('Status', 'A2', rows);
    }
    
    console.log(`✅ Synced ${rows.length} items to Status sheet`);
  } catch (error) {
    console.error('Error syncing to Status sheet:', error);
    throw error;
  }
}

module.exports = {
  readSheet,
  writeSheet,
  appendSheet,
  clearSheet,
  loadExamples,
  syncStatusToSheet
};