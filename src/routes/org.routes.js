const express = require("express");
const orgController = require("../controllers/org.controller");

const router = express.Router();

// Token is validated against Mongo org_tokens
router.get("/me", orgController.getOrgMe);

module.exports = router;
