const mongoose = require('mongoose');
const dns = require('dns');
const dotenv = require('dotenv');

// Change DNS for mongoDB to connect to Atlas
dns.setServers(["1.1.1.1", "8.8.8.8"]);

// Connect to the config.env
dotenv.config({ path: './config.env'});

// Import the local module file
const app = require('./app');
const { connectRedis } = require('./config/redis');

// PORT SERVER
const port = process.env.PORT || 3000;

// Connect to the Moongose Atlas Database
const databaseUrl = process.env.DATABASE_URL.replace(
  '<PASSWORD>',
  process.env.DATABASE_PASSWORD
);


const startServer = async () => {
  try {
    await mongoose.connect(databaseUrl);
      console.log('MongoDB connected successfully!')

    await connectRedis();

    app.listen(port, () => {
      console.log(`Server running on port ${port}...`);
    });
  } catch (error) {
    console.error('Startup failed:', error);
    process.exit(1);
  }
}

startServer();