const router = require("express").Router();
const User = require("../models/User");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const auth = require("../middlewares/auth.middleware");

router.post("/register", async (req, res) => {
  try {
    const { name, email, password, teamCode, investedAmount, sharePercentage } = req.body;

    if (!name || !email || !password || !teamCode) {
      return res.status(400).json({ message: "name, email, password and teamCode are required" });
    }
    if (password.length < 6) {
      return res.status(400).json({ message: "Password must be at least 6 characters" });
    }

    const normalizedEmail = String(email).toLowerCase().trim();
    const normalizedTeamCode = String(teamCode).trim().toUpperCase();
    const exists = await User.findOne({ email: normalizedEmail, teamCode: normalizedTeamCode });
    if (exists) {
      return res.status(409).json({ message: "User already exists in this team" });
    }

    const safeInvested = Number(investedAmount || 0);
    const safeShare = Number(sharePercentage || 0);
    const hashed = await bcrypt.hash(password, 10);
    const user = await User.create({
      name,
      email: normalizedEmail,
      password: hashed,
      teamCode: normalizedTeamCode,
      isVerified: false,
      investedAmount: safeInvested,
      currentBalance: safeInvested,
      sharePercentage: safeShare
    });

    res.status(201).json({
      id: user._id,
      name: user.name,
      email: user.email,
      teamCode: user.teamCode,
      isVerified: user.isVerified,
      message: "Registration submitted. Account will be active after admin approval."
    });
  } catch (err) {
    res.status(500).json({ message: "Failed to register user" });
  }
});

router.post("/login", async (req, res) => {
  try {
    const { email, password, teamCode } = req.body;
    if (!email || !password || !teamCode) {
      return res.status(400).json({ message: "email, password and teamCode are required" });
    }

    const normalizedEmail = String(email).toLowerCase().trim();
    const normalizedTeamCode = String(teamCode).trim().toUpperCase();
    const user = await User.findOne({ email: normalizedEmail, teamCode: normalizedTeamCode });
    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({ message: "Invalid credentials" });
    }
    if (!user.isVerified) {
      return res.status(403).json({ message: "Account pending approval. Contact admin." });
    }

    const token = jwt.sign(
      { id: user._id, teamCode: user.teamCode },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );
    res.json({
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        teamCode: user.teamCode,
        isVerified: user.isVerified,
        investedAmount: user.investedAmount,
        sharePercentage: user.sharePercentage,
        currentBalance: user.currentBalance
      }
    });
  } catch (err) {
    res.status(500).json({ message: "Failed to login" });
  }
});

router.get("/me", auth, async (req, res) => {
  try {
    const user = await User.findOne({ _id: req.user.id, teamCode: req.user.teamCode }).select("-password");
    if (!user) return res.status(404).json({ message: "User not found" });
    res.json(user);
  } catch (err) {
    res.status(500).json({ message: "Failed to load profile" });
  }
});

module.exports = router;
