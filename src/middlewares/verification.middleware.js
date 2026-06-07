const jwt = require("jsonwebtoken");
const User = require("../models/user.model");
const { statusCodeTemplate } = require("../utils/api.utils");

const verifyToken = (req, res, next) => {
  const jwtSecret = process.env.JWT_SECRET;
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return statusCodeTemplate(res, 401, "Bearer Token missing.");
  }

  const token = authHeader.split(" ")[1];

  try {
    const decoded = jwt.verify(token, jwtSecret);
    req.user = decoded;
    next();
  } catch (error) {
    return statusCodeTemplate(res, 403, "Invalid or expired token");
  }
};

const loadUser = async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id).select("-password");
    if (!user) {
      return statusCodeTemplate(res, 404, "User not found.");
    }

    req.user = {
      id: user._id.toString(),
      role: user.role,
    };
    next();
  } catch (error) {
    return statusCodeTemplate(res, 500, "Internal Server Error");
  }
};

const verifyRole = (requiredRoles) => {
  return (req, res, next) => {
    if (!req.user?.role) {
      return statusCodeTemplate(res, 403, "Access denied");
    }

    const roles = Array.isArray(requiredRoles)
      ? requiredRoles
      : [requiredRoles];

    if (!roles.includes(req.user.role)) {
      return statusCodeTemplate(res, 403, "Access denied");
    }

    next();
  };
};

const verifySelfOrAdmin = (paramName = "userId") => {
  return (req, res, next) => {
    const targetId = req.params[paramName] || req.params.id;
    const isSelf = req.user?.id === targetId;
    const isAdmin = req.user?.role === "admin";

    if (!isSelf && !isAdmin) {
      return statusCodeTemplate(res, 403, "Access denied");
    }

    next();
  };
};

module.exports = {
  verifyToken,
  loadUser,
  verifyRole,
  verifySelfOrAdmin,
};
