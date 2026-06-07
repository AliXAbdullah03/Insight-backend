const mongoose = require("mongoose");

const resolveMongoUri = () => {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    throw new Error("MONGO_URI is not set.");
  }

  const hasDatabaseName = /mongodb(\+srv)?:\/\/[^/]+\/[^/?]+/.test(uri);
  if (hasDatabaseName) {
    return uri;
  }

  const dbName = process.env.MONGO_DB_NAME || "insight";
  const separator = uri.includes("?") ? "&" : "?";
  return uri.replace(/\/?(\?|$)/, `/${dbName}$1`);
};

const connectDB = async () => {
  const connectionUri = resolveMongoUri();

  try {
    console.log("DB Connection in progress.");
    await mongoose.connect(connectionUri);
    console.log(`Connected successfully to DB (${mongoose.connection.name}).`);
  } catch (error) {
    console.error(
      `Error connecting to the database. The following error occured: ${error}`
    );
    process.exit(1);
  }
};

module.exports = connectDB;
