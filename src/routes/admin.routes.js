const express = require("express");
const {
  verifyToken,
  loadUser,
  verifyRole,
} = require("../middlewares/verification.middleware");
const adminController = require("../controllers/admin.controller");

const router = express.Router();

router.use(verifyToken, loadUser, verifyRole(["admin"]));

router.post("/add-user", adminController.addUser);
router.get("/get-all-users", adminController.getAllUsers);
router.get("/get-user/:userId", adminController.getUserById);
router.put("/update-user/:userId", adminController.updateUser);
router.delete("/delete-user/:userId", adminController.deleteUser);

module.exports = router;
