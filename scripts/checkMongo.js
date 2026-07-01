const mongoose = require('mongoose');
mongoose.connect('mongodb+srv://railway_db_access311:2ERiDjZx9QtoY4I6@cluster0.qpbzfpf.mongodb.net/?appName=Cluster0').then(async () => {
  const IntradayCandle = mongoose.models.IntradayCandle || mongoose.model('IntradayCandle', new mongoose.Schema({}, {strict: false}));
  const last = await IntradayCandle.findOne({ symbol: 'RELIANCE' }).sort({ date: -1 });
  console.log(last.date);
  process.exit(0);
});
