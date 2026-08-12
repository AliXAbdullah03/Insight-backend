const express = require("express");
const orgController = require("../controllers/org.controller");

const router = express.Router();

// Garage-style admin helpers (protected by MOBILE_BACKEND_TOKEN when set)
router.post("/organizations", orgController.createOrganization);
router.post(
  "/organizations/:org_id/rotate-token",
  orgController.rotateOrganizationToken
);

module.exports = router;
