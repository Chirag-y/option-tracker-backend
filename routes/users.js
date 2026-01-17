const router = require("express").Router();
const User = require("../models/User");

router.get("/balances", async (req, res) => {
  res.json(await User.find());
});

module.exports = router;