import yfinance as yf
import json
import sys

symbol = "MAXHEALTH.NS"
print(f"Fetching 5m data for {symbol} using yfinance...", file=sys.stderr)

try:
    ticker = yf.Ticker(symbol)
    df = ticker.history(period="7d", interval="5m")
    
    if df.empty:
        print(json.dumps([]))
        sys.exit(0)
        
    records = []
    for index, row in df.iterrows():
        records.append({
            "date": index.isoformat(),
            "open": row["Open"],
            "high": row["High"],
            "low": row["Low"],
            "close": row["Close"],
            "volume": row["Volume"]
        })
        
    print(json.dumps(records))
except Exception as e:
    print(f"Error: {e}", file=sys.stderr)
    print(json.dumps([]))
