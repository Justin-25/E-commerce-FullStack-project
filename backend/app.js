const express = require('express');
const cookieParser = require('cookie-parser');
const userRouter = require('./routes/userRoutes');

// Start express app
const app = express();

// Body parser - reads incoming JSON and convert it to req.body
app.use(express.json({ limit: '10kb' }));

// Cookie parser
app.use(cookieParser());

// ROUTES
app.use('/api/users', userRouter);

// Global Error Handling

// Exports app for server.js
module.exports = app;