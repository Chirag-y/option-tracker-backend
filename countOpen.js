const mongoose = require('mongoose');
mongoose.connect('mongodb://127.0.0.1:27017/trade_screener').then(async () => {
  const FoActiveTrade = require('./models/FoActiveTrade');
  const open = await FoActiveTrade.countDocuments({ status: 'OPEN' });
  const total = await FoActiveTrade.countDocuments();
  console.log({open, total});
  process.exit(0);
});
