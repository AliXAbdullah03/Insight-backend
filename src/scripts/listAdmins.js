const mongoose = require("mongoose");
const connectDB = require("../db");
const User = require("../models/user.model");

(async () => {
  try {
    if (!process.env.MONGO_URI) {
      console.error("MONGO_URI is not set. Provide it as an environment variable.");
      process.exit(1);
    }

    await connectDB();

    const admins = await User.find({ role: "admin" })
      .select("name email role")
      .sort({ name: 1 })
      .lean();

    if (!admins.length) {
      console.log("No admin users found.");
    } else {
      console.log(`Found ${admins.length} admin user(s):`);
      for (const admin of admins) {
        const name = admin.name || "<no name>";
        const email = admin.email || "<no email>";
        console.log(`- ${name} <${email}>`);
      }
    }
  } catch (err) {
    console.error("Error while listing admin users:", err);
    process.exitCode = 1;
  } finally {
    try {
      await mongoose.disconnect();
    } catch (_) {}
  }
})();










