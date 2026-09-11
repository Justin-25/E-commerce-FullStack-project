const express = require('express');

// Start express app
const app = express();

// Body parser - reads incoming JSON and convert it to req.body
app.use(express.json({ limit: '10kb' }));

// ROUTES

// Global Error Handling

// Exports app for server.js
module.exports = app;