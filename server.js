import axios from 'axios';
import express from 'express';
import cors from 'cors';
import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// /remember (manual insert)
app.post('/remember', async (req, res) => {
  const apiKey = req.headers['x-api-key'];
  if (apiKey !== process.env.API_KEY) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  const { type, content, date } = req.body;

  try {
    const result = await pool.query(
      'INSERT INTO memory (type, content, date, timestamp) VALUES ($1, $2, $3, NOW()) RETURNING *',
      [type, content, date]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// /smart-remember (auto route logic)
app.post('/smart-remember', async (req, res) => {
  const apiKey = req.headers['x-api-key'];
  if (apiKey !== process.env.API_KEY) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  const { type, content, date } = req.body;

  if (!type || !content) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    if (content.length <= 500) {
      const result = await pool.query(
        'INSERT INTO memory (type, content, date, timestamp) VALUES ($1, $2, $3, NOW()) RETURNING *',
        [type, content, date]
      );
      return res.json({ storage: 'neon', ...result.rows[0] });
    }

    const fileName = `${type}_${date || new Date().toISOString().slice(0, 10)}.txt`;
    const metadata = {
      name: fileName,
      mimeType: 'text/plain',
    };

    const boundary = 'boundary123';
    const multipartBody =
      `--${boundary}\r\n` +
      `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
      JSON.stringify(metadata) + `\r\n` +
      `--${boundary}\r\n` +
      `Content-Type: text/plain\r\n\r\n` +
      content + `\r\n` +
      `--${boundary}--`;

    const driveRes = await axios.post(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink',
      multipartBody,
      {
        headers: {
          Authorization: `Bearer ${process.env.GOOGLE_ACCESS_TOKEN}`,
          'Content-Type': `multipart/related; boundary=${boundary}`,
        },
      }
    );

    const file = driveRes.data;

    const result = await pool.query(
      'INSERT INTO memory (type, content, date, timestamp) VALUES ($1, $2, $3, NOW()) RETURNING *',
      ['gdrive_link', file.webViewLink, date]
    );

    res.json({
      storage: 'google_drive',
      file,
      neonRecord: result.rows[0],
    });

  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to process memory', detail: err.message });
  }
});

// /query (safe SQL SELECT)
app.post('/query', async (req, res) => {
  const apiKey = req.headers['x-api-key'];
  if (apiKey !== process.env.API_KEY) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  const { sql, confirmDelete } = req.body;

  const sqlType = sql?.trim().split(' ')[0]?.toLowerCase();
  const allowedKeywords = ['select', 'insert', 'update', 'delete', 'create'];

  if (!allowedKeywords.includes(sqlType)) {
    return res.status(400).json({ error: 'Query type not allowed' });
  }

  // 🚨 Add explicit delete protection
  if (sqlType === 'delete' && !confirmDelete) {
    return res.status(400).json({
      error: 'DELETE query blocked. You must set "confirmDelete": true in the request body to run DELETE queries.',
    });
  }

  // Optional: log dangerous queries
  if (sqlType !== 'select') {
    console.log(`⚠️ GPT is running ${sqlType.toUpperCase()} query:\n${sql}`);
  }

  try {
    const result = await pool.query(sql);
    res.json(result.rows);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.listen(3000, () => {
  console.log('Postgres API listening on http://localhost:3000');
});
