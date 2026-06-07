require("dotenv").config();

const { app } = require("./app");
const connectDB = require("./db");

const port = process.env.PORT || 3000;

(async () => {
  try {
    await connectDB();
    app.listen(port, () => {
      console.log(`Listening on ${port}.`);
    });
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
})();
