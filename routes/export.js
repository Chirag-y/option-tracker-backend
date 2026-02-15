const router = require("express").Router();
const Trade = require("../models/Trade");
const auth = require("../middlewares/auth.middleware");

router.get("/trades", auth, async (req, res) => {
  try {
    const trades = await Trade.find({ teamCode: req.user.teamCode }).sort({ tradeDate: 1 });
    let csv = "Date,Instrument,OptionType,ResultType,Amount,Charges,FinalAmount\n";
    trades.forEach((t) => {
      csv += `${new Date(t.tradeDate).toISOString().slice(0, 10)},${t.instrument},${t.optionType},${t.resultType},${t.amount},${t.charges},${t.finalAmount}\n`;
    });
    res.header("Content-Type", "text/csv");
    res.header("Content-Disposition", "attachment; filename=trades.csv");
    res.send(csv);
  } catch (err) {
    res.status(500).json({ message: "Failed to export trades" });
  }
});

module.exports = router;
