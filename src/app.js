const express = require("express");
const cors = require("cors");

const app = express();
const authRoutes = require("./routes/auth.routes");
const departmentRoutes = require("./routes/department.routes");
const profileRoutes = require("./routes/profile.routes");
const logRoutes = require("./routes/logs.routes");
const branchRoutes = require("./routes/branch.routes");
const adminRoutes = require("./routes/admin.routes");
const alertRoutes = require("./routes/alert.routes");
const orgRoutes = require("./routes/org.routes");
const orgAdminRoutes = require("./routes/orgAdmin.routes");
const aiProxyRoutes = require("./routes/aiProxy.routes");
const mobileRoutes = require("./routes/mobile.routes");
const orgController = require("./controllers/org.controller");
const authController = require("./controllers/auth.controller");
const { verifyToken } = require("./middlewares/verification.middleware");
const apiRouter = express.Router();

const corsOptions = process.env.ALLOWED_ORIGINS
  ? {
      origin: process.env.ALLOWED_ORIGINS.split(",").map((origin) =>
        origin.trim()
      ),
    }
  : undefined;

app.use(cors(corsOptions));
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

apiRouter.use("/auth", authRoutes);
apiRouter.use("/org", orgRoutes);
apiRouter.get("/violations", orgController.listViolations);
apiRouter.get("/status", orgController.listOrgCameraStatus);
apiRouter.get("/persons", orgController.listPersons);
apiRouter.get("/analytics/dashboard", orgController.getAnalyticsDashboard);
apiRouter.get("/analytics/today", orgController.getAnalyticsToday);
apiRouter.get("/analytics/history", orgController.listDailyAnalytics);
apiRouter.get("/analytics/employees", orgController.listEmployees);
apiRouter.get(
  "/analytics/employees/:person_id",
  orgController.getEmployeeProfile
);
apiRouter.get("/analytics/insights", orgController.listInsights);
apiRouter.use("/mobile", mobileRoutes);
apiRouter.use(mobileRoutes);
apiRouter.use("/ai", aiProxyRoutes);
apiRouter.use("/department", departmentRoutes);
apiRouter.use("/profile", profileRoutes);
apiRouter.use("/logs", logRoutes);
apiRouter.use("/branch", branchRoutes);
// Org admin helpers must be registered before JWT-protected /admin user routes.
apiRouter.use("/admin", orgAdminRoutes);
apiRouter.use("/admin", adminRoutes);
apiRouter.use("/alerts", alertRoutes);

// Legacy paths used by the mobile app
apiRouter.post("/reset-password", authController.resetPassword);
apiRouter.post("/change-password", verifyToken, authController.changePassword);

app.use("/api", apiRouter);

// Garage mobile APIs (org token only — no separate API key)
app.use("/mobile", mobileRoutes);

// Garage notifier expects MOBILE_BACKEND_URL=.../alerts (not under /api)
app.use("/alerts", alertRoutes);

app.use((req, res) => {
  res.status(404).json({ message: "Route not found." });
});

app.use((error, req, res, next) => {
  console.error("Unhandled error:", error);
  res.status(500).json({ message: "Internal Server Error" });
});

module.exports = { app };
