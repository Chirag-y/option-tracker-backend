const router = require("express").Router();
const Trade = require("../models/Trade");

router.get("/daily", async (req, res) => {
  res.json(await Trade.aggregate([
    { $group: { _id: { $dayOfMonth: "$tradeDate" }, total: { $sum: "$finalAmount" } } }
  ]));
});

router.get("/monthly", async (req, res) => {
  res.json(await Trade.aggregate([
    { $group: { _id: { $month: "$tradeDate" }, total: { $sum: "$finalAmount" } } }
  ]));
});

module.exports = router;