require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(__dirname)); // Serve static files from current directory

// Database configuration
const dbConfig = {
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || 'password',
    database: process.env.DB_NAME || 'exammiee_db',
    port: process.env.DB_PORT || 3306
};

let pool;

async function initDb() {
    try {
        // First connect without database to create it if it doesn't exist
        const connection = await mysql.createConnection({
            host: dbConfig.host,
            user: dbConfig.user,
            password: dbConfig.password
        });
        
        await connection.query('CREATE DATABASE IF NOT EXISTS exammiee_db');
        await connection.end();

        // Now connect to the database
        pool = mysql.createPool(dbConfig);
        console.log('Connected to MySQL database.');

        // Initialize schema
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id VARCHAR(255) PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                password VARCHAR(255) NOT NULL,
                role ENUM('superadmin', 'admin', 'student') NOT NULL
            )
        `);
        // Alter table just in case it already exists without superadmin
        try {
            await pool.query("ALTER TABLE users MODIFY COLUMN role ENUM('superadmin', 'admin', 'student') NOT NULL");
        } catch (e) { }

        // Add admin_id to users to map students to the admin who created them
        try {
            await pool.query("ALTER TABLE users ADD COLUMN admin_id VARCHAR(255)");
        } catch (e) { }

        await pool.query(`
            CREATE TABLE IF NOT EXISTS tests (
                id VARCHAR(255) PRIMARY KEY,
                title VARCHAR(255) NOT NULL,
                duration INT NOT NULL,
                admin_id VARCHAR(255),
                start_time BIGINT,
                end_time BIGINT
            )
        `);

        // Add new columns to tests if it already exists
        try {
            await pool.query("ALTER TABLE tests ADD COLUMN admin_id VARCHAR(255)");
        } catch (e) { }
        try {
            await pool.query("ALTER TABLE tests ADD COLUMN start_time BIGINT");
        } catch (e) { }
        try {
            await pool.query("ALTER TABLE tests ADD COLUMN end_time BIGINT");
        } catch (e) { }
        try {
            await pool.query("ALTER TABLE tests ADD COLUMN show_marks BOOLEAN DEFAULT TRUE");
        } catch (e) { }

        await pool.query(`
            CREATE TABLE IF NOT EXISTS questions (
                id VARCHAR(255) PRIMARY KEY,
                test_id VARCHAR(255),
                q TEXT NOT NULL,
                options JSON,
                correct JSON,
                marks INT,
                type VARCHAR(50),
                FOREIGN KEY (test_id) REFERENCES tests(id)
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS assignments (
                id INT AUTO_INCREMENT PRIMARY KEY,
                student_id VARCHAR(255),
                test_id VARCHAR(255),
                FOREIGN KEY (student_id) REFERENCES users(id),
                FOREIGN KEY (test_id) REFERENCES tests(id),
                UNIQUE KEY unique_assignment (student_id, test_id)
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS results (
                id INT AUTO_INCREMENT PRIMARY KEY,
                student_id VARCHAR(255),
                test_id VARCHAR(255),
                score INT,
                answers JSON,
                FOREIGN KEY (student_id) REFERENCES users(id),
                FOREIGN KEY (test_id) REFERENCES tests(id)
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS snapshots (
                id INT AUTO_INCREMENT PRIMARY KEY,
                student_id VARCHAR(255),
                test_id VARCHAR(255),
                image_data LONGTEXT,
                FOREIGN KEY (student_id) REFERENCES users(id),
                FOREIGN KEY (test_id) REFERENCES tests(id)
            )
        `);
        
        await pool.query(`
            CREATE TABLE IF NOT EXISTS messages (
                id INT AUTO_INCREMENT PRIMARY KEY,
                sender_id VARCHAR(255) ,
                sender_name VARCHAR(255),
                receiver_role ENUM('admin', 'student', 'all') NOT NULL,
                receiver_id VARCHAR(255),
                content TEXT NOT NULL,
                timestamp BIGINT NOT NULL,
                admin_id VARCHAR(255)
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS logs (
                id INT AUTO_INCREMENT PRIMARY KEY,
                timestamp VARCHAR(255),
                type VARCHAR(255),
                userId VARCHAR(255),
                details TEXT
            )
        `);

        // Seed Super Admin if not exists
        const [superadminRows] = await pool.query('SELECT * FROM users WHERE id = ?', ['superadmin']);
        if (superadminRows.length === 0) {
            await pool.query('INSERT INTO users (id, name, password, role) VALUES (?, ?, ?, ?)', ['superadmin', 'Super Admin', 'superpass', 'superadmin']);
        } else {
            // Migration: If password is the specific hash provided by the user, update it to 'superpass'
            const currentPass = superadminRows[0].password;
            if (currentPass === '$2b$10$BQ93MPOAuAnSGEr1oFRDoet7L6U.DICjD//DzzeMv.NGdxRN/jOom') {
                await pool.query('UPDATE users SET password = ? WHERE id = ?', ['superpass', 'superadmin']);
                console.log('Superadmin password migrated to "superpass".');
            }
        }

        // Seed Admin if not exists
        const [adminRows] = await pool.query('SELECT * FROM users WHERE role = ?', ['admin']);
        if (adminRows.length === 0) {
            await pool.query('INSERT INTO users (id, name, password, role) VALUES (?, ?, ?, ?)', ['admin', 'Administrator', 'adminpass', 'admin']);
        }
        
        console.log('Database initialized successfully.');
    } catch (err) {
        console.error('Database initialization failed. Please check your MySQL credentials.', err.message);
        process.exit(1);
    }
}

// API Routes

// Login
app.post('/api/login', async (req, res) => {
    const { id, pass, role } = req.body;
    try {
        const [rows] = await pool.query('SELECT * FROM users WHERE id = ? AND password = ? AND role = ?', [id, pass, role]);
        if (rows.length > 0) {
            res.json({ success: true, user: { id: rows[0].id, name: rows[0].name, role: rows[0].role } });
        } else {
            res.status(401).json({ success: false, message: 'Invalid credentials' });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Register Student
app.post('/api/register', async (req, res) => {
    const { id, name, pass, admin_id } = req.body;
    try {
        const [existing] = await pool.query('SELECT id FROM users WHERE id = ?', [id]);
        if (existing.length > 0) {
            return res.status(400).json({ success: false, message: 'Student ID already exists' });
        }
        await pool.query('INSERT INTO users (id, name, password, role, admin_id) VALUES (?, ?, ?, ?, ?)', [id, name, pass, 'student', admin_id || null]);
        res.json({ success: true, message: 'Registration successful' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Change Admin Password (Super Admin Only)
app.post('/api/admin/change-password', async (req, res) => {
    const { admin_id, new_password } = req.body;
    try {
        const [result] = await pool.query('UPDATE users SET password = ? WHERE id = ? AND role = "admin"', [new_password, admin_id]);
        if (result.affectedRows > 0) {
            res.json({ success: true, message: 'Password updated successfully' });
        } else {
            res.status(404).json({ success: false, message: 'Admin not found' });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get Tests
app.get('/api/tests', async (req, res) => {
    try {
        const [tests] = await pool.query('SELECT * FROM tests');
        for (let test of tests) {
            const [questions] = await pool.query('SELECT * FROM questions WHERE test_id = ?', [test.id]);
            test.questions = questions;
        }
        res.json(tests);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Save Test
app.post('/api/tests', async (req, res) => {
    const { id, title, duration, questions, show_marks } = req.body;
    try {
        await pool.query('INSERT INTO tests (id, title, duration, show_marks) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE title=VALUES(title), duration=VALUES(duration), show_marks=VALUES(show_marks)', 
            [id, title, duration, show_marks !== undefined ? show_marks : true]);
        
        await pool.query('DELETE FROM questions WHERE test_id = ?', [id]);
        
        for (let q of questions) {
            await pool.query('INSERT INTO questions (id, test_id, q, options, correct, marks, type) VALUES (?, ?, ?, ?, ?, ?, ?)',
                [q.id, id, q.q, JSON.stringify(q.options), JSON.stringify(q.correct), q.marks, q.type]);
        }
        
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Delete Test
app.delete('/api/tests/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM results WHERE test_id = ?', [req.params.id]);
        await pool.query('DELETE FROM assignments WHERE test_id = ?', [req.params.id]);
        await pool.query('DELETE FROM questions WHERE test_id = ?', [req.params.id]);
        await pool.query('DELETE FROM tests WHERE id = ?', [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get Students
app.get('/api/students', async (req, res) => {
    try {
        const [students] = await pool.query('SELECT id, name FROM users WHERE role = "student"');
        res.json(students);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Delete Student
app.delete('/api/students/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM results WHERE student_id = ?', [req.params.id]);
        await pool.query('DELETE FROM assignments WHERE student_id = ?', [req.params.id]);
        await pool.query('DELETE FROM users WHERE id = ? AND role = "student"', [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Assignments API
app.get('/api/assignments', async (req, res) => {
    try {
        const [assignments] = await pool.query('SELECT student_id, test_id FROM assignments');
        res.json(assignments);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/assignments', async (req, res) => {
    const { studentId, testIds } = req.body;
    try {
        await pool.query('DELETE FROM assignments WHERE student_id = ?', [studentId]);
        for (let tid of testIds) {
            await pool.query('INSERT INTO assignments (student_id, test_id) VALUES (?, ?)', [studentId, tid]);
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Submit Exam Results
app.post('/api/submit', async (req, res) => {
    const { studentId, testId, score, answers } = req.body;
    try {
        await pool.query('INSERT INTO results (student_id, test_id, score, answers) VALUES (?, ?, ?, ?)', 
            [studentId, testId, score, JSON.stringify(answers)]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get Results
app.get('/api/results', async (req, res) => {
    try {
        const [results] = await pool.query('SELECT * FROM results');
        res.json(results);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get Messages
app.get('/api/messages', async (req, res) => {
    const { userId, role, adminId } = req.query;
    try {
        let query = 'SELECT * FROM messages WHERE ';
        let params = [];
        
        if (role === 'superadmin') {
            query += '1=1'; // Super Admin sees everything
        } else if (role === 'admin') {
            // Admin sees:
            // 1. Messages sent to 'admin' (from superadmin)
            // 2. Messages sent to 'all'
            // 3. Messages they sent themselves
            query += '( (receiver_role IN ("admin", "all")) OR (sender_id = ?) )';
            params.push(userId);
        } else if (role === 'student') {
            // Student sees:
            // 1. Messages sent to 'all'
            // 2. Messages sent to 'student' IF (it's from their admin OR it's from superadmin)
            query += '( (receiver_role = "all") OR (receiver_role = "student" AND (admin_id = ? OR sender_id = "superadmin")) )';
            params.push(adminId);
        } else {
            return res.status(403).json({ error: 'Unauthorized' });
        }
        
        query += ' ORDER BY timestamp DESC';
        const [rows] = await pool.query(query, params);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Send Message
app.post('/api/messages', async (req, res) => {
    const { sender_id, sender_name, receiver_role, receiver_id, content, admin_id } = req.body;
    try {
        await pool.query('INSERT INTO messages (sender_id, sender_name, receiver_role, receiver_id, content, timestamp, admin_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [sender_id, sender_name, receiver_role, receiver_id || null, content, Date.now(), admin_id || null]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Factory Reset API
app.post('/api/factory-reset', async (req, res) => {
    try {
        await pool.query('DELETE FROM snapshots');
        await pool.query('DELETE FROM results');
        await pool.query('DELETE FROM assignments');
        await pool.query('DELETE FROM questions');
        await pool.query('DELETE FROM tests');
        await pool.query('DELETE FROM messages');
        await pool.query('DELETE FROM logs');
        await pool.query('DELETE FROM users WHERE role != "superadmin"');
        
        // Re-seed default admin just in case
        await pool.query('INSERT IGNORE INTO users (id, name, password, role) VALUES (?, ?, ?, ?)', 
            ['admin', 'Administrator', 'adminpass', 'admin']);
            
        res.json({ success: true, message: 'System factory reset successful.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Sync API for frontend compatibility
app.get('/api/sync', async (req, res) => {
    try {
        const DB = {
            admin: { id: 'admin', pass: 'adminpass' }, // Legacy single admin fallback
            admins: {},
            students: {},
            tests: [],
            assignments: {},
            results: {}
        };
        
        // Load superadmin / admins
        const [admins] = await pool.query('SELECT id, name, password, role FROM users WHERE role IN ("admin", "superadmin")');
        for (let a of admins) {
            if (a.role === 'admin') {
                DB.admins[a.id] = { name: a.name, pass: a.password };
                if(a.id === 'admin') DB.admin = { id: 'admin', pass: a.password }; // Backwards compatibility for single admin reference
            } else if (a.role === 'superadmin') {
                DB.superadmin = { id: a.id, pass: a.password };
            }
        }
        
        // Load students
        const [students] = await pool.query('SELECT id, name, password, admin_id FROM users WHERE role = "student"');
        for (let s of students) {
            DB.students[s.id] = { name: s.name, pass: s.password, admin_id: s.admin_id };
        }

        // Load tests
        const [tests] = await pool.query('SELECT * FROM tests');
        for (let t of tests) {
            const testObj = { 
                id: t.id, 
                title: t.title, 
                duration: t.duration, 
                admin_id: t.admin_id,
                start_time: t.start_time,
                end_time: t.end_time,
                show_marks: t.show_marks === undefined ? true : !!t.show_marks,
                questions: [] 
            };
            const [questions] = await pool.query('SELECT * FROM questions WHERE test_id = ?', [t.id]);
            for (let q of questions) {
                testObj.questions.push({
                    id: q.id,
                    q: q.q,
                    options: q.options,
                    correct: q.correct,
                    marks: q.marks,
                    type: q.type
                });
            }
            DB.tests.push(testObj);
        }

        // Load assignments
        const [assignments] = await pool.query('SELECT student_id, test_id FROM assignments');
        for (let a of assignments) {
            if (!DB.assignments[a.student_id]) DB.assignments[a.student_id] = [];
            DB.assignments[a.student_id].push(a.test_id);
        }

        // Load results
        const [results] = await pool.query('SELECT * FROM results');
        for (let r of results) {
            if (!DB.results[r.student_id]) DB.results[r.student_id] = {};
            DB.results[r.student_id][r.test_id] = {
                testTitle: DB.tests.find(t => t.id === r.test_id)?.title || 'Unknown',
                score: r.score,
                maxScore: 0, // Not stored directly, but frontend recalculates or we just skip if not needed by UI
                completionTime: Date.now(), // approximation as we didn't store time
                answers: r.answers,
                snapshots: [], // Need to skip snapshots if not stored
                fullScreenOffenses: 0
            };
            // Actually, we should store full result object in JSON if possible.
            // Let's modify the sync to just use JSON for results to match frontend perfectly.
        }

        // Let's improve the GET to match the DB object exactly
        const [allResults] = await pool.query('SELECT student_id, test_id, answers FROM results');
        for (let r of allResults) {
            if (!DB.results[r.student_id]) DB.results[r.student_id] = {};
            
            let parsedResult = typeof r.answers === 'string' ? JSON.parse(r.answers) : r.answers;
            parsedResult.snapshots = [];

            // Load snapshots from the separate table
            const [snaps] = await pool.query('SELECT image_data FROM snapshots WHERE student_id = ? AND test_id = ?', [r.student_id, r.test_id]);
            for (let snap of snaps) {
                parsedResult.snapshots.push(snap.image_data);
            }

            DB.results[r.student_id][r.test_id] = parsedResult;
        }

        // Load logs
        const [logs] = await pool.query('SELECT timestamp, type, userId, details FROM logs ORDER BY id DESC LIMIT 200');
        DB.logs = logs;

        res.json(DB);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/sync', async (req, res) => {
    const DB = req.body;
    try {
        // Sync logs
        if (DB.logs) {
            await pool.query('DELETE FROM logs');
            for (let log of DB.logs) {
                await pool.query('INSERT INTO logs (timestamp, type, userId, details) VALUES (?, ?, ?, ?)',
                    [log.timestamp, log.type, log.userId, log.details]);
            }
        }
        // Sync students and admins
        // First, make sure we only sync roles correctly
        for (let id in DB.students) {
            const s = DB.students[id];
            await pool.query('INSERT INTO users (id, name, password, role, admin_id) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE name=VALUES(name), password=VALUES(password), admin_id=VALUES(admin_id)',
                [id, s.name, s.pass, 'student', s.admin_id || null]);
        }
        
        if (DB.admins) {
            for (let id in DB.admins) {
                const a = DB.admins[id];
                await pool.query('INSERT INTO users (id, name, password, role) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE name=VALUES(name), password=VALUES(password)',
                    [id, a.name, a.pass, 'admin']);
            }
        }

        // Sync tests
        for (let t of DB.tests) {
            await pool.query('INSERT INTO tests (id, title, duration, admin_id, start_time, end_time, show_marks) VALUES (?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE title=VALUES(title), duration=VALUES(duration), admin_id=VALUES(admin_id), start_time=VALUES(start_time), end_time=VALUES(end_time), show_marks=VALUES(show_marks)',
                [t.id, t.title, t.duration, t.admin_id || null, t.start_time || null, t.end_time || null, t.show_marks !== undefined ? t.show_marks : true]);
            
            for (let q of t.questions) {
                await pool.query('INSERT INTO questions (id, test_id, q, options, correct, marks, type) VALUES (?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE q=VALUES(q), options=VALUES(options), correct=VALUES(correct), marks=VALUES(marks), type=VALUES(type)',
                    [q.id, t.id, q.q, JSON.stringify(q.options), JSON.stringify(q.correct), q.marks, q.type]);
            }
        }

        // Sync assignments
        await pool.query('DELETE FROM assignments'); // clear all and reinsert
        for (let student_id in DB.assignments) {
            for (let test_id of DB.assignments[student_id]) {
                await pool.query('INSERT IGNORE INTO assignments (student_id, test_id) VALUES (?, ?)', [student_id, test_id]);
            }
        }

        // Sync results and snapshots
        await pool.query('DELETE FROM snapshots'); // clear all and reinsert
        await pool.query('DELETE FROM results');
        for (let student_id in DB.results) {
            for (let test_id in DB.results[student_id]) {
                const resultObj = DB.results[student_id][test_id];
                
                // Extract snapshots array
                const snapshots = resultObj.snapshots || [];
                // Store result without snapshots to save space in the JSON column
                const resultObjToStore = { ...resultObj, snapshots: [] };

                await pool.query('INSERT INTO results (student_id, test_id, score, answers) VALUES (?, ?, ?, ?)',
                    [student_id, test_id, resultObjToStore.score, JSON.stringify(resultObjToStore)]);
                
                // Insert each snapshot into the dedicated table
                for (let snap of snapshots) {
                    await pool.query('INSERT INTO snapshots (student_id, test_id, image_data) VALUES (?, ?, ?)',
                        [student_id, test_id, snap]);
                }
            }
        }

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
(async () => {
    await initDb();
    app.listen(PORT, () => {
        console.log(`Server running on http://localhost:${PORT}`);
    });
})();
