const mongoose = require('mongoose');
const FoActiveTrade = require('./models/FoActiveTrade');
mongoose.connect('mongodb://127.0.0.1:27017/test').then(async () => {
  const count = await FoActiveTrade.countDocuments();
  console.log('Total F&O Trades:', count);
  process.exit();
});
