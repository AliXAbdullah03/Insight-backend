const express = require("express");
const {
  verifyToken,
  loadUser,
  verifyRole,
} = require("../middlewares/verification.middleware");
const branchController = require("../controllers/branch.controller");

const router = express.Router();

router.post(
  "/add-branch",
  verifyToken,
  loadUser,
  verifyRole(["admin"]),
  branchController.addBranch
);
router.put(
  "/update-branch/:branchId",
  verifyToken,
  loadUser,
  verifyRole(["admin"]),
  branchController.updateBranch
);
router.delete(
  "/delete-branch/:branchId",
  verifyToken,
  loadUser,
  verifyRole(["admin"]),
  branchController.deleteBranch
);

router.get("/get-all-branches", branchController.getAllBranches);
router.get("/get-branch/:branchId", branchController.getBranchById);

module.exports = router;
