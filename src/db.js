const dns = require("dns");
const mongoose = require("mongoose");

// Windows/router DNS often refuses MongoDB Atlas SRV lookups (querySrv ECONNREFUSED).
// Prefer public resolvers before any mongodb+srv connect attempt.
try {
  dns.setServers(["8.8.8.8", "1.1.1.1", "8.8.4.4"]);
} catch (_) {
  // ignore if platform disallows overriding resolvers
}

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
  return uri.replace(/\/?(\?|$)/, `/${dbName}$1`);
};

const startMemoryMongo = async () => {
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const dbName = process.env.MONGO_DB_NAME || "insight";
  const memoryServer = await MongoMemoryServer.create({
    instance: { dbName },
  });
  global.__INSIGHT_MEMORY_MONGO__ = memoryServer;
  console.log("Started in-memory MongoDB for local development.");
  return memoryServer.getUri(dbName);
};

const connectWithUri = async (connectionUri) => {
  console.log("DB Connection in progress.");
  await mongoose.connect(connectionUri);
  console.log(`Connected successfully to DB (${mongoose.connection.name}).`);
};

const connectDB = async () => {
  const preferMemory =
    process.env.MONGO_USE_MEMORY === "true" ||
    process.env.MONGO_USE_MEMORY === "1";

  if (preferMemory) {
    try {
      await connectWithUri(await startMemoryMongo());
      return;
    } catch (memoryError) {
      console.error(`In-memory MongoDB failed: ${memoryError}`);
      process.exit(1);
    }
  }

  try {
    await connectWithUri(resolveMongoUri());
  } catch (error) {
    const isSrvOrDnsFailure =
      error?.code === "ECONNREFUSED" ||
      error?.code === "ENOTFOUND" ||
      /querySrv|ECONNREFUSED|ENOTFOUND|getaddrinfo/i.test(String(error));

    if (isSrvOrDnsFailure) {
      console.warn(
        `Primary MongoDB unreachable (${error.message}). Falling back to in-memory MongoDB.`
      );
      try {
        await connectWithUri(await startMemoryMongo());
        return;
      } catch (memoryError) {
        console.error(`In-memory MongoDB fallback also failed: ${memoryError}`);
        process.exit(1);
      }
    }

    console.error(
      `Error connecting to the database. The following error occured: ${error}`
    );
    process.exit(1);
  }
};

module.exports = connectDB;
