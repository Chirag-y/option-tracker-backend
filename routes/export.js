const router = require("express").Router();
const Trade = require("../models/Trade");

router.get("/trades", async (req, res) => {
  const trades = await Trade.find();
  let csv = "Instrument,OptionType,FinalAmount\n";
  trades.forEach(t => {
    csv += `${t.instrument},${t.optionType},${t.finalAmount}\n`;
  });
  res.header("Content-Type", "text/csv");
  res.send(csv);
});

module.exports = router;