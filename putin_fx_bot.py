import os
import json
import math
import time
import sqlite3
import threading
from datetime import datetime, timedelta
import pytz
import requests
import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestClassifier
from telegram import Update
from telegram.ext import Application, CommandHandler, ContextTypes

# ==============================================================================
# 1. CREDENTIALS & CORE SETTINGS
# ==============================================================================
TWELVE_DATA_API_KEY = "b5b34b4a620c456aabb3ff8b9c674fe8"
TELEGRAM_BOT_TOKEN = "8668712082:AAGt3mM8VNSfzxq6rkVYkOrVcB-ZHgtZcWA"

BOT_NAME = "PUTIN FX BOT"
SYMBOL = "XAU/USD"
LOCAL_TZ = pytz.timezone("Africa/Johannesburg")  # SAST
DB_PATH = "putin_fx_memory.db"
SETTINGS_PATH = "putin_fx_settings.json"
STATE_JSON_PATH = "market_data.json"
BRAIN_JSON_PATH = "putin_fx_brain.json"
SCAN_INTERVAL_SEC = 60

DEFAULT_SETTINGS = {
    "telegram_chat_id": None,                # Auto-saved when you send /start or /status
    "xm_mt5_bid_offset": 0.00,
    "xm_matched": False,                     # Track if user calibrated XM MT5 Bid
    "min_room_dollars": 6.00,                # Minimum $6.00 unobstructed room
    "max_stop_dollars": 3.50,                # Max stop-loss distance
    "ai_usage_mode": "decide_once_proven",   # "decide_once_proven" | "confluence_only"
    "min_win_chance_pct": 60.0,              # Minimum AI win probability (%)
    "use_best_version_once_proven": True,
    "recommend_exit_once_proven": True,
    "history_lookback_days": 60,
    "backtest_period_days": 30,
    "spread_cost_dollars": 0.35,
    "trade_management": "thirds_be_after_tp1",
}


def load_settings() -> dict:
    if os.path.exists(SETTINGS_PATH):
        with open(SETTINGS_PATH, "r") as f:
            return {**DEFAULT_SETTINGS, **json.load(f)}
    save_settings(DEFAULT_SETTINGS)
    return DEFAULT_SETTINGS.copy()


def save_settings(cfg: dict):
    with open(SETTINGS_PATH, "w") as f:
        json.dump(cfg, f, indent=2)


def register_chat_id(chat_id: int):
    cfg = load_settings()
    if cfg.get("telegram_chat_id") != chat_id:
        cfg["telegram_chat_id"] = chat_id
        save_settings(cfg)


# ==============================================================================
# 2. SQLITE MEMORY, 30-VARIANT PAPER TRADER & AI ENGINE
# ==============================================================================
def init_db():
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("""
        CREATE TABLE IF NOT EXISTS setups (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            created_at TEXT,
            source TEXT DEFAULT 'LIVE',
            bias TEXT,
            zone_low REAL,
            zone_high REAL,
            stop_price REAL,
            tp1 REAL,
            tp2 REAL,
            tp3 REAL,
            touches INTEGER,
            atr_15m REAL,
            has_key_level INTEGER,
            confluences INTEGER,
            is_a_grade INTEGER DEFAULT 0,
            status TEXT DEFAULT 'OPEN',
            outcome_win INTEGER DEFAULT NULL,
            hit_tp1 INTEGER DEFAULT 0,
            hit_tp2 INTEGER DEFAULT 0,
            hit_tp3 INTEGER DEFAULT 0
        )
    """)
    c.execute("""
        CREATE TABLE IF NOT EXISTS paper_variants (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            setup_id INTEGER,
            tp1_dist REAL,
            entry_pct REAL,
            stop_mode TEXT,
            entry_price REAL,
            stop_price REAL,
            tp1_price REAL,
            filled INTEGER DEFAULT 0,
            closed INTEGER DEFAULT 0,
            pnl_dollars REAL DEFAULT 0.0
        )
    """)
    conn.commit()
    conn.close()


def spawn_30_paper_variants(conn, setup_id: int, bias: str, z_low: float, z_high: float):
    """Spawns 30 shadow paper-trade variants (5 TP1s x 3 entry depths x 2 stop widths)."""
    c = conn.cursor()
    height = abs(z_high - z_low)
    for tp1_d in [4.0, 5.0, 6.0, 7.0, 8.0]:
        for depth in [0.0, 0.25, 0.50]:
            for mode, buf in [("standard", 1.0), ("wider", 2.0)]:
                if bias == "SELL":
                    entry = round(z_low + height * depth, 2)
                    stop = round(z_high + buf, 2)
                    tp1 = round(entry - tp1_d, 2)
                else:
                    entry = round(z_high - height * depth, 2)
                    stop = round(z_low - buf, 2)
                    tp1 = round(entry + tp1_d, 2)
                c.execute("""
                    INSERT INTO paper_variants
                    (setup_id, tp1_dist, entry_pct, stop_mode, entry_price, stop_price, tp1_price)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                """, (setup_id, tp1_d, depth, mode, entry, stop, tp1))


def update_live_paper_trades(high_5m: float, low_5m: float):
    """Updates all open setups and 30 paper variants against incoming live candle highs/lows."""
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()

    for vid, bias, entry, stop, tp1, filled in c.execute("""
        SELECT pv.id, s.bias, pv.entry_price, pv.stop_price, pv.tp1_price, pv.filled
        FROM paper_variants pv JOIN setups s ON pv.setup_id = s.id WHERE pv.closed = 0
    """).fetchall():
        if not filled:
            if (bias == "SELL" and high_5m >= entry) or (bias == "BUY" and low_5m <= entry):
                c.execute("UPDATE paper_variants SET filled = 1 WHERE id = ?", (vid,))
                filled = 1
        if filled:
            if bias == "SELL":
                if high_5m >= stop:
                    c.execute("UPDATE paper_variants SET closed = 1, pnl_dollars = ? WHERE id = ?", (round(entry - stop, 2), vid))
                elif low_5m <= tp1:
                    c.execute("UPDATE paper_variants SET closed = 1, pnl_dollars = ? WHERE id = ?", (round(entry - tp1, 2), vid))
            else:
                if low_5m <= stop:
                    c.execute("UPDATE paper_variants SET closed = 1, pnl_dollars = ? WHERE id = ?", (round(stop - entry, 2), vid))
                elif high_5m >= tp1:
                    c.execute("UPDATE paper_variants SET closed = 1, pnl_dollars = ? WHERE id = ?", (round(tp1 - entry, 2), vid))

    for sid, bias, z_low, z_high, stop, tp1, tp2, tp3, status, h1, h2 in c.execute("""
        SELECT id, bias, zone_low, zone_high, stop_price, tp1, tp2, tp3, status, hit_tp1, hit_tp2
        FROM setups WHERE status IN ('OPEN', 'FILLED')
    """).fetchall():
        entry = z_low if bias == "SELL" else z_high
        if status == "OPEN":
            if (bias == "SELL" and high_5m >= entry) or (bias == "BUY" and low_5m <= entry):
                c.execute("UPDATE setups SET status = 'FILLED' WHERE id = ?", (sid,))
                status = "FILLED"
        if status == "FILLED":
            if bias == "SELL":
                if high_5m >= stop:
                    c.execute("UPDATE setups SET status = 'CLOSED', outcome_win = ? WHERE id = ?", (1 if h1 else 0, sid))
                else:
                    nh1 = 1 if (h1 or low_5m <= tp1) else 0
                    nh2 = 1 if (h2 or low_5m <= tp2) else 0
                    if low_5m <= tp3:
                        c.execute("UPDATE setups SET status = 'CLOSED', outcome_win = 1, hit_tp1 = 1, hit_tp2 = 1, hit_tp3 = 1 WHERE id = ?", (sid,))
                    else:
                        c.execute("UPDATE setups SET hit_tp1 = ?, hit_tp2 = ? WHERE id = ?", (nh1, nh2, sid))
            else:
                if low_5m <= stop:
                    c.execute("UPDATE setups SET status = 'CLOSED', outcome_win = ? WHERE id = ?", (1 if h1 else 0, sid))
                else:
                    nh1 = 1 if (h1 or high_5m >= tp1) else 0
                    nh2 = 1 if (h2 or high_5m >= tp2) else 0
                    if high_5m >= tp3:
                        c.execute("UPDATE setups SET status = 'CLOSED', outcome_win = 1, hit_tp1 = 1, hit_tp2 = 1, hit_tp3 = 1 WHERE id = ?", (sid,))
                    else:
                        c.execute("UPDATE setups SET hit_tp1 = ?, hit_tp2 = ? WHERE id = ?", (nh1, nh2, sid))

    conn.commit()
    conn.close()


def evaluate_ai_and_telemetry(features: dict, cfg: dict) -> dict:
    """Walk-forward out-of-sample AI validation, 30-variant tuning, Smart Exits, and feature weights."""
    conn = sqlite3.connect(DB_PATH)
    cutoff = (datetime.utcnow() - timedelta(days=cfg["history_lookback_days"])).isoformat()
    df_all = pd.read_sql_query("SELECT * FROM setups WHERE created_at >= ?", conn, params=(cutoff,))
    df_var = pd.read_sql_query("SELECT * FROM paper_variants WHERE closed = 1", conn)
    conn.close()

    closed = df_all[df_all["status"] == "CLOSED"].copy()
    waiting = df_all[df_all["status"].isin(["OPEN", "FILLED"])]
    live_count = int((df_all["source"] == "LIVE").sum()) if not df_all.empty else 0

    lessons = len(closed)
    wins = int((closed["outcome_win"] == 1).sum()) if not closed.empty else 0
    losses = int((closed["outcome_win"] == 0).sum()) if not closed.empty else 0

    ai_proven = False
    win_chance = None
    learned_weights = {}

    if lessons >= 30:
        split = int(lessons * 0.7)
        train_df, test_df = closed.iloc[:split], closed.iloc[split:]
        cols = ["touches", "atr_15m", "has_key_level", "confluences"]
        labels = {
            "touches": "Zone Touches (M5/M15/H1)",
            "atr_15m": "15m Volatility (ATR)",
            "has_key_level": "Key Level / $5 Round Number",
            "confluences": "13-Point Confluence Score",
        }
        if train_df["outcome_win"].nunique() > 1 and len(test_df) >= 5:
            clf = RandomForestClassifier(n_estimators=100, random_state=42)
            clf.fit(train_df[cols], train_df["outcome_win"])
            probs = clf.predict_proba(test_df[cols])[:, 1] * 100
            ai_picks = test_df[probs >= cfg["min_win_chance_pct"]]
            rule_picks = test_df[test_df["confluences"] >= 10]

