const express = require("express");
const orgController = require("../controllers/org.controller");
const { requireOrgToken } = require("../middlewares/org.middleware");

const router = express.Router();

router.get("/me", requireOrgToken, orgController.getOrgMe);

module.exports = router;
