const express = require("express");
const orgController = require("../controllers/org.controller");

const router = express.Router();

router.get("/me", orgController.getOrgMe);
router.get("/violations", orgController.listViolations);
router.get("/status", orgController.listOrgCameraStatus);
router.get("/persons", orgController.listPersons);
router.get("/analytics/dashboard", orgController.getAnalyticsDashboard);
router.get("/analytics/today", orgController.getAnalyticsToday);
router.get("/analytics/history", orgController.listDailyAnalytics);
router.get("/analytics/employees", orgController.listEmployees);
router.get(
  "/analytics/employees/:person_id",
  orgController.getEmployeeProfile
);
router.get("/analytics/insights", orgController.listInsights);
router.get("/snapshots", orgController.listSnapshots);
router.get("/media", orgController.proxyMedia);

module.exports = router;
