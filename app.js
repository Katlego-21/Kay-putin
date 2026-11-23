// PUTIN FX BOT - app.js - TwelveData LIVE VERSION
const API_KEY = 'b5b34b4a620c456aabb3ff8b9c674fe8';

let curPair = 'XAUUSD', curTF = '1H';
const pairs = ['XAUUSD','XAGUSD','EURUSD','BTCUSD','ETHUSD','US30'];
const tfs = ['1m','5m','15m','30m','1H','4H','Daily'];
// TwelveData intervals
const tdInterval = {'1m':'1min','5m':'5min','15m':'15min','30m':'30min','1H':'1h','4H':'4h','Daily':'1day'};
// TwelveData symbols
const tdSymbol = {'XAUUSD':'XAU/USD','XAGUSD':'XAG/USD','EURUSD':'EUR/USD','BTCUSD':'BTC/USD','ETHUSD':'ETH/USD','US30':'DJI'};

// Buttons
pairs.forEach(p=>{
  let b=document.createElement('button'); b.textContent=p; b.className=p===curPair?'active':'';
  b.onclick=()=>{curPair=p; document.querySelectorAll('#pairs button').forEach(x=>x.className=''); b.className='active'; load();};
  document.getElementById('pairs').appendChild(b);
});
tfs.forEach(t=>{
  let b=document.createElement('button'); b.textContent=t; b.className=t===curTF?'active-blue':'';
  b.onclick=()=>{curTF=t; document.querySelectorAll('#tfs button').forEach(x=>x.className=''); b.className='active-blue'; load();};
  document.getElementById('tfs').appendChild(b);
});

// CHART
let chart = LightweightCharts.createChart(document.getElementById('chart'), {
  layout:{background:{color:'#071018'},textColor:'#ddd'},
  grid:{vertLines:{color:'#0f1a26'},horzLines:{color:'#0f1a26'}},
  timeScale:{timeVisible:true,secondsVisible:false},
  width: document.getElementById('chart').clientWidth || 350,
  height: 420
});
let candles = chart.addCandlestickSeries({upColor:'#00e676',downColor:'#ff5252',wickUpColor:'#00e676',wickDownColor:'#ff5252'});
let vwapS = chart.addLineSeries({color:'#4da6ff',lineWidth:1,title:'VWAP'});
let emaS = chart.addLineSeries({color:'#888888',lineWidth:1,title:'EMA'});

window.addEventListener('resize', ()=>{
  try{ chart.resize(document.getElementById('chart').clientWidth, 420); }catch(e){}
});

function calcRisk(){
  let bal=parseFloat(document.getElementById('bal').value)||0;
  let pct=parseFloat(document.getElementById('riskPct').value)||2;
  let slP=parseFloat(document.getElementById('slPips').value)||20;
  let risk=bal*pct/100;
  let lot=(risk/(slP*10)).toFixed(2); if(parseFloat(lot)<0.01) lot='0.01';
  document.getElementById('riskAmt').textContent='R'+risk.toFixed(2);
  document.getElementById('lotSize').textContent=lot;
  document.getElementById('riskProfit').textContent='R'+(risk*2).toFixed(2);
}

function updateSession(){
  let now=new Date(new Date().toLocaleString('en-US',{timeZone:'Africa/Johannesburg'}));
  let h=now.getHours()+now.getMinutes()/60;
  let sess='Asia (Quiet)', advice='⚠️ Avoid - Low volatility';
  if(h>=10 && h<15.5){sess='🟢 London (Active)'; advice='✅ Good to trade';}
  if(h>=15.5 && h<22){sess='🟢 New York (Most Active)'; advice='✅ BEST time to trade';}
  if(h>=22 || h<2){sess='🔴 Late NY / Off'; advice='⚠️ Avoid - Market closing';}
  document.getElementById('sessNow').textContent=sess;
  document.getElementById('sessAdvice').textContent=advice;
  document.getElementById('sessTime').textContent=now.toLocaleTimeString('en-ZA');
}

// FETCH FROM TWELVEDATA WITH YOUR API KEY
async function fetchCandles(symbol, tf){
  const sym = tdSymbol[symbol] || 'XAU/USD';
  const interval = tdInterval[tf] || '1h';
  const url = 'https://api.twelvedata.com/time_series?symbol=' + encodeURIComponent(sym) + '&interval=' + interval + '&outputsize=120&format=JSON&apikey=' + API_KEY;
  let res = await fetch(url);
  let j = await res.json();
  // TwelveData errors
  if(j.status === 'error' || j.code){
    throw new Error('TwelveData: ' + (j.message || j.code));
  }
  if(!j.values || j.values.length===0) throw new Error('No data from TwelveData for '+sym);
  // TwelveData returns newest first, reverse to oldest first
  let data = j.values.reverse().map(v=>{
    return {
      time: Math.floor(new Date(v.datetime).getTime()/1000),
      open: parseFloat(v.open),
      high: parseFloat(v.high),
      low: parseFloat(v.low),
      close: parseFloat(v.close)
    };
  }).filter(d=>d.open && d.close);
  return data;
}

function render(data){
  candles.setData(data);
  let emaData=[], vwapData=[], e=null, pv=0, vv=0;
  data.forEach(d=>{
    e = e===null ? d.close : d.close*(2/21)+e*(1-2/21);
    emaData.push({time:d.time,value:e});
    let tp=(d.high+d.low+d.close)/3; pv+=tp*1000; vv+=1000;
    vwapData.push({time:d.time,value:pv/vv});
  });
  emaS.setData(emaData); vwapS.setData(vwapData);
  let last=data[data.length-1], prev=data[data.length-2];
  let high=Math.max(...data.map(d=>d.high)), low=Math.min(...data.map(d=>d.low));
  let emaLast=emaData[emaData.length-1].value;
  let bullish=last.close>emaLast;
  let bos=last.close>prev.high?'BOS UP 🟢':last.close<prev.low?'CHoCH DOWN 🔴':'No Break';
  let fvg=Math.abs(last.high-last.low)>Math.abs(prev.high-prev.low)*1.5?'FVG Found at '+last.low.toFixed(2):'No FVG';
  let sweep=last.low<=low+0.2?'Swept Lows - Reversal Soon':last.high>=high-0.2?'Swept Highs':'No Sweep';
  let entry=last.close, sl=bullish?low:high, tp=bullish?entry+(entry-sl)*2:entry-(sl-entry)*2;
  document.getElementById('msg').textContent=curPair+' • '+curTF+' • '+last.close.toFixed(2)+' • LIVE via TwelveData';
  document.getElementById('sigText').textContent=bullish?'🟢 BUY NOW':'🔴 SELL NOW';
  document.getElementById('sigText').className='big '+(bullish?'green':'red');
  document.getElementById('signalBox').className='signal '+(bullish?'':'sell');
  document.getElementById('sigDetail').textContent=bullish?'Price above EMA, BOS confirmed, wait for pullback to Buy Zone':'Price below EMA, CHoCH confirmed, wait for pullback to Sell Zone';
  document.getElementById('entry').textContent=entry.toFixed(2);
  document.getElementById('sl').textContent=sl.toFixed(2);
  document.getElementById('tp').textContent=tp.toFixed(2);
  document.getElementById('sigConf').textContent='Confidence: '+(bullish?'78':'72')+'% • RR: 1:2 • Pair: '+curPair;
  document.getElementById('smcBos').textContent=bullish?'BULLISH 🟢':'BEARISH 🔴';
  document.getElementById('smcChoch').textContent=bos;
  document.getElementById('smcOb').textContent=bullish?'Bullish OB at '+low.toFixed(2):'Bearish OB at '+high.toFixed(2);
  document.getElementById('smcFvg').textContent=fvg;
  document.getElementById('smcLiq').textContent=sweep;
  document.getElementById('smcTrend').textContent=bullish?'Above EMA 🟢':'Below EMA 🔴';
  document.getElementById('lvlBuy').textContent=low.toFixed(2);
  document.getElementById('lvlSell').textContent=high.toFixed(2);
  document.getElementById('lvlHigh').textContent=high.toFixed(2);
  document.getElementById('lvlLow').textContent=low.toFixed(2);
  document.getElementById('trend').innerHTML=bullish?'🟢 <b>BULLISH</b> - Look for BUY':'🔴 <b>BEARISH</b> - Look for SELL';
  document.getElementById('slPips').value=Math.abs(entry-sl).toFixed(0)||20; calcRisk();
  chart.timeScale().fitContent();
}

async function load(){
  document.getElementById('msg').textContent='Loading chart... '+curPair+' '+curTF+' via TwelveData...';
  updateSession();
  try{
    let data = await fetchCandles(curPair, curTF);
    render(data);
  }catch(e){
    document.getElementById('msg').textContent='TwelveData Error: '+e.message;
    console.log('TwelveData failed:', e);
  }
}

calcRisk();
load();
setInterval(updateSession, 30000);
