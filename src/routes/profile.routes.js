const express = require("express");
const {
  verifyToken,
  loadUser,
  verifySelfOrAdmin,
} = require("../middlewares/verification.middleware");
const profileController = require("../controllers/profile.controller");

const router = express.Router();

router.get(
  "/get-profile/:id",
  verifyToken,
  loadUser,
  verifySelfOrAdmin("id"),
  profileController.getProfile
);
router.put(
  "/update-profile/:userId",
  verifyToken,
  loadUser,
  verifySelfOrAdmin("userId"),
  profileController.updateProfile
);

module.exports = router;
