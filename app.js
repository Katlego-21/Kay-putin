 const tg = window.Telegram.WebApp;
tg.expand();

const API_KEY = 'b5b34b4a620c456aabb3ff8b9c674fe8';
let currentSymbol = 'XAU/USD';
let currentInterval = '1m,5m,15m,30m,1h,4h,1daily';

const chart = LightweightCharts.createChart(document.getElementById('chart'), {
  layout: { background: { color: '#0c1724' }, textColor: '#7da1c4' },
  grid: { vertLines: { color: '#14263b' }, horzLines: { color: '#14263b' } },
  crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
  timeScale: { timeVisible: true, secondsVisible: false }
});

const candleSeries = chart.addCandlestickSeries({
  upColor: '#00ffaa',
  downColor: '#ff3b5c',
  borderVisible: false,
  wickUpColor: '#00ffaa',
  wickDownColor: '#ff3b5c'
});

const emaSeries = chart.addLineSeries({ color: '#7da1c4', lineWidth: 1 });
let buyLine = null;
let sellLine = null;

function changePair(symbol, btn) {
  currentSymbol = symbol;
  document.querySelectorAll('.pair-bar button').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  loadChart(currentInterval);
}

async function loadChart(interval, btn) {
  currentInterval = interval;
  if (btn) {
    document.querySelectorAll('.tf-bar button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  }

  try {
    const url = `https://twelvedata.com{currentSymbol}&interval=${interval}&outputsize=250&apikey=${API_KEY}`;
    const res = await fetch(url);
    const data = await res.json();

    if (!data.values) {
      alert('API Error: ' + (data.message || 'Rate limit reached — wait 1 minute'));
      return;
    }

    const candles = data.values.reverse().map(d => ({
      time: Math.floor(new Date(d.datetime.replace(' ', 'T') + 'Z').getTime() / 1000),
      open: parseFloat(d.open),
      high: parseFloat(d.high),
      low: parseFloat(d.low),
      close: parseFloat(d.close)
    }));

    candleSeries.setData(candles);

    // EMA 200
    const emaData = [];
    const k = 2 / (200 + 1);
    let ema = candles[0].close;
    for (let i = 0; i < candles.length; i++) {
      ema = candles[i].close * k + ema * (1 - k);
      if (i >= 50) emaData.push({ time: candles[i].time, value: ema });
    }
    emaSeries.setData(emaData);

    // BOS & CHoCH Swing Markers
    const markers = [];
    for (let i = 4; i < candles.length - 4; i++) {
      const c = candles[i];
      const isSwingHigh = c.high > candles[i-1].high && c.high > candles[i-2].high && c.high > candles[i+1].high && c.high > candles[i+2].high;
      const isSwingLow = c.low < candles[i-1].low && c.low < candles[i-2].low && c.low < candles[i+1].low && c.low < candles[i+2].low;

      if (isSwingHigh) {
        markers.push({ time: c.time, position: 'aboveBar', color: '#ff3b5c', shape: 'circle', text: 'CHoCH' });
      } else if (isSwingLow) {
        markers.push({ time: c.time, position: 'belowBar', color: '#00ffaa', shape: 'circle', text: 'BOS' });
      }
    }
    candleSeries.setMarkers(markers);

    // Dynamic Buy & Sell Zones
    const recent = candles.slice(-30);
    const lowZone = Math.min(...recent.map(c => c.low));
    const highZone = Math.max(...recent.map(c => c.high));

    if (buyLine) candleSeries.removePriceLine(buyLine);
    if (sellLine) candleSeries.removePriceLine(sellLine);

    buyLine = candleSeries.createPriceLine({
      price: lowZone, color: '#00ffaa', lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed, title: 'Buy Zone'
    });
    sellLine = candleSeries.createPriceLine({
      price: highZone, color: '#ff3b5c', lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed, title: 'Sell Zone'
    });
  } catch (err) {
    console.error(err);
  }
}

async function loadNews() {
  const newsBox = document.getElementById('news-feed');
  try {
    const proxy = 'https://allorigins.win' + encodeURIComponent('https://faireconomy.media');
    const res = await fetch(proxy);
    const events = await res.json();
    const todayStr = new Date().toDateString();
    const usdHigh = events.filter(e => e.country === 'USD' && e.impact === 'High');
    const todayNews = usdHigh.filter(e => new Date(e.date).toDateString() === todayStr);

    if (todayNews.length > 0) {
      newsBox.innerHTML = todayNews.map(e => {
        const time = new Date(e.date).toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' });
        return `• <b>${e.title}</b> at ${time}`;
      }).join('<br>');
    } else if (usdHigh.length > 0) {
      const next = usdHigh[0];
      const nextTime = new Date(next.date).toLocaleString('en-ZA', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
      newsBox.innerHTML = `No high-impact USD news today. Next: <b>${next.title}</b>, ${nextTime}`;
    } else {
      newsBox.innerText = 'No high-impact USD news scheduled this week.';
    }
  } catch (err) {
    newsBox.innerText = 'No high-impact USD news right now.';
  }
}

loadChart('1h');
loadNews();
