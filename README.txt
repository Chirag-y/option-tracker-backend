ADD TO server.js:
app.use('/api/trades', require('./routes/trade.routes'));
app.use('/api/calendar', require('./routes/calendar.routes'));
app.use('/api/charts', require('./routes/chart.routes'));