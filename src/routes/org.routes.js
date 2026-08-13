const express = require("express");
const orgController = require("../controllers/org.controller");

const router = express.Router();

// Token is validated by proxying to garage AI /mobile/me (no local Mongo required).
router.get("/me", orgController.getOrgMe);

module.exports = router;
