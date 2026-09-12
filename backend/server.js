const mongoose = require('mongoose');
const dns = require('dns');
const dotenv = require('dotenv');

// Change DNS for mongoDB to connect to Atlas
dns.setServers(["1.1.1.1", "8.8.8.8"]);

// Connect to the config.env
dotenv.config({ path: './config.env'});

// Import the local module file
const app = require('./app');

// PORT SERVER
const port = process.env.PORT || 3000;

// Connect to the Moongose Atlas Database

// Start the server.js
app.listen(port, () => {
  console.log(`App running on port ${port}...`);
});