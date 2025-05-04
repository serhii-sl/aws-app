const express = require('express');
const cors = require('cors');
const { Client } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

const dbConfig = {
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: parseInt(process.env.DB_PORT || '5432', 10),
    ssl: {
        rejectUnauthorized: false, // allow self-signed certs (ok for AWS RDS)
    },
};

const client = new Client(dbConfig);

client.connect()
    .then(() => {
        console.log('Connected to PostgreSQL database');
    })
    .catch((err) => {
        console.error('Error connecting to PostgreSQL:', err.message);
    });

// API route
app.get('/api/hello', async (req, res) => {
    try {
        const result = await client.query('SELECT NOW()'); // simple test query
        res.json({ message: 'Hello from backend (Node.js)', time: result.rows[0].now });
    } catch (err) {
        res.status(500).json({ error: 'Database error', detail: err.message });
    }
});

// Root route
app.get('/', (req, res) => {
    res.send('Backend is running');
});

// Start server
app.listen(PORT, () => {
    console.log(`Backend listening on port ${PORT}`);
});