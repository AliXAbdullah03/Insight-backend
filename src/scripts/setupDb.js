require("dotenv").config({ path: require("path").join(__dirname, "../../.env") });

const mongoose = require("mongoose");
const connectDB = require("../db");
const User = require("../models/user.model");
const Branch = require("../models/branch.model");
const Department = require("../models/department.model");
const UserStatus = require("../models/userStatus.model");
const UserIncidents = require("../models/userIncidents.model");
const UserBehaviours = require("../models/userBehaviours.model");

const MODELS = [
  { name: "users", model: User },
  { name: "branches", model: Branch },
  { name: "departments", model: Department },
  { name: "user_status", model: UserStatus },
  { name: "user_incidents", model: UserIncidents },
  { name: "user_behaviours", model: UserBehaviours },
];

const ensureCollections = async () => {
  const db = mongoose.connection.db;
  const existing = new Set(
    (await db.listCollections().toArray()).map((collection) => collection.name)
  );

  for (const { name, model } of MODELS) {
    if (!existing.has(name)) {
      await db.createCollection(name);
      console.log(`Created collection: ${name}`);
    } else {
      console.log(`Collection already exists: ${name}`);
    }

    await model.createIndexes();
    console.log(`Synced indexes for: ${name}`);
  }
};

const seedAdmin = async () => {
  const adminEmail = process.env.SEED_ADMIN_EMAIL || "admin@smartinsight.com";
  const adminPassword = process.env.SEED_ADMIN_PASSWORD || "Admin@123456";
  const adminName = process.env.SEED_ADMIN_NAME || "System Admin";

  const existingAdmin = await User.findOne({ email: adminEmail });
  if (existingAdmin) {
    console.log(`Seed admin already exists: ${adminEmail}`);
    return;
  }

  await User.create({
    name: adminName,
    email: adminEmail,
    password: adminPassword,
    role: "admin",
  });

  console.log(`Created seed admin user: ${adminEmail}`);
  console.log("Default password: (value of SEED_ADMIN_PASSWORD or Admin@123456)");
};

const run = async () => {
  try {
    await connectDB();
    console.log("Setting up database collections and indexes...");
    await ensureCollections();
    await seedAdmin();
    console.log("Database setup completed successfully.");
  } catch (error) {
    console.error("Database setup failed:", error);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
};

run();
