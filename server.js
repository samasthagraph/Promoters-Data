const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

let pool;

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

// Initialize Database & Tables
async function initializeDatabase() {
  const dbConfig = getDatabaseConfig();
  console.log(`🔌 Connecting to MySQL database at ${dbConfig.host}:${dbConfig.port} (DB: ${dbConfig.database}, User: ${dbConfig.user}, SSL: ${dbConfig.ssl ? 'Enabled' : 'Disabled'})...`);

  try {
    // 1. Check direct connection to database
    let connection;
    try {
      connection = await mysql.createConnection({
        host: dbConfig.host,
        port: dbConfig.port,
        user: dbConfig.user,
        password: dbConfig.password,
        database: dbConfig.database,
        ssl: dbConfig.ssl
      });
    } catch (connErr) {
      // If DB doesn't exist on local server, attempt creating it (only on local environments)
      if (connErr.code === 'ER_BAD_DB_ERROR' && (dbConfig.host === '127.0.0.1' || dbConfig.host === 'localhost')) {
        console.log(`Creating database '${dbConfig.database}' locally...`);
        const rootConn = await mysql.createConnection({
          host: dbConfig.host,
          port: dbConfig.port,
          user: dbConfig.user,
          password: dbConfig.password,
          ssl: dbConfig.ssl
        });
        await rootConn.query(`CREATE DATABASE IF NOT EXISTS \`${dbConfig.database}\`;`);
        await rootConn.end();

        connection = await mysql.createConnection({
          host: dbConfig.host,
          port: dbConfig.port,
          user: dbConfig.user,
          password: dbConfig.password,
          database: dbConfig.database,
          ssl: dbConfig.ssl
        });
      } else {
        throw connErr;
      }
    }

    // 2. Ensure promoters table exists
    const createPromotersTableQuery = `
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
    `;
    await connection.query(createPromotersTableQuery);

    // 3. Ensure hierarchy_locations table exists
    const createHierarchyTableQuery = `
      CREATE TABLE IF NOT EXISTS hierarchy_locations (
        id INT AUTO_INCREMENT PRIMARY KEY,
        district VARCHAR(100) NOT NULL,
        zone VARCHAR(100) NOT NULL,
        circle VARCHAR(100) NOT NULL
      );
    `;
    await connection.query(createHierarchyTableQuery);
    await connection.end();

    console.log(`✅ Database connected successfully! Verified 'promoters' and 'hierarchy_locations' tables.`);

    // 4. Create connection pool for handling API requests
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

  } catch (error) {
    console.error('❌ Failed to initialize database:');
    console.error(`   Error Code: ${error.code || 'UNKNOWN'}`);
    console.error(`   Message:    ${error.message}`);
    console.error('   Please check your DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, and DB_NAME environment variables.');
    process.exit(1);
  }
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
// REST API Endpoints
// ==========================================

// 0. GET HIERARCHY LOCATIONS
app.get('/api/hierarchy', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT district, zone, circle FROM hierarchy_locations ORDER BY district, zone, circle');
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
app.get('/api/promoters', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM promoters ORDER BY timestamp DESC');
    res.json(rows.map(mapRowToPromoter));
  } catch (error) {
    console.error('GET /api/promoters error:', error);
    res.status(500).json({ error: 'Failed to retrieve promoters.' });
  }
});

// 2. CREATE A PROMOTER
app.post('/api/promoters', async (req, res) => {
  const { id, fullName, mobileNumber, level, hierarchy } = req.body;

  if (!fullName || !mobileNumber || !level) {
    return res.status(400).json({ error: 'fields', message: 'Name, mobile number, and level are required.' });
  }

  const finalId = id || 'p_' + Date.now();
  const district = hierarchy?.district || null;
  const zone = (level === 'Zone' || level === 'Circle') ? (hierarchy?.zone || null) : null;
  const circle = (level === 'Circle') ? (hierarchy?.circle || null) : null;

  try {
    // A. Unique mobile number check
    const [mobileRows] = await pool.query('SELECT id FROM promoters WHERE mobileNumber = ?', [mobileNumber]);
    if (mobileRows.length > 0) {
      return res.status(400).json({ error: 'mobileNumber', message: 'This mobile number is already registered.' });
    }

    // B. Uniqueness validation based on level hierarchy
    if (level === 'District') {
      if (!district) {
        return res.status(400).json({ error: 'district', message: 'District selection is required.' });
      }
      const [locRows] = await pool.query('SELECT id FROM promoters WHERE level = "District" AND district = ?', [district]);
      if (locRows.length > 0) {
        return res.status(400).json({ error: 'district', message: 'A promoter is already registered for this District.' });
      }
    } else if (level === 'Zone') {
      if (!district || !zone) {
        return res.status(400).json({ error: 'zone', message: 'District and Zone selections are required.' });
      }
      const [locRows] = await pool.query('SELECT id FROM promoters WHERE level = "Zone" AND district = ? AND zone = ?', [district, zone]);
      if (locRows.length > 0) {
        return res.status(400).json({ error: 'zone', message: 'A promoter is already registered for this Zone.' });
      }
    } else if (level === 'Circle') {
      if (!district || !zone || !circle) {
        return res.status(400).json({ error: 'circle', message: 'District, Zone, and Circle selections are required.' });
      }
      const [locRows] = await pool.query('SELECT id FROM promoters WHERE level = "Circle" AND district = ? AND zone = ? AND circle = ?', [district, zone, circle]);
      if (locRows.length > 0) {
        return res.status(400).json({ error: 'circle', message: 'A promoter is already registered for this Circle.' });
      }
    }

    // C. Perform Insert
    await pool.query(
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
app.put('/api/promoters/:id', async (req, res) => {
  const { id } = req.params;
  const { fullName, mobileNumber, level, hierarchy } = req.body;

  if (!fullName || !mobileNumber || !level) {
    return res.status(400).json({ error: 'fields', message: 'Name, mobile number, and level are required.' });
  }

  const district = hierarchy?.district || null;
  const zone = (level === 'Zone' || level === 'Circle') ? (hierarchy?.zone || null) : null;
  const circle = (level === 'Circle') ? (hierarchy?.circle || null) : null;

  try {
    // A. Unique mobile number check (excluding current promoter)
    const [mobileRows] = await pool.query('SELECT id FROM promoters WHERE mobileNumber = ? AND id != ?', [mobileNumber, id]);
    if (mobileRows.length > 0) {
      return res.status(400).json({ error: 'mobileNumber', message: 'This mobile number is already registered to another promoter.' });
    }

    // B. Uniqueness validation based on level hierarchy (excluding current promoter)
    if (level === 'District') {
      if (!district) {
        return res.status(400).json({ error: 'district', message: 'District selection is required.' });
      }
      const [locRows] = await pool.query('SELECT id FROM promoters WHERE level = "District" AND district = ? AND id != ?', [district, id]);
      if (locRows.length > 0) {
        return res.status(400).json({ error: 'district', message: 'A promoter is already registered for this District.' });
      }
    } else if (level === 'Zone') {
      if (!district || !zone) {
        return res.status(400).json({ error: 'zone', message: 'District and Zone selections are required.' });
      }
      const [locRows] = await pool.query('SELECT id FROM promoters WHERE level = "Zone" AND district = ? AND zone = ? AND id != ?', [district, zone, id]);
      if (locRows.length > 0) {
        return res.status(400).json({ error: 'zone', message: 'A promoter is already registered for this Zone.' });
      }
    } else if (level === 'Circle') {
      if (!district || !zone || !circle) {
        return res.status(400).json({ error: 'circle', message: 'District, Zone, and Circle selections are required.' });
      }
      const [locRows] = await pool.query('SELECT id FROM promoters WHERE level = "Circle" AND district = ? AND zone = ? AND circle = ? AND id != ?', [district, zone, circle, id]);
      if (locRows.length > 0) {
        return res.status(400).json({ error: 'circle', message: 'A promoter is already registered for this Circle.' });
      }
    }

    // C. Perform Update
    const [result] = await pool.query(
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
app.delete('/api/promoters/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const [result] = await pool.query('DELETE FROM promoters WHERE id = ?', [id]);
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
app.delete('/api/promoters', async (req, res) => {
  try {
    await pool.query('DELETE FROM promoters');
    res.json({ message: 'All promoters cleared successfully.' });
  } catch (error) {
    console.error('DELETE /api/promoters error:', error);
    res.status(500).json({ error: 'Failed to clear database.' });
  }
});

// 6. ADMIN AUTHENTICATION LOGIN
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;
  const validUser = process.env.ADMIN_USERNAME || 'graphadmin';
  const validPass = process.env.ADMIN_PASSWORD || 'graph951';

  if (!username || !password) {
    return res.status(400).json({ success: false, error: 'Username and password are required.' });
  }

  if (username === validUser && password === validPass) {
    const token = Buffer.from(`${username}:${Date.now()}:samantha_graph_admin_session`).toString('base64');
    return res.json({ success: true, token, message: 'Authentication successful.' });
  }

  return res.status(401).json({ success: false, error: 'Invalid username or password.' });
});

// Start Server after database initialization
initializeDatabase().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 Server is running at http://localhost:${PORT}`);
  });
});
