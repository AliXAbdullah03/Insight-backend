const express = require("express");
const alertController = require("../controllers/alert.controller");

const router = express.Router();

// Garage PC → mobile backend webhook (instant popup trigger)
router.post("/", alertController.receiveGarageAlert);

// Mobile app consumers
router.get("/events", alertController.listGarageEvents);
router.get("/live", alertController.listLiveAlerts);
router.get("/camera-status", alertController.listCameraStatus);
router.get("/stream", alertController.streamAlerts);

module.exports = router;
