const mongoose = require('mongoose');
async function count() {
    await mongoose.connect('mongodb+srv://railway_db_access311:2ERiDjZx9QtoY4I6@cluster0.qpbzfpf.mongodb.net/?appName=Cluster0');
    const FoActiveTrade = mongoose.model('FoActiveTrade', new mongoose.Schema({}, {strict: false}));
    
    const results = await FoActiveTrade.aggregate([
        { $group: { _id: '$scannerId', count: { $sum: 1 } } }
    ]);
    console.log(results);
    process.exit(0);
}
count();
