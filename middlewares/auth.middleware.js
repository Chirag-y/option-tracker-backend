const jwt = require("jsonwebtoken");

module.exports = (req, res, next) => {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ message: "Unauthorized" });

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = {
      id: payload.id,
      teamCode: payload.teamCode,
      email: payload.email,
      isAdmin: Boolean(payload.isAdmin)
    };
    next();
  } catch (err) {
    res.status(401).json({ message: "Invalid token" });
  }
};
