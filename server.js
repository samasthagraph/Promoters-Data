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

// Initialize Database & Table
async function initializeDatabase() {
  const host = process.env.DB_HOST || '127.0.0.1';
  const port = process.env.DB_PORT || 3306;
  const user = process.env.DB_USER || 'root';
  const password = process.env.DB_PASSWORD || '';
  const database = process.env.DB_NAME || 'samantha_graph';

  try {
    // Connect to MySQL server first without selecting DB
    const connection = await mysql.createConnection({ host, port, user, password });
    
    // Create DB if not exists
    await connection.query(`CREATE DATABASE IF NOT EXISTS \`${database}\`;`);
    await connection.query(`USE \`${database}\`;`);
    
    // Create promoters table if not exists
    const createTableQuery = `
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
    await connection.query(createTableQuery);

    // Create hierarchy_locations table if not exists
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
    
    console.log(`Database and tables verified/created in MySQL.`);

    // Create pool for subsequent requests
    pool = mysql.createPool({
      host,
      port,
      user,
      password,
      database,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0
    });
  } catch (error) {
    console.error('Failed to initialize database:', error.message);
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

// Endpoints

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

// Start Server after database initialization
initializeDatabase().then(() => {
  app.listen(PORT, () => {
    console.log(`Server is running at http://localhost:${PORT}`);
  });
});
