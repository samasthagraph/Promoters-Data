const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const app = express();
const PORT = process.env.PORT || 4000;

// Middleware
app.use(cors());
app.use(express.json());

// Serve static assets from public/ folder and project root as fallback
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

let pool = null;
let dbInitialized = false;
let dbInitPromise = null;

// Helper to extract database connection config from env / DATABASE_URL
function getDatabaseConfig() {
  if (process.env.DATABASE_URL) {
    try {
      const dbUrl = new URL(process.env.DATABASE_URL);
      const isLocal = dbUrl.hostname === '127.0.0.1' || dbUrl.hostname === 'localhost';
      return {
        host: dbUrl.hostname,
        port: parseInt(dbUrl.port, 10) || 3306,
        user: decodeURIComponent(dbUrl.username),
        password: decodeURIComponent(dbUrl.password),
        database: dbUrl.pathname.replace(/^\//, '') || process.env.DB_NAME || 'promotersdatadb',
        ssl: (process.env.DB_SSL === 'true' || (!isLocal && process.env.DB_SSL !== 'false')) 
          ? { rejectUnauthorized: false } 
          : undefined
      };
    } catch (err) {
      console.warn('⚠️ Could not parse DATABASE_URL, falling back to individual DB environment variables:', err.message);
    }
  }

  const host = process.env.DB_HOST || '127.0.0.1';
  const port = parseInt(process.env.DB_PORT, 10) || (host.includes('aiven') ? 18515 : 3306);
  const user = process.env.DB_USER || (host.includes('aiven') ? 'avnadmin' : 'root');
  const password = process.env.DB_PASSWORD || '';
  const database = process.env.DB_NAME || 'promotersdatadb';
  const isLocal = host === '127.0.0.1' || host === 'localhost';
  const ssl = (process.env.DB_SSL === 'true' || (!isLocal && process.env.DB_SSL !== 'false'))
    ? { rejectUnauthorized: false }
    : undefined;

  return { host, port, user, password, database, ssl };
}

// Lazy Pool Initializer (Reused across serverless function invocations)
function getPool() {
  if (!pool) {
    const dbConfig = getDatabaseConfig();
    console.log(`🔌 Initializing MySQL pool: ${dbConfig.host}:${dbConfig.port} (DB: ${dbConfig.database}, User: ${dbConfig.user}, SSL: ${dbConfig.ssl ? 'Enabled' : 'Disabled'})`);
    pool = mysql.createPool({
      host: dbConfig.host,
      port: dbConfig.port,
      user: dbConfig.user,
      password: dbConfig.password,
      database: dbConfig.database,
      ssl: dbConfig.ssl,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      connectTimeout: 20000
    });
  }
  return pool;
}

// Ensure database tables exist (Runs once lazily)
async function ensureDatabase() {
  if (dbInitialized) return;
  if (!dbInitPromise) {
    dbInitPromise = (async () => {
      const dbPool = getPool();
      try {
        // 1. Ensure promoters table exists
        await dbPool.query(`
          CREATE TABLE IF NOT EXISTS promoters (
            id VARCHAR(50) PRIMARY KEY,
            fullName VARCHAR(255) NOT NULL,
            mobileNumber VARCHAR(15) NOT NULL,
            level ENUM('District', 'Zone', 'Circle') NOT NULL,
            district VARCHAR(100) NOT NULL,
            zone VARCHAR(100) DEFAULT NULL,
            circle VARCHAR(100) DEFAULT NULL,
            timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY unique_mobile (mobileNumber)
          );
        `);

        // 2. Ensure hierarchy_locations table exists
        await dbPool.query(`
          CREATE TABLE IF NOT EXISTS hierarchy_locations (
            id INT AUTO_INCREMENT PRIMARY KEY,
            district VARCHAR(100) NOT NULL,
            zone VARCHAR(100) NOT NULL,
            circle VARCHAR(100) NOT NULL
          );
        `);

        dbInitialized = true;
        console.log(`✅ Database tables verified successfully.`);
      } catch (err) {
        console.warn('⚠️ Table verification note:', err.message);
      }
    })();
  }
  await dbInitPromise;
}

// Helper to map DB rows to JSON payload structures expected by client
function mapRowToPromoter(row) {
  return {
    id: row.id,
    fullName: row.fullName,
    mobileNumber: row.mobileNumber,
    level: row.level,
    timestamp: row.timestamp,
    hierarchy: {
      district: row.district,
      zone: row.zone,
      circle: row.circle
    }
  };
}

// ==========================================
// API Router (Mounted on both /api and /)
// ==========================================
const apiRouter = express.Router();

// Middleware to ensure DB connection is ready before querying
apiRouter.use(async (req, res, next) => {
  try {
    getPool();
    await ensureDatabase();
    next();
  } catch (err) {
    console.error('Database connection error in apiRouter:', err);
    return res.status(500).json({ error: 'database', message: 'Database connection failed.' });
  }
});

// 0. GET HIERARCHY LOCATIONS
apiRouter.get('/hierarchy', async (req, res) => {
  try {
    const dbPool = getPool();
    const [rows] = await dbPool.query('SELECT district, zone, circle FROM hierarchy_locations ORDER BY district, zone, circle');
    const hierarchy = {};
    
    rows.forEach(row => {
      const d = row.district ? row.district.trim() : '';
      const z = row.zone ? row.zone.trim() : '';
      const c = row.circle ? row.circle.trim() : '';
      
      if (!d) return;
      if (!hierarchy[d]) hierarchy[d] = {};
      if (z) {
        if (!hierarchy[d][z]) hierarchy[d][z] = [];
        if (c && !hierarchy[d][z].includes(c)) {
          hierarchy[d][z].push(c);
        }
      }
    });

    res.json({ hierarchy, count: rows.length, list: rows });
  } catch (error) {
    console.error('GET /api/hierarchy error:', error);
    res.status(500).json({ error: 'Failed to retrieve hierarchy locations.' });
  }
});

// 1. GET ALL PROMOTERS
apiRouter.get('/promoters', async (req, res) => {
  try {
    const dbPool = getPool();
    const [rows] = await dbPool.query('SELECT * FROM promoters ORDER BY timestamp DESC');
    res.json(rows.map(mapRowToPromoter));
  } catch (error) {
    console.error('GET /api/promoters error:', error);
    res.status(500).json({ error: 'Failed to retrieve promoters.' });
  }
});

// 2. CREATE A PROMOTER
apiRouter.post('/promoters', async (req, res) => {
  const { id, fullName, mobileNumber, level, hierarchy } = req.body;

  if (!fullName || !mobileNumber || !level) {
    return res.status(400).json({ error: 'fields', message: 'Name, WhatsApp number, and level are required.' });
  }

  if (level !== 'Zone' && level !== 'Circle') {
    return res.status(400).json({ error: 'level', message: 'Level must be Zone or Circle.' });
  }

  const finalId = id || 'p_' + Date.now();
  const district = hierarchy?.district || null;
  const zone = hierarchy?.zone || null;
  const circle = (level === 'Circle') ? (hierarchy?.circle || null) : null;

  try {
    const dbPool = getPool();

    // A. Unique mobile/whatsapp number check
    const [mobileRows] = await dbPool.query('SELECT id FROM promoters WHERE mobileNumber = ?', [mobileNumber]);
    if (mobileRows.length > 0) {
      return res.status(400).json({ error: 'mobileNumber', message: 'This WhatsApp number is already registered.' });
    }

    // B. Uniqueness validation based on level hierarchy
    if (level === 'Zone') {
      if (!district || !zone) {
        return res.status(400).json({ error: 'zone', message: 'District and Zone selections are required.' });
      }
      const [locRows] = await dbPool.query('SELECT id FROM promoters WHERE level = "Zone" AND district = ? AND zone = ?', [district, zone]);
      if (locRows.length > 0) {
        return res.status(400).json({ error: 'zone', message: 'A promoter is already registered for this Zone.' });
      }
    } else if (level === 'Circle') {
      if (!district || !zone || !circle) {
        return res.status(400).json({ error: 'circle', message: 'District, Zone, and Circle selections are required.' });
      }
      const [locRows] = await dbPool.query('SELECT id FROM promoters WHERE level = "Circle" AND district = ? AND zone = ? AND circle = ?', [district, zone, circle]);
      if (locRows.length > 0) {
        return res.status(400).json({ error: 'circle', message: 'A promoter is already registered for this Circle.' });
      }
    }

    // C. Perform Insert
    await dbPool.query(
      'INSERT INTO promoters (id, fullName, mobileNumber, level, district, zone, circle) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [finalId, fullName, mobileNumber, level, district, zone, circle]
    );

    res.status(201).json({ id: finalId, message: 'Promoter registered successfully.' });
  } catch (error) {
    console.error('POST /api/promoters error:', error);
    res.status(500).json({ error: 'database', message: 'Database error occurred while saving promoter.' });
  }
});

// 3. EDIT AN EXISTING PROMOTER
apiRouter.put('/promoters/:id', async (req, res) => {
  const { id } = req.params;
  const { fullName, mobileNumber, level, hierarchy } = req.body;

  if (!fullName || !mobileNumber || !level) {
    return res.status(400).json({ error: 'fields', message: 'Name, WhatsApp number, and level are required.' });
  }

  if (level !== 'Zone' && level !== 'Circle') {
    return res.status(400).json({ error: 'level', message: 'Level must be Zone or Circle.' });
  }

  const district = hierarchy?.district || null;
  const zone = hierarchy?.zone || null;
  const circle = (level === 'Circle') ? (hierarchy?.circle || null) : null;

  try {
    const dbPool = getPool();

    // A. Unique mobile/whatsapp number check (excluding current promoter)
    const [mobileRows] = await dbPool.query('SELECT id FROM promoters WHERE mobileNumber = ? AND id != ?', [mobileNumber, id]);
    if (mobileRows.length > 0) {
      return res.status(400).json({ error: 'mobileNumber', message: 'This WhatsApp number is already registered to another promoter.' });
    }

    // B. Uniqueness validation based on level hierarchy (excluding current promoter)
    if (level === 'Zone') {
      if (!district || !zone) {
        return res.status(400).json({ error: 'zone', message: 'District and Zone selections are required.' });
      }
      const [locRows] = await dbPool.query('SELECT id FROM promoters WHERE level = "Zone" AND district = ? AND zone = ? AND id != ?', [district, zone, id]);
      if (locRows.length > 0) {
        return res.status(400).json({ error: 'zone', message: 'A promoter is already registered for this Zone.' });
      }
    } else if (level === 'Circle') {
      if (!district || !zone || !circle) {
        return res.status(400).json({ error: 'circle', message: 'District, Zone, and Circle selections are required.' });
      }
      const [locRows] = await dbPool.query('SELECT id FROM promoters WHERE level = "Circle" AND district = ? AND zone = ? AND circle = ? AND id != ?', [district, zone, circle, id]);
      if (locRows.length > 0) {
        return res.status(400).json({ error: 'circle', message: 'A promoter is already registered for this Circle.' });
      }
    }

    // C. Perform Update
    const [result] = await dbPool.query(
      'UPDATE promoters SET fullName = ?, mobileNumber = ?, level = ?, district = ?, zone = ?, circle = ? WHERE id = ?',
      [fullName, mobileNumber, level, district, zone, circle, id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'id', message: 'Promoter not found.' });
    }

    res.json({ message: 'Promoter details updated successfully.' });
  } catch (error) {
    console.error(`PUT /api/promoters/${id} error:`, error);
    res.status(500).json({ error: 'database', message: 'Database error occurred while updating promoter details.' });
  }
});

// 4. DELETE A PROMOTER BY ID
apiRouter.delete('/promoters/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const dbPool = getPool();
    const [result] = await dbPool.query('DELETE FROM promoters WHERE id = ?', [id]);
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Promoter not found.' });
    }
    res.json({ message: 'Promoter deleted successfully.' });
  } catch (error) {
    console.error(`DELETE /api/promoters/${id} error:`, error);
    res.status(500).json({ error: 'Failed to delete promoter.' });
  }
});

// 5. DELETE ALL PROMOTERS (CLEAR)
apiRouter.delete('/promoters', async (req, res) => {
  try {
    const dbPool = getPool();
    await dbPool.query('DELETE FROM promoters');
    res.json({ message: 'All promoters cleared successfully.' });
  } catch (error) {
    console.error('DELETE /api/promoters error:', error);
    res.status(500).json({ error: 'Failed to clear database.' });
  }
});

// 6. ADMIN AUTHENTICATION LOGIN
apiRouter.post('/admin/login', (req, res) => {
  const { username, password } = req.body;
  const validUser = process.env.ADMIN_USERNAME || 'graphadmin';
  const validPass = process.env.ADMIN_PASSWORD || 'graph951';

  if (!username || !password) {
    return res.status(400).json({ success: false, error: 'Username and password are required.' });
  }

  if (username === validUser && password === validPass) {
    const token = Buffer.from(`${username}:${Date.now()}:samastha_graph_admin_session`).toString('base64');
    return res.json({ success: true, token, message: 'Authentication successful.' });
  }

  return res.status(401).json({ success: false, error: 'Invalid username or password.' });
});

// Mount apiRouter on both /api and / to handle direct calls and Vercel path rewrites seamlessly
app.use('/api', apiRouter);
app.use('/', apiRouter);

// Frontend Page Routes
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'), (err) => {
    if (err) res.sendFile(path.join(__dirname, 'admin.html'));
  });
});

app.get('/admin.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'), (err) => {
    if (err) res.sendFile(path.join(__dirname, 'admin.html'));
  });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'), (err) => {
    if (err) res.sendFile(path.join(__dirname, 'index.html'));
  });
});

// Export Express app for Vercel Serverless Function
module.exports = app;

// Start server only when run directly (local development)
if (require.main === module) {
  ensureDatabase().then(() => {
    app.listen(PORT, () => {
      console.log(`🚀 Server is running at http://localhost:${PORT}`);
    });
  }).catch((err) => {
    console.error('Could not initialize database on start:', err);
    app.listen(PORT, () => {
      console.log(`🚀 Server is running at http://localhost:${PORT} (offline mode)`);
    });
  });
}
