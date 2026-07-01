/**
 * Momentum Tracker Clone V10 - JavaScript Implementation
 * Assumes data is an array of objects ordered from oldest to newest:
 * [{ time: Date, open: number, high: number, low: number, close: number, volume: number }]
 */
function calculateMomentumTrackerV10(data) {
    //--- INPUTS / CONFIGURATION ---
    const volLen = 20;
    const stFactor = 1.2;
    const stAtrLen = 7;
    const rsiLen = 14;

    if (data.length < Math.max(volLen, stAtrLen * 2, rsiLen * 2)) {
        return []; // Not enough data to calculate metrics reliably
    }

    //--- HELPER FUNCTIONS FOR INDICATORS ---
    
    // Simple Moving Average
    function getSMA(values, period) {
        let sma = new Array(values.length).fill(null);
        let sum = 0;
        for (let i = 0; i < values.length; i++) {
            sum += values[i];
            if (i >= period - 1) {
                sma[i] = sum / period;
                sum -= values[i - period + 1];
            }
        }
        return sma;
    }

    // Relative Strength Index (RSI)
    function getRSI(closes, period) {
        let rsi = new Array(closes.length).fill(null);
        if (closes.length <= period) return rsi;

        let gains = 0;
        let losses = 0;

        // First RSI value
        for (let i = 1; i <= period; i++) {
            let diff = closes[i] - closes[i - 1];
            if (diff > 0) gains += diff;
            else losses -= diff;
        }

        let avgGain = gains / period;
        let avgLoss = losses / period;
        rsi[period] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));

        // Smooth the rest
        for (let i = period + 1; i < closes.length; i++) {
            let diff = closes[i] - closes[i - 1];
            let gain = diff > 0 ? diff : 0;
            let loss = diff < 0 ? -diff : 0;

            avgGain = (avgGain * (period - 1) + gain) / period;
            avgLoss = (avgLoss * (period - 1) + loss) / period;

            rsi[i] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
        }
        return rsi;
    }

    // True Range & Average True Range (ATR)
    function getATR(highs, lows, closes, period) {
        let tr = new Array(closes.length).fill(0);
        let atr = new Array(closes.length).fill(null);

        tr[0] = highs[0] - lows[0];
        for (let i = 1; i < closes.length; i++) {
            tr[i] = Math.max(
                highs[i] - lows[i],
                Math.abs(highs[i] - closes[i - 1]),
                Math.abs(lows[i] - closes[i - 1])
            );
        }

        // Wilder's Moving Average for ATR
        let sum = 0;
        for (let i = 0; i < period; i++) {
            sum += tr[i];
        }
        atr[period - 1] = sum / period;

        for (let i = period; i < closes.length; i++) {
            atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period;
        }
        return { tr, atr };
    }

    // Supertrend (returns arrays for 'st' and 'dir')
    function getSupertrend(highs, lows, closes, factor, period) {
        const { atr } = getATR(highs, lows, closes, period);
        let st = new Array(closes.length).fill(null);
        let dir = new Array(closes.length).fill(1); // 1 = Bull, -1 = Bear

        let upperBand = new Array(closes.length).fill(0);
        let lowerBand = new Array(closes.length).fill(0);

        for (let i = 0; i < closes.length; i++) {
            if (atr[i] === null) continue;

            let basicUpper = (highs[i] + lows[i]) / 2 + factor * atr[i];
            let basicLower = (highs[i] + lows[i]) / 2 - factor * atr[i];

            upperBand[i] = (basicUpper < upperBand[i - 1] || closes[i - 1] > upperBand[i - 1]) ? basicUpper : upperBand[i - 1];
            lowerBand[i] = (basicLower > lowerBand[i - 1] || closes[i - 1] < lowerBand[i - 1]) ? basicLower : lowerBand[i - 1];

            if (i > 0) {
                dir[i] = dir[i - 1];
                if (dir[i - 1] === 1 && closes[i] < lowerBand[i]) {
                    dir[i] = -1;
                } else if (dir[i - 1] === -1 && closes[i] > upperBand[i]) {
                    dir[i] = 1;
                }
            }
            st[i] = dir[i] === 1 ? lowerBand[i] : upperBand[i];
        }
        return { st, dir };
    }

    //--- EXTRACT DATA ARRAYS ---
    const opens = data.map(d => d.open);
    const highs = data.map(d => d.high);
    const lows = data.map(d => d.low);
    const closes = data.map(d => d.close);
    const volumes = data.map(d => d.volume);
    
    // Support either time or date field
    const times = data.map(d => new Date(d.time || d.date));

    //--- CALCULATE INDICATORS ---
    const volMA = getSMA(volumes, volLen);
    const rsi = getRSI(closes, rsiLen);
    const sma50 = getSMA(closes, 50);
    const { st, dir } = getSupertrend(highs, lows, closes, stFactor, stAtrLen);

    //--- STATE TRACKING ---
    let trendState = 0; // 0 = Neutral, 1 = Long Active, -1 = Short Active
    let results = [];

    //--- LOOP THROUGH DATA SERIES ---
    for (let i = 1; i < data.length; i++) {
        // Skip iterations until indicator calculations are fully ready
        if (volMA[i] === null || rsi[i] === null || rsi[i - 1] === null || st[i] === null || sma50[i] === null) {
            results.push({ time: data[i].time || data[i].date, signal: "NEUTRAL", date: data[i].date || data[i].time });
            continue;
        }

        // 1. Time Filter (9:15 AM check and 14:55 PM check)
        const currentHour = times[i].getHours();
        const currentMinute = times[i].getMinutes();
        const is915 = (currentHour === 9 && currentMinute < 20);
        const isAfter1455 = (currentHour >= 15 || (currentHour === 14 && currentMinute >= 55));

        // 2. Volume Check
        const volRatio = volumes[i] / Math.max(volMA[i], 1);

        // 3. Trend Calculations
        const bullTrend = closes[i] > st[i];
        const bearTrend = closes[i] < st[i];

        const prevBullTrend = closes[i - 1] > st[i - 1];
        const prevBearTrend = closes[i - 1] < st[i - 1];

        const bullFlip = bullTrend && !prevBullTrend;
        const bearFlip = bearTrend && !prevBearTrend;

        // Reset trend state on trend structure flip
        if (bullFlip || bearFlip) {
            trendState = 0;
        }

        // 3.5 Macro Trend Alignment (50-SMA)
        const bullMacroTrend = closes[i] > sma50[i];
        const bearMacroTrend = closes[i] < sma50[i];

        // 4. Momentum Filter (RSI Direction + Absolute Value)
        const bullMomentum = (closes[i] > opens[i]) && (rsi[i] > 51);
        const bearMomentum = (closes[i] < opens[i]) && (rsi[i] < 49);

        // 5. Ignition Strategy (3-Candle Intraday Breakout)
        let highestHighIntraday = highs[i - 1];
        let lowestLowIntraday = lows[i - 1];
        for (let j = 1; j <= 3; j++) {
            if (i - j >= 0) {
                if (times[i - j].getDate() !== times[i].getDate()) break; // Do not cross over to yesterday
                if (highs[i - j] > highestHighIntraday) highestHighIntraday = highs[i - j];
                if (lows[i - j] < lowestLowIntraday) lowestLowIntraday = lows[i - j];
            }
        }
        const bullIgnition = closes[i] > highestHighIntraday;
        const bearIgnition = closes[i] < lowestLowIntraday;

        // 5.5 Conviction Close (Wick Rejection Filter)
        const candleRange = highs[i] - lows[i];
        const bullConviction = candleRange > 0 && closes[i] >= lows[i] + (0.55 * candleRange); // Top 45%
        const bearConviction = candleRange > 0 && closes[i] <= lows[i] + (0.45 * candleRange); // Bottom 45%

        // 6. Volume Filters (Stricter: 1.3x Spike required)
        const strongBullVol = volumes[i] > (volMA[i] * 1.3);
        const strongBearVol = volumes[i] > (volMA[i] * 1.3);

        // 7. Check for Signal Executions
        let longSignal = !is915 && !isAfter1455 && bullTrend && bullMacroTrend && bullIgnition && bullConviction && bullMomentum && strongBullVol && trendState !== 1;
        let shortSignal = !is915 && !isAfter1455 && bearTrend && bearMacroTrend && bearIgnition && bearConviction && bearMomentum && strongBearVol && trendState !== -1;

        let outputSignal = "NEUTRAL";

        if (longSignal) {
            trendState = 1;
            outputSignal = "LONG";
        } else if (shortSignal) {
            trendState = -1;
            outputSignal = "SHORT";
        }

        // 8. Bubble Volume Scaling Data (Optional Metadata for rendering)
        let bubbleType = "none";
        if (closes[i] > opens[i]) {
            if (volRatio > 3.5) bubbleType = "hugeBull";
            else if (volRatio > 2.5) bubbleType = "largeBull";
            else if (volRatio > 1.8) bubbleType = "mediumBull";
            else if (volRatio > 1.2) bubbleType = "smallBull";
        } else if (closes[i] < opens[i]) {
            if (volRatio > 3.5) bubbleType = "hugeBear";
            else if (volRatio > 2.5) bubbleType = "largeBear";
            else if (volRatio > 1.8) bubbleType = "mediumBear";
            else if (volRatio > 1.2) bubbleType = "smallBear";
        }

        results.push({
            time: data[i].time || data[i].date,
            date: data[i].date || data[i].time,
            signal: outputSignal,
            supertrend: st[i],
            rsi: rsi[i],
            bubbleType: bubbleType,
            price: closes[i],
            action: outputSignal === "LONG" ? "BUY" : (outputSignal === "SHORT" ? "SELL" : "NEUTRAL")
        });
    }

    return results;
}

module.exports = {
    calculateMomentumTrackerV10
};
