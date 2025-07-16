const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('body-parser');
const cors = require('cors');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(bodyParser.json());

const DATA_JSON = './data.json';
const EXISTING_USERS_JSON = './existing-users.json';

function saveUserToDataJson(user) {
  let data = { users: [] };
  if (fs.existsSync(DATA_JSON)) {
    data = JSON.parse(fs.readFileSync(DATA_JSON, 'utf8'));
  }
  // Remove any existing user with the same healthid
  data.users = data.users.filter(u => u.healthid !== user.healthid);
  // Add the updated/new user
  data.users.push(user);
  fs.writeFileSync(DATA_JSON, JSON.stringify(data, null, 2));
}
function updateExistingUsersJson(user) {
  let data = { users: [] };
  if (fs.existsSync(EXISTING_USERS_JSON)) {
    data = JSON.parse(fs.readFileSync(EXISTING_USERS_JSON, 'utf8'));
  }
  // Only add if not already present
  if (!data.users.find(u => u.healthid === user.healthid)) {
    data.users.push({ healthid: user.healthid, mobile: user.mobile, name: user.name });
    fs.writeFileSync(EXISTING_USERS_JSON, JSON.stringify(data, null, 2));
  }
}

// Initialize SQLite database
const db = new sqlite3.Database('./emergencyqr.db', (err) => {
  if (err) return console.error(err.message);
  console.log('Connected to SQLite database.');
});

// Create users table if not exists
db.run(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    healthid TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    name TEXT,
    age INTEGER,
    bloodGroup TEXT,
    mobile TEXT UNIQUE NOT NULL,
    emergencyContact TEXT,
    allergies TEXT,
    medicalHistory TEXT
  )
`);

// Register endpoint
app.post('/api/register', (req, res) => {
  const { healthid, password, mobile } = req.body;
  if (!/^\d{12}$/.test(healthid)) {
    return res.status(400).json({ error: 'Health ID must be exactly 12 digits (no letters, spaces, or symbols)' });
  }
  db.get('SELECT * FROM users WHERE healthid = ?', [healthid], (err, row) => {
    if (row) return res.status(400).json({ error: 'Health ID already registered. Please use a different Health ID.' });
    db.get('SELECT * FROM users WHERE mobile = ?', [mobile], (err, row2) => {
      if (row2) return res.status(400).json({ error: 'Mobile number already in use. Please use a different mobile number.' });
      db.run(
        'INSERT INTO users (healthid, password, mobile) VALUES (?, ?, ?)',
        [healthid, password, mobile],
        function (err) {
          if (err) return res.status(500).json({ error: 'Registration failed' });
          res.json({ message: 'Registration successful' });
        }
      );
    });
  });
});

// Login endpoint
app.post('/api/login', (req, res) => {
  const { healthid, password } = req.body;
  if (!/^\d{12}$/.test(healthid)) {
    return res.status(400).json({ error: 'Health ID must be exactly 12 digits (no letters, spaces, or symbols)' });
  }
  db.get(
    'SELECT * FROM users WHERE healthid = ? AND password = ?',
    [healthid, password],
    (err, row) => {
      if (!row) return res.status(400).json({ error: 'Invalid Health ID or password' });
      res.json({ message: 'Login successful', healthid });
    }
  );
});

// Save user details (after login)
app.post('/api/details', (req, res) => {
  let { healthid, name, dob, age, bloodGroup, mobile, emergencyContact, allergies, medicalHistory } = req.body;
  function saveAndRespond() {
    // Save to data.json and existing-users.json, now including dob
    const user = { healthid, name, dob, age, bloodGroup, mobile, emergencyContact, allergies, medicalHistory };
    saveUserToDataJson(user);
    updateExistingUsersJson(user);
    res.json({ message: 'Details updated' });
  }
  if (!dob) {
    // Fetch dob from database if not provided
    db.get('SELECT dob FROM users WHERE healthid = ?', [healthid], (err, row) => {
      if (row && row.dob) {
        dob = row.dob;
      }
      saveAndRespond();
    });
  } else {
    saveAndRespond();
  }
});

// Get user details
app.get('/api/details/:healthid', (req, res) => {
  db.get('SELECT * FROM users WHERE healthid = ?', [req.params.healthid], (err, row) => {
    if (!row) return res.status(404).json({ error: 'User not found' });
    res.json(row);
  });
});

// Panic alert endpoint
app.post('/api/panic', (req, res) => {
  const { name, emergencyContact } = req.body;
  if (!name || !emergencyContact) {
    return res.status(400).json({ success: false, error: 'Missing name or emergency contact' });
  }
  // Here you would integrate with an SMS/email API
  console.log(`PANIC ALERT: ${name} is in danger! Alert sent to ${emergencyContact}`);
  res.json({ success: true });
});

// --- ADMIN DASHBOARD ENDPOINTS ---
// 1. List/search users
app.get('/api/admin/users', (req, res) => {
  const search = req.query.search ? `%${req.query.search}%` : '%';
  db.all(
    `SELECT healthid, name, mobile, bloodGroup FROM users
     WHERE healthid LIKE ? OR mobile LIKE ? OR name LIKE ?
     ORDER BY id DESC`,
    [search, search, search],
    (err, rows) => {
      if (err) return res.status(500).json({ error: 'Failed to fetch users' });
      res.json({ users: rows });
    }
  );
});
// 2. Get user details
app.get('/api/admin/user/:healthid', (req, res) => {
  db.get('SELECT * FROM users WHERE healthid = ?', [req.params.healthid], (err, row) => {
    if (!row) return res.status(404).json({ error: 'User not found' });
    res.json(row);
  });
});
// 3. Analytics endpoint
app.get('/api/admin/analytics', (req, res) => {
  db.all('SELECT * FROM users', [], (err, users) => {
    if (err) return res.status(500).json({ error: 'Failed to fetch analytics' });
    // Total users
    const totalUsers = users.length;
    // Registered in last 7/30 days (assume id is auto-increment, so use rowid as proxy for recency)
    // If you have a created_at column, use that instead
    // For now, just use all users for demo
    const now = new Date();
    const users7days = users.filter(u => {
      if (!u.created_at) return false;
      return (now - new Date(u.created_at)) < 7*24*60*60*1000;
    }).length;
    const users30days = users.filter(u => {
      if (!u.created_at) return false;
      return (now - new Date(u.created_at)) < 30*24*60*60*1000;
    }).length;
    // Blood group distribution
    const bloodGroups = {};
    users.forEach(u => {
      if (u.bloodGroup) bloodGroups[u.bloodGroup] = (bloodGroups[u.bloodGroup] || 0) + 1;
    });
    // Age group distribution
    const ageGroups = { '0-18': 0, '19-35': 0, '36-60': 0, '60+': 0 };
    users.forEach(u => {
      let age = u.age;
      if (typeof age === 'string') age = parseInt(age);
      if (!age || isNaN(age)) return;
      if (age <= 18) ageGroups['0-18']++;
      else if (age <= 35) ageGroups['19-35']++;
      else if (age <= 60) ageGroups['36-60']++;
      else ageGroups['60+']++;
    });
    // Top allergies
    const allergyCounts = {};
    users.forEach(u => {
      if (u.allergies) {
        u.allergies.split(',').forEach(a => {
          const name = a.trim();
          if (name) allergyCounts[name] = (allergyCounts[name] || 0) + 1;
        });
      }
    });
    const topAllergies = Object.entries(allergyCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, count]) => ({ name, count }));
    res.json({
      totalUsers,
      users7days,
      users30days,
      bloodGroups,
      ageGroups,
      topAllergies
    });
  });
});

// Serve existing users for login page
app.get('/api/existing-users', (req, res) => {
  if (fs.existsSync(EXISTING_USERS_JSON)) {
    const data = JSON.parse(fs.readFileSync(EXISTING_USERS_JSON, 'utf8'));
    res.json(data);
  } else {
    res.json({ users: [] });
  }
});
// Serve all user data for admin
app.get('/api/all-user-data', (req, res) => {
  if (fs.existsSync(DATA_JSON)) {
    const data = JSON.parse(fs.readFileSync(DATA_JSON, 'utf8'));
    res.json(data);
  } else {
    res.json({ users: [] });
  }
});

app.listen(3000, () => console.log('Server running on http://localhost:3000')); 