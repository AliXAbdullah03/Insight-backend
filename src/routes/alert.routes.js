const express = require("express");
const alertController = require("../controllers/alert.controller");
const { requireOrgToken } = require("../middlewares/org.middleware");

const router = express.Router();

// Garage PC webhook — org token in body/header (not end-user session)
router.post("/", alertController.receiveGarageAlert);

// All mobile consumer routes require org token
router.get("/", requireOrgToken, alertController.listAlerts);
router.get("/events", requireOrgToken, alertController.listGarageEvents);
router.get("/live", requireOrgToken, alertController.listLiveAlerts);
router.get("/camera-status", requireOrgToken, alertController.listCameraStatus);
router.get("/stream", requireOrgToken, alertController.streamAlerts);
router.post("/device-token", requireOrgToken, alertController.registerPushToken);

router.get("/:alert_id", requireOrgToken, alertController.getAlertById);
router.patch("/:alert_id/read", requireOrgToken, alertController.markAlertRead);

module.exports = router;
